---
name: df:auto
description: Set up and launch fully autonomous execution with plan generation and ratchet snapshots
---

# /df:auto — Autonomous Mode Setup

Set up and launch fully autonomous execution. Runs `/df:plan` if no PLAN.md exists, takes a ratchet snapshot, then starts `/loop 1m /df:auto-cycle`.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Usage
```
/df:auto    # Set up and start autonomous loop
```

## Behavior

### 1. RUN PLAN IF NEEDED

```
If PLAN.md does not exist:
  → Run /df:plan via Skill tool (skill: "df:plan", no args)
  → Wait for plan to complete before continuing
If PLAN.md exists:
  → Skip planning, proceed to step 2
```

### 2. RATCHET SNAPSHOT

Before starting the loop, snapshot pre-existing test files so the ratchet has a stable baseline:

```bash
# Snapshot pre-existing test files (only these count for ratchet)
git ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
  > .deepflow/auto-snapshot.txt

echo "Ratchet snapshot: $(wc -l < .deepflow/auto-snapshot.txt) pre-existing test files"
```

**Only pre-existing test files are used for ratchet evaluation.** New test files created by agents during implementation do not influence pass/fail decisions. This prevents agents from gaming the ratchet by writing tests that pass trivially.

### 3. START LOOP

Launch the autonomous cycle loop:

```
/loop 1m /df:auto-cycle
```

This starts `/df:auto-cycle` on a 1-minute recurring interval. Each invocation runs with fresh context — no coordination overhead, zero LLM tokens on loop management.

## Rules

| Rule | Detail |
|------|--------|
| Plan once | Only runs `/df:plan` if PLAN.md is absent |
| Snapshot before loop | Ratchet baseline is set before any agents run |
| No lead agent | No custom orchestrator — `/loop` is a native Claude Code feature |
| Zero loop overhead | Loop coordination uses zero LLM tokens |
| Cycle logic lives in `/df:auto-cycle` | This command is setup only |

## Example

```
/df:auto

No PLAN.md found — running /df:plan...
  ✓ Plan generated — 1 spec, 5 tasks.

Ratchet snapshot: 12 pre-existing test files

Starting loop: /loop 1m /df:auto-cycle
```

```
/df:auto

PLAN.md exists — skipping plan.

Ratchet snapshot: 12 pre-existing test files

Starting loop: /loop 1m /df:auto-cycle
```
