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

### 1.5. CREATE WORKTREES (per spec)

Require clean HEAD. Discover **all** specs in execution scope:
```
DOING_SPECS=!`ls specs/doing-*.md 2>/dev/null | sed 's|specs/doing-||;s|\.md$||' | tr '\n' ' ' || echo 'NOT_FOUND'`
```

For **each** `{spec}` in `DOING_SPECS`, create `.deepflow/worktrees/{spec}` on branch `df/{spec}`. Reuse if exists; `--fresh` deletes first. If `worktree.sparse_paths` non-empty: `git worktree add --no-checkout`, `sparse-checkout set {paths}`, checkout.

Build an in-memory map `SPEC_WORKTREES = {spec → {path, branch}}`. This map drives per-task routing in §5 and §5.5 and is persisted in `.deepflow/checkpoint.json` under `spec_worktrees`. Tasks from spec A run in worktree A; tasks from spec B run in worktree B. No cross-spec commits share a branch.

Then run §1.5.1, §1.6, and §1.7 **per worktree** before any wave spawns.

### 1.5.1. SYMLINK DEPENDENCIES (per worktree)

After each worktree is created, symlink `node_modules` from the main repo so TypeScript/LSP/build can resolve dependencies without a full install:
```bash
node "${HOME}/.claude/bin/worktree-deps.js" --source "$(git rev-parse --show-toplevel)" --worktree "${SPEC_WORKTREES[spec].path}"
```
The script finds `node_modules` at root and inside monorepo directories (`packages/`, `apps/`, etc.) and creates symlinks in the worktree. Outputs JSON: `{"linked": N, "total": M}`. Errors are non-fatal — log and continue.

### 1.6. RATCHET SNAPSHOT (per worktree)

For each spec worktree, snapshot pre-existing test files — only these count for ratchet (agent-created excluded):
```bash
git -C ${SPEC_WORKTREES[spec].path} ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' > .deepflow/auto-snapshot-{spec}.txt
```

Each spec has its own snapshot file. Ratchet checks in §5.5 pass the snapshot file matching the task's spec.

### 1.7. NO-TESTS BOOTSTRAP

<!-- AC-1: zero test files triggers bootstrap before wave 1 -->
<!-- AC-2: bootstrap success re-snapshots auto-snapshot.txt; subsequent tasks use updated snapshot -->
<!-- AC-3: bootstrap failure with default model retries with Opus; double failure halts with specific message -->

**Gate (per spec):** After §1.6 snapshot, check each spec's snapshot file independently:
```bash
SNAPSHOT_COUNT=$(wc -l < .deepflow/auto-snapshot-{spec}.txt | tr -d ' ')
```
If `SNAPSHOT_COUNT` is `0` for a given spec (zero test files found), MUST spawn a bootstrap agent for **that spec** before any implementation task from that spec runs. Other specs with non-empty snapshots proceed normally.

**Bootstrap flow (per empty-snapshot spec):**
1. Spawn `Agent(model="{default_model}", ...)` with Bootstrap prompt (§6), `Working directory: ${SPEC_WORKTREES[spec].path}`. End turn, wait for notification.
2. **On success (TASK_STATUS:pass):** Re-snapshot immediately for that spec:
   ```bash
   git -C ${SPEC_WORKTREES[spec].path} ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' > .deepflow/auto-snapshot-{spec}.txt
   ```
   All subsequent tasks for that spec use this updated snapshot as their ratchet baseline. Proceed to wave 1.
3. **On failure (TASK_STATUS:fail) with default model:** Retry ONCE with `Agent(model="opus", ...)` using the same Bootstrap prompt.
   - Opus success → re-snapshot (same command above) → proceed to wave 1.
   - Opus failure → halt with message: `"Bootstrap failed with both default and Opus — manual intervention required"`. Do not proceed.

### 2. LOAD PLAN

Load PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml. Missing → "No PLAN.md found. Run /df:plan first."

**Per-task detail files** (shell injection — load once after PLAN.md):
```
PLAN_TASK_FILES=!`ls .deepflow/plans/doing-*.md 2>/dev/null | tr '\n' ' ' || echo 'NOT_FOUND'`
```
When `PLAN_TASK_FILES` is not `NOT_FOUND`, each file `.deepflow/plans/doing-{specName}.md` contains the full task detail (Files, Steps, ACs, Impact) for all tasks in that spec. Load a task's detail on demand when building its agent prompt (§6). PLAN.md is a slim index — Files and Impact live only in mini-plans. `PLAN_TASK_FILES` contains filenames only — do NOT `cat` or read mini-plan files upfront; the body lives in `WAVE_JSON[task].task_detail_body` and is injected per-agent at spawn time.

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

Before wave 1 spawn, orchestrator MUST NOT read specs/*.md, .deepflow/plans/*.md, or grep across them — all needed fields are in WAVE_JSON.

### 5. SPAWN AGENTS

**Pre-spawn context capture (wave 1 only):**
```bash
_ctx_pct=$(node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('.deepflow/context.json','utf8')).percentage))}catch(e){process.stdout.write('0')}")
_cp=$(cat .deepflow/checkpoint.json 2>/dev/null || echo '{}')
node -e "const d=JSON.parse(process.argv[1]);d.pre_spawn_context_pct=${_ctx_pct};require('fs').writeFileSync('.deepflow/checkpoint.json',JSON.stringify(d,null,2))" "$_cp"
echo "📊 pre-spawn context: ${_ctx_pct}%"
```

Context ≥50% → checkpoint and exit. Before spawning: `TaskUpdate(status: "in_progress")`.

**Token tracking start:** Store `start_percentage` (from context.json) and `start_timestamp` (ISO 8601) keyed by task_id. Omit if unavailable.

**Intra-wave isolation:** Each task in a wave runs with `isolation: "worktree"` — tasks from the same spec share that spec's worktree branch so wave 2 sees wave 1 commits; tasks from different specs run in different worktrees and never interleave. **Spawn ALL ready tasks in ONE message** except file conflicts.

**Per-spec routing (CRITICAL):** Each task in `WAVE_JSON` carries a `spec` field (from `bin/wave-runner.js`). When building the agent prompt (§6), you MUST set `Working directory: ${SPEC_WORKTREES[task.spec].path}` — the worktree for that task's spec, NOT the first spec in the map. Cross-spec contamination (spawning a task from spec B into spec A's worktree) corrupts branch history and breaks `/df:verify`. If `task.spec` is absent from the JSON, fall back to deriving it from the task's mini-plan file `.deepflow/plans/doing-{specName}.md`; if still unresolvable, defer the task and log `"⚠ T{N} deferred — cannot resolve spec"`.

**File conflicts (1 file = 1 writer):** Check `Files:` from wave-runner JSON output or from mini-plan detail files (`.deepflow/plans/doing-{specName}.md`). File-conflict rule applies **only within the same spec** — two tasks from different specs touching files with identical paths are actually in different worktrees and cannot collide. Overlap within a spec → spawn lowest-numbered only; rest stay pending. Log: `"⏳ T{N} deferred — file conflict with T{M} on {filename}"`

**≥2 [SPIKE] tasks same problem →** Parallel Spike Probes (§5.7). **[OPTIMIZE] tasks →** Optimize Cycle (§5.9), one at a time. **[INTEGRATION] tasks** (`task.isIntegration === true` in WAVE_JSON) **→** use the Integration Task prompt template (§6 Integration Task), not the Standard Task template. Integration tasks always land in the final wave via `Blocked by:` — wave-runner guarantees this, so they execute after all producer/consumer implementation tasks have committed. Route them to the **consumer spec's** worktree via `SPEC_WORKTREES[task.spec].path` (plan.md §4.8.2 places the integration task under the consumer's section header, so `task.spec` is already the consumer).

### 5.1. INTRA-WAVE CHERRY-PICK MERGE

After ALL wave-N agents complete, cherry-pick each wave-N commit back to the main branch BEFORE wave N+1 begins. This ensures wave N+1 agents see all wave-N changes regardless of which worktree they run in.

**Wave gate:** Wave N+1 MUST NOT start until all wave-N cherry-picks complete.

**Ordering:** Apply cherry-picks in ascending task-number order (e.g., T1 before T2 before T3) for determinism.

**Steps (per wave completion):**
1. Collect all task commits from wave N (from ratchet PASS records).
2. Sort commits by ascending task-number order.
3. For each commit, spawn haiku context-fork (§5.8): `git cherry-pick {sha}`. Receive one-line summary.
4. On conflict: log `"⚠ cherry-pick conflict: {sha} — {file}"`, abort cherry-pick, mark task as needing manual resolution.
5. Only after all wave-N cherry-picks finish → proceed to spawn wave N+1 agents.

### 5.5. RATCHET CHECK

Run after each agent completes: `node bin/ratchet.js --help` for exit codes and scope rules.
```bash
node bin/ratchet.js --worktree ${SPEC_WORKTREES[task.spec].path} --snapshot .deepflow/auto-snapshot-{task.spec}.txt --task T{N}
```
- **Exit 0 (PASS):** commit stands. Run §5.5.1 AC coverage → §5.5.2 decision extraction.
- **Exit 1 (FAIL):** script already reverted HEAD. `TaskUpdate(status: 'pending')`. Recompute remaining waves with `--recalc --failed T{N}`.
- **Exit 2 (SALVAGEABLE):** spawn `Agent(model='sonnet')` fix, re-run ratchet; still non-zero → revert both commits, set pending.

Pre-existing test updates require a dedicated PLAN.md task — never inline.
#### 5.5.1. AC COVERAGE CHECK (after ratchet pass)

After ratchet PASS (exit 0), run AC coverage check to verify agent reported all acceptance criteria:
```bash
node "${HOME}/.claude/bin/hooks/ac-coverage.js" --spec {spec_path} --output-file {agent_output_file} --status pass
```

where `{spec_path}` is the path to `specs/doing-{spec_name}.md` and `{agent_output_file}` is the task agent's full output transcript (from TaskOutput or notification context).

**Exit codes from ac-coverage.js:**
- **Exit 0:** All ACs covered or no ACs in spec. Status remains PASS. Proceed to decision extraction (§5.5.2).
- **Exit 2 (SALVAGEABLE):** Missed ACs detected despite agent reporting TASK_STATUS:pass. Script outputs summary: `[ac-coverage] N/M ACs covered — missed: AC-X, AC-Y; ...`. Override final status to SALVAGEABLE. Commit stands. TaskUpdate(status: "completed") with note that ACs are incomplete.
- **Exit 1 (script error):** Log error, do not change status. Proceed as if ratchet PASS (exit 0 from ac-coverage).

#### 5.5.2. DECISION EXTRACTION (on ratchet pass)

Parse the agent's response for `DECISIONS:` line. If present:
1. Split by ` | ` to get individual decisions
2. If any entry does not start with `[TAG]` where TAG ∈ {APPROACH, PROVISIONAL, ASSUMPTION, FUTURE, UPDATE}, emit SALVAGEABLE and skip writing that entry to decisions.md (valid entries still get written).
3. Each decision has format `[TAG] description — rationale` where TAG ∈ {APPROACH, PROVISIONAL, ASSUMPTION, FUTURE, UPDATE}
4. Append to `.deepflow/decisions.md` under `### {date} — {spec_name}` header (create header if first decision for this spec today, reuse if exists)
5. Format: `- [TAG] description — rationale`

If no `DECISIONS:` line in agent output and the task effort is not `low` → emit SALVAGEABLE (non-trivial tasks without a decision line may indicate the agent skipped documenting architectural choices). For tasks with effort `low`, skip silently (mechanical tasks don't produce decisions).

**This runs on every ratchet pass, not just at verify time.** Decisions are captured incrementally as tasks complete, so they're never lost even if verify fails or merge is manual.

**Edit scope validation:** ratchet `scope` stage runs `git diff --name-only main...HEAD` vs task `Files:` list. Violation → SALVAGEABLE (commit stands, human decides).
**Impact completeness:** diff vs Impact callers/duplicates. Gap → advisory warning (no revert).

**Metric gate (Optimize only):** Run `eval "${metric_command}"` with cwd=`${SPEC_WORKTREES[task.spec].path}` (never `cd && eval`). Parse float (non-numeric → revert). Compare using `direction`+`min_improvement_threshold`. Both ratchet AND metric must pass → keep. Ratchet pass + metric stagnant → revert. Secondary metrics: regression > `regression_threshold` (5%) → WARNING in auto-report.md (no revert).

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

### 5.6. WAVE TEST AGENT

Trigger: task type is [TEST] or orchestrator spawns a dedicated test-writing agent for a wave.

Before spawning the test agent, collect context:
```bash
SNAPSHOT_FILES=!`cat .deepflow/auto-snapshot.txt 2>/dev/null || echo ''`
EXISTING_TEST_NAMES=!`grep -h -E "^\s*(it|test|describe)\(" ${SNAPSHOT_FILES} 2>/dev/null | sed "s/^[[:space:]]*//" || echo ''`
```

Pass `SNAPSHOT_FILES` and `EXISTING_TEST_NAMES` into the agent prompt so it can avoid duplication.

**Implementation diff:** The wave test agent reads the implementation diff itself using the `Read` tool or `git diff` — do NOT capture or pass the raw diff to the wave test prompt inline. Injecting large diffs inflates context and causes rot.

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
  Working directory: ${SPEC_WORKTREES[task.spec].path}
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

**Common preamble (all):** `Working directory: ${SPEC_WORKTREES[task.spec].path}. All file ops use this path. Commit format: {type}({spec}): {desc}`

Resolve `task.spec` from the `WAVE_JSON` entry for this task (fallback: scan `.deepflow/plans/doing-*.md` for the task's block). Never hand an agent a worktree path that belongs to a different spec.

<!-- LSP type context (EXISTING_TYPES) is injected automatically by the df-implement-protocol PreToolUse hook — no agent action required. -->

**Template selection (deterministic, from WAVE_JSON):**

| Flag                  | Template                           |
|-----------------------|------------------------------------|
| `isIntegration: true` | Integration Task (below)           |
| `isSpike: true`       | Spike                              |
| `isOptimize: true`    | Optimize Task                      |
| (none)                | Standard Task                      |

Read these fields from `WAVE_JSON` entries. Do NOT re-parse the task description for tags — the flags are authoritative. If `isIntegration` is true, skip Standard Task entirely and jump to Integration Task (below).

**Template files** (render with `node bin/prompt-compose.js --template <name> --context <json-or-stdin>`):

| Template | File | Required tokens (see the file for full list) |
|---|---|---|
| Standard Task | `templates/agent-prompts/standard-task.md` | `TASK_ID`, `DESCRIPTION`, `FILES`, `SPEC`, `ACS`, `TASK_BODY` (+ pre-rendered conditional blocks) |
| Integration | `templates/agent-prompts/integration.md` | `TASK_ID`, `SPEC_A`, `SPEC_B`, `INTEGRATION_ACS`, `SPECS_INVOLVED`, `INTERFACE_MAP`, `CONTRACT_RISKS`, `AC_COVERAGE_INSTRUCTIONS` |
| Bootstrap | `templates/agent-prompts/bootstrap.md` | `SPEC` |
| Wave Test | `templates/agent-prompts/wave-test.md` | `TASK_ID`, `SPEC_NAME`, `SNAPSHOT_FILES`, `EXISTING_TEST_NAMES`, `SPEC_PATH`, `EDIT_SCOPE`, `SPEC` |
| Spike | `templates/agent-prompts/spike.md` | `TASK_ID`, `HYPOTHESIS`, `SPEC`, `REVERTED_WARNINGS`, `DESC` |
| Optimize Task | `templates/agent-prompts/optimize.md` | (see file) |
| Optimize Probe | `templates/agent-prompts/optimize-probe.md` | (see file) |

Conditional blocks (`REVERTED_BLOCK`, `SPIKE_BLOCK`, `DOMAIN_MODEL_BLOCK`, `EXISTING_TYPES_BLOCK`) are pre-rendered by the caller — pass empty string to collapse, pre-formatted content (with trailing `\n`) to include.

### 8. COMPLETE SPECS

All tasks done for `doing-*` spec:
1. `skill: "df:verify", args: "doing-{name} --from-execute"` — runs L0-L4 gates, merges, cleans worktree, renames doing→done, extracts decisions. Fail (fix tasks added) → stop; `--continue` picks them up.
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

Skills: `atomic-commits`, `browse-fetch`.

**Model+effort routing** (read from PLAN.md, defaults: sonnet/medium):

| Fields | Agent | Preamble |
|--------|-------|----------|
| sonnet/low | `Agent(model="sonnet")` | `Maximally efficient: skip explanations, minimize tool calls, straight to implementation.` |
| sonnet/medium | `Agent(model="sonnet")` | `Direct and efficient. Explain only non-obvious logic.` |
| opus/high | `Agent(model="opus")` | _(none)_ |

**Checkpoint:** `.deepflow/checkpoint.json`:
```json
{
  "completed_tasks": ["T1"],
  "current_wave": 2,
  "pre_spawn_context_pct": 42,
  "spec_worktrees": {
    "upload":   {"path": ".deepflow/worktrees/upload",   "branch": "df/upload"},
    "auth":     {"path": ".deepflow/worktrees/auth",     "branch": "df/auth"}
  }
}
```
One entry per `doing-*` spec in scope. `--continue` rehydrates this map before wave scheduling.

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
