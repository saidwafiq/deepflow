# /df:auto-cycle — Single Cycle of Auto Mode

## Purpose
Execute one task from PLAN.md. Designed to be called by `/loop 1m /df:auto-cycle` — each invocation gets fresh context.

**NEVER:** use EnterPlanMode, use ExitPlanMode

---

## Usage
```
/df:auto-cycle    # Pick next undone task and execute it (or verify if all done)
```

## Behavior

### 1. LOAD STATE

```
Load: PLAN.md (required)
  → If missing: Error "No PLAN.md. Run /df:plan first."
Load: .deepflow/auto-memory.yaml (optional — cross-cycle state, ignore if missing)
```

**auto-memory.yaml full schema:**

```yaml
task_results:
  T1: { status: success, commit: abc1234, cycle: 3 }
  T2: { status: reverted, reason: "tests failed: 2 of 24", cycle: 4 }
revert_history:
  - { task: T2, cycle: 4, reason: "tests failed" }
  - { task: T2, cycle: 5, reason: "build error" }
consecutive_reverts:   # written by circuit breaker (step 3.5)
  T1: 0
  T2: 2
probe_learnings:
  - { spike: T1, probe: "streaming", insight: "discovered hidden dependency on fs.watch" }
```

Each section is optional. Missing keys are treated as empty. The file is created on first write if absent.

### 2. PICK NEXT TASK

Scan PLAN.md for the first `[ ]` task where all "Blocked by:" dependencies are `[x]`:

```
For each [ ] task in PLAN.md (top to bottom):
  → Parse "Blocked by:" line (if present)
  → Check each listed dependency in PLAN.md
  → If ALL listed blockers are [x] (or no blockers) → this task is READY
  → Select first READY task
```

**No tasks remaining (`[ ]` not found):** → skip to step 5 (completion check).

**All remaining tasks blocked:** → Error with blocker info:
```
Error: All remaining tasks are blocked.
  [ ] T3 — blocked by: T2 (incomplete)
  [ ] T4 — blocked by: T2 (incomplete)

Run /df:execute to investigate or resolve blockers manually.
```

### 3. EXECUTE

Run the selected task using the Skill tool:

```
Skill: "df:execute"
Args: "{task_id}"   (e.g., "T3")
```

This handles worktree creation, agent spawning, ratchet health checks, and commit.

**Bootstrap handling:** `/df:execute` may report `"bootstrap: completed"` instead of a regular task result. This means the ratchet snapshot was empty (zero test files) and the cycle was used to write baseline tests. When this happens:

- Do NOT treat it as a task failure or skip
- Record the bootstrap in the report (step 4) using task ID `BOOTSTRAP` and status `passed`
- Exit normally — the NEXT cycle will pick up the first regular task (now protected by the bootstrapped tests)
- Do NOT attempt to execute a regular task in the same cycle as a bootstrap

### 3.5. WRITE STATE

After `/df:execute` returns, record the task result in `.deepflow/auto-memory.yaml`:

**On success (ratchet passed):**

```yaml
# Set task_results[task_id] = success entry
task_results:
  {task_id}: { status: success, commit: {short_hash}, cycle: {cycle_number} }
```

**On revert (ratchet failed):**

```yaml
# Set task_results[task_id] = reverted entry
task_results:
  {task_id}: { status: reverted, reason: "{ratchet failure summary}", cycle: {cycle_number} }

# Append to revert_history
revert_history:
  - { task: {task_id}, cycle: {cycle_number}, reason: "{ratchet failure summary}" }
```

Read the current file first (create if missing), merge the new values, and write back. Preserve all existing keys.

### 3.6. CIRCUIT BREAKER

After `/df:execute` returns, check whether the task was reverted (ratchet failed):

**On revert (ratchet failed):**

```
1. Read .deepflow/auto-memory.yaml (create if missing)
2. Increment consecutive_reverts[task_id] by 1
3. Write updated value back to .deepflow/auto-memory.yaml
4. Read circuit_breaker_threshold from .deepflow/config.yaml (default: 3 if key absent)
5. If consecutive_reverts[task_id] >= threshold:
     → Do NOT start /loop again
     → Report: "Circuit breaker tripped: T{n} failed {N} consecutive times. Reason: {last ratchet failure}"
     → Halt (exit without scheduling next cycle)
   Else:
     → Continue to step 4 (UPDATE REPORT) as normal
```

**On success (ratchet passed):**

```
1. Reset consecutive_reverts[task_id] to 0 in .deepflow/auto-memory.yaml
```

**auto-memory.yaml schema for the circuit breaker:**

```yaml
consecutive_reverts:
  T1: 0
  T3: 2
```

**config.yaml key:**

```yaml
circuit_breaker_threshold: 3   # halt after this many consecutive reverts on the same task
```

### 4. UPDATE REPORT

Append the cycle result to `.deepflow/auto-report.md`.

**Create file if missing** with header:
```markdown
# Auto Mode Report

| Cycle | Task | Status | Commit / Note | Timestamp |
|-------|------|--------|---------------|-----------|
```

**Append row:**
```
| {cycle_number} | {task_id} | {passed|failed|skipped} | {commit_hash or revert note} | {YYYY-MM-DDTHH:MM:SSZ} |
```

- `cycle_number`: count of existing rows + 1
- `status`: `passed` (ratchet passed), `failed` (ratchet failed, reverted), or `skipped` (task was already done)
- `commit_hash`: short hash from the commit, or `reverted` if ratchet failed

### 5. CHECK COMPLETION

**Count tasks in PLAN.md:**
```
done_count   = number of [x] tasks
pending_count = number of [ ] tasks
```

**If ALL tasks are `[x]` (pending_count == 0):**
```
→ Run /df:verify via Skill tool (skill: "df:verify", no args)
→ Report: "All tasks complete. Verification triggered."
```

**If tasks remain (pending_count > 0):**
```
→ Report: "Cycle complete. {pending_count} tasks remaining."
→ Exit — next /loop invocation will pick up
```

## Rules

| Rule | Detail |
|------|--------|
| One task per cycle | Fresh context each invocation — no multi-task batching |
| Bootstrap counts as the cycle's sole task | When `/df:execute` returns `bootstrap: completed`, no regular task runs that cycle |
| Idempotent | Safe to call with no work remaining — just reports "0 tasks remaining" |
| Never modifies PLAN.md directly | `/df:execute` handles PLAN.md updates and commits |
| Zero coordination overhead | Read plan → pick task → execute → update report → exit |
| Auto-memory updated after every cycle | `task_results`, `revert_history`, and `consecutive_reverts` in `.deepflow/auto-memory.yaml` are written after each EXECUTE result |
| Cross-cycle state read at cycle start | LOAD STATE reads the full `auto-memory.yaml` schema; prior task outcomes and probe learnings are available to the cycle |
| Circuit breaker halts the loop | After N consecutive reverts on the same task (default 3, configurable via `circuit_breaker_threshold` in `.deepflow/config.yaml`), the loop is stopped and the reason is reported |

## Example

### Bootstrap Cycle (no pre-existing tests)

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 0 done, 3 pending
Next ready task: T1 (no blockers)

Running: /df:execute T1
  Ratchet snapshot: 0 pre-existing test files
  Bootstrap needed — writing tests for edit_scope first
  ✓ Bootstrap: ratchet passed (boo1234)
  bootstrap: completed

Updated .deepflow/auto-report.md: cycle 1 | BOOTSTRAP | passed | boo1234

Cycle complete. 3 tasks remaining.
```

### Normal Cycle (task executed)

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 1 done, 2 pending
Next ready task: T2 (T1 dependency satisfied)

Running: /df:execute T2
  ✓ T2: ratchet passed (abc1234)

Updated .deepflow/auto-report.md: cycle 2 | T2 | passed | abc1234

Cycle complete. 1 tasks remaining.
```

### All Tasks Done (verify triggered)

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 3 done, 0 pending

All tasks complete. Verification triggered.
Running: /df:verify
  ✓ L0 | ✓ L1 | ⚠ L2 (no coverage tool) | ✓ L4
  ✓ Merged df/upload to main
```

### No Work Remaining (idempotent)

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 3 done, 0 pending
Verification already complete (no doing-* specs found).

Nothing to do. Cycle complete. 0 tasks remaining.
```

### Circuit Breaker Tripped

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 1 done, 2 pending
Next ready task: T3 (no blockers)

Running: /df:execute T3
  ✗ T3: ratchet failed — "2 tests regressed"
  Reverted changes.

Circuit breaker: consecutive_reverts[T3] = 3 (threshold: 3)
Circuit breaker tripped: T3 failed 3 consecutive times. Reason: 2 tests regressed

Loop halted. Resolve T3 manually, then run /df:auto-cycle to resume.
```

### All Tasks Blocked

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 1 done, 2 pending

Error: All remaining tasks are blocked.
  [ ] T3 — blocked by: T2 (incomplete)
  [ ] T4 — blocked by: T2 (incomplete)

Run /df:execute to investigate or resolve blockers manually.
```
