# /df:execute — Execute Tasks from Plan

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

Agents write results to `.deepflow/results/{task_id}.yaml`:
```yaml
task: T3
status: success
commit: abc1234
```

**Spawn with:** `run_in_background: true`
**Poll:** `Glob(".deepflow/results/T*.yaml")`
**NEVER use TaskOutput** — returns full trace, wastes context.

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

### 5. CHECK CONTEXT & EXECUTE

If context ≥50%: wait for agents, checkpoint, exit.

| Ready | Strategy |
|-------|----------|
| 1-3 | All parallel |
| 4+ | 5 parallel, queue rest |

1 writer per file. On failure: spawn `reasoner`.

### 6. PER-TASK (agent)

Implement → verify → commit → write result file.

### 7. COMPLETE SPECS

When all tasks done for a `doing-*` spec:
1. Embed history in spec: `## Completed` section
2. Rename: `doing-upload.md` → `done-upload.md`
3. Remove section from PLAN.md

### 8. ITERATE

Repeat until: all done, all blocked, or checkpoint.

## Rules

| Rule | Enforcement |
|------|-------------|
| 1 task = 1 commit | `atomic-commits` skill |
| No broken commits | Verify before commit |
| 1 writer per file | Sequential if conflict |
| Minimal returns | 5 lines max from agents |
| Internal verification | Agents fix issues, don't report |

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
