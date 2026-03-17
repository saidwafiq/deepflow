---
name: df:auto-cycle
description: Execute one task from PLAN.md with ratchet health checks and state tracking for autonomous mode
---

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

Shell injection (use output directly — no manual file reads needed):
- `` !`cat PLAN.md 2>/dev/null || echo 'NOT_FOUND'` ``
- `` !`cat .deepflow/auto-memory.yaml 2>/dev/null || echo 'NOT_FOUND'` ``

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
optimize_state:                    # present only when an optimize task is active or was completed
  task_id: "T{n}"
  metric_command: "{shell command}"
  target: {number}
  direction: "higher|lower"
  baseline: null                   # float; set on first measure
  current_best: null               # best metric value seen
  best_commit: null                # short commit hash of best value
  cycles_run: 0
  cycles_without_improvement: 0
  consecutive_reverts: 0           # optimize-specific revert counter (separate from global)
  probe_scale: 0                   # 0=no probes yet, 2/4/6
  max_cycles: {number}
  history: []                      # [{cycle, value, delta_pct, kept: bool, commit}]
  failed_hypotheses: []            # ["{description}"] — written to experiments/ on completion
```

Each section is optional. Missing keys are treated as empty. The file is created on first write if absent.

### 2. PICK NEXT TASK

**Optimize-active override:** Before scanning PLAN.md, check `auto-memory.yaml` for `optimize_state.task_id`. If present and the corresponding task is still `[ ]` in PLAN.md, resume that task immediately — skip the normal `[ ]` scan. This ensures optimize tasks survive context exhaustion and resume across cycles.

```
If optimize_state.task_id exists in auto-memory.yaml:
  → Look up that task_id in PLAN.md
  → If the task is still [ ] → select it (override normal scan)
  → If the task is [x] → clear optimize_state.task_id and fall through to normal scan
```

Otherwise, scan PLAN.md for the first `[ ]` task where all "Blocked by:" dependencies are `[x]`:

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

**On success (ratchet passed — non-optimize task):**

```yaml
# Set task_results[task_id] = success entry
task_results:
  {task_id}: { status: success, commit: {short_hash}, cycle: {cycle_number} }
```

**On revert (ratchet failed — non-optimize task):**

```yaml
# Set task_results[task_id] = reverted entry
task_results:
  {task_id}: { status: reverted, reason: "{ratchet failure summary}", cycle: {cycle_number} }

# Append to revert_history
revert_history:
  - { task: {task_id}, cycle: {cycle_number}, reason: "{ratchet failure summary}" }
```

**On optimize cycle result** (task has `Optimize:` block — execute.md section 5.9 handles the inner cycle; auto-cycle only updates the outer state here):

After each optimize cycle reported by `/df:execute`:

```yaml
# Merge updated optimize_state written by execute into auto-memory.yaml
# execute already persists optimize_state after each cycle (5.9.5) — confirm it was written
# Increment cycles_run tracked at auto-cycle level for report summary
optimize_state:
  cycles_run: {N}                  # echoed from execute's optimize_state
  current_best: {value}
  history: [...]                   # full history from execute's optimize_state
```

Read the current file first (create if missing), merge the new values, and write back. Preserve all existing keys.

### 3.6. CIRCUIT BREAKER

After `/df:execute` returns, check whether the task was reverted (ratchet failed):

**What counts as a failure (increments counter):**

```
- L0 ✗ (build failed)
- L1 ✗ (files missing)
- L2 ✗ (coverage dropped)
- L4 ✗ (tests failed)
- L5 ✗ (browser assertions failed — both attempts)
- L5 ✗ (flaky) (browser assertions failed on both attempts, different assertions)

What does NOT count as a failure:
- L5 — (no frontend): skipped, not a revert trigger
- L5 ⚠ (passed on retry): treated as pass, resets counter
```

**On revert (ratchet failed — any of L0 ✗, L1 ✗, L2 ✗, L4 ✗, L5 ✗, or L5 ✗ flaky — non-optimize task):**

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

**On success (ratchet passed — including L5 — no frontend or L5 ⚠ pass-on-retry — non-optimize task):**

```
1. Reset consecutive_reverts[task_id] to 0 in .deepflow/auto-memory.yaml
```

**Optimize stop conditions** (task has `Optimize:` block — checked after every optimize cycle result from execute):

Execute (section 5.9.3) handles the inner-cycle circuit breaker inside the optimize loop. At the auto-cycle level, watch for these terminal outcomes reported by `/df:execute`:

```
1. "target reached: {value}"
     → Mark task [x] (execute already did this — confirm)
     → Write optimize completion (step 3.7)
     → Report: "Optimize complete: target reached — {value} (target: {target})"
     → Continue to step 4

2. "max cycles reached, best: {current_best}"
     → Mark task [x] (execute already did this — confirm)
     → Write optimize completion (step 3.7)
     → Report: "Optimize complete: max cycles reached — best: {current_best} (target: {target})"
     → Continue to step 4

3. "circuit breaker: 3 consecutive reverts"
     → Task stays [ ] — do NOT mark [x]
     → Write optimize failure to experiments/ (step 3.7)
     → Clear optimize_state.task_id (task stays [ ] for manual intervention)
     → Report: "Circuit breaker tripped (optimize): T{n} halted after 3 consecutive reverts. Resolve manually."
     → Halt (exit without scheduling next cycle)
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

### 3.7. OPTIMIZE COMPLETION

When an optimize task reaches a terminal stop condition (target reached, max cycles, or circuit breaker):

**On target reached or max cycles (task [x]):**

```
1. Read optimize_state.failed_hypotheses from .deepflow/auto-memory.yaml
2. For each failed hypothesis, write to .deepflow/experiments/:
     File: {spec}--optimize-{task_id}--{slug}--failed.md
     Content:
       # Failed Hypothesis: {description}
       Task: {task_id}  Spec: {spec_name}  Cycle: {cycle_N}
       Metric before: {value_before}  Metric after: {value_after}
       Reason: {why it was reverted}
3. Write a summary experiment file for the optimize run:
     File: {spec}--optimize-{task_id}--summary--{status}.md
     Content:
       # Optimize Summary: {task_id}
       Metric: {metric_command}  Target: {target}  Direction: {direction}
       Baseline: {baseline}  Best achieved: {current_best}  Final: {final_value}
       Cycles run: {cycles_run}  Status: {reached|max_cycles}
       History (all cycles):
       | Cycle | Value | Delta | Kept | Commit |
       ...
4. Clear optimize_state from .deepflow/auto-memory.yaml (set to null or remove key)
```

**On circuit breaker halt:**

```
1. Write failed_hypotheses to .deepflow/experiments/ (same as above)
2. Write summary experiment file with status: circuit_breaker
3. Preserve optimize_state in auto-memory.yaml (do NOT clear — enables human diagnosis)
     Add note: "halted: circuit_breaker — requires manual intervention"
```

### 4. UPDATE REPORT

Write a comprehensive report to `.deepflow/auto-report.md` after every cycle. The file is appended each cycle — never overwritten. Each cycle adds its row to the per-cycle log table and updates the running summary counts.

#### 4.1 File structure

The report uses four sections. On the **first cycle** (file does not exist), create the full skeleton. On **subsequent cycles**, update the existing file in-place:

```markdown
# Auto Mode Report — {spec_name}

_Last updated: {YYYY-MM-DDTHH:MM:SSZ}_

## Summary

| Metric | Value |
|--------|-------|
| Total cycles run | {N} |
| Tasks committed | {N} |
| Tasks reverted | {N} |
| Optimize cycles run | {N} |          ← present only when optimize tasks exist in PLAN.md
| Optimize best value | {value} / {target} |  ← present only when optimize tasks exist

## Cycle Log

| Cycle | Task | Status | Commit / Revert | Delta | Metric Delta | Reason | Timestamp |
|-------|------|--------|-----------------|-------|--------------|--------|-----------|
| 1 | T1 | passed | abc1234 | tests: 24→24, build: ok | — | — | 2025-01-15T10:00:00Z |
| 2 | T2 | failed | reverted | tests: 24→22 (−2) | — | tests failed: 2 of 24 | 2025-01-15T10:05:00Z |
| 3 | T3 | optimize | def789 | tests: 24→24, build: ok | 72.3→74.1 (+2.5%) | — | 2025-01-15T10:10:00Z |

## Probe Results

_(empty until a probe/spike task runs)_

| Probe | Metric | Winner | Loser | Notes |
|-------|--------|--------|-------|-------|

## Optimize Runs

_(empty until an optimize task completes)_

| Task | Metric | Baseline | Best | Target | Cycles | Status |
|------|--------|----------|------|--------|--------|--------|

## Secondary Metric Warnings

_(empty until a secondary metric regresses >5%)_

| Cycle | Task | Secondary Metric | Before | After | Delta | Severity |
|-------|------|-----------------|--------|-------|-------|----------|

## Health Score

| Check | Status |
|-------|--------|
| Tests passed | {N} / {total} |
| Build status | passing / failing |
| Ratchet | green / red |
| Optimize status | in_progress / reached / max_cycles / circuit_breaker / — |  ← present only when optimize tasks exist

## Reverted Tasks

_(tasks that were reverted with their failure reasons)_

| Task | Cycle | Reason |
|------|-------|--------|
```

#### 4.2 Per-cycle update rules

**Cycle Log — append one row:**

```
| {cycle_number} | {task_id} | {status} | {commit_hash or "reverted"} | {delta} | {metric_delta} | {reason or "—"} | {YYYY-MM-DDTHH:MM:SSZ} |
```

- `cycle_number`: total number of cycles executed so far (count existing data rows in the Cycle Log + 1)
- `task_id`: task ID from PLAN.md, or `BOOTSTRAP` for bootstrap cycles
- `status`: `passed` (ratchet passed), `failed` (ratchet failed, reverted), `skipped` (task was already done), or `optimize` (optimize cycle — one inner cycle of an Optimize task)
- `commit_hash`: short hash from the commit, or `reverted` if ratchet failed
- `delta`: ratchet metric change from this cycle. Format: `tests: {before}→{after}, build: ok/fail`. Include coverage delta if available (e.g., `cov: 80%→82% (+2%)`). On revert, show the regression that triggered it (e.g., `tests: 24→22 (−2)`)
- `metric_delta`: for optimize cycles, show `{old}→{new} ({+/-pct}%)`. For non-optimize cycles, use `—`.
- `reason`: failure reason from ratchet output (e.g., `"tests failed: 2 of 24"`), or `—` if passed

**Summary table — recalculate from Cycle Log rows:**

- `Total cycles run`: count of all data rows in the Cycle Log
- `Tasks committed`: count of rows where Status = `passed`
- `Tasks reverted`: count of rows where Status = `failed`
- `Optimize cycles run`: count of rows where Status = `optimize` (omit row if no optimize tasks in PLAN.md)
- `Optimize best value`: `{current_best} / {target}` from `optimize_state` in auto-memory.yaml (omit row if no optimize tasks)

**Last updated timestamp:** always overwrite the `_Last updated:` line with the current timestamp.

**Optimize Runs table — update on optimize terminal events:**

When an optimize stop condition is reached (target reached, max cycles, circuit breaker), append or update the row for the optimize task:

```
| {task_id} | {metric_command} | {baseline} | {current_best} | {target} | {cycles_run} | {reached|max_cycles|circuit_breaker} |
```

If the task is still in progress, do not add a row yet (it will be added when the terminal event fires).

**Secondary Metric Warnings table — append on regression >5%:**

After each optimize cycle, `/df:execute` section 5.9.2 step j measures secondary metrics. If a regression exceeds the threshold, auto-cycle reads the warning from execute's output and appends to the table:

```
| {cycle_number} | {task_id} | {secondary_metric_command} | {before} | {after} | {+/-pct}% | WARNING |
```

The severity is always `WARNING` (no auto-revert — human decision required). These rows are informational only.

#### 4.3 Probe results (when applicable)

If the executed task was a probe/spike (task description contains "probe" or "spike"), append a row to the Probe Results table:

```
| {probe_name} | {metric description} | {winner approach} | {loser approach} | {key insight from probe_learnings in auto-memory.yaml} |
```

Read `probe_learnings` from `.deepflow/auto-memory.yaml` for the insight text.

If no probe has run yet, leave the `_(empty until a probe/spike task runs)_` placeholder in place.

#### 4.4 Health score (after every cycle)

Read the ratchet output from the last `/df:execute` result and populate:

- `Tests passed`: e.g., `22 / 24` (from ratchet summary line)
- `Build status`: `passing` if exit code 0, `failing` if build error
- `Ratchet`: `green` if ratchet passed, `red` if ratchet failed
- `Optimize status`: read from `optimize_state` in auto-memory.yaml:
  - `in_progress` if `optimize_state.task_id` present and task still `[ ]`
  - `reached` if stop condition was "target reached"
  - `max_cycles` if stop condition was "max cycles"
  - `circuit_breaker` if halted by circuit breaker
  - `—` if no optimize task is active or was ever run
  - Omit this row entirely if PLAN.md contains no `[OPTIMIZE]` tasks

Replace the entire Health Score section content with the latest values each cycle.

#### 4.5 Reverted tasks section

After every revert, append a row to the Reverted Tasks table:

```
| {task_id} | {cycle_number} | {failure reason} |
```

Read from `revert_history` in `.deepflow/auto-memory.yaml` to ensure no entry is missed. If no tasks have been reverted, leave the `_(tasks that were reverted...)_` placeholder in place.

### 5. CHECK COMPLETION

**Count tasks in PLAN.md:**
```
done_count   = number of [x] tasks
pending_count = number of [ ] tasks
```

**Note:** Per-spec verification and merge to main happens automatically in `/df:execute` (step 8) when all tasks for a spec complete. No separate verify call is needed here.

**If no `[ ]` tasks remain (pending_count == 0):**
```
→ Report: "All specs verified and merged. Workflow complete."
→ Exit
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
| One optimize task at a time | Only one `[OPTIMIZE]` task runs at a time — auto-cycle defers other optimize tasks until the active one reaches a terminal stop condition |
| Optimize tasks resume across context windows | `optimize_state.task_id` in `auto-memory.yaml` overrides the normal `[ ]` scan; the same task is picked every cycle until a stop condition fires |
| Optimize circuit breaker halts AND preserves state | When optimize hits 3 consecutive reverts: task stays `[ ]`, `optimize_state` is preserved in `auto-memory.yaml` (not cleared), loop halts |
| Secondary metric regression is advisory only | >5% regression generates WARNING in `auto-report.md` Secondary Metric Warnings table — never triggers auto-revert |
| Optimize completion writes experiments | Failed hypotheses and run summary are written to `.deepflow/experiments/` when a terminal stop condition fires |

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

Updated .deepflow/auto-report.md:
  Summary: cycles=1, committed=1, reverted=0
  Cycle Log row: | 1 | BOOTSTRAP | passed | boo1234 | — | 2025-01-15T10:00:00Z |
  Health: tests 10/10, build passing, ratchet green

Cycle complete. 3 tasks remaining.
```

### Normal Cycle (task executed)

```
/df:auto-cycle

Loading PLAN.md... 3 tasks total, 1 done, 2 pending
Next ready task: T2 (T1 dependency satisfied)

Running: /df:execute T2
  ✓ T2: ratchet passed (abc1234)

Updated .deepflow/auto-report.md:
  Summary: cycles=2, committed=2, reverted=0
  Cycle Log row: | 2 | T2 | passed | abc1234 | — | 2025-01-15T10:05:00Z |
  Health: tests 22/22, build passing, ratchet green

Cycle complete. 1 tasks remaining.
```

### All Tasks Done (workflow complete)

```
/df:auto-cycle

Loading PLAN.md... 0 tasks total, 0 done, 0 pending

All specs verified and merged. Workflow complete.
```

### No Work Remaining (idempotent)

```
/df:auto-cycle

Loading PLAN.md... 0 tasks total, 0 done, 0 pending

All specs verified and merged. Workflow complete.
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

### Optimize Cycle (in progress — task resumes from optimize_state)

```
/df:auto-cycle

Loading PLAN.md... 4 tasks total, 2 done, 2 pending
Loading auto-memory.yaml... optimize_state.task_id = T3

Optimize-active override: T3 still [ ] — resuming optimize task
  optimize_state: cycles_run=4, current_best=74.1, target=85.0, direction=higher

Running: /df:execute T3
  ⟳ T3 cycle 5: 74.1 → 75.8 (+2.3%) — kept [best: 75.8, target: 85.0]

Updated .deepflow/auto-memory.yaml:
  optimize_state.cycles_run = 5
  optimize_state.current_best = 75.8

Updated .deepflow/auto-report.md:
  Summary: cycles=5, committed=2, reverted=0, optimize_cycles=5, optimize_best=75.8/85.0
  Cycle Log row: | 5 | T3 | optimize | abc1234 | tests: 24→24, build: ok | 74.1→75.8 (+2.3%) | — | 2025-01-15T10:15:00Z |
  Health: tests 24/24, build passing, ratchet green, optimize in_progress

Cycle complete. 2 tasks remaining.
```

### Optimize Complete (target reached)

```
/df:auto-cycle

Loading PLAN.md... 4 tasks total, 2 done, 2 pending
Loading auto-memory.yaml... optimize_state.task_id = T3

Optimize-active override: T3 still [ ] — resuming optimize task
  optimize_state: cycles_run=12, current_best=84.9, target=85.0, direction=higher

Running: /df:execute T3
  ⟳ T3 cycle 13: 84.9 → 85.3 (+0.5%) — kept [best: 85.3, target: 85.0]
  Target reached: 85.3 >= 85.0 — marking T3 [x]

Optimize completion:
  Writing 3 failed hypotheses to .deepflow/experiments/
  Writing summary: specs--optimize-T3--summary--reached.md
  Clearing optimize_state from auto-memory.yaml

Updated .deepflow/auto-report.md:
  Summary: cycles=13, committed=3, reverted=0, optimize_cycles=13, optimize_best=85.3/85.0
  Cycle Log row: | 13 | T3 | optimize | def456 | tests: 24→24, build: ok | 84.9→85.3 (+0.5%) | — | 2025-01-15T10:45:00Z |
  Optimize Runs row: | T3 | coverage_cmd | 72.3 | 85.3 | 85.0 | 13 | reached |
  Health: tests 24/24, build passing, ratchet green, optimize reached

Cycle complete. 1 tasks remaining.
```

### Optimize Secondary Metric Warning

```
/df:auto-cycle

Running: /df:execute T3
  ⟳ T3 cycle 8: 80.1 → 81.4 (+1.6%) — kept [best: 81.4, target: 85.0]
  WARNING: secondary metric 'lint_errors' regressed: 2 → 5 (+150%) — exceeds 5% threshold

Updated .deepflow/auto-report.md:
  Secondary Metric Warnings row: | 8 | T3 | lint_errors | 2 | 5 | +150% | WARNING |
  (No auto-revert — human decision required)

Cycle complete. 2 tasks remaining.
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
