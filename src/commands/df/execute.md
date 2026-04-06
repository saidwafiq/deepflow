---
name: df:execute
description: Execute tasks from PLAN.md with agent spawning, ratchet health checks, and worktree management
---

# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You are a coordinator. Spawn agents, run ratchet checks, update PLAN.md. Never implement code yourself.

**NEVER:** Read source files, edit code, use TaskOutput, use EnterPlanMode, use ExitPlanMode
**ONLY:** Read PLAN.md, read specs/doing-*.md, read `.deepflow/plans/doing-*.md` for task detail, spawn background agents, run ratchet health checks, update PLAN.md, write `.deepflow/decisions.md`

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

<!-- AC-1: zero test files triggers bootstrap before wave 1 -->
<!-- AC-2: bootstrap success re-snapshots auto-snapshot.txt; subsequent tasks use updated snapshot -->
<!-- AC-3: bootstrap failure with default model retries with Opus; double failure halts with specific message -->

**Gate:** After §1.6 snapshot, check `auto-snapshot.txt`:
```bash
SNAPSHOT_COUNT=$(wc -l < .deepflow/auto-snapshot.txt | tr -d ' ')
```
If `SNAPSHOT_COUNT` is `0` (zero test files found), MUST spawn bootstrap agent before wave 1. No implementation tasks may start until bootstrap completes successfully.

**Bootstrap flow:**
1. Spawn `Agent(model="{default_model}", ...)` with Bootstrap prompt (§6). End turn, wait for notification.
2. **On success (TASK_STATUS:pass):** Re-snapshot immediately:
   ```bash
   git -C ${WORKTREE_PATH} ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' > .deepflow/auto-snapshot.txt
   ```
   All subsequent tasks use this updated snapshot as their ratchet baseline. Proceed to wave 1.
3. **On failure (TASK_STATUS:fail) with default model:** Retry ONCE with `Agent(model="opus", ...)` using the same Bootstrap prompt.
   - Opus success → re-snapshot (same command above) → proceed to wave 1.
   - Opus failure → halt with message: `"Bootstrap failed with both default and Opus — manual intervention required"`. Do not proceed.

### 2. LOAD PLAN

Load PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml. Missing → "No PLAN.md found. Run /df:plan first."

**Per-task detail files** (shell injection — load once after PLAN.md):
```
PLAN_TASK_FILES=!`ls .deepflow/plans/doing-*.md 2>/dev/null | tr '\n' ' ' || echo 'NOT_FOUND'`
```
When `PLAN_TASK_FILES` is not `NOT_FOUND`, each file `.deepflow/plans/doing-{specName}.md` contains the full task detail (Files, Steps, ACs, Impact) for all tasks in that spec. Load a task's detail on demand when building its agent prompt (§6). PLAN.md is a slim index — Files and Impact live only in mini-plans.

### 2.5. REGISTER NATIVE TASKS

For each `[ ]` task: `TaskCreate(subject: "{task_id}: {description}", activeForm: "{gerund}", description: full block)`. Store task_id → native ID. Set deps via `TaskUpdate(addBlockedBy: [...])`. `--continue` → only remaining `[ ]` items.

### 3–4. READY TASKS

Warn if unplanned `specs/*.md` (excluding doing-/done-) exist (non-blocking).

**Wave computation (shell injection — do NOT compute manually):**
```
WAVE_JSON=!`node "${HOME}/.claude/bin/wave-runner.js" --json --plan PLAN.md 2>/dev/null || echo 'WAVE_ERROR'`
```
`WAVE_JSON` is structured JSON (produced by T1's `--json` flag). Parse it to determine the current wave and scheduling decisions:
```json
{
  "waves": [
    {"wave": 1, "tasks": [{"id": "T1", "description": "...", "files": ["..."], "isolation": "worktree"}, ...]},
    {"wave": 2, "tasks": [...]}
  ],
  "blocked": [{"id": "T3", "blockedBy": ["T2"]}],
  "done": ["T0"]
}
```
Use `waves[0].tasks` as the ready set for the current wave. Use `blocked` to identify tasks not yet ready.

**Fallback (text mode):** If `WAVE_JSON` is `WAVE_ERROR` or cannot be parsed as JSON, fall back to text mode:
```
WAVE_PLAN=!`node "${HOME}/.claude/bin/wave-runner.js" --plan PLAN.md 2>/dev/null || echo 'WAVE_ERROR'`
```
Text output format:
```
Wave 1: T1 — description, T4 — description
Wave 2: T2 — description
...
```
In text fallback: if output is `WAVE_ERROR` or `(no pending tasks)`, fall back to TaskList where status: "pending" AND blockedBy: empty for wave 1.

Ready = tasks listed in Wave 1 (cross-referenced with TaskList status: "pending").

### 5. SPAWN AGENTS

Context ≥50% → checkpoint and exit. Before spawning: `TaskUpdate(status: "in_progress")`.

**Token tracking start:** Store `start_percentage` (from context.json) and `start_timestamp` (ISO 8601) keyed by task_id. Omit if unavailable.

**NEVER use `isolation: "worktree"`.** Deepflow manages a shared worktree so wave 2 sees wave 1 commits. **Spawn ALL ready tasks in ONE message** except file conflicts.

**File conflicts (1 file = 1 writer):** Check `Files:` from wave-runner JSON output or from mini-plan detail files (`.deepflow/plans/doing-{specName}.md`). Overlap → spawn lowest-numbered only; rest stay pending. Log: `"⏳ T{N} deferred — file conflict with T{M} on {filename}"`

**≥2 [SPIKE] tasks same problem →** Parallel Spike Probes (§5.7). **[OPTIMIZE] tasks →** Optimize Cycle (§5.9), one at a time.

### 5.5. RATCHET CHECK

Run `node "${HOME}/.claude/bin/ratchet.js"` in the worktree directory after each agent completes:
```bash
node "${HOME}/.claude/bin/ratchet.js" --worktree ${WORKTREE_PATH} --snapshot .deepflow/auto-snapshot.txt --task T{N}
```

The script handles all health checks internally and outputs structured JSON:
```json
{"status": "PASS"|"FAIL"|"SALVAGEABLE", "reason": "...", "details": "..."}
```

**Exit codes:** 0 = PASS, 1 = FAIL (script already ran `git revert HEAD --no-edit`), 2 = SALVAGEABLE (lint/typecheck only; build+tests passed).

**You MUST NOT inspect, classify, or reinterpret test failures. FAIL means revert. No exceptions.**

**Prohibited actions during ratchet:**
- No `git stash` or `git checkout` for investigation purposes
- No inline edits to pre-existing test files
- No reading raw test output to decide what "really" failed

**Broken-tests policy:** Updating pre-existing tests requires a separate dedicated task in PLAN.md with explicit justification — never inline during execution.

**Orchestrator response by exit code:**
- **Exit 0 (PASS):** Commit stands. TaskUpdate(status: "completed"), update PLAN.md [x] + commit hash. **Extract decisions** (see §5.5.1).
- **Exit 1 (FAIL):** Script already reverted. Set `TaskUpdate(status: "pending")`. Recompute remaining waves:
  ```
  WAVE_JSON=!`node "${HOME}/.claude/bin/wave-runner.js" --json --plan PLAN.md --recalc --failed T{N} 2>/dev/null || echo 'WAVE_ERROR'`
  ```
  (Fall back to text mode if `--json` is unavailable: `node "${HOME}/.claude/bin/wave-runner.js" --plan PLAN.md --recalc --failed T{N}`)
  Report: `"✗ T{n}: reverted"`.
- **Exit 2 (SALVAGEABLE):** Spawn `Agent(model="sonnet")` to fix lint/typecheck issues. Re-run `node "${HOME}/.claude/bin/ratchet.js"`. If still non-zero → revert both commits, set status pending.

#### 5.5.1. DECISION EXTRACTION (on ratchet pass)

Parse the agent's response for `DECISIONS:` line. If present:
1. Split by ` | ` to get individual decisions
2. Each decision has format `[TAG] description — rationale` where TAG ∈ {APPROACH, PROVISIONAL, ASSUMPTION, FUTURE, UPDATE}
3. Append to `.deepflow/decisions.md` under `### {date} — {spec_name}` header (create header if first decision for this spec today, reuse if exists)
4. Format: `- [TAG] description — rationale`

If no `DECISIONS:` line in agent output → skip silently (mechanical tasks don't produce decisions).

**This runs on every ratchet pass, not just at verify time.** Decisions are captured incrementally as tasks complete, so they're never lost even if verify fails or merge is manual.

**Edit scope validation:** `git diff HEAD~1 --name-only` vs allowed globs. Violation → revert, report.
**Impact completeness:** diff vs Impact callers/duplicates. Gap → advisory warning (no revert).

**Metric gate (Optimize only):** Run `eval "${metric_command}"` with cwd=`${WORKTREE_PATH}` (never `cd && eval`). Parse float (non-numeric → revert). Compare using `direction`+`min_improvement_threshold`. Both ratchet AND metric must pass → keep. Ratchet pass + metric stagnant → revert. Secondary metrics: regression > `regression_threshold` (5%) → WARNING in auto-report.md (no revert).

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

### 5.7. PARALLEL SPIKE PROBES

Trigger: ≥2 [SPIKE] tasks with same blocker or identical hypothesis.

1. `BASELINE=$(git rev-parse HEAD)` in shared worktree
2. Sub-worktrees per spike: `git worktree add -b df/{spec}--probe-{ID} .deepflow/worktrees/{spec}/probe-{ID} ${BASELINE}`
3. Spawn all probes in ONE message. End turn.
4. Per notification: ratchet (§5.5). Record: ratchet_passed, regressions, coverage_delta, files_changed, commit.
5. **Winner selection** (no LLM judge): disqualify regressions. Standard: fewer regressions > coverage > fewer files > first complete. Optimize: best metric delta > fewer regressions > fewer files. No passes → reset pending for debugger.
6. Preserve all worktrees. Losers: branch + `-failed`. Record in checkpoint.json.
7. Log all outcomes to `.deepflow/auto-memory.yaml` under `spike_insights`+`probe_learnings` (schema in src/skills/auto-cycle/SKILL.md). Both winners and losers.
8. Cherry-pick winner into shared worktree via haiku context-fork (§5.8): spawn haiku with `git cherry-pick {winner_sha}`; receive one-line summary. Winner → `[x] [PROBE_WINNER]`, losers → `[~] [PROBE_FAILED]`.

#### 5.7.1. PROBE DIVERSITY (Optimize Probes)

Roles: **contextualizada** (refine best), **contraditoria** (opposite of best), **ingenua** (fresh, no context).

| Round | Count | Roles |
|-------|-------|-------|
| 1st plateau | 2 | 1 contraditoria + 1 ingenua |
| 2nd plateau | 4 | 1 contextualizada + 2 contraditoria + 1 ingenua |
| 3rd+ | 6 | 2 contextualizada + 2 contraditoria + 2 ingenua |

Every set: ≥1 contraditoria + ≥1 ingenua. contextualizada from round 2+ only. Scale persists in `optimize_state.probe_scale`.

### 5.8. HAIKU GIT-OPS (context-fork)

<!-- AC-7: git diff/stash/cherry-pick run in a haiku context-fork; orchestrator receives one-line summary -->

Git operations that produce large output (diff, stash, cherry-pick conflict output) MUST be delegated to a context-forked haiku subagent. Raw output never enters the orchestrator context.

**Trigger:** Any of: revert confirmation, cherry-pick merge-back (spike probes).

**Pattern:**
```
Spawn Agent(model="haiku", run_in_background=false):
  Working directory: {WORKTREE_PATH}
  Run: {git command}
  Return exactly ONE line: "{operation}: {N lines changed / N files / outcome}"
  Do NOT output the raw diff or full command output.
  Last line: TASK_STATUS:pass or TASK_STATUS:fail
```

**Examples by operation:**

| Operation | Git command | Expected one-line summary |
|-----------|-------------|--------------------------|
| Post-impl diff | `git diff HEAD~1` | `diff: 3 files, +47/-12 lines` |
| Stash check | `git stash list` | `stash: 2 entries (stash@{0}: T3 work-in-progress)` |
| Cherry-pick | `git cherry-pick {sha}` | `cherry-pick: applied {sha} cleanly` or `cherry-pick: conflict in {file}` |
| Revert confirm | `git log --oneline -3` | `log: HEAD={sha} T3-impl, parent={sha} T2-impl` |

**Orchestrator stores the one-line summary only.** Never stores or logs the haiku subagent transcript.

**Fallback:** If haiku subagent returns TASK_STATUS:fail, orchestrator runs the minimal shell equivalent (`git diff --stat HEAD~1`) directly — this produces compact output safe for orchestrator context.

### 5.9. OPTIMIZE CYCLE

Trigger: task has `Optimize:` block. One at a time, N cycles until stop condition.

**Init:** Parse metric/target/direction/max_cycles/secondary_metrics from the task's `Optimize:` block. The `metric:` field is a **reference key**, not a shell command.

**Resolve `metric_command` from config.yaml (required):**
```
CONFIG=!`cat .deepflow/config.yaml 2>/dev/null || echo 'NOT_FOUND'`
```
Parse YAML: look for `optimize.metric_command` or `metric_commands.{metric_key}` where `{metric_key}` matches the `metric:` field from the task's `Optimize:` block.

**If `metric_command` is absent from config.yaml → REFUSE and halt this task:**
```
ERROR: metric_command for "{metric_key}" is not defined in .deepflow/config.yaml.
Add it under `optimize.metric_command` or `metric_commands.{metric_key}` before retrying.
Task "{task_id}" will not execute.
```
Set `TaskUpdate(status: "pending")`. Do NOT proceed to baseline measurement or cycle loop.

**If `metric_command` resolves → continue:** Load or init `optimize_state` in auto-memory.yaml (fields: task_id, metric_command, target, direction, baseline, current_best, best_commit, cycles_run, cycles_without_improvement, consecutive_reverts, probe_scale, max_cycles, history[], failed_hypotheses[]). Measure baseline (`eval` with cwd=worktree) → store as baseline+current_best. Measure secondaries. Target met → mark `[x]`, done.

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

**Task detail loading (before building agent prompt):** Check for `.deepflow/plans/doing-{task_id}.md` (shell injection):
```
TASK_DETAIL=!`cat .deepflow/plans/doing-{task_id}.md 2>/dev/null || echo 'NOT_FOUND'`
```
If `TASK_DETAIL` is not `NOT_FOUND`, use it as the full Middle section (Steps, ACs, Impact) in the agent prompt, overriding the inline PLAN.md block. If `NOT_FOUND`, fall back to the inline PLAN.md task block.

**Standard Task** (`Agent(model="{Model}", ...)`):
```
--- START ---
{task_id}: {description}  Files: {files}  Spec: {spec}
{If reverted: DO NOT repeat: - Cycle {N}: "{reason}"}
{If spike insights exist:
spike_results:
  hypothesis: {hypothesis from spike_insights}
  outcome: {outcome}
  edge_cases: {edge_cases}
  insight: {insight from probe_learnings}
}
Success criteria: {ACs from spec relevant to this task}
--- MIDDLE (omit for low effort; omit deps for medium) ---
{TASK_DETAIL if available, else inline block:}
Impact: Callers: {file} ({why}) | Duplicates: [active→consolidate] [dead→DELETE] | Data flow: {consumers}
Prior tasks: {dep_id}: {summary}
Steps: 1. chub search/get for APIs 2. LSP findReferences, add unlisted callers 3. LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files) 4. Implement 5. Commit
--- END ---
Duplicates: [active]→consolidate [dead]→DELETE. ONLY job: code+commit. No merge/rename/checkout.
DECISIONS: If you made non-obvious choices, append to the LAST LINE BEFORE TASK_STATUS:
DECISIONS: [TAG] {decision} — {rationale} | [TAG] {decision2} — {rationale2}
Tags:
  [APPROACH] — chose X over Y (architectural/design choice)
  [PROVISIONAL] — works for now but won't scale / needs revisit
  [ASSUMPTION] — assumed X is true; if wrong, Y breaks
  [FUTURE] — deferred X because Y; revisit when Z
  [UPDATE] — changed prior decision from X to Y because Z
Skip for trivial/mechanical changes.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
```

**Integration Task** (`Agent(model="opus")`):
```
--- START ---
{task_id} [INTEGRATION]: Verify contracts between {spec_a} ↔ {spec_b}
Integration ACs: {list from PLAN.md}
--- MIDDLE ---
Specs involved: {spec file paths}
Interface Map: {from integration task detail}
Contract Risks: {from integration task detail}
--- END ---
RULES:
- Fix the CONSUMER to match the PRODUCER's declared interface. Never weaken the producer.
- Each fix must reference the specific contract being repaired.
- If a migration conflict exists, make ALL migrations idempotent (IF NOT EXISTS, IF NOT COLUMN, etc.)
- Do NOT create new variables or intermediate adapters to paper over mismatches. Fix the actual call site.
- Do NOT modify acceptance criteria or spec definitions.
- Commit as fix({spec}): {contract description}. One commit per contract fix.
DECISIONS: Report each contract fix as: [TAG] {what was mismatched} — {which side changed and why}. Use [APPROACH] for definitive fixes, [PROVISIONAL] if the fix is a workaround, [UPDATE] if changing a prior decision.
Last line: TASK_STATUS:pass or TASK_STATUS:fail
```

**Bootstrap:** `BOOTSTRAP: Write tests for edit_scope files. Do NOT change implementation. Commit as test({spec}): bootstrap. Last line: TASK_STATUS:pass or TASK_STATUS:fail`

**Spike:** `{task_id} [SPIKE]: {hypothesis}. Files+Spec. {reverted warnings}. Minimal spike. Commit as spike({spec}): {desc}. If you discovered constraints, rejected approaches, or made assumptions, report: DECISIONS: [TAG] {finding} — {why it matters} (use PROVISIONAL for "works but needs revisit", ASSUMPTION for "assumed X; if wrong Y breaks", APPROACH for definitive choices). Last line: TASK_STATUS:pass or TASK_STATUS:fail`

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
Last line of your response MUST be: TASK_STATUS:pass or TASK_STATUS:fail or TASK_STATUS:revert
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
Last line of your response MUST be: TASK_STATUS:pass or TASK_STATUS:fail or TASK_STATUS:revert
```

### 8. COMPLETE SPECS

All tasks done for `doing-*` spec:
1. `skill: "df:verify", args: "doing-{name}"` — runs L0-L4 gates, merges, cleans worktree, renames doing→done, extracts decisions. Fail (fix tasks added) → stop; `--continue` picks them up.
2. PLAN.md section cleanup handled by verify (step 6).

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
| sonnet/low | `Agent(model="sonnet")` | `Maximally efficient: skip explanations, minimize tool calls, straight to implementation.` |
| sonnet/medium | `Agent(model="sonnet")` | `Direct and efficient. Explain only non-obvious logic.` |
| opus/high | `Agent(model="opus")` | _(none)_ |

**Checkpoint:** `.deepflow/checkpoint.json`: `{"completed_tasks":["T1"],"current_wave":2,"worktree_path":"...","worktree_branch":"df/..."}`

## Failure Handling

Reverted task: `TaskUpdate(status: "pending")`, dependents stay blocked. Repeated failure → spawn reasoner debugger. Leave worktree+checkpoint intact. Output: path, `cd` command, `--continue`/`--fresh` options.

## Rules

| Rule | Detail |
|------|--------|
| Integration tasks run last | [INTEGRATION] tasks execute after all blocked-by tasks complete. Fix tasks from integration failures are prescriptive (name the contract, producer, consumer, and which side to change). Never weaken the producer's declared interface — prefer fixing the consumer. |
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
