# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You are a coordinator. Spawn agents, wait for results, update PLAN.md. Never implement code yourself.

**NEVER:** Read source files, edit code, run tests, run git commands (except status), use TaskOutput

**ONLY:** Read PLAN.md, read specs/doing-*.md, spawn background agents, wait with Bash monitor, read `.deepflow/results/*.yaml` for outcomes, update PLAN.md

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

Each task = one background agent. **NEVER use TaskOutput** — it returns full transcripts (100KB+) that explode context.

**Wait Strategy: Bash Monitor**
- One Bash call that monitors result files
- Shows progress via streaming (user sees in real-time)
- Minimal context (just the final output)
- User can react/cancel if needed

```python
# 1. Spawn agents in parallel (single message, multiple Task calls)
Task(subagent_type="general-purpose", run_in_background=True, prompt="T1: ...")
Task(subagent_type="general-purpose", run_in_background=True, prompt="T2: ...")
Task(subagent_type="general-purpose", run_in_background=True, prompt="T3: ...")

# 2. Wait with Bash monitor (ONE call, streams progress to user)
# IMPORTANT: Use find (not globs) — globs fail in zsh when no matches exist
Bash("""
RESULTS_DIR="{worktree}/.deepflow/results"
EXPECTED=3
SEEN=""
for i in $(seq 1 60); do
  for f in $(find "$RESULTS_DIR" -name '*.yaml' 2>/dev/null); do
    name=$(basename "$f" .yaml)
    if ! echo "$SEEN" | grep -q "$name"; then
      echo "✓ $name"
      SEEN="$SEEN $name"
    fi
  done
  COUNT=$(find "$RESULTS_DIR" -name '*.yaml' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COUNT" -ge "$EXPECTED" ]; then echo "ALL COMPLETE"; exit 0; fi
  sleep 5
done
echo "TIMEOUT: some tasks did not complete"
""")

# 3. Read actual results (minimal context)
Read("{worktree}/.deepflow/results/T1.yaml")
Read("{worktree}/.deepflow/results/T2.yaml")
Read("{worktree}/.deepflow/results/T3.yaml")
```

**User sees streaming:**
```
✓ T1
✓ T3
✓ T2
ALL COMPLETE
```

Result file `.deepflow/results/{task_id}.yaml`:
```yaml
task: T3
status: success|failed
commit: abc1234
summary: "one line"
```

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

Ready = `[ ]` + all `blocked_by` complete + experiment validated (if applicable) + not in checkpoint.

### 6. SPAWN AGENTS

Context ≥50%: checkpoint and exit.

**CRITICAL: Spawn ALL ready tasks in a SINGLE response with MULTIPLE Task tool calls.**

DO NOT spawn one task, wait, then spawn another. Instead, call Task tool multiple times in the SAME message block. This enables true parallelism.

Example: If T1, T2, T3 are ready, send ONE message containing THREE Task tool invocations:

```
// In a SINGLE assistant message, invoke Task THREE times:
Task(subagent_type="general-purpose", model="sonnet", run_in_background=true, prompt="T1: ...")
Task(subagent_type="general-purpose", model="sonnet", run_in_background=true, prompt="T2: ...")
Task(subagent_type="general-purpose", model="sonnet", run_in_background=true, prompt="T3: ...")
```

**WRONG (sequential):** Send message with Task for T1 → wait → send message with Task for T2 → wait → ...
**RIGHT (parallel):** Send ONE message with Task for T1, T2, T3 all together

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
VERIFIED_PASS → Unblock, log "✓ Spike {task_id} verified"
VERIFIED_FAIL → Block, log "✗ Spike {task_id} failed verification"
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

Implement, test, commit as feat({spec}): {description}.
Write result to {worktree_absolute_path}/.deepflow/results/{task_id}.yaml
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

Rules:
- `met: true` ONLY if actual satisfies target
- `status: success` ONLY if ALL criteria met
- Worse than baseline = FAILED (baseline 7k, actual 1.5k → FAILED)
- "Close enough" = FAILED
- Verifier will check. False positives waste resources.
```

### 8. FAILURE HANDLING

When a task fails and cannot be auto-fixed:

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

### 10. ITERATE

After spawning agents, use Bash monitor to wait. **NEVER use TaskOutput** — it explodes context.

```python
# After spawning T1, T2, T3 in parallel:

# 1. Wait with Bash monitor (streams progress to user)
Bash("timeout 300 bash -c '...' ")  # See Agent Protocol for full script

# 2. Read results
Read("{worktree}/.deepflow/results/T1.yaml")
Read("{worktree}/.deepflow/results/T2.yaml")
Read("{worktree}/.deepflow/results/T3.yaml")
```

Then check which tasks completed, update PLAN.md, identify newly unblocked tasks, spawn next wave.

Repeat until: all done, all blocked, or context ≥50% (checkpoint).

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

Wave 1: T1, T2 parallel (context: 25%)
  T1: success (abc1234)
  T2: success (def5678)

Wave 2: T3 (context: 48%)
  T3: success (ghi9012)

✓ doing-upload → done-upload
✓ Complete: 3/3 tasks

Next: Run /df:verify to verify specs and merge to main
```

### Spike-First Execution

```
/df:execute (context: 10%)

Checking experiment status...
  T1 [SPIKE]: No experiment yet, spike executable
  T2: Blocked by T1 (spike not validated)
  T3: Blocked by T1 (spike not validated)

Wave 1: T1 [SPIKE] (context: 15%)
  T1: complete, verifying...

Verifying T1...
  ✓ Spike T1 verified (throughput 8500 >= 7000)
  → upload--streaming--passed.md

Wave 2: T2, T3 parallel (context: 40%)
  T2: success (def5678)
  T3: success (ghi9012)

✓ doing-upload → done-upload
✓ Complete: 3/3 tasks

Next: Run /df:verify to verify specs and merge to main
```

### Spike Failed (Agent Correctly Reported)

```
/df:execute (context: 10%)

Wave 1: T1 [SPIKE] (context: 15%)
  T1: complete, verifying...

Verifying T1...
  ✗ Spike T1 failed verification (throughput 1500 < 7000)
  → upload--streaming--failed.md

⚠ Spike T1 invalidated hypothesis
Complete: 1/3 tasks (2 blocked by failed experiment)

Next: Run /df:plan to generate new hypothesis spike
```

### Spike Failed (Verifier Override)

```
/df:execute (context: 10%)

Wave 1: T1 [SPIKE] (context: 15%)
  T1: complete (agent said: success), verifying...

Verifying T1...
  ✗ Spike T1 failed verification (throughput 1500 < 7000)
  ⚠ Agent incorrectly marked as passed — overriding to FAILED
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
