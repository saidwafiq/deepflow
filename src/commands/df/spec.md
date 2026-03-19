---
name: df:spec
description: Transform conversation context into a structured specification file with requirements and acceptance criteria
---

# /df:spec — Generate Spec from Conversation

## Orchestrator Role

You coordinate agents and ask questions. You never search code directly.

**NEVER:** Read source files, use Glob/Grep directly, run git, use TaskOutput, use EnterPlanMode, use ExitPlanMode

**ONLY:** Spawn agents (non-background), ask user questions, write spec file

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

**Check for debate file first:** If `specs/.debate-{name}.md` exists, read it using the Read tool. Pass its content (especially the Synthesis section) to the reasoner agent in step 3 as additional context.

Follow `templates/explore-agent.md` for spawn rules, prompt structure, and scope restrictions.

Find: related implementations, code patterns/conventions, integration points, existing TODOs.

| Codebase Size | Agents |
|---------------|--------|
| <20 files | 2-3 |
| 20-100 | 5-8 |
| 100+ | 10-15 |

### 2. GAP CHECK (layer-aware)

Use the `gap-discovery` skill to analyze conversation + agent findings. Gaps determine the spec's layer — they do NOT block spec creation.

**Clarity checklist (maps to layers):**
- [ ] Core objective clear → L0
- [ ] Requirements enumerated → L1
- [ ] Success criteria stated (testable ACs) → L2
- [ ] Scope boundaries + constraints + technical context → L3

**If gaps exist for L0–L1** (no objective or no requirements), use the `AskUserQuestion` tool to ask structured questions — these are essential:

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

**If gaps exist for L2–L3** (no ACs, no constraints, no technical notes), do NOT block. Write the spec at whatever layer the available information supports. Spikes will discover what's missing.

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
- Verify every REQ-N has at least one corresponding Acceptance Criterion; flag any uncovered requirements
- Identify and flag vague or untestable requirements before finalizing (e.g., "should be fast" without a metric)

### 4. GENERATE SPEC

Once essential gaps covered (L0–L1 minimum) and context gathered, run `validateSpec` on the generated content **before** writing the file.
- **Hard failure:** Do NOT write the file. Show errors to the user with actionable fix suggestions and re-synthesize.
- **Advisory warnings:** Write the file but display the warnings to the user after confirmation.
- **Layer < 2:** This is expected when information is incomplete. Write the spec — spikes will deepen it.

Create `specs/{name}.md`:

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
✓ Created specs/{name}.md — Layer {N} ({label})

Requirements: {count}
Acceptance criteria: {count}

Next: Run /df:plan to generate tasks
```

**Layer labels:** L0 = "problem defined", L1 = "requirements known", L2 = "verifiable", L3 = "fully constrained"

If layer < 2, add:
```
ℹ Spec is at L{N} — /df:plan will generate spikes to discover what's missing.
  To deepen: add {missing sections for next layer}.
```

## Rules
- **Orchestrator never searches** — Spawn agents for all codebase exploration
- Do NOT generate spec if L0 gaps remain (no clear objective)
- L2+ gaps do NOT block spec creation — write at current layer, spikes will deepen
- Ask maximum 4 questions per tool call (not overwhelming)
- Requirements must be testable (when present)
- Acceptance criteria must be verifiable (when present)
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
