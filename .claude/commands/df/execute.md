# /df:execute — Execute Tasks from Plan

## Purpose
Implement tasks from PLAN.md with parallel agents, atomic commits, and context-efficient execution.

## Usage
```
/df:execute              # Execute all ready tasks
/df:execute T1 T2        # Specific tasks only
/df:execute --continue   # Resume from checkpoint
/df:execute --fresh      # Ignore checkpoint
/df:execute --dry-run    # Show plan only
```

## Skills & Agents
- Skill: `atomic-commits` — Clean commit protocol
- Agent: `general-purpose` (Sonnet) — Task implementation
- Agent: `reasoner` (Opus) — Debugging failures

## Context Budget

| Threshold | Tokens | Action |
|-----------|--------|--------|
| Normal | <60k | Continue execution |
| Warning | 60k | Display budget status |
| Checkpoint | 80k | Save state, prompt resume |
| Limit | 100k | Hard stop |

Display after each wave: `Budget: ~45k/100k tokens`

Token estimates: ~650/task, ~200/wave overhead.

## Agent Output Protocol

Agents MUST return exactly 5 lines:

```yaml
task: T3
status: success|failed
commit: abc1234
duration: 45s
error: "single line if failed"
```

**Agent instructions (include in spawn):**
```
Return ONLY 5-line YAML. No test output, git logs, or stack traces.
Handle all verification internally. Fix issues before returning.
```

If verbose output received: extract minimal data, discard rest.

## Checkpoint & Resume

**File:** `.deepflow/checkpoint.json`

```json
{
  "session_id": "exec_abc123",
  "completed_tasks": ["T1", "T2"],
  "current_wave": 2,
  "last_commit": "def5678",
  "estimated_tokens_used": 82000,
  "decisions_made": ["Used multer for uploads"],
  "resume_instructions": "Continue with Wave 3"
}
```

**Checkpoint protocol** (at 80k tokens):
1. Complete current task
2. Wait for parallel agents
3. Update PLAN.md
4. Write checkpoint atomically (.tmp → rename)
5. Print: `Context limit reached. Run /df:execute --continue`

**Resume** (`--continue`): Load checkpoint, skip completed tasks, reset token counter.

## Behavior

### 1. CHECK CHECKPOINT

```
--continue → Load and resume
--fresh → Delete checkpoint, start fresh
checkpoint exists → Prompt: "Resume? (y/n)"
else → Start fresh
```

### 2. LOAD PLAN

```
Load: PLAN.md (required), specs/*.md, .deepflow/config.yaml
If missing: "No PLAN.md found. Run /df:plan first."
```

### 3. IDENTIFY READY TASKS

Ready = `[ ]` status + all `blocked_by` complete + not in checkpoint.

### 4. EXECUTE IN PARALLEL

| Ready | Strategy |
|-------|----------|
| 1-3 | All parallel |
| 4+ | 5 parallel, queue rest |

**Critical:** 1 writer per file. If T1 and T2 both modify `src/api.ts`, execute sequentially.

**On failure:** Spawn `reasoner` (Opus) for debugging.

### 5. PER-TASK EXECUTION

Each agent internally:
1. Read spec requirements
2. Implement completely (no stubs/TODOs)
3. Verify (tests, types, lint) — fix issues
4. Commit atomically: `feat({spec}): {description}`
5. Return 5-line YAML only

### 6. UPDATE & CHECK BUDGET

- Mark task complete in PLAN.md with commit hash
- Update token estimate
- If >80k: checkpoint and exit
- If >60k: show warning

### 7. ITERATE

Repeat until: all done, all blocked, or budget reached.

## Rules

| Rule | Enforcement |
|------|-------------|
| 1 task = 1 commit | `atomic-commits` skill |
| No broken commits | Verify before commit |
| 1 writer per file | Sequential if conflict |
| Minimal returns | 5 lines max from agents |
| Internal verification | Agents fix issues, don't report |

## Example

```
/df:execute

Loading PLAN.md...
Found 5 tasks, 3 ready

Wave 1: T1, T2, T5 in parallel...
  T1: success (abc1234) 45s
  T2: success (def5678) 32s
  T5: success (ghi9012) 28s
Budget: ~32k/100k tokens

Wave 2: T3, T4 unblocked
  T3: success (jkl3456) 67s
  T4: success (mno7890) 41s
Budget: ~52k/100k tokens

✓ Execution complete
Tasks: 5/5 | Commits: 5

Run /df:verify to confirm specs satisfied.
```
