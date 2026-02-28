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

After spawning, your turn ENDS. Per notification: read result file, output ONE line ("✓ T1: success (abc123)"), update PLAN.md. Write full summary only after ALL wave agents complete.

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

### 2. LOAD PLAN

```
Load: PLAN.md (required), specs/doing-*.md, .deepflow/config.yaml
If missing: "No PLAN.md found. Run /df:plan first."
```

### 2.5. REGISTER NATIVE TASKS

For each `[ ]` task in PLAN.md: `TaskCreate(subject: "{task_id}: {description}", activeForm: "{gerund}", description: full block)`. Store task_id → native ID mapping. Then set dependencies: `TaskUpdate(addBlockedBy: [...])` for each "Blocked by:" entry. On `--continue`: only register remaining `[ ]` items.

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

**NEVER use `isolation: "worktree"` on Task tool calls.** Deepflow manages a shared worktree per spec (`.deepflow/worktrees/{spec}/`) so wave 2 agents see wave 1 commits. Claude Code's native isolation creates separate per-agent worktrees (`.claude/worktrees/`) where agents can't see each other's work.

**Spawn ALL ready tasks in ONE message** with multiple Task tool calls (true parallelism). Same-file conflicts: spawn sequentially.

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
  Log "✗ Spike {task_id} failed verification"
  If override: log "⚠ Agent incorrectly marked as passed"
```

On task failure: spawn `Task(subagent_type="reasoner", model="opus", prompt="Debug failure: {error details}")`.

### 7. PER-TASK (agent prompt)

**Common preamble (include in all agent prompts):**
```
Working directory: {worktree_absolute_path}
All file operations MUST use this absolute path as base. Do NOT write files to the main project directory.
Commit format: {commit_type}({spec}): {description}
Result file: {worktree_absolute_path}/.deepflow/results/{task_id}.yaml

STOP after writing the result file. Do NOT merge branches, rename spec files, remove worktrees, or run git checkout on main. These are handled by the orchestrator and /df:verify.
```

**Standard Task (append after preamble):**
```
{task_id}: {description from PLAN.md}
Files: {target files}
Spec: {spec_name}

Steps:
1. Implement the task
2. Detect and run the project's test command if test infrastructure exists
   - If tests fail: fix and re-run until passing. Do NOT commit with failing tests
   - If NO test infrastructure: set tests_ran: false in result file
3. Commit as feat({spec}): {description}
4. Write result file with ALL fields including test evidence (see schema)
```

**Spike Task (append after preamble):**
```
{task_id} [SPIKE]: {hypothesis}
Type: spike
Method: {minimal steps}
Success criteria: {measurable targets}
Experiment file: {worktree_absolute_path}/.deepflow/experiments/{topic}--{hypothesis}--active.md

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
```

### 8. FAILURE HANDLING

When a task fails and cannot be auto-fixed:

`TaskUpdate(taskId: native_id, status: "pending")` — keeps task visible for retry; dependents remain blocked. Leave worktree intact, keep checkpoint.json, output: worktree path/branch, `cd {worktree_path}` to investigate, `/df:execute --continue` to resume, `/df:execute --fresh` to discard.

### 9. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Embed history in spec: `## Completed` section with task list and commit hashes
2. Rename: `doing-upload.md` → `done-upload.md`
3. Remove the spec's ENTIRE section from PLAN.md:
   - The `### doing-{spec}` header
   - All task entries (`- [x] **T{n}**: ...` and their sub-items)
   - Any `## Execution Summary` block for that spec
   - Any `### Fix Tasks` sub-section for that spec
   - Separators (`---`) between removed sections
4. Recalculate the Summary table at the top of PLAN.md (update counts for completed/pending)

### 10. ITERATE (Notification-Driven)

After spawning wave agents, your turn ENDS. Completion notifications drive the loop.

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

Follow the **main-tree** variant from `templates/decision-capture.md`. Command name: `execute`.

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

Loading PLAN.md... T1 ready, T2/T3 blocked by T1
Registering native tasks: TaskCreate T1/T2/T3, TaskUpdate(T2 blockedBy T1), TaskUpdate(T3 blockedBy T1)

Wave 1: TaskUpdate(T1, in_progress)
[Agent "T1" completed] TaskUpdate(T1, completed) → auto-unblocks T2, T3
✓ T1: success (abc1234)

Wave 2: TaskUpdate(T2/T3, in_progress)
[Agent "T2" completed] ✓ T2: success (def5678)
[Agent "T3" completed] ✓ T3: success (ghi9012)
Context: 35% — ✓ doing-upload → done-upload. Complete: 3/3

Next: Run /df:verify to verify specs and merge to main
```

### Spike with Failure (Agent or Verifier Override)

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
  T2, T3: Blocked by T1 (spike not validated)

Spawning Wave 1: T1 [SPIKE]
  TaskUpdate(task-001, status: "in_progress")

[Agent "T1 SPIKE" completed]
✓ T1: complete (agent said: success), verifying...

Verifying T1...
  ✗ Spike T1 failed verification (throughput 1500 < 7000)
  ⚠ Agent incorrectly marked as passed — overriding to FAILED
  # Spike stays pending — dependents remain blocked
  → upload--streaming--failed.md

⚠ Spike T1 invalidated hypothesis
Complete: 1/3 tasks (2 blocked by failed experiment)

Next: Run /df:plan to generate new hypothesis spike
```

Note: If the agent correctly reports `status: failed`, the "overriding to FAILED" line is omitted — the verifier simply confirms failure.

### With Checkpoint

```
Wave 1 complete (context: 52%)
Checkpoint saved.

Next: Run /df:execute --continue to resume execution
```
