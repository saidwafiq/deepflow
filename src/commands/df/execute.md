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

### 4. IDENTIFY READY TASKS

Ready = `[ ]` + all `blocked_by` complete + not in checkpoint.

### 5. SPAWN AGENTS

Context ≥50%: checkpoint and exit.

Spawn all ready tasks in ONE message (parallel). Same-file conflicts: sequential.

On failure: spawn `reasoner`.

### 6. PER-TASK (agent prompt)

```
{task_id}: {description from PLAN.md}
Files: {target files}
Spec: {spec_name}

Implement, test, commit as feat({spec}): {description}.
Write result to .deepflow/results/{task_id}.yaml
```

### 7. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Embed history in spec: `## Completed` section
2. Rename: `doing-upload.md` → `done-upload.md`
3. Remove section from PLAN.md

### 8. ITERATE

Repeat until: all done, all blocked, or checkpoint.

## Rules

| Rule | Detail |
|------|--------|
| 1 task = 1 agent = 1 commit | `atomic-commits` skill |
| 1 file = 1 writer | Sequential if conflict |
| Agents verify internally | Fix issues, don't report |

## Example

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

With checkpoint:
```
Wave 1 complete (context: 52%)
Checkpoint saved. Run /df:execute --continue
```
