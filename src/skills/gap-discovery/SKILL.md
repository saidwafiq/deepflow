---
name: gap-discovery
description: Discovers requirement gaps during ideation. Use when user describes features, planning specs, or requirements seem incomplete. Asks clarifying questions about scope, constraints, edge cases, success criteria.
allowed-tools: [AskUserQuestion, Read]
---

# Gap Discovery — Proactive Requirement Gap Identification

## Gap Categories

| Category | Example Question |
|----------|------------------|
| **Scope** | "Should this handle X, or is that separate?" |
| **Edge cases** | "What happens if user uploads 50MB file?" |
| **Constraints** | "Max size? Performance needs? Mobile support?" |
| **Dependencies** | "Does this need auth? Existing API?" |
| **Success criteria** | "How will you know this works?" |
| **Anti-goals** | "What should this explicitly NOT do?" |

## AskUserQuestion Format

```json
{
  "questions": [
    {
      "question": "Clear, specific question ending with ?",
      "header": "Short label (max 12 chars)",
      "multiSelect": true,
      "options": [
        {"label": "Option 1", "description": "What this means"},
        {"label": "Option 2", "description": "What this means"}
      ]
    }
  ]
}
```

| Constraint | Value |
|-----------|-------|
| header | Max 12 characters |
| options | 2-4 per question, each with label + description |
| multiSelect | true when choices aren't mutually exclusive |
| questions | Max 4 per tool call |
| Other | Users can always select "Other" for custom input |

## Process

1. Listen to user's description
2. Identify categories lacking clarity
3. Use `AskUserQuestion` with 1-4 targeted questions
4. Wait for answers
5. Follow up if answers reveal new gaps
6. Signal: "Requirements clear. Ready to proceed."

## Rules

- Be specific — offer concrete choices with trade-offs explained
- BAD: "Any other requirements?" / GOOD: "Max file size?" with concrete options
- BAD: "What about errors?" / GOOD: "If upload fails, retry or show error?" with choices
- Don't assume — ask. Stop when gaps are covered.
