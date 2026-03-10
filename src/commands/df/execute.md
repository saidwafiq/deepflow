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

**Use Task tool to spawn agents:**
| Agent | subagent_type | model | Purpose |
|-------|---------------|-------|---------|
| Implementation | `general-purpose` | `sonnet` | Task implementation |
| Debugger | `reasoner` | `opus` | Debugging failures |

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

**Step 3: Evaluate**:
- All checks pass → task succeeds, commit stands
- Any check fails → regression detected → revert: `git revert HEAD --no-edit`

**Ratchet uses ONLY pre-existing test files** (from `.deepflow/auto-snapshot.txt`). If the agent added new test files that fail, those are excluded from evaluation — the agent's new tests don't influence the ratchet decision.

**For spike tasks:** Same ratchet. If the spike's code passes pre-existing health checks, the spike passes. No LLM judges another LLM's work.

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
1. Implement the task
2. Commit as feat({spec}): {description}

Your ONLY job is to write code and commit. The orchestrator will run health checks after you finish.
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

On repeated failure: spawn `Task(subagent_type="reasoner", model="opus", prompt="Debug failure: {ratchet output}")`.

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
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| 1 file = 1 writer | Sequential if conflict |
| Agent writes code, orchestrator measures | Ratchet is the judge |
| No LLM evaluates LLM work | Health checks only |

## Example

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
