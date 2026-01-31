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

## Implementation

**Use the `AskUserQuestion` tool** to ask structured questions with predefined options.

### AskUserQuestion Format

```json
{
  "questions": [
    {
      "question": "What file types should be supported?",
      "header": "File types",
      "multiSelect": true,
      "options": [
        {"label": "JPG/PNG only", "description": "Standard image formats"},
        {"label": "Include WebP", "description": "Modern format with better compression"},
        {"label": "Include GIF", "description": "Animated images supported"},
        {"label": "Include video", "description": "MP4, WebM formats"}
      ]
    }
  ]
}
```

### Guidelines for AskUserQuestion

- **header**: Max 12 characters (e.g., "File types", "Auth", "Storage")
- **options**: 2-4 choices per question, each with label + description
- **multiSelect**: Set `true` when choices aren't mutually exclusive
- **questions**: Max 4 questions per tool call (tool limit)
- Users can always select "Other" to provide custom input

### Example Questions by Category

**Scope:**
```json
{
  "question": "Should this feature include admin management?",
  "header": "Scope",
  "multiSelect": false,
  "options": [
    {"label": "Yes, include admin", "description": "Add admin dashboard for management"},
    {"label": "No, user-only", "description": "Only end-user functionality"},
    {"label": "Phase 2", "description": "Add admin features later"}
  ]
}
```

**Constraints:**
```json
{
  "question": "What's the maximum file size for uploads?",
  "header": "Size limit",
  "multiSelect": false,
  "options": [
    {"label": "5 MB", "description": "Conservative, fast uploads"},
    {"label": "10 MB (Recommended)", "description": "Balanced for most images"},
    {"label": "25 MB", "description": "High-res photos supported"},
    {"label": "50 MB", "description": "Large files, slower uploads"}
  ]
}
```

**Dependencies:**
```json
{
  "question": "What authentication is required?",
  "header": "Auth",
  "multiSelect": false,
  "options": [
    {"label": "Public access", "description": "No login required"},
    {"label": "Logged-in users", "description": "Require authentication"},
    {"label": "Role-based", "description": "Different permissions per role"}
  ]
}
```

## Process

1. Listen to user's description
2. Identify categories lacking clarity
3. Use `AskUserQuestion` with 1-4 targeted questions
4. Wait for answers
5. Follow up if answers reveal new gaps (another AskUserQuestion call)
6. Signal when ready: "Requirements clear. Ready to proceed."

## Question Quality

```
BAD:  "Any other requirements?"
GOOD: "Max file size for uploads?" with concrete options

BAD:  "What about errors?"
GOOD: "If upload fails, retry automatically or show error to user?" with clear choices
```

## Rules

- Use `AskUserQuestion` tool for structured input
- Max 4 questions per tool call (tool limitation)
- Headers max 12 characters
- 2-4 options per question with descriptions
- Use multiSelect when choices can combine
- Be specific, offer choices with trade-offs explained
- Don't assume - ask
- Stop when gaps are covered
