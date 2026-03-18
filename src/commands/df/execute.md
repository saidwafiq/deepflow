---
name: df:execute
description: Execute tasks from PLAN.md with agent spawning, ratchet health checks, and worktree management
---

# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You are a coordinator. Spawn agents, run ratchet checks, update PLAN.md. Never implement code yourself.

**NEVER:** Read source files, edit code, use TaskOutput, use EnterPlanMode, use ExitPlanMode

**ONLY:** Read PLAN.md, read specs/doing-*.md, spawn background agents, run ratchet health checks after each agent completes, update PLAN.md, write `.deepflow/decisions.md` in the main tree

## Core Loop (Notification-Driven)

Each task = one background agent. Completion notifications drive the loop.

**NEVER use TaskOutput** — returns full transcripts (100KB+) that explode context.

```
1. Spawn ALL wave agents with run_in_background=true in ONE message
2. STOP. End your turn. Do NOT poll or monitor.
3. On EACH notification:
   a. Run ratchet check (section 5.5)
   b. Passed → TaskUpdate(status: "completed"), update PLAN.md [x] + commit hash
   c. Failed → run partial salvage protocol (section 5.5). If salvaged → treat as passed. If not → git revert, TaskUpdate(status: "pending")
   d. Report ONE line: "✓ T1: ratchet passed (abc123)" or "⚕ T1: salvaged lint fix (abc124)" or "✗ T1: ratchet failed, reverted"
   e. NOT all done → end turn, wait | ALL done → next wave or finish
4. Between waves: check context %. If ≥50% → checkpoint and exit.
5. Repeat until: all done, all blocked, or context ≥50%.
```

## Context Threshold

Statusline writes `.deepflow/context.json`: `{"percentage": 45}`

| Context % | Action |
|-----------|--------|
| < 50% | Full parallelism (up to 5 agents) |
| ≥ 50% | Wait for running agents, checkpoint, exit |

---

## Behavior

### 1. CHECK CHECKPOINT

```
--continue → Load .deepflow/checkpoint.json from worktree
  → Verify worktree exists on disk (else error: "Use --fresh")
  → Skip completed tasks, resume execution
--fresh → Delete checkpoint, start fresh
checkpoint exists → Prompt: "Resume? (y/n)"
else → Start fresh
```

Shell injection (use output directly — no manual file reads needed):
- `` !`cat .deepflow/checkpoint.json 2>/dev/null || echo 'NOT_FOUND'` ``
- `` !`git diff --quiet && echo 'CLEAN' || echo 'DIRTY'` ``

### 1.5. CREATE WORKTREE

Require clean HEAD (`git diff --quiet`). Derive SPEC_NAME from `specs/doing-*.md`.
Create worktree: `.deepflow/worktrees/{spec}` on branch `df/{spec}`.
Reuse if exists. `--fresh` deletes first.

If `worktree.sparse_paths` is non-empty in config, enable sparse checkout:
```bash
git worktree add --no-checkout -b df/{spec} .deepflow/worktrees/{spec}
cd .deepflow/worktrees/{spec}
git sparse-checkout set {sparse_paths...}
git checkout df/{spec}
```

### 1.6. RATCHET SNAPSHOT

Snapshot pre-existing test files in worktree — only these count for ratchet (agent-created tests excluded):

```bash
cd ${WORKTREE_PATH}
git ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
  > .deepflow/auto-snapshot.txt
```

### 1.7. NO-TESTS BOOTSTRAP

If snapshot has zero test files:

1. Spawn ONE bootstrap agent (section 6 Bootstrap Task) to write tests for `edit_scope` files
2. On ratchet pass: re-snapshot, report `"bootstrap: completed"`, end cycle (no PLAN.md tasks this cycle)
3. On ratchet fail: revert, halt with "Bootstrap failed — manual intervention required"

Subsequent cycles use bootstrapped tests as ratchet baseline.

### 2. LOAD PLAN

```
Load: PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml
If missing: "No PLAN.md found. Run /df:plan first."
```

Shell injection (use output directly — no manual file reads needed):
- `` !`cat .deepflow/checkpoint.json 2>/dev/null || echo 'NOT_FOUND'` ``
- `` !`git diff --quiet && echo 'CLEAN' || echo 'DIRTY'` ``

### 2.5. REGISTER NATIVE TASKS

For each `[ ]` task in PLAN.md: `TaskCreate(subject: "{task_id}: {description}", activeForm: "{gerund}", description: full block)`. Store task_id → native ID mapping. Set dependencies via `TaskUpdate(addBlockedBy: [...])`. On `--continue`: only register remaining `[ ]` items.

### 3. CHECK FOR UNPLANNED SPECS

Warn if `specs/*.md` (excluding doing-/done-) exist. Non-blocking.

### 4. IDENTIFY READY TASKS

Ready = TaskList where status: "pending" AND blockedBy: empty.

### 5. SPAWN AGENTS

Context ≥50%: checkpoint and exit.

Before spawning: `TaskUpdate(taskId: native_id, status: "in_progress")` — activates UI spinner.

**Token tracking — record start:**
```
start_percentage = !`grep -o '"percentage":[0-9]*' .deepflow/context.json 2>/dev/null | grep -o '[0-9]*' || echo ''`
start_timestamp  = !`date -u +%Y-%m-%dT%H:%M:%SZ`
```
Store both values in memory (keyed by task_id) for use after ratchet completes. Omit if context.json unavailable.

**NEVER use `isolation: "worktree"` on Task calls.** Deepflow manages a shared worktree so wave 2 sees wave 1 commits.

**Spawn ALL ready tasks in ONE message** — EXCEPT file conflicts (see below).

**File conflict enforcement (1 file = 1 writer):**
Before spawning, check `Files:` lists of all ready tasks. If two+ ready tasks share a file:
1. Sort conflicting tasks by task number (T1 < T2 < T3)
2. Spawn only the lowest-numbered task from each conflict group
3. Remaining tasks stay `pending` — they become ready once the spawned task completes
4. Log: `"⏳ T{N} deferred — file conflict with T{M} on {filename}"`

**≥2 [SPIKE] tasks for same problem:** Follow Parallel Spike Probes (section 5.7).

**[OPTIMIZE] tasks:** Follow Optimize Cycle (section 5.9). Only ONE optimize task runs at a time — defer others until the active one completes.

### 5.5. RATCHET CHECK

After each agent completes, run health checks in the worktree.

**Auto-detect commands:**

| File | Build | Test | Typecheck | Lint |
|------|-------|------|-----------|------|
| `package.json` | `npm run build` | `npm test` | `npx tsc --noEmit` | `npm run lint` |
| `pyproject.toml` | — | `pytest` | `mypy .` | `ruff check .` |
| `Cargo.toml` | `cargo build` | `cargo test` | — | `cargo clippy` |
| `go.mod` | `go build ./...` | `go test ./...` | — | `go vet ./...` |

Run Build → Test → Typecheck → Lint (stop on first failure).

**Edit scope validation** (if spec declares `edit_scope`): check `git diff HEAD~1 --name-only` against allowed globs. Violations → `git revert HEAD --no-edit`, report "Edit scope violation: {files}".

**Impact completeness check** (if task has Impact block in PLAN.md):
Compare `git diff HEAD~1 --name-only` against Impact callers/duplicates list.
File listed but not modified → **advisory warning**: "Impact gap: {file} listed as {caller|duplicate} but not modified — verify manually". Not auto-revert (callers sometimes don't need changes), but flags the risk.

**Metric gate (Optimize tasks only):**

After ratchet passes, if the current task has an `Optimize:` block, run the metric gate:

1. Run the `metric` shell command in the worktree: `cd ${WORKTREE_PATH} && eval "${metric_command}"`
2. Parse output as float. Non-numeric output → cycle failure (revert, log "metric parse error: {raw output}")
3. Compare against previous measurement using `direction`:
   - `direction: higher` → new value must be > previous + (previous × min_improvement_threshold)
   - `direction: lower` → new value must be < previous - (previous × min_improvement_threshold)
4. Both ratchet AND metric improvement required → keep commit
5. Ratchet passes but metric did not improve → revert (log "ratchet passed but metric stagnant/regressed: {old} → {new}")
6. Run each `secondary_metrics` command, parse as float. If regression > `regression_threshold` (default 5%) compared to baseline: append WARNING to `.deepflow/auto-report.md`: `"WARNING: {name} regressed {delta}% ({baseline_val} → {new_val}) at cycle {N}"`. Do NOT auto-revert.

**Output Truncation:**

After ratchet checks complete, truncate command output for context efficiency:

- **Success (all checks passed):** Suppress output entirely — do not include build/test/lint output in reports
- **Build failure:** Include last 15 lines of build error only
- **Test failure:** Include failed test name(s) + last 20 lines of test output
- **Typecheck/lint failure:** Include error count + first 5 errors only

**Token tracking — write result (on ratchet pass):**

After all checks pass, compute and write the token block to `.deepflow/results/T{N}.yaml`:

```
end_percentage = !`grep -o '"percentage":[0-9]*' .deepflow/context.json 2>/dev/null | grep -o '[0-9]*' || echo ''`
```

Parse `.deepflow/token-history.jsonl` to sum token fields for lines whose `timestamp` falls between `start_timestamp` and `end_timestamp` (ISO 8601 compare):
```bash
awk -v start="REPLACE_start_timestamp" -v end="REPLACE_end_timestamp" '
{
  ts=""; inp=0; cre=0; rd=0
  if (match($0, /"timestamp":"[^"]*"/)) { ts=substr($0, RSTART+13, RLENGTH-14) }
  if (ts >= start && ts <= end) {
    if (match($0, /"input_tokens":[0-9]+/)) inp=substr($0, RSTART+15, RLENGTH-15)
    if (match($0, /"cache_creation_input_tokens":[0-9]+/)) cre=substr($0, RSTART+30, RLENGTH-30)
    if (match($0, /"cache_read_input_tokens":[0-9]+/)) rd=substr($0, RSTART+26, RLENGTH-26)
    si+=inp; sc+=cre; sr+=rd
  }
}
END { printf "{\"input_tokens\":%d,\"cache_creation_input_tokens\":%d,\"cache_read_input_tokens\":%d}\n", si+0, sc+0, sr+0 }
' .deepflow/token-history.jsonl 2>/dev/null || echo '{}'
```

Append (or create) `.deepflow/results/T{N}.yaml` with the following block. Use shell injection to read the existing file first:
```
!`cat .deepflow/results/T{N}.yaml 2>/dev/null || echo ''`
```

Write the `tokens` block:
```yaml
tokens:
  start_percentage: {start_percentage}
  end_percentage: {end_percentage}
  delta_percentage: {end_percentage - start_percentage}
  input_tokens: {sum from jsonl}
  cache_creation_input_tokens: {sum from jsonl}
  cache_read_input_tokens: {sum from jsonl}
```

**Omit entirely if:** context.json was unavailable at start OR end, OR token-history.jsonl is missing, OR awk is unavailable. Never fail the ratchet due to token tracking errors.

**Evaluate:** All pass + no violations → commit stands. Any failure → attempt partial salvage before reverting:

**Partial salvage protocol:**
1. Run `git diff HEAD~1 --stat` to see what the agent changed
2. If failure is lint-only or typecheck-only (build + tests passed):
   - Spawn `Agent(model="haiku", subagent_type="general-purpose")` with prompt: `Fix the {lint|typecheck} errors in the worktree. Only fix what's broken, change nothing else. Files changed: {diff stat}. Error output: {error}`
   - Run ratchet again on the fix commit
   - If passes → both commits stand. If fails → `git revert HEAD --no-edit && git revert HEAD --no-edit` (revert both)
3. If failure is build or test → `git revert HEAD --no-edit` (no salvage, too risky)

Ratchet uses ONLY pre-existing test files from `.deepflow/auto-snapshot.txt`.

### 5.7. PARALLEL SPIKE PROBES

Trigger: ≥2 [SPIKE] tasks with same "Blocked by:" target or identical hypothesis.

1. **Baseline:** Record `BASELINE=$(git rev-parse HEAD)` in shared worktree
2. **Sub-worktrees:** Per spike: `git worktree add -b df/{spec}--probe-{SPIKE_ID} .deepflow/worktrees/{spec}/probe-{SPIKE_ID} ${BASELINE}`
3. **Spawn:** All probes in ONE message, each targeting its probe worktree. End turn.
4. **Ratchet:** Per notification, run standard ratchet (5.5) in probe worktree. Record: ratchet_passed, regressions, coverage_delta, files_changed, commit
5. **Select winner** (after ALL complete, no LLM judge):
   - Disqualify any with regressions
   - **Standard spikes**: Rank: fewer regressions > higher coverage_delta > fewer files_changed > first to complete
   - **Optimize probes**: Rank: best metric improvement (absolute delta toward target) > fewer regressions > fewer files_changed
   - No passes → reset all to pending for retry with debugger
6. **Preserve all worktrees.** Losers: rename branch + `-failed` suffix. Record in checkpoint.json under `"spike_probes"`
7. **Log ALL probe outcomes** to `.deepflow/auto-memory.yaml` (main tree):
   ```yaml
   spike_insights:
     - date: "YYYY-MM-DD"
       spec: "{spec_name}"
       spike_id: "SPIKE_A"
       hypothesis: "{from PLAN.md}"
       outcome: "winner"
       approach: "{one-sentence summary of what the winning probe chose}"
       ratchet_metrics: {regressions: N, coverage_delta: N, files_changed: N}
       branch: "df/{spec}--probe-SPIKE_A"
     - date: "YYYY-MM-DD"
       spec: "{spec_name}"
       spike_id: "SPIKE_B"
       hypothesis: "{from PLAN.md}"
       outcome: "failed"  # or "passed-but-lost"
       failure_reason: "{first failed check + error summary}"
       ratchet_metrics: {regressions: N, coverage_delta: N, files_changed: N}
       worktree: ".deepflow/worktrees/{spec}/probe-SPIKE_B-failed"
       branch: "df/{spec}--probe-SPIKE_B-failed"
   probe_learnings:  # read by /df:auto-cycle each start AND included in per-task preamble
     - spike: "SPIKE_A"
       probe: "probe-SPIKE_A"
       insight: "{one-sentence summary of winning approach — e.g. 'Use Node.js over Bun for Playwright'}"
     - spike: "SPIKE_B"
       probe: "probe-SPIKE_B"
       insight: "{one-sentence summary from failure_reason}"
   ```
   Create file if missing. Preserve existing keys when merging. Log BOTH winners and losers — downstream tasks need to know what was chosen, not just what failed.
8. **Promote winner:** Cherry-pick into shared worktree. Winner → `[x] [PROBE_WINNER]`, losers → `[~] [PROBE_FAILED]`. Resume standard loop.

#### 5.7.1. PROBE DIVERSITY ENFORCEMENT (Optimize Probes)

When spawning probes for optimize plateau resolution, enforce diversity roles:

**Role definitions:**
- **contextualizada**: Builds on the best approach so far — refines, extends, or combines what worked. Prompt includes: "Build on the best result so far: {best_approach_summary}. Refine or extend it."
- **contraditoria**: Tries the opposite of the current best. Prompt includes: "The best approach so far is {best_approach_summary}. Try the OPPOSITE direction — if it cached, don't cache; if it optimized hot path, optimize cold path; etc."
- **ingenua**: No prior context — naive fresh attempt. Prompt includes: "Ignore all prior attempts. Approach this from scratch with no assumptions about what works."

**Auto-scaling by probe round:**

| Probe round | Count | Required roles |
|-------------|-------|----------------|
| 1st plateau | 2 | 1 contraditoria + 1 ingenua |
| 2nd plateau | 4 | 1 contextualizada + 2 contraditoria + 1 ingenua |
| 3rd+ plateau | 6 | 2 contextualizada + 2 contraditoria + 2 ingenua |

**Rules:**
- Every probe set MUST include ≥1 contraditoria and ≥1 ingenua (minimum diversity)
- contextualizada only added from round 2+ (needs prior data to build on)
- Each probe prompt includes its role label and role-specific instruction
- Probe scale persists in `optimize_state.probe_scale` in `auto-memory.yaml`

### 5.9. OPTIMIZE CYCLE

Trigger: task has `Optimize:` block in PLAN.md. Runs instead of standard single-agent spawn.

**Optimize is a distinct execution mode** — one optimize task at a time, spanning N cycles until a stop condition.

#### 5.9.1. INITIALIZATION

1. Parse `Optimize:` block from PLAN.md task: `metric`, `target`, `direction`, `max_cycles`, `secondary_metrics`
2. Load or initialize `optimize_state` from `.deepflow/auto-memory.yaml`:
   ```yaml
   optimize_state:
     task_id: "T{n}"
     metric_command: "{shell command}"
     target: {number}
     direction: "higher|lower"
     baseline: null          # set on first measure
     current_best: null      # best metric value seen
     best_commit: null       # commit hash of best value
     cycles_run: 0
     cycles_without_improvement: 0
     consecutive_reverts: 0
     probe_scale: 0          # 0=no probes yet, 2/4/6
     max_cycles: {number}
     history: []             # [{cycle, value, delta, kept, commit}]
     failed_hypotheses: []   # ["{description}"]
   ```
3. **Measure baseline**: `cd ${WORKTREE_PATH} && eval "${metric_command}"` → parse float → store as `baseline` and `current_best`
4. Measure each secondary metric → store as `secondary_baselines`
5. Check if target already met (`direction: higher` → baseline >= target; `lower` → baseline <= target). If met → mark task `[x]`, log "target already met: {baseline}", done.

#### 5.9.2. CYCLE LOOP

Each cycle = one agent spawn + measure + keep/revert decision.

```
REPEAT:
  1. Check stop conditions (5.9.3) → if triggered, exit loop
  2. Spawn ONE optimize agent (section 6, Optimize Task prompt) with run_in_background=true
  3. STOP. End turn. Wait for notification.
  4. On notification:
     a. Run ratchet check (section 5.5) — build/test/lint must pass
     b. If ratchet fails → git revert HEAD --no-edit, increment consecutive_reverts, log failed hypothesis, go to step 1
     c. Run metric gate (section 5.5 metric gate) — measure new value
     d. If metric parse error → git revert HEAD --no-edit, increment consecutive_reverts, log "metric parse error"
     e. Compute improvement:
        - direction: higher → improvement = (new - current_best) / |current_best| × 100
        - direction: lower  → improvement = (current_best - new) / |current_best| × 100
        - current_best == 0 → use absolute delta
     f. If improvement >= min_improvement_threshold (default 1%):
        → KEEP: update current_best, best_commit, reset cycles_without_improvement=0, reset consecutive_reverts=0
     g. If improvement < min_improvement_threshold:
        → REVERT: git revert HEAD --no-edit, increment cycles_without_improvement
     h. Increment cycles_run
     i. Append to history: {cycle, value, delta_pct, kept: bool, commit}
     j. Measure secondary metrics, check regression (WARNING only, no revert)
     k. Persist optimize_state to auto-memory.yaml
     l. Report: "⟳ T{n} cycle {N}: {old} → {new} ({+/-delta}%) — {kept|reverted} [best: {current_best}, target: {target}]"
     m. Check context %. If ≥50% → checkpoint and exit (auto-cycle resumes).
```

#### 5.9.3. STOP CONDITIONS

| Condition | Detection | Action |
|-----------|-----------|--------|
| **Target reached** | `direction: higher` → value >= target; `lower` → value <= target | Mark task `[x]`, log "target reached: {value}" |
| **Max cycles** | `cycles_run >= max_cycles` | Mark task `[x]` with note: "max cycles reached, best: {current_best}". If current_best worse than baseline → `git reset --hard {best_commit}`, log "reverted to best-known" |
| **Plateau** | `cycles_without_improvement >= 3` | Pause normal cycle → launch probes (5.9.4) |
| **Circuit breaker** | `consecutive_reverts >= 3` | Halt, task stays `[ ]`, log "circuit breaker: 3 consecutive reverts". Requires human intervention. |

On **max cycles** with final value worse than baseline:
1. `git reset --hard {best_commit}` in worktree
2. Log: "final value {current} worse than baseline {baseline}, reverted to best-known commit {best_commit} (value: {current_best})"

#### 5.9.4. PLATEAU → PROBE LAUNCH

When plateau detected (3 cycles without ≥1% improvement):

1. Pause normal optimize cycle
2. Determine probe count from `probe_scale` (section 5.7.1 auto-scaling table): 0→2, 2→4, 4→6
3. Update `probe_scale` in optimize_state
4. Record `BASELINE=$(git rev-parse HEAD)` in shared worktree
5. Create sub-worktrees per probe: `git worktree add -b df/{spec}--opt-probe-{N} .deepflow/worktrees/{spec}/opt-probe-{N} ${BASELINE}`
6. Spawn ALL probes in ONE message using Optimize Probe prompt (section 6), each with its diversity role
7. End turn. Wait for all notifications.
8. Per notification: run ratchet + metric measurement in probe worktree
9. Select winner (section 5.7 step 5, optimize ranking): best metric improvement toward target
10. Winner → cherry-pick into shared worktree, update current_best, reset cycles_without_improvement=0
11. Losers → rename branch with `-failed` suffix, preserve worktrees
12. Log all probe outcomes to `auto-memory.yaml` under `spike_insights` (reuse existing format)
13. Log probe learnings: winning approach summary + each loser's failure reason
14. Resume normal optimize cycle from step 1

#### 5.9.5. STATE PERSISTENCE (auto-memory.yaml)

After every cycle, write `optimize_state` to `.deepflow/auto-memory.yaml` (main tree). This ensures:
- Context exhaustion at 50% → auto-cycle resumes with full history
- Failed hypotheses carry forward (agents won't repeat approaches)
- Probe scale persists across context windows

Also append cycle results to `.deepflow/auto-report.md`:
```
## Optimize: T{n} — {metric_name}
| Cycle | Value | Delta | Kept | Commit |
|-------|-------|-------|------|--------|
| 1 | 72.3 | — | baseline | abc123 |
| 2 | 74.1 | +2.5% | ✓ | def456 |
| 3 | 73.8 | -0.4% | ✗ | (reverted) |
...
Best: {current_best} | Target: {target} | Status: {in_progress|reached|max_cycles|circuit_breaker}
```

---

### 6. PER-TASK (agent prompt)

> **Context engineering rationale:** Prompt order follows the attention U-curve (start/end = high attention, middle = low).
> Critical instructions go at start and end. Navigable data goes in the middle.
> See: Chroma "Context Rot" (2025) — performance degrades ~2%/100K tokens; distractors and semantic ambiguity compound degradation.

**Common preamble (include in all agent prompts):**
```
Working directory: {worktree_absolute_path}
All file operations MUST use this absolute path as base. Do NOT write files to the main project directory.
Commit format: {commit_type}({spec}): {description}
```

**Standard Task** (spawn with `Agent(model="{Model from PLAN.md}", ...)`):

Prompt sections in order (START = high attention, MIDDLE = navigable data, END = high attention):

```
--- START (high attention zone) ---

{task_id}: {description from PLAN.md}
Files: {target files}  Spec: {spec_name}

{Prior failure context — include ONLY if task was previously reverted. Read from .deepflow/auto-memory.yaml revert_history for this task_id:}
DO NOT repeat these approaches:
- Cycle {N}: reverted — "{reason from revert_history}"
{Omit this entire block if task has no revert history.}

{Acceptance criteria excerpt — extract 2-3 key ACs from the spec file (specs/doing-*.md). Include only the criteria relevant to THIS task, not the full spec.}
Success criteria:
- {AC relevant to this task}
- {AC relevant to this task}
{Omit if spec has no structured ACs.}

--- MIDDLE (navigable data zone) ---

{Impact block from PLAN.md — include verbatim if present. Annotate each caller with WHY it's impacted:}
Impact:
  - Callers: {file} ({why — e.g. "imports validateToken which you're changing"})
  - Duplicates:
    - {file} [active — consolidate]
    - {file} [dead — DELETE]
  - Data flow: {consumers}
{Omit if no Impact in PLAN.md.}

{Dependency context — for each completed blocker task, include a one-liner summary:}
Prior tasks:
- {dep_task_id}: {one-line summary of what changed — e.g. "refactored validateToken to async, changed signature (string) → (string, opts)"}
{Omit if task has no dependencies or all deps are bootstrap/spike tasks.}

Steps:
1. External APIs/SDKs → chub search "<library>" --json → chub get <id> --lang <lang> (skip if chub unavailable or internal code only)
2. LSP freshness check: run `findReferences` on each function/type you're about to change. If callers exist beyond the Impact list, add them to your scope before implementing.
3. Read ALL files in Impact (+ any new callers from step 2) before implementing — understand the full picture
4. Implement the task, updating all impacted files
5. Commit as feat({spec}): {description}

--- END (high attention zone) ---

{If .deepflow/auto-memory.yaml exists and has probe_learnings, include:}
Spike results (follow these approaches):
{each probe_learning with outcome "winner" → "- {insight}"}
{Omit this block if no probe_learnings exist.}

If Impact lists duplicates: [active] → consolidate into single source of truth. [dead] → DELETE entirely.
Your ONLY job is to write code and commit. Orchestrator runs health checks after.
STOP after committing. Do NOT merge branches, rename spec files, remove worktrees, or run git checkout on main.
```

**Effort-aware context budget:** For `Effort: low` tasks, omit the MIDDLE section entirely (no Impact, no dependency context, no steps). For `Effort: medium`, include Impact but omit dependency context. For `Effort: high`, include everything.

**Bootstrap Task:**
```
BOOTSTRAP: Write tests for files in edit_scope
Files: {edit_scope files}  Spec: {spec_name}

Write tests covering listed files. Do NOT change implementation files.
Commit as test({spec}): bootstrap tests for edit_scope
```

**Spike Task:**
```
{task_id} [SPIKE]: {hypothesis}
Files: {target files}  Spec: {spec_name}

{Prior failure context — include ONLY if this spike was previously reverted. Read from .deepflow/auto-memory.yaml revert_history + spike_insights for this task_id:}
DO NOT repeat these approaches:
- Cycle {N}: reverted — "{reason}"
{Omit this entire block if no revert history.}

Implement minimal spike to validate hypothesis.
Commit as spike({spec}): {description}
```

**Optimize Task** (spawn with `Agent(model="opus", subagent_type="general-purpose")`):

One agent per cycle. Agent makes ONE atomic change to improve the metric.

```
--- START (high attention zone) ---

{task_id} [OPTIMIZE]: Improve {metric_name} — cycle {N}/{max_cycles}
Files: {target files}  Spec: {spec_name}

Current metric: {current_value} (baseline: {baseline}, best: {current_best})
Target: {target} ({direction})
Improvement needed: {delta_to_target} ({direction})

CONSTRAINT: Make exactly ONE atomic change. Do not refactor broadly.
The metric is measured by: {metric_command}
You succeed if the metric moves toward {target} after your change.

--- MIDDLE (navigable data zone) ---

Attempt history (last 5 cycles):
{For each recent history entry:}
- Cycle {N}: {value} ({+/-delta}%) — {kept|reverted} — "{one-line description of what was tried}"
{Omit if cycle 1.}

DO NOT repeat these failed approaches:
{For each failed_hypothesis in optimize_state:}
- "{hypothesis description}"
{Omit if no failed hypotheses.}

{Impact block from PLAN.md if present}

{Dependency context if present}

Steps:
1. Analyze the metric command to understand what's being measured
2. Read the target files and identify ONE specific improvement
3. Implement the change (ONE atomic modification)
4. Commit as feat({spec}): optimize {metric_name} — {what you changed}

--- END (high attention zone) ---

{Spike/probe learnings if any}

Your ONLY job is to make ONE atomic change and commit. Orchestrator measures the metric after.
Do NOT run the metric command yourself. Do NOT make multiple changes.
STOP after committing. Do NOT merge branches, rename spec files, remove worktrees, or run git checkout on main.
```

**Optimize Probe Task** (spawn with `Agent(model="opus", subagent_type="general-purpose")`):

Used during plateau resolution. Each probe has a diversity role.

```
--- START (high attention zone) ---

{task_id} [OPTIMIZE PROBE]: {metric_name} — probe {probe_id} ({role_label})
Files: {target files}  Spec: {spec_name}

Current metric: {current_value} (baseline: {baseline}, best: {current_best})
Target: {target} ({direction})

Role: {role_label}
{role_instruction — one of:}
  contextualizada: "Build on the best approach so far: {best_approach_summary}. Refine, extend, or combine what worked."
  contraditoria: "The best approach so far was: {best_approach_summary}. Try the OPPOSITE — if it optimized X, try Y instead. Challenge the current direction."
  ingenua: "Ignore all prior attempts. Approach this metric from scratch with no assumptions about what has or hasn't worked."

--- MIDDLE (navigable data zone) ---

Full attempt history:
{ALL history entries from optimize_state}
- Cycle {N}: {value} ({+/-delta}%) — {kept|reverted}

All failed approaches (DO NOT repeat):
{ALL failed_hypotheses}
- "{hypothesis description}"

--- END (high attention zone) ---

Make ONE atomic change that moves the metric toward {target}.
Commit as feat({spec}): optimize probe {probe_id} — {what you changed}
STOP after committing.
```

### 8. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Run `/df:verify doing-{name}` via the Skill tool (`skill: "df:verify", args: "doing-{name}"`)
   - Verify runs quality gates (L0-L4), merges worktree branch to main, cleans up worktree, renames spec `doing-*` → `done-*`, and extracts decisions
   - If verify fails (adds fix tasks): stop here — `/df:execute --continue` will pick up the fix tasks
   - If verify passes: proceed to step 2
2. Remove spec's ENTIRE section from PLAN.md (header, tasks, summaries, fix tasks, separators)
3. Recalculate Summary table at top of PLAN.md

---

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
- Skill: `browse-fetch` — Fetch live web pages and external API docs via browser before coding

| Agent | subagent_type | Purpose |
|-------|---------------|---------|
| Implementation | `general-purpose` | Task implementation |
| Debugger | `reasoner` | Debugging failures |

**Model + effort routing:** Read `Model:` and `Effort:` fields from each task block in PLAN.md. Pass `model:` parameter when spawning the agent. Prepend effort instruction to the agent prompt. Defaults: `Model: sonnet`, `Effort: medium`.

| Task fields | Agent call | Prompt preamble |
|-------------|-----------|-----------------|
| `Model: haiku, Effort: low` | `Agent(model="haiku", ...)` | `You MUST be maximally efficient: skip explanations, minimize tool calls, go straight to implementation.` |
| `Model: sonnet, Effort: medium` | `Agent(model="sonnet", ...)` | `Be direct and efficient. Explain only when the logic is non-obvious.` |
| `Model: opus, Effort: high` | `Agent(model="opus", ...)` | _(no preamble — default behavior)_ |
| (missing) | `Agent(model="sonnet", ...)` | `Be direct and efficient. Explain only when the logic is non-obvious.` |

**Effort preamble rules:**
- `low` → Prepend efficiency instruction. Agent should make fewest possible tool calls.
- `medium` → Prepend balanced instruction. Agent skips preamble but explains non-obvious decisions.
- `high` → No preamble added. Agent uses full reasoning capabilities.

**Checkpoint schema:** `.deepflow/checkpoint.json` in worktree:
```json
{"completed_tasks": ["T1","T2"], "current_wave": 2, "worktree_path": ".deepflow/worktrees/upload", "worktree_branch": "df/upload"}
```

---

## Failure Handling

When task fails ratchet and is reverted:
- `TaskUpdate(taskId: native_id, status: "pending")` — dependents remain blocked
- Repeated failure → spawn `Task(subagent_type="reasoner", prompt="Debug failure: {ratchet output}")`
- Leave worktree intact, keep checkpoint.json
- Output: worktree path/branch, `cd {path}` to investigate, `--continue` to resume, `--fresh` to discard

## Rules

| Rule | Detail |
|------|--------|
| Zero test files → bootstrap first | Bootstrap is cycle's sole task when snapshot empty |
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| 1 file = 1 writer | Sequential if conflict |
| Agent writes code, orchestrator measures | Ratchet is the judge |
| No LLM evaluates LLM work | Health checks only |
| ≥2 spikes same problem → parallel probes | Never run competing spikes sequentially |
| All probe worktrees preserved | Losers renamed `-failed`; never deleted |
| Machine-selected winner | Regressions > coverage > files changed; no LLM judge |
| External APIs → chub first | Skip if unavailable |
| 1 optimize task at a time | Inherently sequential — no parallel optimize tasks |
| Optimize = atomic changes only | One modification per cycle for diagnosability |
| Ratchet + metric = both required | Optimize keeps commit only if ratchet AND metric improve |
| Plateau → probes, not more cycles | 3 cycles without ≥1% improvement triggers probe launch |
| Circuit breaker = 3 consecutive reverts | Halts optimize loop, requires human intervention |
| Optimize probes need diversity | Every probe set: ≥1 contraditoria + ≥1 ingenua minimum |

## Example

```
/df:execute (context: 12%)

Loading PLAN.md... T1 ready, T2/T3 blocked by T1
Ratchet snapshot: 24 pre-existing test files

Wave 1: TaskUpdate(T1, in_progress)
[Agent "T1" completed]
  Running ratchet: build ✓ | tests ✓ (24 passed) | typecheck ✓
  ✓ T1: ratchet passed (abc1234)
  TaskUpdate(T1, completed) → auto-unblocks T2, T3

Wave 2: TaskUpdate(T2/T3, in_progress)
[Agent "T2" completed]  ✓ T2: ratchet passed (def5678)
[Agent "T3" completed]  ✓ T3: ratchet passed (ghi9012)

Context: 35% — All tasks done for doing-upload.
Running /df:verify doing-upload...
  ✓ L0 | ✓ L1 (3/3 files) | ⚠ L2 (no coverage tool) | ✓ L4 (24 tests)
  ✓ Merged df/upload to main
  ✓ Spec complete: doing-upload → done-upload
Complete: 3/3
```
