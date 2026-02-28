# Explore Agent Pattern

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

Return ONLY:
- File paths matching criteria
- One-line description per file
- Integration points (if asked)

DO NOT: read/summarize specs, make recommendations, propose solutions, generate tables.

Max response: 500 tokens (configurable via .deepflow/config.yaml explore.max_tokens)
```

## Scope Restrictions

MUST only report factual findings: files found, patterns/conventions, integration points.

MUST NOT: make recommendations, propose architectures, summarize specs, draw conclusions.
