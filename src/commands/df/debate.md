---
name: df:debate
description: Generate multi-perspective analysis of a problem before formalizing into a spec
allowed-tools: [Agent, AskUserQuestion]
---

# /df:debate — Multi-Perspective Analysis

## Orchestrator Role

Coordinate reasoner agents to debate a problem from multiple perspectives, then synthesize into a structured document.

**NEVER:** use TaskOutput, `run_in_background`, Explore agents, EnterPlanMode, ExitPlanMode

**ONLY:** Spawn context-fork agent for codebase gathering, spawn reasoner agents (non-background), write debate file, respond conversationally

## Agents

| Agent | subagent_type | model | Focus |
|-------|---------------|-------|-------|
| Summarizer | `reasoner` | `opus` | Compress raw conversation into neutral problem statement |
| User Advocate | `reasoner` | `opus` | UX, simplicity, real user needs |
| Tech Skeptic | `reasoner` | `opus` | Technical risks, hidden complexity, feasibility |
| Systems Thinker | `reasoner` | `opus` | Integration, scalability, long-term effects |
| LLM Efficiency | `reasoner` | `opus` | Token density, minimal scaffolding, navigable structure |
| Synthesizer | `reasoner` | `opus` | Merge perspectives into consensus + tensions |

## Behavior

### 1. SUMMARIZE (delegated — orchestrator MUST NOT write the summary)

Spawn a summarizer reasoner (`subagent_type="reasoner"`, `model="opus"`) with prompt:

```
## Task: Neutral Problem Statement

Produce a ~200 word summary covering: core problem, requirements, constraints, user priorities.
Factual compression only. No recommendations, no framing, no editorial phrasing.

## Raw Conversation Context
{verbatim conversation context — orchestrator pastes transcript, does not paraphrase}

Return ONLY the summary text. No preamble.
```

Store response verbatim as `{summary}`. The orchestrator never composes its own summary and never edits the returned text before passing it to downstream agents.

### 2. GATHER CODEBASE CONTEXT
Spawn a context-fork agent (subagent_type="general-purpose", model="sonnet") with the following prompt:

```
## Task: Codebase Context Gathering

Problem being analyzed: {summary}

Instructions:
- Use LSP documentSymbol to understand file structure where available
- Use Read with offset/limit on relevant ranges only (never read full files)
- Use Glob/Grep to locate relevant files (up to 5-6, focus on core logic)
- Produce a ~300 word summary covering: what exists, key interfaces, current limitations, dependencies

Return ONLY the codebase summary text (~300 words). No preamble, no explanation.
```

Store the agent's response as {codebase_summary}. Passed to every perspective agent.

### 3. SPAWN PERSPECTIVES

**Spawn ALL 4 perspective agents in ONE message (parallel, non-background).** Each receives the shared preamble + a role-specific lens.

**Shared preamble (included in every agent prompt):**
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

**Role lenses (append one per agent):**

| Role | Focus areas |
|------|------------|
| USER ADVOCATE | Simplicity, real vs assumed needs, friction, cognitive load, user mental model |
| TECH SKEPTIC | What could go wrong, hidden dependencies/coupling, deceptive simplicity, maintenance burden |
| SYSTEMS THINKER | Integration with existing components, scalability, second-order effects, extensibility |
| LLM EFFICIENCY | Token density, minimal ceremony, navigable structure, attention budget |

### 4. SYNTHESIZE

After all 4 return, spawn 1 synthesizer agent. Pass context summary + all 4 responses. Synthesizer produces (under 500 words):
1. **Consensus** — Points where perspectives agree
2. **Tensions** — Unresolved disagreements and genuine trade-offs
3. **Open Decisions** — Questions needing human judgment
4. **Recommendation** — Balanced recommendation considering all perspectives

Instruction: "Be specific. Name the tensions, don't smooth them over."

### 5. WRITE DEBATE FILE

Create `specs/.debate-{name}.md` with sections: Context, Codebase Context, Perspectives (User Advocate / Tech Skeptic / Systems Thinker / LLM Efficiency), Synthesis (Consensus / Tensions / Open Decisions / Recommendation).

### 6. CONFIRM

Present key tensions and open decisions, then: `Next: Run /df:spec {name} to formalize into a specification`

## Rules

- ALL 4 perspective agents MUST be spawned in ONE message (parallel, non-background)
- Orchestrator delegates codebase gathering (step 2) to a context-fork agent — orchestrator never reads files directly
- Orchestrator delegates summarization (step 1) to a summarizer reasoner — orchestrator never writes or edits the summary
- Orchestrator is a router: collect agent outputs verbatim, pass to the next phase, write the final file. No interpretation, no paraphrasing, no compression.
- File name MUST be `.debate-{name}.md` (dot prefix = auxiliary file, lives in `specs/`)
- Word limits: each perspective <400 words, synthesis <500 words
