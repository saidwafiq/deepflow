---
name: df:auto
description: Set up and launch fully autonomous execution with plan generation and ratchet snapshots
allowed-tools: [Skill, Read, Write, Bash]
---

# /df:auto — Autonomous Mode Setup

Set up and launch fully autonomous execution. Run `/df:plan` if no PLAN.md, take ratchet snapshot, start `/loop 1m /df:auto-cycle`.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Behavior

### 1. RUN PLAN IF NEEDED

If PLAN.md missing → run `/df:plan` via Skill tool, wait for completion. If exists → skip.

### 2. RATCHET SNAPSHOT

Snapshot pre-existing test files for stable ratchet baseline:

```bash
git ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
  > .deepflow/auto-snapshot.txt
echo "Ratchet snapshot: $(wc -l < .deepflow/auto-snapshot.txt) pre-existing test files"
```

Only pre-existing tests count for ratchet. New agent-created tests are excluded to prevent gaming.

### 3. START LOOP

```
/loop 1m /df:auto-cycle
```

Each invocation gets fresh context — zero LLM tokens on loop management.

## Rules

| Rule | Detail |
|------|--------|
| Plan once | Only runs `/df:plan` if PLAN.md absent |
| Snapshot before loop | Ratchet baseline set before any agents run |
| No lead agent | `/loop` is native Claude Code — no custom orchestrator |
| Cycle logic in `src/skills/auto-cycle/SKILL.md` | This command is setup only; `/df:auto-cycle` is a shim that delegates to the skill |
