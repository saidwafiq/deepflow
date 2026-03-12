# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You are a coordinator. Spawn agents, run ratchet checks, update PLAN.md. Never implement code yourself.

**NEVER:** Read source files, edit code, use TaskOutput, use EnterPlanMode, use ExitPlanMode

**ONLY:** Read PLAN.md, read specs/doing-*.md, spawn background agents, run ratchet health checks after each agent completes, update PLAN.md, write `.deepflow/decisions.md` in the main tree

---

## Purpose
Implement tasks from PLAN.md with parallel agents, atomic commits, ratchet-driven quality gates, and context-efficient execution.

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
- Skill: `context-hub` — Fetch external API docs before coding (when task involves external libraries)

**Use Task tool to spawn agents:**
| Agent | subagent_type | Purpose |
|-------|---------------|---------|
| Implementation | `general-purpose` | Task implementation |
| Debugger | `reasoner` | Debugging failures |

**Model routing from frontmatter:**
The model for each agent is determined by the `model:` field in the command/agent/skill frontmatter being invoked. The orchestrator reads the relevant frontmatter to determine which model to pass to `Task()`. If no `model:` field is present in the frontmatter, default to `sonnet`.

## Context-Aware Execution

Statusline writes to `.deepflow/context.json`: `{"percentage": 45}`

| Context % | Action |
|-----------|--------|
| < 50% | Full parallelism (up to 5 agents) |
| ≥ 50% | Wait for running agents, checkpoint, exit |

## Agent Protocol

Each task = one background agent. Use agent completion notifications as the feedback loop.

**NEVER use TaskOutput** — returns full agent transcripts (100KB+) that explode context.

### Notification-Driven Execution

```
1. Spawn ALL wave agents with run_in_background=true in ONE message
2. STOP. End your turn. Do NOT run Bash monitors or poll for results.
3. Wait for "Agent X completed" notifications (they arrive automatically)
4. On EACH notification:
   a. Run ratchet check (health checks on the worktree)
   b. Report: "✓ T1: ratchet passed (abc123)" or "✗ T1: ratchet failed, reverted"
   c. Update PLAN.md for that task
   d. Check: all wave agents done?
      - No → end turn, wait for next notification
      - Yes → proceed to next wave or write final summary
```

After spawning, your turn ENDS. Per notification: run ratchet, output ONE line, update PLAN.md. Write full summary only after ALL wave agents complete.

## Checkpoint & Resume

**File:** `.deepflow/checkpoint.json` — stored in WORKTREE directory, not main.

**Schema:**
```json
{
  "completed_tasks": ["T1", "T2"],
  "current_wave": 2,
  "worktree_path": ".deepflow/worktrees/upload",
  "worktree_branch": "df/upload"
}
```

**On checkpoint:** Complete wave → update PLAN.md → save to worktree → exit.
**Resume:** `--continue` loads checkpoint, verifies worktree, skips completed tasks.

## Behavior

### 1. CHECK CHECKPOINT

```
--continue → Load checkpoint
  → If worktree_path exists:
    → Verify worktree still exists on disk
    → If missing: Error "Worktree deleted. Use --fresh"
    → If exists: Use it, skip worktree creation
  → Resume execution with completed tasks
--fresh → Delete checkpoint, start fresh
checkpoint exists → Prompt: "Resume? (y/n)"
else → Start fresh
```

### 1.5. CREATE WORKTREE

Before spawning any agents, create an isolated worktree:

```
# Check main is clean (ignore untracked)
git diff --quiet HEAD || Error: "Main has uncommitted changes. Commit or stash first."

# Generate paths
SPEC_NAME=$(basename spec/doing-*.md .md | sed 's/doing-//')
BRANCH_NAME="df/${SPEC_NAME}"
WORKTREE_PATH=".deepflow/worktrees/${SPEC_NAME}"

# Create worktree (or reuse existing)
if [ -d "${WORKTREE_PATH}" ]; then
  echo "Reusing existing worktree"
else
  git worktree add -b "${BRANCH_NAME}" "${WORKTREE_PATH}"
fi
```

**Existing worktree:** Reuse it (same spec = same worktree).

**--fresh flag:** Deletes existing worktree and creates new one.

### 1.6. RATCHET SNAPSHOT

Before spawning agents, snapshot pre-existing test files:

```bash
cd ${WORKTREE_PATH}

# Snapshot pre-existing test files (only these count for ratchet)
git ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
  > .deepflow/auto-snapshot.txt

echo "Ratchet snapshot: $(wc -l < .deepflow/auto-snapshot.txt) pre-existing test files"
```

**Only pre-existing test files are used for ratchet evaluation.** New test files created by agents during implementation don't influence the pass/fail decision. This prevents agents from gaming the ratchet by writing tests that pass trivially.

### 1.7. NO-TESTS BOOTSTRAP

After the ratchet snapshot, check if zero test files were found:

```bash
TEST_COUNT=$(wc -l < .deepflow/auto-snapshot.txt | tr -d ' ')

if [ "${TEST_COUNT}" = "0" ]; then
  echo "Bootstrap needed: no pre-existing test files found."
  BOOTSTRAP_NEEDED=true
else
  BOOTSTRAP_NEEDED=false
fi
```

**If `BOOTSTRAP_NEEDED=true`:**

1. **Inject a bootstrap task** as the FIRST action before any regular PLAN.md task is executed:
   - Bootstrap task description: "Write tests for files in edit_scope"
   - Read `edit_scope` from `specs/doing-*.md` to know which files need tests
   - Spawn ONE dedicated bootstrap agent using the Bootstrap Task prompt (section 6)

2. **Bootstrap agent behavior:**
   - Write tests covering the files listed in `edit_scope`
   - Commit as `test({spec}): bootstrap tests for edit_scope`
   - The bootstrap agent's ONLY job is writing tests — no implementation changes

3. **After bootstrap agent completes:**
   - Run ratchet health checks (build must pass; test suite must not error out)
   - If ratchet passes: re-take the ratchet snapshot so subsequent tasks use the new tests as baseline:
     ```bash
     cd ${WORKTREE_PATH}
     git ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
       > .deepflow/auto-snapshot.txt
     echo "Post-bootstrap snapshot: $(wc -l < .deepflow/auto-snapshot.txt) test files"
     ```
   - If ratchet fails: revert bootstrap commit, log error, halt and report "Bootstrap failed — manual intervention required"

4. **Signal to caller:** After bootstrap completes successfully, report `"bootstrap: completed"` in the cycle summary. This cycle's sole output is the test bootstrap — no regular PLAN.md task is executed this cycle.

5. **Subsequent cycles:** The updated `.deepflow/auto-snapshot.txt` now contains the bootstrapped test files. All subsequent ratchet checks use these as the baseline.

**If `BOOTSTRAP_NEEDED=false`:** Proceed normally to section 2.

### 2. LOAD PLAN

```
Load: PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml
If missing: "No PLAN.md found. Run /df:plan first."
```

### 2.5. REGISTER NATIVE TASKS

For each `[ ]` task in PLAN.md: `TaskCreate(subject: "{task_id}: {description}", activeForm: "{gerund}", description: full block)`. Store task_id → native ID mapping. Then set dependencies: `TaskUpdate(addBlockedBy: [...])` for each "Blocked by:" entry. On `--continue`: only register remaining `[ ]` items.

### 3. CHECK FOR UNPLANNED SPECS

Warn if `specs/*.md` (excluding doing-/done-) exist. Non-blocking.

### 4. IDENTIFY READY TASKS

Use TaskList to find ready tasks:

```
Ready = TaskList results where:
  - status: "pending"
  - blockedBy: empty (auto-unblocked by native dependency system)
```

### 5. SPAWN AGENTS

Context ≥50%: checkpoint and exit.

**Before spawning each agent**, mark its native task as in_progress:
```
TaskUpdate(taskId: native_id, status: "in_progress")
```
This activates the UI spinner showing the task's activeForm (e.g. "Creating upload endpoint").

**NEVER use `isolation: "worktree"` on Task tool calls.** Deepflow manages a shared worktree per spec (`.deepflow/worktrees/{spec}/`) so wave 2 agents see wave 1 commits. Claude Code's native isolation creates separate per-agent worktrees (`.claude/worktrees/`) where agents can't see each other's work.

**Spawn ALL ready tasks in ONE message** with multiple Task tool calls (true parallelism). Same-file conflicts: spawn sequentially.

**Multiple [SPIKE] tasks for the same problem:** When PLAN.md contains two or more `[SPIKE]` tasks grouped by the same "Blocked by:" target or identical problem description, do NOT run them sequentially. Instead, follow the **Parallel Spike Probes** protocol in section 5.7 before spawning any implementation tasks that depend on the spike outcome.

### 5.5. RATCHET CHECK

After each agent completes (notification received), the orchestrator runs health checks on the worktree.

**Step 1: Detect commands** (same auto-detection as /df:verify):

| File | Build | Test | Typecheck | Lint |
|------|-------|------|-----------|------|
| `package.json` | `npm run build` (if scripts.build) | `npm test` (if scripts.test not placeholder) | `npx tsc --noEmit` (if tsconfig.json) | `npm run lint` (if scripts.lint) |
| `pyproject.toml` | — | `pytest` | `mypy .` (if mypy in deps) | `ruff check .` (if ruff in deps) |
| `Cargo.toml` | `cargo build` | `cargo test` | — | `cargo clippy` (if installed) |
| `go.mod` | `go build ./...` | `go test ./...` | — | `go vet ./...` |

**Step 2: Run health checks** in the worktree:
```bash
cd ${WORKTREE_PATH}

# Run each detected command
# Build → Test → Typecheck → Lint (stop on first failure)
```

**Step 3: Validate edit scope** (if spec declares `edit_scope`):
```bash
# Get files changed by the agent
CHANGED=$(git diff HEAD~1 --name-only)

# Load edit_scope from spec (files/globs)
EDIT_SCOPE=$(grep 'edit_scope:' specs/doing-*.md | sed 's/edit_scope://' | tr ',' '\n' | xargs)

# Check each changed file against allowed scope
for file in ${CHANGED}; do
  ALLOWED=false
  for pattern in ${EDIT_SCOPE}; do
    # Match file against glob pattern
    [[ "${file}" == ${pattern} ]] && ALLOWED=true
  done
  ${ALLOWED} || VIOLATIONS+=("${file}")
done
```

- Violations found → revert: `git revert HEAD --no-edit`, report "✗ Edit scope violation: {files}"
- No violations → continue to health checks

**Step 4: Evaluate**:
- All checks pass AND no scope violations → task succeeds, commit stands
- Any check fails → regression detected → revert: `git revert HEAD --no-edit`

**Ratchet uses ONLY pre-existing test files** (from `.deepflow/auto-snapshot.txt`). If the agent added new test files that fail, those are excluded from evaluation — the agent's new tests don't influence the ratchet decision.

**For spike tasks:** Same ratchet. If the spike's code passes pre-existing health checks, the spike passes. No LLM judges another LLM's work.

### 5.7. PARALLEL SPIKE PROBES

When two or more `[SPIKE]` tasks address the **same problem** (same "Blocked by:" target OR identical or near-identical hypothesis wording), treat them as a probe set and run this protocol instead of the standard single-agent flow.

#### Detection

```
Spike group = all [SPIKE] tasks where:
  - same "Blocked by:" value, OR
  - problem description is identical after stripping task ID prefix
If group size ≥ 2 → enter parallel probe mode
```

#### Step 1: Record baseline commit

```bash
cd ${WORKTREE_PATH}
BASELINE=$(git rev-parse HEAD)
echo "Probe baseline: ${BASELINE}"
```

All probes branch from this exact commit so they share the same ratchet baseline.

#### Step 2: Create isolated sub-worktrees

For each spike `{SPIKE_ID}` in the probe group:

```bash
PROBE_BRANCH="df/${SPEC_NAME}/probe-${SPIKE_ID}"
PROBE_PATH=".deepflow/worktrees/${SPEC_NAME}/probe-${SPIKE_ID}"

git worktree add -b "${PROBE_BRANCH}" "${PROBE_PATH}" "${BASELINE}"
echo "Created probe worktree: ${PROBE_PATH} (branch: ${PROBE_BRANCH})"
```

#### Step 3: Spawn all probes in parallel

Mark every spike task as `in_progress`, then spawn one agent per probe **in a single message** using the Spike Task prompt (section 6), with the probe's worktree path as its working directory.

```
TaskUpdate(taskId: native_id_SPIKE_A, status: "in_progress")
TaskUpdate(taskId: native_id_SPIKE_B, status: "in_progress")
[spawn agent for SPIKE_A → PROBE_PATH_A]
[spawn agent for SPIKE_B → PROBE_PATH_B]
... (all in ONE message)
```

End your turn. Do NOT poll or monitor. Wait for completion notifications.

#### Step 4: Ratchet each probe (on completion notifications)

When a probe agent's notification arrives, run the standard ratchet (section 5.5) against its dedicated probe worktree:

```bash
cd ${PROBE_PATH}

# Identical health-check commands as standard tasks
# Build → Test → Typecheck → Lint (stop on first failure)
```

Record per-probe metrics:

```yaml
probe_id: SPIKE_A
worktree: .deepflow/worktrees/{spec}/probe-SPIKE_A
branch: df/{spec}/probe-SPIKE_A
ratchet_passed: true/false
regressions: 0          # failing pre-existing tests
coverage_delta: +3      # new lines covered (positive = better)
files_changed: 4        # number of files touched
commit: abc1234
```

Wait until **all** probe notifications have arrived before proceeding to selection.

#### Step 5: Machine-select winner

No LLM evaluates another LLM's work. Apply the following ordered criteria to all probes that **passed** the ratchet:

```
1. Fewer regressions  (lower is better — hard gate: any regression disqualifies)
2. Better coverage    (higher delta is better)
3. Fewer files changed (lower is better — smaller blast radius)

Tie-break: first probe to complete (chronological)
```

If **no** probe passes the ratchet, all are failed probes. Log insights (step 7) and reset the spike tasks to `pending` for retry with debugger guidance.

#### Step 6: Preserve ALL probe worktrees

Do NOT delete losing probe worktrees. They are preserved for manual inspection and cross-cycle learning:

```bash
# Winning probe: leave as-is, will be used as implementation base (step 8)
# Losing probes: leave worktrees intact, mark branches with -failed suffix for clarity
git branch -m "df/{spec}/probe-SPIKE_B" "df/{spec}/probe-SPIKE_B-failed"
```

Record all probe paths in `.deepflow/checkpoint.json` under `"spike_probes"` so future `--continue` runs know they exist.

#### Step 7: Log failed probe insights

For every probe that failed the ratchet (or lost selection), write two entries to `.deepflow/auto-memory.yaml` in the **main** tree.

**Entry 1 — `spike_insights` (detailed probe record):**

```yaml
spike_insights:
  - date: "YYYY-MM-DD"
    spec: "{spec_name}"
    spike_id: "SPIKE_B"
    hypothesis: "{hypothesis text from PLAN.md}"
    outcome: "failed"               # or "passed-but-lost"
    failure_reason: "{first failed check and error summary}"
    ratchet_metrics:
      regressions: 2
      coverage_delta: -1
      files_changed: 7
    worktree: ".deepflow/worktrees/{spec}/probe-SPIKE_B-failed"
    branch: "df/{spec}/probe-SPIKE_B-failed"
    edge_cases: []                  # orchestrator may populate after manual review
```

**Entry 2 — `probe_learnings` (cross-cycle memory, read by `/df:auto-cycle` on each cycle start):**

```yaml
probe_learnings:
  - spike: "SPIKE_B"
    probe: "{probe branch suffix, e.g. probe-SPIKE_B}"
    insight: "{one-sentence summary of what the probe revealed, derived from failure_reason}"
```

If the file does not exist, create it. Initialize both `spike_insights:` and `probe_learnings:` as empty lists before appending. Preserve all existing keys when merging.

#### Step 8: Promote winning probe

Cherry-pick the winner's commit into the shared spec worktree so downstream implementation tasks see the winning approach:

```bash
cd ${WORKTREE_PATH}               # shared worktree (not the probe sub-worktree)
git cherry-pick ${WINNER_COMMIT}
```

Then mark the winning spike task as `completed` and auto-unblock its dependents:

```
TaskUpdate(taskId: native_id_SPIKE_WINNER, status: "completed")
TaskUpdate(taskId: native_id_SPIKE_LOSERS, status: "pending")  # keep visible for audit
```

Update PLAN.md:
- Winning spike → `[x]` with commit hash and `[PROBE_WINNER]` tag
- Losing spikes → `[~]` (skipped) with `[PROBE_FAILED: see auto-memory.yaml]` note

Resume the standard execution loop (section 9) — implementation tasks blocked by the spike group are now unblocked.

---

### 6. PER-TASK (agent prompt)

**Common preamble (include in all agent prompts):**
```
Working directory: {worktree_absolute_path}
All file operations MUST use this absolute path as base. Do NOT write files to the main project directory.
Commit format: {commit_type}({spec}): {description}

STOP after committing. Do NOT merge branches, rename spec files, remove worktrees, or run git checkout on main. These are handled by the orchestrator and /df:verify.
```

**Standard Task (append after preamble):**
```
{task_id}: {description from PLAN.md}
Files: {target files}
Spec: {spec_name}

Steps:
1. If the task involves external APIs/SDKs, run: chub search "<library>" --json → chub get <id> --lang <lang>
   Use fetched docs as ground truth for API signatures. Annotate any gaps: chub annotate <id> "note"
   Skip this step if chub is not installed or the task only touches internal code.
2. Implement the task
3. Commit as feat({spec}): {description}

Your ONLY job is to write code and commit. The orchestrator will run health checks after you finish.
```

**Bootstrap Task (append after preamble):**
```
BOOTSTRAP: Write tests for files in edit_scope
Files: {edit_scope files from spec}
Spec: {spec_name}

Steps:
1. Write tests that cover the functionality of the files listed above
2. Do NOT change implementation files — tests only
3. Commit as test({spec}): bootstrap tests for edit_scope

Your ONLY job is to write tests and commit. The orchestrator will run health checks after you finish.
```

**Spike Task (append after preamble):**
```
{task_id} [SPIKE]: {hypothesis}
Files: {target files}
Spec: {spec_name}

Steps:
1. Implement the minimal spike to validate the hypothesis
2. Commit as spike({spec}): {description}

Your ONLY job is to write code and commit. The orchestrator will run health checks to determine if the spike passes.
```

### 7. FAILURE HANDLING

When a task fails ratchet and is reverted:

`TaskUpdate(taskId: native_id, status: "pending")` — keeps task visible for retry; dependents remain blocked.

On repeated failure: spawn `Task(subagent_type="reasoner", model={model from debugger frontmatter, default "sonnet"}, prompt="Debug failure: {ratchet output}")`.

Leave worktree intact, keep checkpoint.json, output: worktree path/branch, `cd {worktree_path}` to investigate, `/df:execute --continue` to resume, `/df:execute --fresh` to discard.

### 8. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Embed history in spec: `## Completed` section with task list and commit hashes
2. Rename: `doing-upload.md` → `done-upload.md`
3. Extract decisions from done-* spec: Read the `done-{name}.md` file. Model-extract architectural decisions — look for explicit choices (→ `[APPROACH]`), unvalidated assumptions (→ `[ASSUMPTION]`), and "for now" decisions (→ `[PROVISIONAL]`). Append as a new section to **main tree** `.deepflow/decisions.md`:
   ```
   ### {YYYY-MM-DD} — {spec-name}
   - [TAG] decision text — rationale
   ```
   After successful append, delete `specs/done-{name}.md`. If write fails, preserve the file.
4. Remove the spec's ENTIRE section from PLAN.md:
   - The `### doing-{spec}` header
   - All task entries (`- [x] **T{n}**: ...` and their sub-items)
   - Any `## Execution Summary` block for that spec
   - Any `### Fix Tasks` sub-section for that spec
   - Separators (`---`) between removed sections
5. Recalculate the Summary table at the top of PLAN.md (update counts for completed/pending)

### 9. ITERATE (Notification-Driven)

After spawning wave agents, your turn ENDS. Completion notifications drive the loop.

**Per notification:**
1. Run ratchet check for the completed agent (see section 5.5)
2. Ratchet passed → `TaskUpdate(taskId: native_id, status: "completed")` — auto-unblocks dependent tasks
3. Ratchet failed → revert commit, `TaskUpdate(taskId: native_id, status: "pending")`
4. Update PLAN.md: `[ ]` → `[x]` + commit hash (on pass) or note revert (on fail)
5. Report: "✓ T1: ratchet passed (abc123)" or "✗ T1: ratchet failed, reverted"
6. If NOT all wave agents done → end turn, wait
7. If ALL wave agents done → use TaskList to find newly unblocked tasks, check context, spawn next wave or finish

**Between waves:** Check context %. If ≥50%, checkpoint and exit.

**Repeat** until: all done, all blocked, or context ≥50% (checkpoint).

## Rules

| Rule | Detail |
|------|--------|
| Zero test files → bootstrap first | Section 1.7; bootstrap is the cycle's sole task when snapshot is empty |
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| 1 file = 1 writer | Sequential if conflict |
| Agent writes code, orchestrator measures | Ratchet is the judge |
| No LLM evaluates LLM work | Health checks only |
| ≥2 spikes for same problem → parallel probes | Section 5.7; never run competing spikes sequentially |
| All probe worktrees preserved | Losing probes renamed with `-failed` suffix; never deleted |
| Machine-selected winner | Fewer regressions > better coverage > fewer files changed; no LLM judge |
| Failed probe insights logged | `.deepflow/auto-memory.yaml` in main tree; persists across cycles |
| Winner cherry-picked to shared worktree | Downstream tasks see winning approach via shared worktree |
| External APIs → chub first | Agents fetch curated docs before implementing external API calls; skip if chub unavailable |

## Example

### No-Tests Bootstrap

```
/df:execute (context: 8%)

Loading PLAN.md... T1 ready, T2/T3 blocked by T1
Ratchet snapshot: 0 pre-existing test files
Bootstrap needed: no pre-existing test files found.

Spawning bootstrap agent for edit_scope...
[Bootstrap agent completed]
  Running ratchet: build ✓ | tests ✓ (12 new tests pass)
  ✓ Bootstrap: ratchet passed (boo1234)
  Re-taking ratchet snapshot: 3 test files

bootstrap: completed — cycle's sole task was test bootstrap
Next: Run /df:auto-cycle again to execute T1
```

### Standard Execution

```
/df:execute (context: 12%)

Loading PLAN.md... T1 ready, T2/T3 blocked by T1
Ratchet snapshot: 24 pre-existing test files
Registering native tasks: TaskCreate T1/T2/T3, TaskUpdate(T2 blockedBy T1), TaskUpdate(T3 blockedBy T1)

Wave 1: TaskUpdate(T1, in_progress)
[Agent "T1" completed]
  Running ratchet: build ✓ | tests ✓ (24 passed) | typecheck ✓
  ✓ T1: ratchet passed (abc1234)
  TaskUpdate(T1, completed) → auto-unblocks T2, T3

Wave 2: TaskUpdate(T2/T3, in_progress)
[Agent "T2" completed]
  Running ratchet: build ✓ | tests ✓ (24 passed) | typecheck ✓
  ✓ T2: ratchet passed (def5678)
[Agent "T3" completed]
  Running ratchet: build ✓ | tests ✓ (24 passed) | typecheck ✓
  ✓ T3: ratchet passed (ghi9012)

Context: 35% — ✓ doing-upload → done-upload. Complete: 3/3

Next: Run /df:verify to verify specs and merge to main
```

### Ratchet Failure (Regression Detected)

```
/df:execute (context: 10%)

Wave 1: TaskUpdate(T1, in_progress)
[Agent "T1" completed]
  Running ratchet: build ✓ | tests ✗ (2 failed of 24)
  ✗ T1: ratchet failed, reverted
  TaskUpdate(T1, pending)

Spawning debugger for T1...
[Debugger completed]
  Re-running T1 with fix guidance...

[Agent "T1 retry" completed]
  Running ratchet: build ✓ | tests ✓ (24 passed) | typecheck ✓
  ✓ T1: ratchet passed (abc1234)
```

### With Checkpoint

```
Wave 1 complete (context: 52%)
Checkpoint saved.

Next: Run /df:execute --continue to resume execution
```
