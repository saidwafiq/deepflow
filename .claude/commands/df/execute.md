# /df:execute — Execute Tasks from Plan

## Purpose
Implement tasks from PLAN.md with parallel agents and atomic commits.

## Usage
```
/df:execute
/df:execute T1 T2    # Execute specific tasks only
```

## Skills & Agents
- Skill: `atomic-commits` — Clean commit protocol
- Agent: `general-purpose` (Sonnet) — Task implementation
- Agent: `reasoner` (Opus) — Debugging failures

## Behavior

### 1. LOAD PLAN

```
Load:
- PLAN.md (required)
- specs/*.md (for context)
- .specflow/config.yaml (if exists)
```

If PLAN.md missing:
```
No PLAN.md found. Run /df:plan first.
```

### 2. IDENTIFY READY TASKS

Find tasks where:
- Status is `[ ]` (not done)
- All `blocked_by` tasks are `[x]` (complete)

```
Ready: [T1, T2, T5]     # No blockers
Blocked: [T3, T4]       # Waiting on dependencies
Done: []
```

### 3. EXECUTE IN PARALLEL

**Spawn `general-purpose` agents** (Sonnet) for ready tasks:

| Ready Tasks | Agents |
|-------------|--------|
| 1-3 | All parallel |
| 4-10 | 5 parallel, queue rest |
| 10+ | 5 parallel, queue rest |

Each agent uses `atomic-commits` skill for commit protocol.

**Critical rule: 1 writer per file**
If T1 and T2 both modify `src/api.ts`, execute sequentially.

**On failure:** Spawn `reasoner` agent (Opus) for debugging.

### 4. PER-TASK EXECUTION

Each executor agent:

```
1. READ spec requirements for this task
2. READ existing code context
3. IMPLEMENT the task completely
   - No stubs
   - No placeholders
   - No TODO comments
4. VERIFY implementation works
   - Run related tests if they exist
   - Check TypeScript/lint if applicable
5. COMMIT atomically
   - Format: feat({spec}): {task description}
   - One task = one commit
```

### 5. UPDATE PLAN

After each task completes:
```markdown
- [x] **T1**: Create upload API endpoint ✓ (abc1234)
  - Files: src/api/upload.ts
  - Blocked by: none
```

### 6. ITERATE

After wave completes:
```
Wave 1 complete: T1 ✓, T2 ✓

Unblocked: T3, T4 now ready
Executing wave 2...
```

Repeat until all tasks done or blocked.

### 7. REPORT

```
✓ Execution complete

Tasks completed: 5/5
Commits: 5
Failed: 0

All specs implemented. Run /df:verify to confirm.
```

Or if partial:
```
⚠ Execution paused

Tasks completed: 3/5
Blocked: T4 (waiting on T3)
Failed: T3 (see error below)

Error in T3:
  [error details]

Fix the issue and run /df:execute to continue.
```

## Rules

### Parallelism
- **Read operations**: Unlimited parallel
- **Write operations**: Max 5 parallel, 1 per file
- **Build/test**: Always sequential

### Commits
- One task = one commit
- Format: `feat({spec}): {description}`
- Include task ID in commit body
- Never commit broken code

### Completeness
- No stubs or placeholders
- No `// TODO` comments
- Implement fully or don't commit

### Conflict Avoidance
```
If T1 writes to src/api.ts
And T2 writes to src/api.ts
Then execute T1, wait, then T2
```

## Agent Spawning

```yaml
executor_agents:
  max_parallel: 5
  per_file_limit: 1

model_selection:
  implement: sonnet
  debug: opus

commit_after: each_task
push_after: all_complete  # Not every commit
```

## Example Session

```
/df:execute

Loading PLAN.md...
Found 5 tasks, 3 ready (no blockers)

Wave 1: Executing T1, T2, T5 in parallel...
  T1: Create upload API endpoint... ✓ (abc1234)
  T2: Add validation middleware... ✓ (def5678)
  T5: Integrate color-thief... ✓ (ghi9012)

Wave 2: T3, T4 now unblocked
  T3: Implement S3 upload... ✓ (jkl3456)
  T4: Complete thumbnails... ✓ (mno7890)

✓ Execution complete
Tasks: 5/5
Commits: 5

Run /df:verify to confirm specs satisfied.
```
