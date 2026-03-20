---
name: auto-cycle
description: Execute one task from PLAN.md with ratchet health checks and state tracking for autonomous mode
---

# auto-cycle — Single Cycle of Auto Mode

Execute one task from PLAN.md. Called by `/loop 1m /df:auto-cycle` — each invocation gets fresh context.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Behavior

### 1. LOAD STATE

Shell injection (use output directly):
- `` !`cat PLAN.md 2>/dev/null || echo 'NOT_FOUND'` `` — required, error if missing
- `` !`cat .deepflow/auto-memory.yaml 2>/dev/null || echo 'NOT_FOUND'` `` — optional cross-cycle state

**auto-memory.yaml schema:** see `/df:execute`. Each section optional, missing keys = empty. Created on first write if absent.

### 2. PICK NEXT TASK

**Optimize-active override:** Check `optimize_state.task_id` in auto-memory.yaml first. If present and task still `[ ]` in PLAN.md, resume it (skip normal scan). If task is `[x]`, clear `optimize_state.task_id` and fall through.

**Normal scan:** First `[ ]` task in PLAN.md where all `Blocked by:` deps are `[x]`.

**No `[ ]` tasks:** Skip to step 5 (completion check).

**All remaining blocked:** Error with blocker details, suggest `/df:execute` for manual resolution.

### 3. EXECUTE

Run via Skill tool: `skill: "df:execute", args: "{task_id}"`. Handles worktree, agent spawning, ratchet, commit.

**Bootstrap handling:** If execute returns `"bootstrap: completed"` (zero pre-existing tests, baseline written):
- Record as task `BOOTSTRAP`, status `passed`
- Do NOT run a regular task in the same cycle
- Next cycle picks up the first regular task

### 3.5. WRITE STATE

After execute returns, update `.deepflow/auto-memory.yaml` (read-merge-write, preserve all keys):

| Outcome | Write |
|---------|-------|
| Success (non-optimize) | `task_results[id]: {status: success, commit: {hash}, cycle: {N}}` |
| Revert (non-optimize) | `task_results[id]: {status: reverted, reason: "{msg}", cycle: {N}}` + append to `revert_history` |
| Optimize cycle | Merge updated `optimize_state` from execute (confirm `cycles_run`, `current_best`, `history`) |

### 3.6. CIRCUIT BREAKER

**Failure = any L0-L5 verification failure** (build, files, coverage, tests, browser assertions). Does NOT count: L5 skip (no frontend), L5 pass-on-retry.

**On revert (non-optimize):**
1. Increment `consecutive_reverts[task_id]` in auto-memory.yaml
2. Read `circuit_breaker_threshold` from `.deepflow/config.yaml` (default: 3)
3. If `consecutive_reverts[task_id] >= threshold`: halt loop, report "Circuit breaker tripped: T{n} failed {N} times. Reason: {msg}"
4. Else: continue to step 4

**On success (non-optimize):** Reset `consecutive_reverts[task_id]` to 0.

**Optimize stop conditions** (from execute terminal outcomes):

| Outcome | Action |
|---------|--------|
| `"target reached: {value}"` | Confirm task [x], write optimize completion (3.7), report, continue |
| `"max cycles reached, best: {value}"` | Confirm task [x], write optimize completion (3.7), report, continue |
| `"circuit breaker: 3 consecutive reverts"` | Task stays [ ], write failure to experiments (3.7), preserve optimize_state, halt loop |

### 3.7. OPTIMIZE COMPLETION

**On target reached or max cycles (task [x]):**
1. Write each `failed_hypotheses` entry to `.deepflow/experiments/{spec}--optimize-{task_id}--{slug}--failed.md`
2. Write summary to `.deepflow/experiments/{spec}--optimize-{task_id}--summary--{status}.md` with metric/target/direction/baseline/best/cycles/history table
3. Clear `optimize_state` from auto-memory.yaml

**On circuit breaker halt:** Same experiment writes but with status `circuit_breaker`. Preserve `optimize_state` in auto-memory.yaml (add `halted: circuit_breaker` note).

### 4. UPDATE REPORT

Write to `.deepflow/auto-report.md` — append each cycle, never overwrite. First cycle creates skeleton, subsequent cycles update in-place.

**File sections:** Summary table, Cycle Log, Probe Results, Optimize Runs, Secondary Metric Warnings, Health Score, Reverted Tasks.

#### Per-cycle update rules

| Section | When | Action |
|---------|------|--------|
| Cycle Log | Every cycle | Append row: `cycle | task_id | status | commit/reverted | delta | metric_delta | reason | timestamp` |
| Summary | Every cycle | Recalculate from Cycle Log: total cycles, committed, reverted, optimize cycles/best (if applicable) |
| Last updated | Every cycle | Overwrite timestamp |
| Probe Results | Probe/spike task | Append row from `probe_learnings` in auto-memory.yaml |
| Optimize Runs | Optimize terminal event | Append row: task/metric/baseline/best/target/cycles/status |
| Secondary Metric Warnings | >5% regression | Append row (severity: WARNING, advisory only — no auto-revert) |
| Health Score | Every cycle | Replace with latest: tests passed, build status, ratchet green/red, optimize status |
| Reverted Tasks | On revert | Append row from `revert_history` |

**Status values:** `passed`, `failed` (reverted), `skipped` (already done), `optimize` (inner cycle).

**Delta format:** `tests: {before}→{after}, build: ok/fail`. Include coverage if available. On revert, show regression.

**Optimize status in Health Score:** `in_progress` | `reached` | `max_cycles` | `circuit_breaker` | `—` (omit row if no optimize tasks in PLAN.md).

### 5. CHECK COMPLETION

Count `[x]` and `[ ]` tasks in PLAN.md. Per-spec verify+merge happens in `/df:execute` step 8 automatically.

- **No `[ ]` remaining:** "All specs verified and merged. Workflow complete." → exit
- **Tasks remain:** "Cycle complete. {N} tasks remaining." → exit (next /loop invocation picks up)

## Rules

| Rule | Detail |
|------|--------|
| One task per cycle | Fresh context each invocation — no multi-task batching |
| Bootstrap = sole task | No regular task runs in a bootstrap cycle |
| Idempotent | Safe to call with no work — reports "0 tasks remaining" |
| Never modifies PLAN.md | `/df:execute` handles PLAN.md updates |
| Auto-memory after every cycle | `task_results`, `revert_history`, `consecutive_reverts` always written |
| Circuit breaker halts loop | Default 3 consecutive reverts (configurable: `circuit_breaker_threshold` in config.yaml) |
| One optimize at a time | Defers other optimize tasks until active one terminates |
| Optimize resumes across contexts | `optimize_state.task_id` overrides normal scan |
| Optimize CB preserves state | On halt: task stays [ ], optimize_state kept for diagnosis |
| Secondary metric regression advisory | >5% = WARNING in report, never auto-revert |
| Optimize completion writes experiments | Failed hypotheses + summary to `.deepflow/experiments/` |

## Example

### Normal Cycle
```
/df:auto-cycle
Loading PLAN.md... 3 tasks, 1 done, 2 pending
Next: T2 (T1 satisfied)
Running: /df:execute T2 → ✓ ratchet passed (abc1234)
Updated auto-report.md: cycles=2, committed=2
Cycle complete. 1 tasks remaining.
```

### Circuit Breaker Tripped
```
/df:auto-cycle
Loading PLAN.md... 3 tasks, 1 done, 2 pending
Next: T3
Running: /df:execute T3 → ✗ ratchet failed — "2 tests regressed"
Circuit breaker: consecutive_reverts[T3] = 3 (threshold: 3)
Loop halted. Resolve T3 manually, then resume.
```
