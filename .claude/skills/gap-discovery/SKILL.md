---
name: gap-discovery
description: Discovers requirement gaps during ideation. Use when user describes features, planning specs, or requirements seem incomplete. Asks clarifying questions about scope, constraints, edge cases, success criteria.
---

# Gap Discovery

Proactively identify missing requirements before implementation.

## Gap Categories

| Category | Example Question |
|----------|------------------|
| **Scope** | "Should this handle X, or is that separate?" |
| **Edge cases** | "What happens if user uploads 50MB file?" |
| **Constraints** | "Max size? Performance needs? Mobile support?" |
| **Dependencies** | "Does this need auth? Existing API?" |
| **Success criteria** | "How will you know this works?" |
| **Anti-goals** | "What should this explicitly NOT do?" |

## Process

1. Listen to user's description
2. Identify categories lacking clarity
3. Ask 3-5 targeted questions (not overwhelming)
4. Wait for answers
5. Follow up if answers reveal new gaps
6. Signal when ready: "Requirements clear. Ready to proceed."

## Question Quality

```
BAD:  "Any other requirements?"
GOOD: "Max file size for uploads?"

BAD:  "What about errors?"
GOOD: "If upload fails, retry automatically or show error to user?"
```

## Rules

- Max 5 questions per round
- Be specific, offer choices when possible
- Don't assume - ask
- Stop when gaps are covered
