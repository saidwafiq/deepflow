# Experiment: Agent Teams Core Primitives

**Status:** active
**Date:** 2026-03-08
**Spec:** deepflow-v3-agent-teams

## Hypothesis

Agent teams can (a) reuse a worktree created by a prior teammate, (b) restrict a subagent to read-only tools, (c) provide fresh context per phase.

## Method

Documentation research and minimal agent definition creation to validate the three primitives.

## Results

### Criterion 1: Worktree Reuse — MET

Agent team teammates share the lead's working directory by default. Sequential teammates see each other's commits because they work in the same git repo. No automatic worktree isolation for teammates (subagents have optional `isolation: worktree`).

**Caveat:** Current shell orchestration (`deepflow-auto.sh`) provides MORE control — you can target any directory per process. Agent teams constrain teammates to the lead's directory.

### Criterion 2: Read-Only Tools — MET

The `tools` frontmatter field in `.claude/agents/*.md` is a stable allowlist. Setting `tools: Read, Grep, Glob` restricts the subagent to ONLY those three tools. Write, Edit, Bash become unavailable. The built-in Explore subagent uses this exact pattern. `disallowedTools` also available for denylist approach.

**Caveat:** For team agents (not subagents), `disallowedTools` was fixed in v2.1.69, but `skills` and `hooks` are still broken (GitHub issue #30703).

### Criterion 3: Fresh Context — MET

Each subagent/teammate creates a new instance with a fresh context window. They load project context (CLAUDE.md, MCP servers, skills) but do NOT inherit conversation history from the lead or prior teammates.

## Caveats

- Agent teams is EXPERIMENTAL with known limitations (issue #30703: custom agent definitions partially broken for team agents; no session resumption; skills/hooks silently ignored)
- The subagent system is stable and covers criteria 2 and 3 well
- Current shell orchestration provides the most control for criterion 1
- A hybrid approach using stable subagents + shell orchestration may be more reliable than full migration to experimental agent teams

## Conclusion

All three primitives are supported. Migration is feasible but carries risk due to the experimental nature of agent teams. Recommend proceeding with T2 (Sonnet-as-lead quality validation) before committing to full migration.
