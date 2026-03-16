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

### 2.5. REGISTER NATIVE TASKS

For each `[ ]` task in PLAN.md: `TaskCreate(subject: "{task_id}: {description}", activeForm: "{gerund}", description: full block)`. Store task_id → native ID mapping. Set dependencies via `TaskUpdate(addBlockedBy: [...])`. On `--continue`: only register remaining `[ ]` items.

### 3. CHECK FOR UNPLANNED SPECS

Warn if `specs/*.md` (excluding doing-/done-) exist. Non-blocking.

### 4. IDENTIFY READY TASKS

Ready = TaskList where status: "pending" AND blockedBy: empty.

### 5. SPAWN AGENTS

Context ≥50%: checkpoint and exit.

Before spawning: `TaskUpdate(taskId: native_id, status: "in_progress")` — activates UI spinner.

**NEVER use `isolation: "worktree"` on Task calls.** Deepflow manages a shared worktree so wave 2 sees wave 1 commits.

**Spawn ALL ready tasks in ONE message** — EXCEPT file conflicts (see below).

**File conflict enforcement (1 file = 1 writer):**
Before spawning, check `Files:` lists of all ready tasks. If two+ ready tasks share a file:
1. Sort conflicting tasks by task number (T1 < T2 < T3)
2. Spawn only the lowest-numbered task from each conflict group
3. Remaining tasks stay `pending` — they become ready once the spawned task completes
4. Log: `"⏳ T{N} deferred — file conflict with T{M} on {filename}"`

**≥2 [SPIKE] tasks for same problem:** Follow Parallel Spike Probes (section 5.7).

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
   - Rank: fewer regressions > higher coverage_delta > fewer files_changed > first to complete
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
