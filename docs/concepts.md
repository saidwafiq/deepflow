# Concepts

## Philosophy

deepflow is built on these principles:

### 1. Specs Define Intent, Code Is Reality

- **Specs** describe what you want to build
- **Code** is what actually exists
- **Plan** bridges the gap

The LLM compares specs to code and generates tasks to close gaps.

### 2. Conversation Over Automation

Instead of automated research agents, deepflow uses:
- Natural conversation to understand requirements
- Proactive gap questions to ensure completeness
- Human judgment for ambiguous decisions

### 3. Minimal Ceremony

- 4 commands, not 27
- 2 levels (Specs → Tasks), not 5
- Markdown files, not complex schemas

### 4. Complete Implementations

- No stubs
- No placeholders
- No `// TODO` comments

If it's not ready to implement, don't create the task.

### 5. Atomic Commits

Every task produces one commit:
- Easy to review
- Easy to revert
- Clean git history

## The Flow

```
Conversation → Spec → Plan → Execute → Verify
     ↑                          |
     └──────────────────────────┘
              (iterate)
```

### Conversation

You describe what you want. The LLM asks clarifying questions:

| Category | Purpose |
|----------|---------|
| Scope | What's in/out? |
| Edge cases | What if X happens? |
| Constraints | Limits, requirements? |
| Success criteria | How do we know it works? |

### Spec

A structured document capturing:
- Objective (one sentence)
- Requirements (testable)
- Constraints (limits)
- Out of scope (explicit exclusions)
- Acceptance criteria (verification)

### Plan

Comparison of specs against codebase:
- What exists? (mark done)
- What's partial? (task to complete)
- What's missing? (task to create)

Tasks are ordered by dependencies and priority.

### Execute

Parallel implementation with rules:
- Independent tasks run in parallel
- Dependent tasks wait
- One writer per file (no conflicts)
- Atomic commit per task

### Verify

Check that specs are satisfied:
- All requirements implemented
- Acceptance criteria met
- No incomplete work (stubs, TODOs)

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
                      │
Unblocked:       [T3, T4]         (were waiting on T1)
                      │
                   ┌──┴──┐
                   ▼     ▼
                Agent  Agent       (parallel)
```

## Agent Spawning

Dynamic based on scope:

| Files in Project | Search Agents |
|------------------|---------------|
| <20 | 3-5 |
| 20-100 | 10-15 |
| 100-500 | 25-40 |
| 500+ | 50-100 |

Rules:
- Read/search: High parallelism (no side effects)
- Write: Limited (avoid conflicts)
- Test: Sequential (always)

## State Continuity

`STATE.md` provides context across sessions:
- Current progress
- Decisions made (and why)
- Learnings discovered
- Blockers (and workarounds)

This helps the LLM understand where you left off.
