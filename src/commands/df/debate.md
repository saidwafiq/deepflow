# /df:debate — Multi-Perspective Analysis

## Orchestrator Role

You coordinate reasoner agents to debate a problem from multiple perspectives, then synthesize their arguments into a structured document.

**NEVER:** use TaskOutput, use `run_in_background`, use Explore agents, use EnterPlanMode, use ExitPlanMode

**ONLY:** Gather codebase context (Glob/Grep/Read), spawn reasoner agents (non-background), write debate file, respond conversationally

---

## Purpose
Generate a multi-perspective analysis of a problem before formalizing into a spec. Surfaces tensions, trade-offs, and blind spots that a single perspective would miss.

## Usage
```
/df:debate <name>
```

## Skills & Agents

**Use Task tool to spawn agents:**
| Agent | subagent_type | model | Purpose |
|-------|---------------|-------|---------|
| User Advocate | `reasoner` | `opus` | UX, simplicity, real user needs |
| Tech Skeptic | `reasoner` | `opus` | Technical risks, hidden complexity, feasibility |
| Systems Thinker | `reasoner` | `opus` | Integration, scalability, long-term effects |
| LLM Efficiency | `reasoner` | `opus` | Token density, minimal scaffolding, navigable structure |
| Synthesizer | `reasoner` | `opus` | Merge perspectives into consensus + tensions |

---

## Behavior

### 1. SUMMARIZE

Summarize the conversation context (from prior discover/conversation) in ~200 words. This summary will be passed to each perspective agent.

The summary should capture:
- The core problem being solved
- Key requirements mentioned
- Constraints and boundaries
- User's stated preferences and priorities

### 2. GATHER CODEBASE CONTEXT

Before spawning perspectives, ground the debate in what actually exists. Use Glob, Grep, and Read to understand the current implementation relevant to the debate topic.

**Steps:**
1. **Glob** for files related to the topic (e.g., `**/*{topic}*`, `src/**/*.{ts,js,py}`)
2. **Grep** for key terms, patterns, or interfaces mentioned in the conversation
3. **Read** the most relevant files (up to 5-6 files — focus on core logic, not boilerplate)

**Produce a ~300 word codebase summary covering:**
- What already exists (implemented features, patterns, architecture)
- Key interfaces, types, or contracts in play
- Current limitations or technical debt visible in the code
- Dependencies and integration points

This codebase summary is appended to the context passed to every perspective agent, so they argue from facts rather than assumptions.

### 3. SPAWN PERSPECTIVES

**Spawn ALL 4 perspective agents in ONE message (non-background, parallel):**

Each agent receives the same context summary + codebase context but a different role. Each must:
- Argue from their perspective, grounded in what the codebase actually does
- Identify risks the other perspectives might miss
- Propose concrete alternatives where they disagree with the likely approach

```python
# All 4 in a single message — parallel, non-background:
Task(subagent_type="reasoner", model="opus", prompt="""
You are the USER ADVOCATE in a design debate.

## Context
{summary}

## Current Codebase
{codebase_summary}

## Your Role
Argue from the perspective of the end user. Focus on:
- Simplicity and ease of use
- Real user needs vs assumed needs
- Friction points and cognitive load
- Whether the solution matches how users actually think

Provide:
1. Your key arguments (3-5 points)
2. Risks you see from a user perspective
3. Concrete alternatives if you disagree with the current direction

Keep response under 400 words.
""")

Task(subagent_type="reasoner", model="opus", prompt="""
You are the TECH SKEPTIC in a design debate.

## Context
{summary}

## Current Codebase
{codebase_summary}

## Your Role
Challenge technical assumptions and surface hidden complexity. Focus on:
- What could go wrong technically
- Hidden dependencies or coupling
- Complexity that seems simple but isn't
- Maintenance burden over time

Provide:
1. Your key arguments (3-5 points)
2. Technical risks others might overlook
3. Simpler alternatives worth considering

Keep response under 400 words.
""")

Task(subagent_type="reasoner", model="opus", prompt="""
You are the SYSTEMS THINKER in a design debate.

## Context
{summary}

## Current Codebase
{codebase_summary}

## Your Role
Analyze how this fits into the broader system. Focus on:
- Integration with existing components
- Scalability implications
- Second-order effects and unintended consequences
- Long-term evolution and extensibility

Provide:
1. Your key arguments (3-5 points)
2. Systemic risks and ripple effects
3. Architectural alternatives worth considering

Keep response under 400 words.
""")

Task(subagent_type="reasoner", model="opus", prompt="""
You are the LLM EFFICIENCY expert in a design debate.

## Context
{summary}

## Current Codebase
{codebase_summary}

## Your Role
Evaluate from the perspective of LLM consumption and interaction. Focus on:
- Token density: can the output be consumed efficiently by LLMs?
- Minimal scaffolding: avoid ceremony that adds tokens without information
- Navigable structure: can an LLM quickly find what it needs?
- Attention budget: does the design respect limited context windows?

Provide:
1. Your key arguments (3-5 points)
2. Efficiency risks others might not consider
3. Alternatives that optimize for LLM consumption

Keep response under 400 words.
""")
```

### 4. SYNTHESIZE

After all 4 perspectives return, spawn 1 additional reasoner to synthesize:

```python
Task(subagent_type="reasoner", model="opus", prompt="""
You are the SYNTHESIZER. Four perspectives have debated a design problem.

## Context
{summary}

## User Advocate's Arguments
{user_advocate_response}

## Tech Skeptic's Arguments
{tech_skeptic_response}

## Systems Thinker's Arguments
{systems_thinker_response}

## LLM Efficiency's Arguments
{llm_efficiency_response}

## Your Task
Synthesize these perspectives into:

1. **Consensus** — Points where all or most perspectives agree
2. **Tensions** — Unresolved disagreements and genuine trade-offs
3. **Open Decisions** — Questions that need human judgment to resolve
4. **Recommendation** — Your balanced recommendation considering all perspectives

Be specific. Name the tensions, don't smooth them over.

Keep response under 500 words.
""")
```

### 5. WRITE DEBATE FILE

Create `specs/.debate-{name}.md`:

```markdown
# Debate: {Name}

## Context
[~200 word summary from step 1]

## Codebase Context
[~300 word summary from step 2 — what exists, key patterns, limitations]

## Perspectives

### User Advocate
[arguments from agent]

### Tech Skeptic
[arguments from agent]

### Systems Thinker
[arguments from agent]

### LLM Efficiency
[arguments from agent]

## Synthesis

### Consensus
[from synthesizer]

### Tensions
[from synthesizer]

### Open Decisions
[from synthesizer]

### Recommendation
[from synthesizer]
```

### 6. CONFIRM

After writing the file, present a brief summary to the user:

```
✓ Created specs/.debate-{name}.md

Key tensions:
- [tension 1]
- [tension 2]

Open decisions:
- [decision 1]
- [decision 2]

Next: Run /df:spec {name} to formalize into a specification
```

### 7. CAPTURE DECISIONS

Extract up to 4 candidates from consensus/resolved tensions. Ask user via `AskUserQuestion(multiSelect=True)` with options like `{ label: "[APPROACH] {decision}", description: "{rationale}" }`.

For confirmed decisions, append to `.deepflow/decisions.md` (create if absent) using format:
```
### {YYYY-MM-DD} — debate
- [{TAG}] {decision text} — {rationale}
```
Tags: [APPROACH] directional choices · [PROVISIONAL] tentative · [ASSUMPTION] unverified premises. If a new decision contradicts an existing one, note the conflict inline.

---

## Rules

- **All 4 perspective agents MUST be spawned in ONE message** (parallel, non-background)
- **NEVER use `run_in_background`** — causes late notifications that pollute output
- **NEVER use TaskOutput** — returns full transcripts that explode context
- **NEVER use Explore agents** — the orchestrator gathers context directly
- **Codebase context is gathered by the orchestrator** (step 2) and passed to agents via prompt
- Reasoner agents receive context through their prompt, not by reading files themselves
- The debate file goes in `specs/` so `/df:spec` can reference it
- File name MUST be `.debate-{name}.md` (dot prefix = auxiliary file)
- Keep each perspective under 400 words, synthesis under 500 words

## Example

```
USER: /df:debate auth

CLAUDE: Let me summarize what we've discussed and understand the current
codebase before getting multiple perspectives on the authentication design.

[Summarizes: ~200 words about auth requirements from conversation]

[Globs/Greps/Reads relevant auth files — middleware, routes, config]

[Produces ~300 word codebase summary of what exists]

[Spawns 4 reasoner agents in parallel — each receives both summaries]

[All 4 return their arguments]

[Spawns synthesizer agent with all 4 perspectives]

[Synthesizer returns consensus, tensions, open decisions, recommendation]

[Writes specs/.debate-auth.md]

✓ Created specs/.debate-auth.md

Key tensions:
- OAuth complexity vs simpler API key approach
- User convenience (social login) vs privacy concerns
- Centralized auth service vs per-route middleware

Open decisions:
- Session storage strategy (JWT vs server-side)
- Token expiration policy

Next: Run /df:spec auth to formalize into a specification
```
