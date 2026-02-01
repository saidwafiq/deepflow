# /df:spec — Generate Spec from Conversation

## Orchestrator Role

You coordinate agents and ask questions. You never search code directly.

**NEVER:** Read source files, use Glob/Grep directly, run git

**ONLY:** Spawn agents, poll results, ask user questions, write spec file

---

## Purpose
Transform conversation context into a structured specification file.

## Usage
```
/df:spec <name>
```

## Skills & Agents
- Skill: `gap-discovery` — Proactive requirement gap identification

**Use Task tool to spawn agents:**
| Agent | subagent_type | model | Purpose |
|-------|---------------|-------|---------|
| Context | `Explore` | `haiku` | Codebase context gathering |
| Synthesizer | `reasoner` | `opus` | Synthesize findings into requirements |

## Behavior

### 1. GATHER CODEBASE CONTEXT

**Use Task tool to spawn Explore agents in parallel:**
```
Task tool parameters:
- subagent_type: "Explore"
- model: "haiku"
- run_in_background: true
```

Find:
- Related existing implementations
- Code patterns and conventions
- Integration points relevant to the feature
- Existing TODOs or placeholders in related areas

| Codebase Size | Agents |
|---------------|--------|
| <20 files | 2-3 |
| 20-100 | 5-8 |
| 100+ | 10-15 |

**Explore Agent Prompt Structure:**
```
Find: [specific question]
Return ONLY:
- File paths matching criteria
- One-line description per file
- Integration points (if asked)

DO NOT:
- Read or summarize spec files
- Make recommendations
- Propose solutions
- Generate tables or lengthy explanations

Max response: 500 tokens (configurable via .deepflow/config.yaml explore.max_tokens)
```

**Explore Agent Scope Restrictions:**
- MUST only report factual findings:
  - Files found
  - Patterns/conventions observed
  - Integration points
- MUST NOT:
  - Make recommendations
  - Propose architectures
  - Read and summarize specs (that's orchestrator's job)
  - Draw conclusions about what should be built

### 2. GAP CHECK
Use the `gap-discovery` skill to analyze conversation + agent findings.

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

### 3. SYNTHESIZE FINDINGS

**Use Task tool to spawn reasoner agent:**
```
Task tool parameters:
- subagent_type: "reasoner"
- model: "opus"
```

The reasoner will:
- Analyze codebase context from Explore agents
- Identify constraints from existing architecture
- Suggest requirements based on patterns found
- Flag potential conflicts with existing code

### 4. GENERATE SPEC

Once gaps covered and context gathered, create `specs/{name}.md`:

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
[Implementation hints from codebase analysis — patterns, integration points, constraints discovered by agents]
```

### 5. CONFIRM

After writing:
```
✓ Created specs/{name}.md

Requirements: {count}
Acceptance criteria: {count}

Next: Run /df:plan to generate tasks
```

## Rules
- **Orchestrator never searches** — Spawn agents for all codebase exploration
- Do NOT generate spec if critical gaps remain
- Ask maximum 4 questions per tool call (not overwhelming)
- Requirements must be testable
- Acceptance criteria must be verifiable
- Include agent-discovered context in Technical Notes
- Keep specs concise (<100 lines)

## Agent Scaling

| Agent | subagent_type | model | Base | Purpose |
|-------|---------------|-------|------|---------|
| Explore | `Explore` | `haiku` | 3-5 | Find related code, patterns |
| Reasoner | `reasoner` | `opus` | 1 | Synthesize into requirements |

**IMPORTANT**: Always use the `Task` tool with explicit `subagent_type` and `model` parameters.

## Example

```
USER: I want to add image upload

CLAUDE: [Spawns 3 Explore agents in parallel]
- "Find existing file handling patterns"
- "Find API endpoint conventions"
- "Find storage service implementations"

[Agents return: Express multer middleware, REST conventions, no cloud storage yet]

CLAUDE: [Uses AskUserQuestion tool]
{
  "questions": [
    {
      "question": "What file types should be supported?",
      "header": "File types",
      "multiSelect": true,
      "options": [
        {"label": "JPG/PNG only", "description": "Standard formats"},
        {"label": "Include WebP", "description": "Modern compression"}
      ]
    },
    {
      "question": "Where should files be stored?",
      "header": "Storage",
      "multiSelect": false,
      "options": [
        {"label": "S3 (Recommended)", "description": "Scalable cloud storage"},
        {"label": "Local filesystem", "description": "Simple, matches current setup"}
      ]
    }
  ]
}

USER: [Selects: JPG/PNG + WebP, S3]

CLAUDE: [Spawns reasoner agent]
- Synthesize: multer + S3 + existing API patterns

CLAUDE: ✓ Created specs/image-upload.md

Requirements: 4
Acceptance criteria: 5
Technical notes: Express/multer pattern, REST conventions from existing API

Next: Run /df:plan to generate tasks
```
