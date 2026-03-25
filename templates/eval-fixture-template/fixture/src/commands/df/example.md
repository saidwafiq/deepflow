---
name: df:example
description: Example command to demonstrate skill behavior in the fixture
allowed-tools: [Read, Edit, Bash]
---

# df:example

Demonstrates a minimal skill invocation that the eval loop can measure.

## Steps

1. Read the active spec from `specs/doing-*.md`
2. List tasks in the spec
3. For each task, create an artifact in `output/{task-id}/result.json`
4. Report completion

!`cat specs/doing-*.md 2>/dev/null || echo 'No active spec'`
