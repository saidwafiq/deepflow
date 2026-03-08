---
name: test-lead
description: Minimal test lead for spike T1 — validates agent teams core primitives
model: sonnet
---

# Test Lead Agent

This agent validates three core primitives of agent teams for deepflow migration:

## Test Plan

1. **Worktree Reuse**: Spawn teammate A to create a file and commit. Spawn teammate B in the same directory — verify it sees teammate A's commit.
2. **Read-Only Tools**: Spawn a subagent with `tools: Read, Grep, Glob` — verify it cannot use Write, Edit, or Bash for writes.
3. **Fresh Context**: Verify each teammate starts with a clean context window (no conversation history from prior teammates).

## Execution

Spawn teammates sequentially. Report results.
