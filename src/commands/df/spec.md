---
name: df:spec
description: Transform conversation context into a structured specification file with requirements and acceptance criteria
allowed-tools: [Task, AskUserQuestion, Write]
---

# /df:spec — Generate Spec from Conversation

## Orchestrator Role

Coordinate agents and ask questions. Never search code directly.

**NEVER:** Read source files, use Glob/Grep directly, run git, use TaskOutput, EnterPlanMode, ExitPlanMode

**ONLY:** Spawn agents (non-background), ask user questions, write spec file

## Agents

| Agent | subagent_type | model | Count | Purpose |
|-------|---------------|-------|-------|---------|
| Explore | `Explore` | `haiku` | 2-3 (<20 files), 5-8 (20-100), 10-15 (100+) | Find related code, patterns |
| Reasoner | `reasoner` | `opus` | 1 | Synthesize into requirements |

Skill: `gap-discovery` — Proactive requirement gap identification

**IMPORTANT**: Always use `Task` tool with explicit `subagent_type` and `model` parameters.

## Behavior

### 1. GATHER CODEBASE CONTEXT

Check for `specs/.debate-{name}.md` first — if exists, read it and pass Synthesis section to reasoner in step 3.

Follow `templates/explore-agent.md` for spawn rules, prompt structure, scope restrictions. Find: related implementations, code patterns/conventions, integration points, existing TODOs.

### 2. GAP CHECK (layer-aware)

Use `gap-discovery` skill. Gaps determine spec layer — they do NOT block spec creation.

**Clarity checklist (maps to layers):**
- Core objective clear → L0
- Requirements enumerated → L1
- Testable ACs stated → L2
- Scope boundaries + constraints + technical context → L3

**L0-L1 gaps** (no objective/requirements): Use `AskUserQuestion` tool (max 4 questions per call, wait for answers). See `gap-discovery` skill for format.

**L2-L3 gaps**: Do NOT block. Write spec at current layer — spikes will discover what's missing.

### 3. SYNTHESIZE FINDINGS

Spawn reasoner agent (`subagent_type: "reasoner"`, `model: "opus"`). The reasoner:
- Analyzes codebase context from Explore agents
- Identifies constraints from existing architecture
- Suggests requirements based on patterns found
- Flags conflicts with existing code
- Verifies every REQ-N has a corresponding AC; flags uncovered requirements
- Flags vague/untestable requirements (e.g., "should be fast" without a metric)
- If Explore agents found type definitions or interfaces relevant to this spec, include a ## Domain Model section with Key Types (signatures only) and Ubiquitous Language (domain terms). Omit if no relevant types found.

### 4. GENERATE SPEC

Run `validateSpec` on generated content **before** writing.
- **Hard failure:** Do NOT write. Show errors with fix suggestions, re-synthesize.
- **Advisory warnings:** Write file, display warnings after confirmation.
- **Layer < 2:** Expected when info incomplete. Write the spec.

Create `specs/{name}.md`:

```markdown
# {Name}

## Objective
[One sentence: what this achieves for the user]

## Requirements
- REQ-1: [Requirement]
- REQ-2: [Requirement]

## Constraints
- [Constraint]

## Out of Scope
- [Explicitly excluded item]

## Acceptance Criteria
- [ ] **AC-1** — (REQ-1) [Testable criterion]
- [ ] **AC-2** — (REQ-2) [Testable criterion]

## Technical Notes
[Implementation hints from codebase analysis — patterns, integration points, constraints discovered by agents]
```

### 5. CONFIRM

```
✓ Created specs/{name}.md — Layer {N} ({label})

Requirements: {count}
Acceptance criteria: {count}

Next: Run /df:plan to generate tasks
```

**Layer labels:** L0="problem defined", L1="requirements known", L2="verifiable", L3="fully constrained"

If layer < 2: `ℹ Spec is at L{N} — /df:plan will generate spikes to discover what's missing. To deepen: add {missing sections for next layer}.`

## Rules

- Orchestrator never searches — spawn agents for all codebase exploration
- Do NOT generate spec if L0 gaps remain (no clear objective)
- L2+ gaps do NOT block spec creation
- Max 4 questions per AskUserQuestion call
- Requirements must be testable; ACs must be verifiable (when present)
- Every AC line MUST use format `- [ ] **AC-N** — (REQ-M) ...`. Never reuse `REQ-N:` as the AC identifier (lint hard-fails on missing **AC-N** and duplicate REQ-N).
- Include agent-discovered context in Technical Notes
- Keep specs concise (<100 lines)
