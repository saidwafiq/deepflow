---
name: df:execute
description: Execute tasks from PLAN.md with agent spawning, ratchet health checks, and worktree management
---

# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You are a coordinator. Spawn agents, run ratchet checks, update PLAN.md. Never implement code yourself.

**NEVER:** Read source files, edit code, use TaskOutput, use EnterPlanMode, use ExitPlanMode
**ONLY:** Read PLAN.md, read specs/doing-*.md, spawn background agents, run ratchet health checks, update PLAN.md, write `.deepflow/decisions.md`

## Core Loop (Notification-Driven)

Each task = one background agent. **NEVER use TaskOutput** (100KB+ transcripts explode context).

```
1. Spawn ALL wave agents with run_in_background=true in ONE message
2. STOP. End turn. Do NOT poll.
3. On EACH notification:
   a. Ratchet check (§5.5)
   b. Passed → TaskUpdate(status: "completed"), update PLAN.md [x] + commit hash
   c. Failed → partial salvage (§5.5). Salvaged → passed. Not → git revert, TaskUpdate(status: "pending")
   d. Report ONE line: "✓ T1: ratchet passed (abc123)" or "⚕ T1: salvaged (abc124)" or "✗ T1: reverted"
   e. NOT all done → end turn, wait | ALL done → next wave or finish
4. Between waves: context ≥50% → checkpoint and exit.
5. Repeat until: all done, all blocked, or context ≥50%.
```

**Context threshold:** Statusline writes `.deepflow/context.json`: `{"percentage": 45}`. <50% = full parallelism (up to 5). ≥50% = wait, checkpoint, exit.

---

## Behavior

### 1. CHECK CHECKPOINT

`--continue` → load `.deepflow/checkpoint.json`, verify worktree exists (else error "Use --fresh"), skip completed. `--fresh` → delete checkpoint. Checkpoint exists → prompt "Resume? (y/n)".
Shell: `` !`cat .deepflow/checkpoint.json 2>/dev/null || echo 'NOT_FOUND'` `` / `` !`git diff --quiet && echo 'CLEAN' || echo 'DIRTY'` ``

### 1.5. CREATE WORKTREE

Require clean HEAD. Derive SPEC_NAME from `specs/doing-*.md`. Create `.deepflow/worktrees/{spec}` on branch `df/{spec}`. Reuse if exists; `--fresh` deletes first. If `worktree.sparse_paths` non-empty: `git worktree add --no-checkout`, `sparse-checkout set {paths}`, checkout.

### 1.6. RATCHET SNAPSHOT

Snapshot pre-existing test files — only these count for ratchet (agent-created excluded):
```bash
git -C ${WORKTREE_PATH} ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' > .deepflow/auto-snapshot.txt
```

### 1.7. NO-TESTS BOOTSTRAP

Zero test files → spawn ONE bootstrap agent (§6 Bootstrap). Pass → re-snapshot, end cycle. Fail → revert, halt "Bootstrap failed — manual intervention required". Subsequent cycles use bootstrapped tests as baseline.

### 2. LOAD PLAN

Load PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml. Missing → "No PLAN.md found. Run /df:plan first."

### 2.5. REGISTER NATIVE TASKS

For each `[ ]` task: `TaskCreate(subject: "{task_id}: {description}", activeForm: "{gerund}", description: full block)`. Store task_id → native ID. Set deps via `TaskUpdate(addBlockedBy: [...])`. `--continue` → only remaining `[ ]` items.

### 3–4. READY TASKS

Warn if unplanned `specs/*.md` (excluding doing-/done-) exist (non-blocking). Ready = TaskList where status: "pending" AND blockedBy: empty.

### 5. SPAWN AGENTS

Context ≥50% → checkpoint and exit. Before spawning: `TaskUpdate(status: "in_progress")`.

**Token tracking start:** Store `start_percentage` (from context.json) and `start_timestamp` (ISO 8601) keyed by task_id. Omit if unavailable.

**NEVER use `isolation: "worktree"`.** Deepflow manages a shared worktree so wave 2 sees wave 1 commits. **Spawn ALL ready tasks in ONE message** except file conflicts.

**File conflicts (1 file = 1 writer):** Check `Files:` lists. Overlap → spawn lowest-numbered only; rest stay pending. Log: `"⏳ T{N} deferred — file conflict with T{M} on {filename}"`

**≥2 [SPIKE] tasks same problem →** Parallel Spike Probes (§5.7). **[OPTIMIZE] tasks →** Optimize Cycle (§5.9), one at a time.

### 5.5. RATCHET CHECK

Run health checks in worktree after each agent completes.

| File | Build | Test | Typecheck | Lint |
|------|-------|------|-----------|------|
| `package.json` | `npm run build` | `npm test` | `npx tsc --noEmit` | `npm run lint` |
| `pyproject.toml` | — | `pytest` | `mypy .` | `ruff check .` |
| `Cargo.toml` | `cargo build` | `cargo test` | — | `cargo clippy` |
| `go.mod` | `go build ./...` | `go test ./...` | — | `go vet ./...` |

Run Build → Test → Typecheck → Lint (stop on first failure). Ratchet uses ONLY pre-existing tests from `.deepflow/auto-snapshot.txt`.

**Edit scope validation:** `git diff HEAD~1 --name-only` vs allowed globs. Violation → revert, report.
**Impact completeness:** diff vs Impact callers/duplicates. Gap → advisory warning (no revert).

**Metric gate (Optimize only):** Run `eval "${metric_command}"` with cwd=`${WORKTREE_PATH}` (never `cd && eval`). Parse float (non-numeric → revert). Compare using `direction`+`min_improvement_threshold`. Both ratchet AND metric must pass → keep. Ratchet pass + metric stagnant → revert. Secondary metrics: regression > `regression_threshold` (5%) → WARNING in auto-report.md (no revert).

**Output truncation:** Success → suppress. Build fail → last 15 lines. Test fail → names + last 20 lines. Typecheck/lint → count + first 5 errors.

**Token tracking result (on pass):** Read `end_percentage`. Sum token fields from `.deepflow/token-history.jsonl` between start/end timestamps (awk ISO 8601 compare). Write to `.deepflow/results/T{N}.yaml`:
```yaml
tokens:
  start_percentage: {val}
  end_percentage: {val}
  delta_percentage: {end - start}
  input_tokens: {sum}
  cache_creation_input_tokens: {sum}
  cache_read_input_tokens: {sum}
```
Omit if context.json/token-history.jsonl/awk unavailable. Never fail ratchet for tracking errors.

**Evaluate:** All pass → commit stands. Failure → partial salvage:
1. Lint/typecheck-only (build+tests passed): spawn `Agent(model="haiku")` to fix. Re-ratchet. Fail → revert both.
2. Build/test failure → `git revert HEAD --no-edit` (no salvage).

### 5.7. PARALLEL SPIKE PROBES

Trigger: ≥2 [SPIKE] tasks with same blocker or identical hypothesis.

1. `BASELINE=$(git rev-parse HEAD)` in shared worktree
2. Sub-worktrees per spike: `git worktree add -b df/{spec}--probe-{ID} .deepflow/worktrees/{spec}/probe-{ID} ${BASELINE}`
3. Spawn all probes in ONE message. End turn.
4. Per notification: ratchet (§5.5). Record: ratchet_passed, regressions, coverage_delta, files_changed, commit.
5. **Winner selection** (no LLM judge): disqualify regressions. Standard: fewer regressions > coverage > fewer files > first complete. Optimize: best metric delta > fewer regressions > fewer files. No passes → reset pending for debugger.
6. Preserve all worktrees. Losers: branch + `-failed`. Record in checkpoint.json.
7. Log all outcomes to `.deepflow/auto-memory.yaml` under `spike_insights`+`probe_learnings` (schema in auto-cycle.md). Both winners and losers.
8. Cherry-pick winner into shared worktree. Winner → `[x] [PROBE_WINNER]`, losers → `[~] [PROBE_FAILED]`.

#### 5.7.1. PROBE DIVERSITY (Optimize Probes)

Roles: **contextualizada** (refine best), **contraditoria** (opposite of best), **ingenua** (fresh, no context).

| Round | Count | Roles |
|-------|-------|-------|
| 1st plateau | 2 | 1 contraditoria + 1 ingenua |
| 2nd plateau | 4 | 1 contextualizada + 2 contraditoria + 1 ingenua |
| 3rd+ | 6 | 2 contextualizada + 2 contraditoria + 2 ingenua |

Every set: ≥1 contraditoria + ≥1 ingenua. contextualizada from round 2+ only. Scale persists in `optimize_state.probe_scale`.

### 5.9. OPTIMIZE CYCLE

Trigger: task has `Optimize:` block. One at a time, N cycles until stop condition.

**Init:** Parse metric/target/direction/max_cycles/secondary_metrics. Load or init `optimize_state` in auto-memory.yaml (fields: task_id, metric_command, target, direction, baseline, current_best, best_commit, cycles_run, cycles_without_improvement, consecutive_reverts, probe_scale, max_cycles, history[], failed_hypotheses[]). Measure baseline (`eval` with cwd=worktree) → store as baseline+current_best. Measure secondaries. Target met → mark `[x]`, done.

**Cycle loop:**
```
REPEAT:
  1. Check stop conditions → if triggered, exit
  2. Spawn ONE optimize agent (§6) run_in_background=true. STOP, end turn.
  3. On notification:
     a. Ratchet fail → revert, ++consecutive_reverts, log hypothesis, goto 1
     b. Metric parse error → revert, ++consecutive_reverts
     c. improvement = (new - best) / |best| × 100 (flip for lower; absolute if best==0)
     d. >= 1% threshold → KEEP, update best, reset counters
     e. < threshold → REVERT, ++cycles_without_improvement
     f. ++cycles_run, append history, check secondaries, persist state
     g. Report: "⟳ T{n} cycle {N}: {old}→{new} ({delta}%) — {kept|reverted} [best: X, target: Y]"
     h. Context ≥50% → checkpoint, exit
```

**Stop conditions:**

| Condition | Action |
|-----------|--------|
| Target reached | Mark `[x]` |
| cycles_run >= max_cycles | Mark `[x]`. If best < baseline → `git reset --hard {best_commit}` |
| 3 cycles without improvement | Launch probes (plateau) |
| 3 consecutive reverts | Halt, task `[ ]`, requires human intervention |

**Plateau → probes:** Scale 0→2, 2→4, 4→6 per §5.7.1. Create sub-worktrees, spawn all with diversity roles (§6 Optimize Probe). Per notification: ratchet + metric. Winner → cherry-pick, update best, reset counters. Losers → `-failed`. Log outcomes. Resume cycle.

**State persistence:** Write `optimize_state` to auto-memory.yaml after every cycle. Append results table to `.deepflow/auto-report.md`.

---

### 6. PER-TASK (agent prompt)

**Common preamble (all):** `Working directory: {worktree_absolute_path}. All file ops use this path. Commit format: {type}({spec}): {desc}`

**Standard Task** (`Agent(model="{Model}", ...)`):
```
--- START ---
{task_id}: {description}  Files: {files}  Spec: {spec}
{If reverted: DO NOT repeat: - Cycle {N}: "{reason}"}
Success criteria: {ACs from spec relevant to this task}
--- MIDDLE (omit for low effort; omit deps for medium) ---
Impact: Callers: {file} ({why}) | Duplicates: [active→consolidate] [dead→DELETE] | Data flow: {consumers}
Prior tasks: {dep_id}: {summary}
Steps: 1. chub search/get for APIs 2. LSP findReferences, add unlisted callers 3. Read all Impact files 4. Implement 5. Commit
--- END ---
Spike results: {winner learnings}
Duplicates: [active]→consolidate [dead]→DELETE. ONLY job: code+commit. No merge/rename/checkout.
```

**Bootstrap:** `BOOTSTRAP: Write tests for edit_scope files. Do NOT change implementation. Commit as test({spec}): bootstrap`

**Spike:** `{task_id} [SPIKE]: {hypothesis}. Files+Spec. {reverted warnings}. Minimal spike. Commit as spike({spec}): {desc}`

**Optimize Task** (`Agent(model="opus")`):
```
--- START ---
{task_id} [OPTIMIZE]: {metric} — cycle {N}/{max}. Files+Spec.
Current: {val} (baseline: {b}, best: {best}). Target: {t} ({dir}). Metric: {cmd}
CONSTRAINT: ONE atomic change.
--- MIDDLE ---
Last 5 cycles + failed hypotheses + Impact/deps.
--- END ---
{Learnings}. ONE change + commit. No metric run, no multiple changes.
```

**Optimize Probe** (`Agent(model="opus")`):
```
--- START ---
{task_id} [OPTIMIZE PROBE]: {metric} — probe {id} ({role})
Current/Target. Role instruction:
  contextualizada: "Build on best: {summary}. Refine."
  contraditoria: "Best was: {summary}. Try OPPOSITE."
  ingenua: "Ignore prior. Fresh approach."
--- MIDDLE ---
Full history + all failed hypotheses.
--- END ---
ONE atomic change. Commit. STOP.
```

### 8. COMPLETE SPECS

All tasks done for `doing-*` spec:
1. `skill: "df:verify", args: "doing-{name}"` — runs L0-L4 gates, merges, cleans worktree, renames doing→done, extracts decisions. Fail (fix tasks added) → stop; `--continue` picks them up.
2. Remove spec's ENTIRE section from PLAN.md. Recalculate Summary table.

---

## Usage

```
/df:execute              # All ready tasks
/df:execute T1 T2        # Specific tasks
/df:execute --continue   # Resume checkpoint
/df:execute --fresh      # Ignore checkpoint
/df:execute --dry-run    # Show plan only
```

## Skills & Agents

Skills: `atomic-commits`, `browse-fetch`. Agents: Implementation (`general-purpose`), Debugger (`reasoner`).

**Model+effort routing** (read from PLAN.md, defaults: sonnet/medium):

| Fields | Agent | Preamble |
|--------|-------|----------|
| haiku/low | `Agent(model="haiku")` | `Maximally efficient: skip explanations, minimize tool calls, straight to implementation.` |
| sonnet/medium | `Agent(model="sonnet")` | `Direct and efficient. Explain only non-obvious logic.` |
| opus/high | `Agent(model="opus")` | _(none)_ |

**Checkpoint:** `.deepflow/checkpoint.json`: `{"completed_tasks":["T1"],"current_wave":2,"worktree_path":"...","worktree_branch":"df/..."}`

## Failure Handling

Reverted task: `TaskUpdate(status: "pending")`, dependents stay blocked. Repeated failure → spawn reasoner debugger. Leave worktree+checkpoint intact. Output: path, `cd` command, `--continue`/`--fresh` options.

## Rules

| Rule | Detail |
|------|--------|
| Zero tests → bootstrap first | Sole task when snapshot empty |
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| 1 file = 1 writer | Sequential on conflict |
| Agent codes, orchestrator measures | Ratchet judges |
| No LLM evaluates LLM | Health checks only |
| ≥2 spikes → parallel probes | Never sequential |
| Probe worktrees preserved | Losers `-failed`, never deleted |
| Machine-selected winner | Regressions > coverage > files; no LLM judge |
| External APIs → chub first | Skip if unavailable |
| 1 optimize at a time | Sequential |
| Optimize = atomic only | One change per cycle |
| Ratchet + metric both required | Keep only if both pass |
| Plateau → probes | 3 cycles <1% triggers probes |
| Circuit breaker = 3 reverts | Halts, needs human |
| Probe diversity | ≥1 contraditoria + ≥1 ingenua |
