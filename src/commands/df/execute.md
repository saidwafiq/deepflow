# /df:execute — Execute Tasks from Plan

## Orchestrator Role

You spawn agents and poll results. You never implement.

**NEVER:** Read source files, edit code, run tests, run git (except status), use `TaskOutput`

**ONLY:** Read `PLAN.md` + `specs/doing-*.md`, spawn background agents, poll `.deepflow/results/`, update PLAN.md

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
- Agent: `general-purpose` (Sonnet) — Task implementation
- Agent: `reasoner` (Opus) — Debugging failures

## Context-Aware Execution

Statusline writes to `.deepflow/context.json`: `{"percentage": 45}`

| Context % | Action |
|-----------|--------|
| < 50% | Full parallelism (up to 5 agents) |
| ≥ 50% | Wait for running agents, checkpoint, exit |

## Agent Protocol

Every task = one background agent. Poll result files, never `TaskOutput`.

```python
Task(subagent_type="general-purpose", run_in_background=True, prompt="T1: ...")
# Poll: Glob(".deepflow/results/T*.yaml")
```

Result file `.deepflow/results/{task_id}.yaml`:
```yaml
task: T3
status: success|failed
commit: abc1234
summary: "one line"
```

## Checkpoint & Resume

**File:** `.deepflow/checkpoint.json` — stores completed tasks, current wave.

**On checkpoint:** Complete wave → update PLAN.md → save → exit.
**Resume:** `--continue` loads checkpoint, skips completed tasks.

## Behavior

### 1. CHECK CHECKPOINT

```
--continue → Load and resume
--fresh → Delete checkpoint, start fresh
checkpoint exists → Prompt: "Resume? (y/n)"
else → Start fresh
```

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

Spawn all ready tasks in ONE message (parallel). Same-file conflicts: sequential.

**Spike Task Execution:**
When spawning a spike task, the agent MUST:
1. Execute the minimal validation method
2. Record result in experiment file (update status: `--passed.md` or `--failed.md`)
3. If passed: implementation tasks become unblocked
4. If failed: record conclusion with "next hypothesis" for future planning

On failure: spawn `reasoner`.

### 7. PER-TASK (agent prompt)

**Standard Task:**
```
{task_id}: {description from PLAN.md}
Files: {target files}
Spec: {spec_name}

Implement, test, commit as feat({spec}): {description}.
Write result to .deepflow/results/{task_id}.yaml
```

**Spike Task:**
```
{task_id} [SPIKE]: {hypothesis}
Type: spike
Method: {minimal steps to validate}
Success criteria: {how to know it passed}
Time-box: {duration}
Experiment file: {.deepflow/experiments/{topic}--{hypothesis}--active.md}
Spec: {spec_name}

Execute the minimal validation:
1. Follow the method steps exactly
2. Measure against success criteria
3. Update experiment file with result:
   - If passed: rename to --passed.md, record findings
   - If failed: rename to --failed.md, record conclusion with "next hypothesis"
4. Commit as spike({spec}): validate {hypothesis}
5. Write result to .deepflow/results/{task_id}.yaml

Result status:
- success = hypothesis validated (passed)
- failed = hypothesis invalidated (failed experiment, NOT agent error)
```

### 8. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Embed history in spec: `## Completed` section
2. Rename: `doing-upload.md` → `done-upload.md`
3. Remove section from PLAN.md

### 9. ITERATE

Repeat until: all done, all blocked, or checkpoint.

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
```

### Spike-First Execution

```
/df:execute (context: 10%)

Checking experiment status...
  T1 [SPIKE]: No experiment yet, spike executable
  T2: Blocked by T1 (spike not validated)
  T3: Blocked by T1 (spike not validated)

Wave 1: T1 [SPIKE] (context: 20%)
  T1: success (abc1234) → upload--streaming--passed.md

Checking experiment status...
  T2: Experiment passed, unblocked
  T3: Experiment passed, unblocked

Wave 2: T2, T3 parallel (context: 45%)
  T2: success (def5678)
  T3: success (ghi9012)

✓ doing-upload → done-upload
✓ Complete: 3/3 tasks
```

### Spike Failed

```
/df:execute (context: 10%)

Wave 1: T1 [SPIKE] (context: 20%)
  T1: failed → upload--streaming--failed.md

Checking experiment status...
  T2: ⚠ Blocked - Experiment failed
  T3: ⚠ Blocked - Experiment failed

⚠ Spike T1 invalidated hypothesis
  Experiment: upload--streaming--failed.md
  → Run /df:plan to generate new hypothesis spike

Complete: 1/3 tasks (2 blocked by failed experiment)
```

### With Checkpoint

```
Wave 1 complete (context: 52%)
Checkpoint saved. Run /df:execute --continue
```
