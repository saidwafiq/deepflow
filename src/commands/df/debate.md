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

Summarize conversation context in ~200 words: core problem, key requirements, constraints, user priorities. Passed to each perspective agent.

### 2. GATHER CODEBASE CONTEXT

Ground the debate in what actually exists. Glob/Grep/Read relevant files (up to 5-6, focus on core logic).

Produce a ~300 word codebase summary: what exists, key interfaces/contracts, current limitations, dependencies. Passed to every perspective agent so they argue from facts, not assumptions.

### 3. SPAWN PERSPECTIVES

**Spawn ALL 4 perspective agents in ONE message (non-background, parallel):**

Each agent receives the same preamble + codebase context but a different role lens.

**Shared preamble for all perspectives:**
```
## Context
{summary}

## Current Codebase
{codebase_summary}

Provide:
1. Your key arguments (3-5 points)
2. Risks your perspective surfaces
3. Concrete alternatives if you disagree with the current direction

Keep response under 400 words.
```

**Perspective-specific role lenses (append to preamble):**

```python
# All 4 in a single message — parallel, non-background:

Task(subagent_type="reasoner", model="opus", prompt="""
{shared_preamble}

## Your Role: USER ADVOCATE
Argue from the perspective of the end user. Focus on:
- Simplicity and ease of use
- Real user needs vs assumed needs
- Friction points and cognitive load
- Whether the solution matches how users actually think
""")

Task(subagent_type="reasoner", model="opus", prompt="""
{shared_preamble}

## Your Role: TECH SKEPTIC
Challenge technical assumptions and surface hidden complexity. Focus on:
- What could go wrong technically
- Hidden dependencies or coupling
- Complexity that seems simple but isn't
- Maintenance burden over time
""")

Task(subagent_type="reasoner", model="opus", prompt="""
{shared_preamble}

## Your Role: SYSTEMS THINKER
Analyze how this fits into the broader system. Focus on:
- Integration with existing components
- Scalability implications
- Second-order effects and unintended consequences
- Long-term evolution and extensibility
""")

Task(subagent_type="reasoner", model="opus", prompt="""
{shared_preamble}

## Your Role: LLM EFFICIENCY
Evaluate from the perspective of LLM consumption and interaction. Focus on:
- Token density: can the output be consumed efficiently by LLMs?
- Minimal scaffolding: avoid ceremony that adds tokens without information
- Navigable structure: can an LLM quickly find what it needs?
- Attention budget: does the design respect limited context windows?
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

Create `specs/.debate-{name}.md` with sections: Context · Codebase Context · Perspectives (User Advocate / Tech Skeptic / Systems Thinker / LLM Efficiency) · Synthesis (Consensus / Tensions / Open Decisions / Recommendation).

### 6. CONFIRM

Present key tensions and open decisions, then: `Next: Run /df:spec {name} to formalize into a specification`

### 7. CAPTURE DECISIONS

Follow the **default** variant from `templates/decision-capture.md`. Command name: `debate`.

---

## Rules

- **All 4 perspective agents MUST be spawned in ONE message** (parallel, non-background)
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
