# Concepts

## Philosophy

### Doing Reveals What Thinking Can't Predict

You can't foresee every edge case in a spec. Execution reveals them. When doing is fast and cheap, it makes more sense to run N approaches in parallel and extract the best one than to try to get it right the first time.

The spec is a hypothesis. Code evolves toward it through iterative cycles.

### Spec as Living Hypothesis

- Core intent stays fixed
- Details refine through implementation
- "The spec becomes bulletproof because you built it, not before"

This creates tension with TDD: TDD assumes you know the correct behavior before coding. Deepflow assumes execution reveals what planning can't anticipate.

### Metrics Decide, Not Opinions

No LLM judges another LLM. Deepflow started with adversarial selection (AI evaluating AI) and discovered gaming: agents that estimated instead of measuring, simulated instead of implementing.

The fix: only objective metrics decide — build, tests, typecheck, lint. Tests created by the agent are excluded from the baseline to prevent self-validation. We call this a **ratchet** — the metric can only improve, never regress.

### Conversation Over Automation

Instead of automated research agents, deepflow uses:
- Natural conversation to understand requirements
- Proactive gap questions to ensure completeness
- Human judgment for ambiguous decisions

AI research comes after you've defined the problem.

### Minimal Ceremony

- 6 commands, one flow
- 2 levels (Specs → Tasks), not 5
- Markdown files, not complex schemas

## The Flow

```
Conversation → Discover → Debate → Spec → Plan → Execute → Verify
                  ↑                                  |
                  └──────────────────────────────────┘
                              (iterate)
```

### Discover

Deep problem exploration through Socratic questioning:

| Phase | Purpose |
|-------|---------|
| Motivation | Why? What problem? Who suffers? |
| Context | What exists? What's been tried? |
| Scope | What's in/out? Minimum viable? |
| Constraints | Technical limits, time, resources? |
| Success | How to verify? Metrics? |
| Anti-Goals | What NOT to do? What to avoid? |

No code is read, no agents are spawned. Purely conversational.

### Debate

Multi-perspective analysis before formalizing. Four reasoner agents argue from different angles:

| Perspective | Focus |
|-------------|-------|
| User Advocate | UX, simplicity, real needs |
| Tech Skeptic | Risks, complexity, feasibility |
| Systems Thinker | Integration, scalability, long-term |
| LLM Efficiency | Token density, structure, attention budget |

A fifth agent synthesizes consensus, tensions, and open decisions. Output saved as `specs/.debate-{name}.md`.

### Spec

A structured document capturing:
- Objective (one sentence)
- Requirements (REQ-N format, testable)
- Constraints (limits)
- Out of scope (explicit exclusions)
- Acceptance criteria (checkbox format)

Validated before writing — hard invariants block, advisory warnings inform.

### Plan

Comparison of specs against codebase:
- What exists? (mark done)
- What's partial? (task to complete)
- What's missing? (task to create)
- What failed before? (check `.deepflow/experiments/`, don't repeat)
- What's risky? (spike task first)

Tasks ordered by dependencies and priority.

### Execute

Implementation with ratchet validation:
- Independent tasks run in parallel in isolated worktrees
- Dependent tasks wait
- One writer per file (no conflicts)
- Atomic commit per task
- Health checks after each commit: build, pre-existing tests, typecheck, lint
- Pass = commit stands. Fail = revert

### Verify

Check that specs are satisfied:
- L0: Build passes
- L1: All planned files in diff
- L2: Coverage didn't drop
- L4: Tests pass

On success: merge worktree to main, extract architectural decisions, clean up.

## Parallelism Model

```
Ready tasks:     [T1, T2, T5]     (no blockers)
                      │
                 ┌────┼────┐
                 ▼    ▼    ▼
              Agent Agent Agent   (parallel)
                 │    │    │
                 ▼    ▼    ▼
             Commit Commit Commit
              │    │    │
           Ratchet Ratchet Ratchet  (health checks)
                      │
Unblocked:       [T3, T4]         (were waiting on T1)
```

## Spike-First Planning

For risky or uncertain work, `/df:plan` generates a spike task first:

```
Spike: Validate streaming upload handles 10MB+ files
  | Run minimal experiment in isolated worktree
  | Pass (ratchet)? -> Unblock implementation tasks
  | Fail? -> Record in .deepflow/experiments/, generate new hypothesis
```

In autonomous mode, multiple spikes for the same problem run as parallel probes. Machine selects the winner: fewer regressions > better coverage > fewer files changed.

## Autonomous Mode

Two loops operate at different timescales:

**Human loop (upstream):** `/df:discover` → `/df:debate` → `/df:spec` — you define the problem, at your pace.

**AI loop (downstream):** `/df:auto` → repeated `/df:auto-cycle` — the system plans, executes, validates, and merges autonomously.

Each cycle gets fresh context (no accumulated rot). Cross-cycle state persists in `.deepflow/auto-memory.yaml` — task outcomes, revert counts, probe insights.

Circuit breaker halts after N consecutive reverts on the same task.

## Decision Capture

Architectural decisions are captured in two ways:
- **Automatically** by `/df:verify` — extracted from completed specs
- **Manually** via `/df:note` — ad-hoc decisions from conversation

All decisions go to `.deepflow/decisions.md`. Contradictions appended, never overwritten.

## Context Management

Each command runs in its own session — cache-optimal via prefix matching. Artifacts serve as handoff between sessions.

During execution, context usage is monitored. At ≥50%:
- Waits for running agents
- Checkpoints state to `.deepflow/checkpoint.json`
- Resume with `/df:execute --continue`
