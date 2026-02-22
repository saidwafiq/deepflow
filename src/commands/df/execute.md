# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You are a coordinator. Spawn agents, wait for results, update PLAN.md. Never implement code yourself.

**NEVER:** Read source files, edit code, run tests, run git commands (except status), use TaskOutput, use EnterPlanMode, use ExitPlanMode

**ONLY:** Read PLAN.md, read specs/doing-*.md, spawn background agents, read `.deepflow/results/*.yaml` on completion notifications, update PLAN.md, write `.deepflow/decisions.md` in the main tree

---

## Purpose
Implement tasks from PLAN.md with parallel agents, atomic commits, and context-efficient execution.

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
| Spike Verifier | `reasoner` | `opus` | Verify spike pass/fail is correct |
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
   a. Read the result file: Read("{worktree}/.deepflow/results/{task_id}.yaml")
   b. Report: "✓ T1: success (abc123)" or "✗ T1: failed"
   c. Update PLAN.md for that task
   d. Check: all wave agents done?
      - No → end turn, wait for next notification
      - Yes → proceed to next wave or write final summary
```

**CRITICAL: After spawning agents, your turn ENDS. Do NOT:**
- Run Bash commands to poll/monitor
- Try to read result files before notifications arrive
- Write summaries before all wave agents complete

**On notification, respond briefly:**
- ONE line per completed agent: "✓ T1: success (abc123)"
- Only write full summary after ALL wave agents complete
- Do NOT repeat the full execution status on every notification

```python
# Step 1: Spawn wave (ONE message, then STOP)
Task(subagent_type="general-purpose", model="sonnet", run_in_background=True, prompt="T1: ...")
Task(subagent_type="general-purpose", model="sonnet", run_in_background=True, prompt="T2: ...")
Task(subagent_type="general-purpose", model="sonnet", run_in_background=True, prompt="T3: ...")
# Turn ends here. Wait for notifications.

# Step 2: On "Agent T1 completed" notification:
Read("{worktree}/.deepflow/results/T1.yaml")
# Output: "✓ T1: success (abc123)" — then STOP, wait for next

# Step 3: On "Agent T2 completed" notification:
Read("{worktree}/.deepflow/results/T2.yaml")
# Output: "✓ T2: success (def456)" — then STOP, wait for next

# Step 4: On "Agent T3 completed" notification (last one):
Read("{worktree}/.deepflow/results/T3.yaml")
# Output: "✓ T3: success (ghi789)"
# All done → proceed to next wave or final summary
```

Result file `.deepflow/results/{task_id}.yaml`:
```yaml
task: T3
status: success|failed
commit: abc1234
summary: "one line"
tests_ran: true|false
test_command: "npm test"
test_exit_code: 0
test_output_tail: |
  PASS src/upload.test.ts
  Tests: 12 passed, 12 total
```

New fields: `tests_ran` (bool), `test_command` (string), `test_exit_code` (int), `test_output_tail` (last 20 lines of output).

**Spike result file** `.deepflow/results/{task_id}.yaml` (additional fields):
```yaml
task: T1
type: spike
status: success|failed
commit: abc1234
summary: "one line"
criteria:
  - name: "throughput"
    target: ">= 7000 g/s"
    actual: "1500 g/s"
    met: false
  - name: "memory usage"
    target: "< 500 MB"
    actual: "320 MB"
    met: true
all_criteria_met: false  # ALL must be true for spike to pass
experiment_file: ".deepflow/experiments/upload--streaming--failed.md"
```

**CRITICAL:** `status` MUST equal `success` only if `all_criteria_met: true`. The spike verifier will reject mismatches.

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

Note: `completed_tasks` is kept for backward compatibility but is now derivable from PLAN.md `[x]` entries. The native task system (TaskList) is the primary source for runtime task status.

**On checkpoint:** Complete wave → update PLAN.md → save to worktree → exit.
**Resume:** `--continue` loads checkpoint, verifies worktree, skips completed tasks. Native tasks are re-registered for remaining `[ ]` items only.

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

### 2. LOAD PLAN

```
Load: PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml
If missing: "No PLAN.md found. Run /df:plan first."
```

### 2.5. REGISTER NATIVE TASKS

Parse PLAN.md and create native tasks for tracking, dependency management, and UI spinners.

**For each uncompleted task (`[ ]`) in PLAN.md:**

```
1. TaskCreate:
   - subject: "{task_id}: {description}" (e.g. "T1: Create upload endpoint")
   - description: Full task block from PLAN.md (files, blocked by, type, etc.)
   - activeForm: "{gerund form of description}" (e.g. "Creating upload endpoint")

2. Store mapping: PLAN.md task_id (T1) → native task ID
```

**After all tasks created, set up dependencies:**

```
For each task with "Blocked by: T{n}, T{m}":
  TaskUpdate(taskId: native_id, addBlockedBy: [native_id_of_Tn, native_id_of_Tm])
```

**On `--continue`:** Only create tasks for remaining `[ ]` items (skip `[x]` completed).

### 3. CHECK FOR UNPLANNED SPECS

Warn if `specs/*.md` (excluding doing-/done-) exist. Non-blocking.

### 4. CHECK EXPERIMENT STATUS (HYPOTHESIS VALIDATION)

**Before identifying ready tasks**, check experiment validation for full implementation tasks.

**Task Types:**
- **Spike tasks**: Have `[SPIKE]` in title OR `Type: spike` in description — always executable
- **Full implementation tasks**: Blocked by spike tasks — require validated experiment

**Validation Flow:**

```
For each task in plan:
  If task is spike task:
    → Mark as executable (spikes are always allowed)
  Else if task is blocked by a spike task (T{n}):
    → Find related experiment file in .deepflow/experiments/
    → Check experiment status:
      - --passed.md exists → Unblock, proceed with implementation
      - --failed.md exists → Keep blocked, warn user
      - --active.md exists → Keep blocked, spike in progress
      - No experiment → Keep blocked, spike not started
```

**Experiment File Discovery:**

```
Glob: .deepflow/experiments/{topic}--*--{status}.md

Topic extraction:
1. From spike task: experiment file path in task description
2. From spec name: doing-{topic} → {topic}
3. Fuzzy match: normalize and match
```

**Status Handling:**

| Experiment Status | Task Status | Action |
|-------------------|-------------|--------|
| `--passed.md` | Ready | Execute full implementation |
| `--failed.md` | Blocked | Skip, warn: "Experiment failed, re-plan needed" |
| `--active.md` | Blocked | Skip, info: "Waiting for spike completion" |
| Not found | Blocked | Skip, info: "Spike task not executed yet" |

**Warning Output:**

```
⚠ T3 blocked: Experiment 'upload--streaming--failed.md' did not validate
  → Run /df:plan to generate new hypothesis spike
```

### 5. IDENTIFY READY TASKS

Use TaskList to find ready tasks (replaces manual PLAN.md parsing):

```
Ready = TaskList results where:
  - status: "pending"
  - blockedBy: empty (auto-unblocked by native dependency system)
```

**Cross-check with experiment validation** (for spike-blocked tasks):
- If task depends on spike AND experiment not `--passed.md` → still blocked
  - TaskUpdate to add spike as blocker if not already set

Ready = TaskList pending + empty blockedBy + experiment validated (if applicable).

### 6. SPAWN AGENTS

Context ≥50%: checkpoint and exit.

**Before spawning each agent**, mark its native task as in_progress:
```
TaskUpdate(taskId: native_id, status: "in_progress")
```
This activates the UI spinner showing the task's activeForm (e.g. "Creating upload endpoint").

**CRITICAL: Spawn ALL ready tasks in a SINGLE response with MULTIPLE Task tool calls.**

DO NOT spawn one task, wait, then spawn another. Instead, call Task tool multiple times in the SAME message block. This enables true parallelism.

Example: If T1, T2, T3 are ready, send ONE message containing THREE Task tool invocations:

```
// In a SINGLE assistant message, invoke Task with run_in_background=true:
Task(subagent_type="general-purpose", model="sonnet", run_in_background=true, prompt="T1: ...")
Task(subagent_type="general-purpose", model="sonnet", run_in_background=true, prompt="T2: ...")
Task(subagent_type="general-purpose", model="sonnet", run_in_background=true, prompt="T3: ...")
// Turn ends here. Wait for completion notifications.
```

**WRONG (sequential):** Send message with Task for T1 → wait → send message with Task for T2 → wait → ...
**RIGHT (parallel):** Send ONE message with Task for T1, T2, T3 all together, then STOP

Same-file conflicts: spawn sequentially instead.

**Spike Task Execution:**
When spawning a spike task, the agent MUST:
1. Execute the minimal validation method
2. Record structured criteria evaluation in result file (see spike result schema above)
3. Write experiment file with `--active.md` status (verifier determines final status)
4. Commit as `spike({spec}): validate {hypothesis}`

**IMPORTANT:** Spike agent writes `--active.md`, NOT `--passed.md` or `--failed.md`. The verifier determines final status.

### 6.5. VERIFY SPIKE RESULTS

After spike completes, spawn verifier BEFORE unblocking implementation tasks.

**Trigger:** Spike result file detected (`.deepflow/results/T{n}.yaml` with `type: spike`)

**Spawn:**
```
Task(subagent_type="reasoner", model="opus", prompt=VERIFIER_PROMPT)
```

**Verifier Prompt:**
```
SPIKE VERIFICATION — Be skeptical. Catch false positives.

Task: {task_id}
Result: {worktree_path}/.deepflow/results/{task_id}.yaml
Experiment: {worktree_path}/.deepflow/experiments/{topic}--{hypothesis}--active.md

For each criterion in result file:
1. Is `actual` a concrete number? (reject "good", "improved", "better")
2. Does `actual` satisfy `target`? Do the math.
3. Is `met` correct?

Reject these patterns:
- "Works but doesn't meet target" → FAILED
- "Close enough" → FAILED
- Actual 1500 vs Target >= 7000 → FAILED

Output to {worktree_path}/.deepflow/results/{task_id}-verified.yaml:
  verified_status: VERIFIED_PASS|VERIFIED_FAIL
  override: true|false
  reason: "one line"

Then rename experiment:
- VERIFIED_PASS → --passed.md
- VERIFIED_FAIL → --failed.md (add "Next hypothesis:" to Conclusion)
```

**Gate:**
```
VERIFIED_PASS →
  TaskUpdate(taskId: spike_native_id, status: "completed")
  # Native system auto-unblocks dependent tasks
  Log "✓ Spike {task_id} verified"

VERIFIED_FAIL →
  # Spike task stays as pending, dependents remain blocked
  # No TaskUpdate needed — native system keeps them blocked
  Log "✗ Spike {task_id} failed verification"
  If override: log "⚠ Agent incorrectly marked as passed"
```

**On failure, use Task tool to spawn reasoner:**
```
Task tool parameters:
- subagent_type: "reasoner"
- model: "opus"
- prompt: "Debug failure: {error details}"
```

### 7. PER-TASK (agent prompt)

**Standard Task:**
```
{task_id}: {description from PLAN.md}
Files: {target files}
Spec: {spec_name}

**IMPORTANT: Working Directory**
All file operations MUST use this absolute path as base:
{worktree_absolute_path}

Example: To edit src/foo.ts, use:
{worktree_absolute_path}/src/foo.ts

Do NOT write files to the main project directory.

Steps:
1. Implement the task
2. Detect test command: check for package.json (npm test), pyproject.toml (pytest),
   Cargo.toml (cargo test), go.mod (go test ./...), or Makefile (make test)
3. Run tests if test infrastructure exists:
   - Run the detected test command
   - If tests fail: fix the code and re-run until passing
   - Do NOT commit with failing tests
4. If NO test infrastructure: set tests_ran: false in result file
5. Commit as feat({spec}): {description}
6. Write result file with ALL fields including test evidence (see schema):
   {worktree_absolute_path}/.deepflow/results/{task_id}.yaml

**STOP after writing the result file. Do NOT:**
- Merge branches or cherry-pick commits
- Rename or move spec files (doing-* → done-*)
- Remove worktrees or delete branches
- Run git checkout on main
These are handled by the orchestrator and /df:verify.
```

**Spike Task:**
```
{task_id} [SPIKE]: {hypothesis}
Type: spike
Method: {minimal steps}
Success criteria: {measurable targets}
Experiment file: {worktree_absolute_path}/.deepflow/experiments/{topic}--{hypothesis}--active.md

Working directory: {worktree_absolute_path}

Steps:
1. Execute method
2. For EACH criterion: record target, measure actual, compare (show math)
3. Write experiment as --active.md (verifier determines final status)
4. Commit: spike({spec}): validate {hypothesis}
5. Write result to .deepflow/results/{task_id}.yaml (see spike result schema)
6. If test infrastructure exists, also run tests and include evidence in result file

Rules:
- `met: true` ONLY if actual satisfies target
- `status: success` ONLY if ALL criteria met
- Worse than baseline = FAILED (baseline 7k, actual 1.5k → FAILED)
- "Close enough" = FAILED
- Verifier will check. False positives waste resources.
- STOP after writing result file. Do NOT merge, rename specs, or clean up worktrees.
```

### 8. FAILURE HANDLING

When a task fails and cannot be auto-fixed:

**Native task update:**
```
TaskUpdate(taskId: native_id, status: "pending")  # Reset to pending, not deleted
```
This keeps the task visible for retry. Dependent tasks remain blocked.

**Behavior:**
1. Leave worktree intact at `{worktree_path}`
2. Keep checkpoint.json for potential resume
3. Output debugging instructions

**Output:**
```
✗ Task T3 failed after retry

Worktree preserved for debugging:
  Path: .deepflow/worktrees/upload
  Branch: df/upload

To investigate:
  cd .deepflow/worktrees/upload
  # examine files, run tests, etc.

To resume after fixing:
  /df:execute --continue

To discard and start fresh:
  /df:execute --fresh
```

**Key points:**
- Never auto-delete worktree on failure (cleanup_on_fail: false by default)
- Always provide the exact cleanup commands
- Checkpoint remains so --continue can work after manual fix

### 9. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Embed history in spec: `## Completed` section
2. Rename: `doing-upload.md` → `done-upload.md`
3. Remove section from PLAN.md

### 10. ITERATE (Notification-Driven)

After spawning wave agents, your turn ENDS. Completion notifications drive the loop.

**NEVER use TaskOutput** — it explodes context.

**Per notification:**
1. Read result file for the completed agent
2. Validate test evidence:
   - `tests_ran: true` + `test_exit_code: 0` → trust result
   - `tests_ran: true` + `test_exit_code: non-zero` → status MUST be failed (flag mismatch if agent said success)
   - `tests_ran: false` + `status: success` → flag: "⚠ Tx: success but no tests ran"
3. TaskUpdate(taskId: native_id, status: "completed") — auto-unblocks dependent tasks
4. Update PLAN.md: `[ ]` → `[x]` + commit hash (as before)
5. Report: "✓ T1: success (abc123) [12 tests passed]" or "⚠ T1: success (abc123) [no tests]"
6. If NOT all wave agents done → end turn, wait
7. If ALL wave agents done → use TaskList to find newly unblocked tasks, check context, spawn next wave or finish

**Between waves:** Check context %. If ≥50%, checkpoint and exit.

**Repeat** until: all done, all blocked, or context ≥50% (checkpoint).

### 11. CAPTURE DECISIONS

After all tasks complete (or all blocked), extract up to 4 candidate decisions from the session (implementation patterns, deviations from plan, key assumptions made).

Present via AskUserQuestion with multiSelect: true. Labels: `[TAG] decision text`. Descriptions: rationale.

For each confirmed decision, append to **main tree** `.deepflow/decisions.md` (create if missing):
```
### {YYYY-MM-DD} — execute
- [APPROACH] Parallel agent spawn for independent tasks — confirmed no file conflicts
```

Main tree path: use the repo root (parent of `.deepflow/worktrees/`), NOT the worktree.

Max 4 candidates per prompt. Tags: [APPROACH], [PROVISIONAL], [ASSUMPTION].

## Rules

| Rule | Detail |
|------|--------|
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| 1 file = 1 writer | Sequential if conflict |
| Agents verify internally | Fix issues, don't report |

## Example

### Standard Execution

```
/df:execute (context: 12%)

Loading PLAN.md...
  T1: Create upload endpoint (ready)
  T2: Add S3 service (blocked by T1)
  T3: Add auth guard (blocked by T1)

Registering native tasks...
  TaskCreate → T1 (native: task-001)
  TaskCreate → T2 (native: task-002)
  TaskCreate → T3 (native: task-003)
  TaskUpdate(task-002, addBlockedBy: [task-001])
  TaskUpdate(task-003, addBlockedBy: [task-001])

Spawning Wave 1: T1
  TaskUpdate(task-001, status: "in_progress")  ← spinner: "Creating upload endpoint"

[Agent "T1" completed]
  TaskUpdate(task-001, status: "completed")  ← auto-unblocks task-002, task-003
  ✓ T1: success (abc1234)

TaskList → task-002, task-003 now ready (blockedBy empty)

Spawning Wave 2: T2, T3 parallel
  TaskUpdate(task-002, status: "in_progress")
  TaskUpdate(task-003, status: "in_progress")

[Agent "T2" completed]
  TaskUpdate(task-002, status: "completed")
  ✓ T2: success (def5678)

[Agent "T3" completed]
  TaskUpdate(task-003, status: "completed")
  ✓ T3: success (ghi9012)

Wave 2 complete (2/2). Context: 35%

✓ doing-upload → done-upload
✓ Complete: 3/3 tasks

Next: Run /df:verify to verify specs and merge to main
```

### Spike-First Execution

```
/df:execute (context: 10%)

Loading PLAN.md...
Registering native tasks...
  TaskCreate → T1 [SPIKE] (native: task-001)
  TaskCreate → T2 (native: task-002)
  TaskCreate → T3 (native: task-003)
  TaskUpdate(task-002, addBlockedBy: [task-001])
  TaskUpdate(task-003, addBlockedBy: [task-001])

Checking experiment status...
  T1 [SPIKE]: No experiment yet, spike executable
  T2: Blocked by T1 (spike not validated)
  T3: Blocked by T1 (spike not validated)

Spawning Wave 1: T1 [SPIKE]
  TaskUpdate(task-001, status: "in_progress")

[Agent "T1 SPIKE" completed]
✓ T1: complete, verifying...

Verifying T1...
  ✓ Spike T1 verified (throughput 8500 >= 7000)
  TaskUpdate(task-001, status: "completed")  ← auto-unblocks task-002, task-003
  → upload--streaming--passed.md

TaskList → task-002, task-003 now ready

Spawning Wave 2: T2, T3 parallel
  TaskUpdate(task-002, status: "in_progress")
  TaskUpdate(task-003, status: "in_progress")

[Agent "T2" completed]
  TaskUpdate(task-002, status: "completed")
  ✓ T2: success (def5678)

[Agent "T3" completed]
  TaskUpdate(task-003, status: "completed")
  ✓ T3: success (ghi9012)

Wave 2 complete (2/2). Context: 40%

✓ doing-upload → done-upload
✓ Complete: 3/3 tasks

Next: Run /df:verify to verify specs and merge to main
```

### Spike Failed (Agent Correctly Reported)

```
/df:execute (context: 10%)

Registering native tasks...
  TaskCreate → T1 [SPIKE], T2, T3 (with dependencies)

Wave 1: T1 [SPIKE] (context: 15%)
  TaskUpdate(task-001, status: "in_progress")
  T1: complete, verifying...

Verifying T1...
  ✗ Spike T1 failed verification (throughput 1500 < 7000)
  # Spike stays pending — dependents remain blocked
  → upload--streaming--failed.md

⚠ Spike T1 invalidated hypothesis
Complete: 1/3 tasks (2 blocked by failed experiment)

Next: Run /df:plan to generate new hypothesis spike
```

### Spike Failed (Verifier Override)

```
/df:execute (context: 10%)

Registering native tasks...
  TaskCreate → T1 [SPIKE], T2, T3 (with dependencies)

Wave 1: T1 [SPIKE] (context: 15%)
  TaskUpdate(task-001, status: "in_progress")
  T1: complete (agent said: success), verifying...

Verifying T1...
  ✗ Spike T1 failed verification (throughput 1500 < 7000)
  ⚠ Agent incorrectly marked as passed — overriding to FAILED
  TaskUpdate(task-001, status: "pending")  ← reset, dependents stay blocked
  → upload--streaming--failed.md

⚠ Spike T1 invalidated hypothesis
Complete: 1/3 tasks (2 blocked by failed experiment)

Next: Run /df:plan to generate new hypothesis spike
```

### With Checkpoint

```
Wave 1 complete (context: 52%)
Checkpoint saved.

Next: Run /df:execute --continue to resume execution
```
