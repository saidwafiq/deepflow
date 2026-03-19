---
name: df:resume
description: Synthesize project state into a briefing covering what happened, current decisions, and next steps
allowed-tools: [Read, Grep, Glob, Bash]
---

# /df:resume — Session Continuity Briefing

## Orchestrator Role

Read project state from multiple sources, produce a concise briefing for resuming work. Pure read-only.

**NEVER:** Write/create/modify files, run git write ops, use AskUserQuestion, spawn agents, use TaskOutput, EnterPlanMode, ExitPlanMode

**ONLY:** Read files (Bash read-only git commands, Read, Glob, Grep), write briefing to stdout

## Behavior

### 1. GATHER SOURCES (parallel, all reads)

| Source | Command/Path | Purpose |
|--------|-------------|---------|
| Git timeline | `` !`git log --oneline -20` `` | What changed and when |
| Decisions | `` !`cat .deepflow/decisions.md 2>/dev/null \|\| echo 'NOT_FOUND'` `` | Live [APPROACH], [PROVISIONAL], [ASSUMPTION] entries |
| Plan | `` !`cat PLAN.md 2>/dev/null \|\| echo 'NOT_FOUND'` `` | Task status (checked vs unchecked) |
| Spec headers | `` !`head -20 specs/doing-*.md 2>/dev/null \|\| echo 'NOT_FOUND'` `` | In-flight features |
| Experiments | `` !`ls .deepflow/experiments/ 2>/dev/null \|\| echo 'NOT_FOUND'` `` | Validated/failed approaches |

Token budget: ~2500 tokens input. Skip missing sources silently.

### 2. SYNTHESIZE BRIEFING (200-500 words, 3 sections)

**## Timeline** — 3-6 sentences: arc of work from git log + spec/PLAN state. What completed, in-flight, notable milestones. Reference dates/commits where informative.

**## Live Decisions** — All `[APPROACH]`, `[PROVISIONAL]`, `[ASSUMPTION]` from `.deepflow/decisions.md` as bullets with tag + text + rationale. Show newest entry per topic if contradictions exist. State "No decisions recorded yet." if absent/empty.

**## Next Steps** — From PLAN.md: unblocked `- [ ]` tasks first, then blocked tasks with blockers. If no PLAN.md: suggest `/df:plan`.

### 3. OUTPUT

Print briefing to stdout. No file writes.

## Rules

- Read sources in a single pass — no re-reads
- Contradicted decisions: show newest per topic only
- Token budget: ~2500 input tokens to produce ~500 words output
