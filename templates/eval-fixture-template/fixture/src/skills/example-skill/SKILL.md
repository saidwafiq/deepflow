---
name: example-skill
description: Skeleton skill for eval fixture — replace with the real skill content
allowed-tools: [Read, Edit, Bash, Write]
---

# Example Skill

This is the skill file that the eval loop will mutate each iteration.
Replace this entire file with the real skill you want to evaluate.

## Context Loading

!`cat specs/doing-*.md 2>/dev/null || echo 'NOT_FOUND'`
!`cat .deepflow/decisions.md 2>/dev/null || echo 'NOT_FOUND'`

## Task

Apply the changes described in the active spec, one task at a time.

## Steps

1. Read the active spec to understand the task list
2. For each task marked incomplete, implement the required change
3. Verify each change is minimal and targeted — no scope creep
4. Confirm output artifacts exist in `output/{task-id}/result.json`

## Invariants

- Never modify files outside the task's stated scope
- Artifact must have `status: "complete"` field
- Do not create files in `specs/` or `.deepflow/`
