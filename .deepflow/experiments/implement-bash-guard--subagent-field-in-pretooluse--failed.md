# Experiment: Subagent Identification in PreToolUse Hook Payload

## Hypothesis

The Bash PreToolUse hook payload includes a field (subagent_type, agent_name, or derivable from transcript_path) that identifies the active subagent, enabling a guard hook to restrict behavior to df-implement agents only.

## Method

1. Examined existing PreToolUse hooks in `hooks/` to identify available payload fields
2. Read `hooks/df-bash-rewrite.js` to understand current payload handling
3. Read `hooks/df-explore-protocol.js` and `hooks/df-implement-protocol.js` to see how other hooks detect agent type
4. Read `hooks/df-worktree-guard.js` to understand existing guard patterns
5. Examined test files to confirm payload structure
6. Reviewed `/df:execute` command documentation to understand agent spawn conventions

## Results

### Evidence Found

**Direct field exists:** `tool_input.subagent_type` is present in the PreToolUse payload when the Agent tool is invoked.

**Implementation examples:**
1. `hooks/df-explore-protocol.js` (line 35):
   ```javascript
   const subagentType = (tool_input.subagent_type || '').toLowerCase();
   if (subagentType !== 'explore') {
     return;
   }
   ```

2. Test payload structure from `hooks/df-explore-protocol.test.js`:
   ```javascript
   {
     tool_name: 'Agent',
     tool_input: { 
       subagent_type: 'Explore', 
       prompt: '...' 
     }
   }
   ```

3. `/df:execute` command spawns agents with explicit `subagent_type`:
   ```
   Agent(subagent_type: "df-implement", run_in_background=true):
     {task content}
   ```

**Subagent routing table from `src/commands/df/execute.md`:**

| Flag                  | `subagent_type`  | Use Case                |
|-----------------------|------------------|-------------------------|
| `isIntegration: true` | `df-integration` | Integration Task        |
| `isSpike: true`       | `df-spike`       | Spike                   |
| `isOptimize: true`    | `df-optimize`    | Optimize Task           |
| `isTest: true`        | `df-test`        | Wave Test               |
| (none)                | `df-implement`   | Standard Task (default) |

**Additional subagent types observed:**
- `df-haiku-ops` (for git operations)
- `Explore` (search protocol)

### Payload Structure

For Agent tool calls, the PreToolUse hook receives:
```javascript
{
  tool_name: "Agent",
  tool_input: {
    subagent_type: "df-implement",  // or "df-spike", "df-integration", etc.
    prompt: "...",
    // other fields
  },
  cwd: "/path/to/worktree"
}
```

For Bash tool calls, the payload does NOT include `subagent_type` directly:
```javascript
{
  tool_name: "Bash",
  tool_input: {
    command: "npm test",
    description: "..."
  },
  cwd: "/path/to/worktree"
}
```

## Criteria Check

**Can we detect df-implement from a Bash PreToolUse hook?**

**NO — directly from Bash payload:** The Bash PreToolUse hook does NOT receive `subagent_type` because Bash is the tool being invoked, not Agent.

**Alternative mechanisms evaluated:**

1. **Direct field (`subagent_type`)**: Not available in Bash PreToolUse payloads. Only Agent tool calls include this field.

2. **Working directory convention**: The payload includes `cwd` which points to the worktree path. However:
   - `df-worktree-guard.js` uses `cwd` to detect worktree branches via `git branch --list df/*`
   - This tells us IF we're in a df/ worktree, but NOT which subagent is active
   - Multiple agent types can operate in the same worktree (e.g., df-haiku-ops for git, df-implement for code)

3. **Transcript path parsing**: No `transcript_path` field found in examined payloads.

4. **Environment variables**: No evidence of `DF_SUBAGENT_TYPE` or similar in environment.

## Conclusion

**FAILED** — The Bash PreToolUse hook payload does NOT include sufficient information to reliably identify the active subagent type.

**Root cause:** The `subagent_type` field is only present when the Agent tool is invoked. When a subagent (df-implement, df-spike, etc.) internally invokes Bash, the PreToolUse hook for Bash receives only the Bash tool parameters (`command`, `description`) plus global context (`cwd`), but NOT the identity of the calling subagent.

**Blocking issue:** There is no parent-agent context propagated to nested tool invocations. The hook system is tool-centric, not agent-centric.

### Confidence

**HIGH** — Based on:
1. Examination of 3+ existing PreToolUse hooks (df-bash-rewrite, df-explore-protocol, df-implement-protocol)
2. Review of test files showing actual payload structures
3. Inspection of df-worktree-guard which uses similar pattern (guards Write/Edit, not Bash)
4. Documentation in /df:execute showing Agent spawn conventions

## Alternative Approaches for T3

Since direct subagent detection is not possible, alternative guard strategies:

### Option A: Worktree-level guard (location-based)
**Mechanism:** Detect if `cwd` is inside `.deepflow/worktrees/` but NOT on a df/ branch (main branch in worktree)
**Weakness:** Cannot distinguish df-implement from df-spike or df-haiku-ops in same worktree

### Option B: Command pattern allowlist (behavioral)
**Mechanism:** Allow waste commands globally (npm ci, git worktree add) but NOT build/test commands that should use compression
**Weakness:** Requires maintaining a separate allowlist; may have false negatives

### Option C: Marker-based opt-out (explicit)
**Mechanism:** Set `DF_BASH_REWRITE_ALLOW_WASTE=1` environment variable in df-implement agent prompt or frontmatter
**Strength:** Explicit, no heuristics
**Weakness:** Requires modifying agent definitions; environment may not propagate to hooks

### Option D: No guard (accept the trade-off)
**Mechanism:** Accept that df-bash-rewrite affects all agents; rely on its existing PROTECTED list to exclude critical parseable commands
**Strength:** Simple, already working
**Weakness:** Waste issue persists in SPIKE tasks per T1 motivation

### Recommended: Option D + expand PROTECTED list
**Rationale:** The current PROTECTED list in df-bash-rewrite.js already prevents rewriting commands whose output is parsed. The "waste" concern is about context bloat, not correctness. Since we cannot reliably detect subagent type, the safest approach is:
1. Keep the existing universal rewrite behavior
2. Expand PROTECTED list to cover any additional parseable commands discovered
3. Accept compression in SPIKE tasks as a non-issue (SPIKEs are exploratory; output IS confirmatory)

## Implementation Sketch for T3 (if proceeding despite failure)

**Not applicable** — T3 should be marked BLOCKED pending architectural decision on whether to:
1. Accept universal compression (recommended)
2. Introduce environment-based opt-in/opt-out (requires parent-agent protocol change)
3. Switch to Agent-level hook events (would require Claude Code platform changes)
