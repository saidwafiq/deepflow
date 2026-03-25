# Explore Agent — Orchestrator Rules

Instructions for commands that **spawn** Explore agents (plan, spec, debate).
The agent itself receives `explore-protocol.md` automatically via hook.

## Spawn Rules

**NEVER use `run_in_background`** — causes late "Agent completed" notifications.
**NEVER use TaskOutput** — returns full transcripts (100KB+) that explode context.

Spawn ALL agents in ONE message (non-background, parallel):
```python
Task(subagent_type="Explore", model="haiku", prompt="Find: ...")
Task(subagent_type="Explore", model="haiku", prompt="Find: ...")
# Returns final message only; blocks until all complete; no late notifications
```

## Prompt Structure

```
Find: [specific question]
```

Do NOT include search instructions in the prompt — the `df-explore-protocol` hook injects `explore-protocol.md` automatically.

## Scope Restrictions

MUST only report factual findings: files found, patterns/conventions, integration points.

MUST NOT: make recommendations, propose architectures, summarize specs, draw conclusions.
