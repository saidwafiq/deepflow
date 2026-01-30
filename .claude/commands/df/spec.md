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

**If gaps exist**, ask targeted questions (see skill for categories).

Max 5 questions per round. Wait for answers before proceeding.

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

CLAUDE: A few questions before I create the spec:

1. **File types**: Just images (jpg/png), or also gifs/videos?
2. **Size limit**: Max file size?
3. **Storage**: Local, S3, or other?
4. **Auth**: Anyone can upload, or logged-in users only?

USER: jpg/png/webp only, max 10MB, S3, logged-in only

CLAUDE: ✓ Created specs/image-upload.md

Requirements: 4
Acceptance criteria: 5

Next: Run /df:plan to generate tasks
```
