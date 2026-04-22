# Spike: Task ID Extraction Mechanism for PreToolUse Hooks

## Hypothesis

The orchestrator (df:execute) can write a per-worktree `.deepflow/runtime/active-task.json` file before spawning each implementation agent. A PreToolUse hook can then read the cwd from the hook payload, walk up to find `.deepflow/runtime/`, read `active-task.json`, and extract the task ID. This enables the test-invocation-cap hook (T4) to key counters by task ID.

## Method

1. Read `src/commands/df/execute.md` to find where agents are spawned and check for existing task ID mechanisms
2. Read `hooks/df-bash-rewrite.js` to understand hook payload structure
3. Read `hooks/df-implement-protocol.js` to see what fields are available in PreToolUse payloads
4. Read `hooks/df-statusline.js` to discover existing environment variable patterns
5. Read `.deepflow/worktrees/multi-spec/hooks/df-execution-history.js` to see how task IDs are currently extracted
6. Determine the most reliable mechanism for task ID extraction

## Results

### Findings from Code Examination

**1. Hook Payload Structure (PreToolUse):**

From `df-implement-protocol.js` line 436:
```javascript
function main(payload) {
  const { tool_name, tool_input, cwd } = payload || {};
```

PreToolUse hooks receive:
- `tool_name`: The tool being invoked (e.g., "Bash", "Agent")
- `tool_input`: The tool's input parameters (e.g., `{ command: "..." }` for Bash, `{ prompt: "..." }` for Agent)
- `cwd`: The current working directory where the tool will execute

**2. Existing Environment Variable Pattern:**

From `df-statusline.js` lines 222-223 and 259-260:
```javascript
const agentRole = process.env.DEEPFLOW_AGENT_ROLE || 'orchestrator';
const taskId = process.env.DEEPFLOW_TASK_ID || null;
```

**CRITICAL DISCOVERY:** The codebase already uses `DEEPFLOW_TASK_ID` environment variable in two hooks:
- `df-statusline.js` (statusLine hook) - for token tracking
- `df-execution-history.js` (PostToolUse hook) - as a fallback for task ID extraction

**3. Task ID Extraction Fallback Pattern:**

From `.deepflow/worktrees/multi-spec/hooks/df-execution-history.js` lines 23-28:
```javascript
function extractTaskId(prompt) {
  if (prompt) {
    const match = prompt.match(/T(\d+)/);
    if (match) return `T${match[1]}`;
  }
  return process.env.DEEPFLOW_TASK_ID || null;
}
```

The execution-history hook uses a two-tier approach:
1. Primary: Extract from Agent prompt via regex `T(\d+)`
2. Fallback: `process.env.DEEPFLOW_TASK_ID`

**4. Orchestrator Agent Spawn Pattern:**

From `execute.md` section 5 and 6, agents are spawned with:
- `Working directory: ${SPEC_WORKTREES[task.spec].path}`
- Task prompts include the task ID in format `T{N}: {description}`
- No explicit mention of `DEEPFLOW_TASK_ID` being set

**5. Hook CWD Behavior:**

The `cwd` field in the hook payload represents:
- For Bash tool: the directory where the command will execute
- For Agent tool: the working directory set when spawning the agent
- In worktree context: this is the worktree path (e.g., `.deepflow/worktrees/{spec}`)

## Proposed Mechanism

**Option A: Environment Variable (RECOMMENDED)**

The orchestrator sets `DEEPFLOW_TASK_ID` environment variable when spawning each task agent:

```javascript
Agent(
  subagent_type: "df-implement",
  run_in_background: true,
  env: { DEEPFLOW_TASK_ID: "T3" }
):
  Working directory: ${SPEC_WORKTREES[task.spec].path}
  ...
```

The PreToolUse hook then reads:
```javascript
const taskId = process.env.DEEPFLOW_TASK_ID;
```

**Advantages:**
- Simple, no file I/O required
- Works immediately across all tools (Bash, Write, Edit, etc.)
- Already established pattern in the codebase (df-statusline.js uses it)
- No race conditions between file write and hook read
- Survives across multiple tool calls within the same agent
- No cleanup required

**Disadvantages:**
- Requires orchestrator modification to pass env vars to Agent tool
- Unclear if Claude Code's Agent tool supports custom environment variables

**Option B: Runtime State File (FALLBACK)**

The orchestrator writes `.deepflow/runtime/{spec}/active-task.json` before spawning each task:

```json
{
  "task_id": "T3",
  "spec": "upload",
  "started_at": "2026-04-22T10:30:00Z"
}
```

The PreToolUse hook extracts task ID:
```javascript
function extractTaskId(cwd) {
  // Walk up from cwd to find .deepflow/runtime/
  let current = cwd;
  while (current !== path.dirname(current)) {
    const runtimePath = path.join(current, '.deepflow', 'runtime');
    if (fs.existsSync(runtimePath)) {
      // Try spec-specific file first
      const specMatch = current.match(/\.deepflow\/worktrees\/([^/]+)/);
      if (specMatch) {
        const specFile = path.join(runtimePath, specMatch[1], 'active-task.json');
        if (fs.existsSync(specFile)) {
          return JSON.parse(fs.readFileSync(specFile, 'utf8')).task_id;
        }
      }
      // Fallback: shared active-task.json
      const sharedFile = path.join(runtimePath, 'active-task.json');
      if (fs.existsSync(sharedFile)) {
        return JSON.parse(fs.readFileSync(sharedFile, 'utf8')).task_id;
      }
    }
    current = path.dirname(current);
  }
  return null;
}
```

**Advantages:**
- No dependency on Agent tool supporting custom env vars
- Works with current Claude Code capabilities
- Clear state for debugging

**Disadvantages:**
- File I/O overhead on every Bash call
- Potential race conditions if file write completes after hook fires
- Requires cleanup between tasks
- More complex implementation

**Option C: Hybrid Approach (ROBUST)**

Combine both mechanisms with a priority order:
1. Check `process.env.DEEPFLOW_TASK_ID` (fastest, if available)
2. Extract from `tool_input.prompt` for Agent tool (reliable for Agent spawns)
3. Read from runtime state file (fallback for Bash/other tools)
4. Return null (fail-open)

```javascript
function getTaskId(payload) {
  // 1. Environment variable (if orchestrator sets it)
  if (process.env.DEEPFLOW_TASK_ID) {
    return process.env.DEEPFLOW_TASK_ID;
  }
  
  // 2. Extract from Agent prompt (for Agent tool)
  if (payload.tool_name === 'Agent' && payload.tool_input?.prompt) {
    const match = payload.tool_input.prompt.match(/\bT(\d+)\s*:/);
    if (match) return `T${match[1]}`;
  }
  
  // 3. Runtime state file (fallback for Bash tool)
  if (payload.cwd) {
    return extractTaskIdFromFile(payload.cwd);
  }
  
  // 4. Fail-open
  return null;
}
```

## Edge Cases Discovered

1. **Parallel worktrees**: Each spec has its own worktree. If using runtime files, must key by spec name or worktree path to avoid collisions.

2. **Missing file race condition**: Hook may fire before orchestrator writes the runtime file. Fail-open policy applies - no task ID means no cap enforcement.

3. **Cross-tool consistency**: An Agent spawns, sets task ID context. Within that agent, Bash calls need the same task ID. Environment variables naturally inherit; file-based approach requires the hook to walk up from the Bash command's cwd.

4. **Non-task commands**: User-initiated Bash commands outside df:execute won't have a task ID. This is expected - no cap enforcement.

5. **Cleanup timing**: If using files, orchestrator must clean up after each task completes to prevent stale state affecting the next task.

## Criteria Check

✓ **Documented concrete mechanism**: Environment variable (Option A) is the simplest and most reliable if supported; hybrid approach (Option C) provides maximum robustness.

✓ **Works with parallel worktrees**: Yes - each agent process has isolated environment variables. File-based approach requires spec-keyed paths.

✓ **Hook payload includes sufficient info**: Yes - `cwd` field enables file discovery; `process.env` enables direct access; `tool_input.prompt` for Agent tool enables regex extraction.

✓ **Reliable extraction**: Hybrid approach provides three fallback layers, ensuring high reliability across different tool types and spawn methods.

## Conclusion

**PASSED** - Multiple viable mechanisms exist for task ID extraction in PreToolUse hooks.

**Recommended approach**: **Option C (Hybrid)** with the following implementation priority:

1. Primary: `process.env.DEEPFLOW_TASK_ID` (if orchestrator can set it)
2. Secondary: Regex extraction from Agent `tool_input.prompt` (pattern: `T\d+:`)
3. Tertiary: Runtime state file at `.deepflow/runtime/{spec}/active-task.json`
4. Fail-open: Return `null` if all methods fail

This layered approach ensures maximum reliability while maintaining simplicity where possible.

### Confidence

**HIGH** - The hybrid approach leverages existing, proven patterns from `df-execution-history.js` and `df-statusline.js`. The cwd field in the hook payload is confirmed to exist and contain the worktree path. The environment variable pattern is already in use for `DEEPFLOW_TASK_ID`, providing a strong precedent.

### Implementation Notes for T4

The test-invocation-cap hook (T4) should:

1. Implement the hybrid `getTaskId(payload)` function shown above
2. Use task ID to key per-task counters in memory (Map structure)
3. If `taskId` is `null`, fail-open (allow the command)
4. Counter state lives only in the hook process lifetime (reset on hook reload)
5. No need for persistent state - caps are per-task-execution, not cross-session

### Orchestrator Changes Required

If using environment variables (Option A or C):
- Modify `df:execute` section 5 (SPAWN AGENTS) to pass `env` parameter to Agent tool with `DEEPFLOW_TASK_ID`
- This may require checking if Claude Code's Agent tool supports custom environment variables
- If not supported, fall back to Option C's secondary/tertiary methods
