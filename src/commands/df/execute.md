---
name: df:execute
description: Execute curated tasks from spec with ratchet health checks and a shared worktree.
allowed-tools: [Agent, Bash, TaskCreate, TaskUpdate, TaskList, Read, Edit, Write]
---

# /df:execute — Execute Curated Tasks from Spec

## Orchestrator Role

You are a coordinator. Spawn agents, run ratchet checks, update task state. Never implement code yourself.

**NEVER:** Read source files, edit code, use TaskOutput, use EnterPlanMode, use ExitPlanMode, read `.deepflow/experiments/**`, read `**/CLAUDE.md`, read any file not explicitly referenced in the active section.
**ONLY:** Read `specs/doing-*.md`, read `.deepflow/config.yaml`, spawn background agents, run ratchet health checks, edit `specs/doing-*.md` to augment context bundles (escape hatch / integration), write `.deepflow/decisions.md`.

## Core Loop (Notification-Driven)

Each task = one background agent. **NEVER use TaskOutput** (100KB+ transcripts explode context).

```
1. Spawn ALL wave agents with run_in_background=true in ONE message
2. STOP. End turn. Do NOT poll.
3. On EACH notification:
   a. Ratchet check (§5.5)
   b. Passed → TaskUpdate(status: "completed"), mark task done
   c. Failed → partial salvage (§5.5). Salvaged → passed. Not → git revert, TaskUpdate(status: "pending")
   d. Report ONE line: "✓ T1: ratchet passed (abc123)" or "⚕ T1: salvaged (abc124)" or "✗ T1: reverted"
   e. NOT all done → end turn, wait | ALL done → next wave or finish
4. Between waves: context ≥50% → checkpoint and exit.
5. Repeat until: all done, all blocked, or context ≥50%.
```

**Context threshold:** Statusline writes `.deepflow/context.json`: `{"percentage": 45}`. <50% = full parallelism. ≥50% = wait, checkpoint, exit.

---

## Behavior

### 0. PRECHECK

#### 0a. Resolve target spec(s)

Inventory `specs/`:

```bash
DOING=$(ls specs/doing-*.md 2>/dev/null)
# Planned = .md files NOT prefixed by doing-/done-/_ and NOT starting with `.`
PLANNED=$(ls specs/*.md 2>/dev/null | grep -vE '/(doing-|done-|_|\.)' || true)
```

**Selection rules** (in order):

1. **Explicit start** — `/df:execute {spec-name}` where `{spec-name}` matches `specs/{spec-name}.md` (planned, not yet `doing-`). Rename `specs/{spec-name}.md` → `specs/doing-{spec-name}.md` and proceed. If `{spec-name}` matches a `doing-` already, treat as resume (proceed). If neither, exit 1: `✗ ERROR: specs/{spec-name}.md not found (planned or doing-).`
2. **At least one `doing-*.md` exists** — proceed to §0b directly. (Don't auto-promote planned specs; the orchestrator may have intentionally left them un-started.)
3. **No `doing-*.md` but exactly one planned spec** — TTY: prompt `Start /df:execute on specs/{name}.md? [Y/n]` (default Y). On Y → rename to `doing-` and proceed. On n → exit 0 silently. Non-TTY → exit 1 with: `✗ ERROR: specs/{name}.md is planned but not yet started. Run \`mv specs/{name}.md specs/doing-{name}.md\` or \`/df:execute {name}\` to start.`
4. **No `doing-*.md` but multiple planned specs** — TTY: list them numbered and prompt `Pick one to start [1-N] (n to abort): `. On valid pick → rename → proceed. Non-TTY → exit 1 with the same hint as rule 3.
5. **No `doing-*.md` and no planned specs** — exit 1: `✗ ERROR: no specs to execute. Author one with /df:spec.`

Renaming uses `git mv` only when the spec is git-tracked; otherwise plain `mv` (deepflow's default `.gitignore` excludes `specs/`).

#### 0b. Validate curated section

Read every `specs/doing-*.md`. Each MUST contain a `## Tasks (curated)` section. Any spec missing it is a hard error:

```
✗ ERROR: specs/doing-{name}.md has no '## Tasks (curated)' section.
  Run /df:spec --upgrade specs/doing-{name}.md to migrate, then re-run /df:execute.
```

Exit 1. No fan-out, no fallback. The legacy PLAN.md flow has been removed; pre-curator specs MUST be migrated first.

If `.deepflow/plans/` exists with any `*.md` files, emit a one-line warning to stderr (REQ-11):

```
! WARNING: legacy .deepflow/plans/ directory detected. Run `node bin/migrate-legacy-plan.js` to convert per-spec plans into ## Tasks (curated) sections.
```

Continue regardless — the warning is informational. The curated-section precheck above is the actual gate.

Checkpoint handling (after precheck passes):
- `--fresh` → delete `.deepflow/checkpoint.json`.
- Checkpoint exists without flag → prompt "Resume? (y/n)". If yes: rehydrate from checkpoint (§A.1).

---

### §A. SHARED WORKTREE

Single worktree for all curated tasks: `.deepflow/worktrees/curator-active/` on branch `df/curator-active`.

```bash
# Require clean HEAD
git diff --quiet || (echo "ERROR: dirty working tree. Commit or stash first." && exit 1)

# Create or reuse worktree
git worktree list | grep -q curator-active \
  || git worktree add -b df/curator-active .deepflow/worktrees/curator-active HEAD
```

`--fresh`: remove and recreate:
```bash
git worktree remove --force .deepflow/worktrees/curator-active 2>/dev/null || true
git branch -D df/curator-active 2>/dev/null || true
git worktree add -b df/curator-active .deepflow/worktrees/curator-active HEAD
```

Symlink dependencies once:
```bash
node "${HOME}/.claude/bin/worktree-deps.js" \
  --source "$(git rev-parse --show-toplevel)" \
  --worktree .deepflow/worktrees/curator-active
```

Ratchet snapshot (single, shared):
```bash
git -C .deepflow/worktrees/curator-active ls-files \
  | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
  > .deepflow/auto-snapshot.txt
```

Persist to checkpoint:
```json
{ "worktree": ".deepflow/worktrees/curator-active", "branch": "df/curator-active" }
```

### §A.1. CONTINUE EXPRESS LANE

`--continue` skips §A through §C setup:
1. Load `.deepflow/checkpoint.json`. If missing → error "No checkpoint found. Use --fresh."
2. Verify worktree exists: `ls -d .deepflow/worktrees/curator-active`. Missing → error "Worktree gone. Use --fresh."
3. Reload wave state from checkpoint `current_wave` + `completed_tasks`.
4. Jump to §D (SPAWN WAVE) for remaining tasks.

### §B. NO-TESTS BOOTSTRAP

After §A snapshot, check:
```bash
SNAPSHOT_COUNT=$(wc -l < .deepflow/auto-snapshot.txt | tr -d ' ')
```

If `SNAPSHOT_COUNT` is `0`: spawn bootstrap agent before any implementation task.

1. Spawn `Agent(subagent_type: "df-implement")` with Bootstrap prompt (§6), `Working directory: .deepflow/worktrees/curator-active`. End turn, wait.
2. On success: re-snapshot `.deepflow/auto-snapshot.txt`. Proceed to §C.
3. On failure: retry once with `model: opus`. Opus failure → halt: `"Bootstrap failed with both default and Opus — manual intervention required"`.

### §C. PARSE CURATED

Read all `specs/doing-*.md` files. For each, find the `## Tasks (curated)` section and extract task entries:

Each entry is a `### T<n>: <title>` block with fields:
- `**Slice:**` — files touched
- `**Parallel:**` — `[P]` or `Blocked by: T<n>, T<m>`
- `**Context bundle:**` — fenced content (consumed by hook; orchestrator does NOT read it)
- `**Subagent prompt:**` — short directive text

Build wave graph:
- If `## Execution graph` section exists in the spec → parse wave assignments from it.
- Otherwise: derive from `**Parallel:**` fields. `[P]` = wave 1 (or earliest unblocked wave). `Blocked by:` → place in wave after all blockers.

`TaskCreate` per task: `subject: "T<n>: <title>"`, `description: full block`.
Set deps via `TaskUpdate(addBlockedBy: [...])` for `Blocked by:` tasks.

### §D. SPAWN WAVE

For each wave, spawn ALL `[P]` tasks in ONE message (single turn):

```
Agent(subagent_type: "<inferred>", run_in_background=true):
  Working directory: .deepflow/worktrees/curator-active
  T<n>: <slice>. <subagent_prompt>. Do not use Read/Grep/Glob.
```

**Hook integration (AC-2, AC-5):** The PreToolUse hook `hooks/df-context-injection.js` fires on every `Task` tool call. It detects the task ID (e.g., `T1`) in the spawn prompt, finds the matching entry in `specs/doing-*.md ## Tasks (curated)`, and prepends the full `**Context bundle:**` content. Orchestrator does NOT inline the bundle — only references the task ID. Hook is already shipped (Wave 1 — REQ-5); do not re-implement.

**Subagent type from title marker** (set by `/df:spec` curation per spec.md §4d):
- `[INTEGRATION]` → `df-integration`
- `[SPIKE]` → `df-spike`
- `[TEST]` → `df-test`
- `[OPTIMIZE]` → `df-optimize`
- (no marker) → `df-implement`

End turn after spawning the full wave. Do NOT poll.

Single shared branch `df/curator-active` makes wave N+1 see wave N commits via normal git history. No cherry-pick between waves.

### §E. ESCAPE HATCH (CONTEXT_INSUFFICIENT)

On notification, if agent output contains `CONTEXT_INSUFFICIENT: <path>` instead of `TASK_STATUS:`:

1. Orchestrator reads `<path>` via `Read` tool.
2. Appends a brief excerpt to the task's `**Context bundle:**` in `specs/doing-<name>.md` via `Edit` tool.
3. Re-spawns the task with the same prompt (`T<n>: ...`). Hook re-injects the updated bundle automatically.
4. Track retry count in checkpoint under `retries: {T<n>: count}`.
5. On 3rd escape hatch trigger (after 2 retries): abort with diagnostic:
   ```
   ✗ T<n>: aborted after 2 retries — curator gap on <path>
   ```
   `TaskUpdate(status: "pending")`. Do not re-spawn. Log gap for spec author.

### §F. INTEGRATION TASKS

When the wave graph reaches an integration task (type `df-integration`, `Blocked by:` all producers):

1. At execute time, after blocker tasks have committed: orchestrator reads producer/consumer interface files from the current branch state in `.deepflow/worktrees/curator-active/`.
2. Augments the integration task's `**Context bundle:**` in `specs/doing-<name>.md` via `Edit` tool (append producer interface excerpt).
3. Spawns `df-integration` with prompt `T<n>: ...`. Hook injects the augmented bundle.

This ensures the integration task sees actual committed interfaces, not stale spec text.

---

## Execution Checks

### 5.5. RATCHET CHECK

Run after each agent completes:
```bash
node "${HOME}/.claude/bin/ratchet.js" \
  --worktree .deepflow/worktrees/curator-active \
  --snapshot .deepflow/auto-snapshot.txt \
  --task T{N}
```

- **Exit 0 (PASS):** commit stands. Run §5.5.1 → §5.5.2 → §5.5.3.
- **Exit 1 (FAIL):** script reverted HEAD. `TaskUpdate(status: 'pending')`.
- **Exit 2 (SALVAGEABLE):** spawn `df-implement` fix prompt, re-run ratchet. Still non-zero → revert both, pending.

#### 5.5.1. AC COVERAGE CHECK

```bash
node "${HOME}/.claude/hooks/ac-coverage.js" \
  --spec {spec_path} --output-file {agent_output_file} --status pass
```
Exit 0: all covered. Exit 2: SALVAGEABLE override. Exit 1: log error, treat as PASS.

#### 5.5.2. DECISION EXTRACTION

Parse `DECISIONS:` line from agent output. Format: `[TAG] description — rationale`, TAG ∈ {APPROACH, PROVISIONAL, ASSUMPTION, FUTURE, UPDATE}.

```sh
grep -q "^### $(date +%Y-%m-%d) — {spec_name}$" .deepflow/decisions.md 2>/dev/null \
  || printf '\n### %s — %s\n' "$(date +%Y-%m-%d)" "{spec_name}" >> .deepflow/decisions.md
printf -- '- [%s] %s\n' "{TAG}" "{decision_text}" >> .deepflow/decisions.md
```

Invalid TAG → SALVAGEABLE for that entry. No `DECISIONS:` line on non-low-effort task → SALVAGEABLE.

#### 5.5.3. FINDINGS APPEND

Parse `FINDINGS:` yaml block from agent output. Append:
```bash
mkdir -p .deepflow/maps/{spec}
printf '# T%s findings\n' "{task_id}" >> .deepflow/maps/{spec}/findings.md
printf '%s\n\n' "{findings_block}" >> .deepflow/maps/{spec}/findings.md
```
Missing block → skip silently.

**Edit scope validation:** `git diff --name-only main...HEAD` vs task `Slice:` list. Violation → SALVAGEABLE.

### 5.6. WAVE TEST AGENT

Trigger: task type is [TEST].
```bash
SNAPSHOT_FILES=!`cat .deepflow/auto-snapshot.txt 2>/dev/null || echo ''`
EXISTING_TEST_NAMES=!`grep -h -E "^\s*(it|test|describe)\(" ${SNAPSHOT_FILES} 2>/dev/null || echo ''`
```
Pass into agent prompt. Agent reads impl diff itself via `Read` or `git diff` — do NOT inline raw diff.

### 5.7. PARALLEL SPIKE PROBES

Trigger: ≥2 [SPIKE] tasks with same blocker or identical hypothesis.

1. `BASELINE=$(git rev-parse HEAD)` in shared worktree.
2. Sub-worktrees per probe: `git worktree add -b df/curator-active--probe-{ID} .deepflow/worktrees/curator-active/probe-{ID} ${BASELINE}`.
3. Spawn all probes in ONE message. End turn.
4. Per notification: ratchet (§5.5). Record ratchet_passed, regressions, coverage_delta, files_changed, commit.
5. **Winner selection** (no LLM judge): disqualify regressions. Standard: fewer regressions > coverage > fewer files > first complete. Optimize: best metric delta > fewer regressions > fewer files. None → reset pending.
6. Preserve all worktrees. Losers: branch + `-failed`. Record in checkpoint.
7. Log to `.deepflow/auto-memory.yaml` under `spike_insights`+`probe_learnings`. Both winners and losers.
8. Cherry-pick winner into shared worktree via haiku (§5.8). Winner → `[x] [PROBE_WINNER]`, losers → `[~] [PROBE_FAILED]`.

#### 5.7.1. PROBE DIVERSITY (Optimize Probes)

Roles: **contextualizada** (refine best), **contraditoria** (opposite), **ingenua** (fresh).

| Round | Count | Roles |
|-------|-------|-------|
| 1st plateau | 2 | 1 contraditoria + 1 ingenua |
| 2nd plateau | 4 | 1 contextualizada + 2 contraditoria + 1 ingenua |
| 3rd+ | 6 | 2 contextualizada + 2 contraditoria + 2 ingenua |

Every set: ≥1 contraditoria + ≥1 ingenua. contextualizada from round 2+ only. Scale persists in `optimize_state.probe_scale`.

### 5.8. HAIKU GIT-OPS (context-fork)

Git operations with large output MUST be delegated to a context-forked haiku subagent. Raw output never enters orchestrator context.

**Trigger:** revert confirmation, cherry-pick (spike probe winners).

```
Spawn Agent(subagent_type: "df-haiku-ops", run_in_background=false):
  Working directory: .deepflow/worktrees/curator-active
  Operation: {git command}
  Output schema (DELEGATION.md#df-haiku-ops):
    exit: {int, 0=success}
    stdout: {one-line summary}
    stderr: {captured or ""}
    Last line: TASK_STATUS:pass or TASK_STATUS:fail
  Do NOT output raw diff.
```

| Operation | Git command | One-line summary |
|-----------|-------------|-----------------|
| Post-impl diff | `git diff HEAD~1` | `diff: 3 files, +47/-12 lines` |
| Stash check | `git stash list` | `stash: 2 entries` |
| Cherry-pick | `git cherry-pick {sha}` | `cherry-pick: applied {sha} cleanly` |
| Revert confirm | `git log --oneline -3` | `log: HEAD={sha} T3-impl` |

Fallback: TASK_STATUS:fail → run `git diff --stat HEAD~1` directly.

### 5.9. OPTIMIZE CYCLE

Trigger: task has `Optimize:` block. One at a time, N cycles until stop.

Resolve `metric_command` from `.deepflow/config.yaml` (`optimize.metric_command` or `metric_commands.{key}`). Absent → REFUSE and halt: set pending, do not proceed.

Load/init `optimize_state` in auto-memory.yaml. Measure baseline. Target met → mark `[x]`.

```
REPEAT:
  1. Check stop conditions
  2. Spawn ONE optimize agent run_in_background=true. STOP.
  3. On notification:
     a. Ratchet fail → revert, ++consecutive_reverts
     b. improvement = (new - best) / |best| × 100
     c. >= 1% → KEEP, update best, reset counters
     d. < threshold → REVERT, ++cycles_without_improvement
     e. ++cycles_run, persist state
     f. Report: "⟳ T{n} cycle {N}: {old}→{new} ({delta}%) — {kept|reverted}"
     g. Context ≥50% → checkpoint, exit
```

| Stop condition | Action |
|----------------|--------|
| Target reached | Mark `[x]` |
| cycles_run >= max_cycles | Mark `[x]`; if best < baseline → reset --hard best_commit |
| 3 cycles without improvement | Launch probes (plateau) |
| 3 consecutive reverts | Halt, `[ ]`, human intervention required |

Plateau → probes: scale 0→2, 2→4, 4→6 per §5.7.1. Resume cycle after winner applied.

State persistence: write `optimize_state` to auto-memory.yaml after every cycle. Append to `.deepflow/auto-report.md`.

---

### 6. PER-TASK (agent prompt)

**Common preamble:** `Working directory: .deepflow/worktrees/curator-active. All file ops use this path. Commit format: {type}({spec}): {desc}. Do not use Read/Grep/Glob.`

**Template selection** (from title marker per spec.md §4d):

| Title marker | `subagent_type` | Template |
|--------------|-----------------|---------|
| `[INTEGRATION]` | `df-integration` | Integration |
| `[SPIKE]` | `df-spike` | Spike |
| `[TEST]` | `df-test` | Wave Test |
| `[OPTIMIZE]` | `df-optimize` | Optimize Task |
| (none) | `df-implement` | Standard Task |

```
Agent(subagent_type: "{subagent_type}", run_in_background=true):
  Working directory: .deepflow/worktrees/curator-active
  {rendered template content}
```

Templates rendered via:
```bash
printf '%s' "$ctx" | node "${HOME}/.claude/bin/prompt-compose.js" --template standard-task --context -
```

Every template requires `WORKTREE_PATH` (set to `.deepflow/worktrees/curator-active`). `prompt-compose.js` exits 1 if missing.

| Template | File |
|----------|------|
| Standard Task | `templates/agent-prompts/standard-task.md` |
| Integration | `templates/agent-prompts/integration.md` |
| Bootstrap | `templates/agent-prompts/bootstrap.md` |
| Wave Test | `templates/agent-prompts/wave-test.md` |
| Spike | `templates/agent-prompts/spike.md` |
| Optimize Task | `templates/agent-prompts/optimize.md` |
| Optimize Probe | `templates/agent-prompts/optimize-probe.md` |

**Required output schema per subagent_type:**

| `subagent_type` | Required output |
|-----------------|----------------|
| `df-implement` / `df-test` | Optional `DECISIONS:`; `AC_COVERAGE:...AC_COVERAGE_END`; `TASK_STATUS:pass\|fail\|revert` |
| `df-integration` | `AC_COVERAGE:...AC_COVERAGE_END`; `TASK_STATUS:pass\|fail` |
| `df-spike` | Result file; `PASSED/FAILED/INCONCLUSIVE`; `TASK_STATUS:pass\|fail` |
| `df-optimize` | `before {val} → after {val} ({pct}%)`; `TASK_STATUS:pass\|fail` |

Findings injection: when `findings.md` is available, inject as `PRIOR_FINDINGS:` block in agent prompt.

### §G. AUTO-VERIFY

After all tasks in all curated specs complete:
```
skill: "df:verify", args: "doing-{name} --from-execute"
```
Runs L0-L4 gates, merges branch, cleans worktree, renames `doing-` → `done-`, extracts decisions. The `--from-execute` flag prevents recursion (verify will not re-invoke execute). Fail (fix tasks added) → stop; `--continue` picks them up.

---

## Usage

```
/df:execute                    # Auto-detect: prompt to start a planned spec, or run all doing-* tasks
/df:execute {spec-name}        # Start execution on specs/{spec-name}.md (rename to doing- first)
/df:execute T1 T2              # Specific tasks (within active doing-*)
/df:execute --continue         # Resume checkpoint
/df:execute --fresh            # Ignore checkpoint, recreate worktree
/df:execute --dry-run          # Show plan only
```

The auto-promote flow (§0a) only fires when no `doing-*.md` exists. If you have a planned spec ready and want to skip the prompt, use the explicit form `/df:execute {spec-name}`.

## Skills & Agents

Skills: `atomic-commits`, `browse-fetch`.

**Model+effort routing** (read from spec, defaults: sonnet/medium):

| Effort | Preamble |
|--------|---------|
| low | `Maximally efficient: skip explanations, minimize tool calls, straight to implementation.` |
| medium | `Direct and efficient. Explain only non-obvious logic.` |
| high | _(none)_ |

**Checkpoint:** `.deepflow/checkpoint.json`:
```json
{
  "completed_tasks": ["T1"],
  "current_wave": 2,
  "pre_spawn_context_pct": 42,
  "worktree": ".deepflow/worktrees/curator-active",
  "branch": "df/curator-active",
  "retries": {"T3": 1}
}
```
`--continue` rehydrates `worktree` and `branch` directly. Pre-curator checkpoints (with `spec_worktrees` map) are not supported — delete `.deepflow/checkpoint.json` and re-run with `--fresh`.

## Failure Handling

Reverted task: `TaskUpdate(status: "pending")`, dependents stay blocked. Repeated failure → spawn reasoner debugger. Leave worktree+checkpoint intact. Output: path, `cd` command, `--continue`/`--fresh` options.

## Rules

| Rule | Detail |
|------|--------|
| 1 worktree | All curated tasks share `.deepflow/worktrees/curator-active/` |
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| Hook injects bundle | Orchestrator only references task ID; `df-context-injection.js` prepends bundle via PreToolUse |
| Curator owns conflicts | `[P]` only when file-touch sets are pairwise disjoint (enforced at curation time by `/df:spec`) |
| Zero tests → bootstrap first | Sole task when snapshot empty |
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
| Integration tasks run last | `Blocked by:` all producers; orchestrator augments bundle at execute time |
| CONTEXT_INSUFFICIENT | Max 2 retries; 3rd → abort with diagnostic |
