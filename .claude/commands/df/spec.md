# /df:spec — Generate Spec from Conversation

## Purpose
Transform conversation context into a structured specification file.

## Usage
```
/df:spec <name>
```

## Skills
Uses: `gap-discovery` — Proactive requirement gap identification

## Behavior

### 1. GAP CHECK
Before generating, use the `gap-discovery` skill to analyze conversation.

**Required clarity:**
- [ ] Core objective clear
- [ ] Scope boundaries defined (what's in/out)
- [ ] Key constraints identified
- [ ] Success criteria stated

**If gaps exist**, use the `AskUserQuestion` tool to ask structured questions:

```json
{
  "questions": [
    {
      "question": "Clear, specific question ending with ?",
      "header": "Short label",
      "multiSelect": false,
      "options": [
        {"label": "Option 1", "description": "What this means"},
        {"label": "Option 2", "description": "What this means"}
      ]
    }
  ]
}
```

Max 4 questions per tool call. Wait for answers before proceeding.

### 2. GENERATE SPEC

Once gaps covered, create `specs/{name}.md`:

```markdown
# {Name}

## Objective
[One sentence: what this achieves for the user]

## Requirements
- REQ-1: [Requirement]
- REQ-2: [Requirement]
- REQ-3: [Requirement]

## Constraints
- [Constraint 1]
- [Constraint 2]

## Out of Scope
- [Explicitly excluded item]

## Acceptance Criteria
- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]
- [ ] [Testable criterion 3]

## Technical Notes
[Any implementation hints, preferred approaches, or context]
```

### 3. CONFIRM

After writing:
```
✓ Created specs/{name}.md

Requirements: {count}
Acceptance criteria: {count}

Next: Run /df:plan to generate tasks
```

## Rules
- Do NOT generate spec if critical gaps remain
- Ask maximum 5 questions per round (not overwhelming)
- Requirements must be testable
- Acceptance criteria must be verifiable
- Keep specs concise (<100 lines)

## Example

```
USER: I want to add image upload

CLAUDE: [Uses AskUserQuestion tool]
{
  "questions": [
    {
      "question": "What file types should be supported?",
      "header": "File types",
      "multiSelect": true,
      "options": [
        {"label": "JPG/PNG only", "description": "Standard formats"},
        {"label": "Include WebP", "description": "Modern compression"},
        {"label": "Include GIF", "description": "Animated images"}
      ]
    },
    {
      "question": "What's the maximum upload size?",
      "header": "Size limit",
      "multiSelect": false,
      "options": [
        {"label": "5 MB", "description": "Fast uploads"},
        {"label": "10 MB (Recommended)", "description": "Balanced"},
        {"label": "25 MB", "description": "High-res photos"}
      ]
    },
    {
      "question": "Where should files be stored?",
      "header": "Storage",
      "multiSelect": false,
      "options": [
        {"label": "S3 (Recommended)", "description": "Scalable cloud storage"},
        {"label": "Local filesystem", "description": "Simple, single server"},
        {"label": "Cloudflare R2", "description": "S3-compatible, no egress fees"}
      ]
    },
    {
      "question": "Who can upload files?",
      "header": "Auth",
      "multiSelect": false,
      "options": [
        {"label": "Logged-in users", "description": "Require authentication"},
        {"label": "Public", "description": "Anyone can upload"},
        {"label": "Role-based", "description": "Specific roles only"}
      ]
    }
  ]
}

USER: [Selects: JPG/PNG + WebP, 10MB, S3, Logged-in users]

CLAUDE: ✓ Created specs/image-upload.md

Requirements: 4
Acceptance criteria: 5

Next: Run /df:plan to generate tasks
```
