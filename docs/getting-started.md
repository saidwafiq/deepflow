# Getting Started

## Installation

```bash
npx deepflow
```

The installer prompts you to choose:
- **Global** (`~/.claude/`) — available across all projects
- **Project** (`./.claude/`) — project-specific

To update, run the same command again. To uninstall:

```bash
npx deepflow --uninstall
```

## Your First Spec

### 1. Start a conversation

```bash
cd your-project
claude
```

Describe what you want to build:

```
I want to add user authentication to my app. Users should be able
to sign up with email/password, log in, and reset their password.
```

### 2. Discover the problem

```
/df:discover auth
```

This is where deepflow diverges from other tools. Instead of jumping into planning, the LLM asks structured questions to understand what you actually need:

```
Before we go further, let me understand the problem:

Motivation: Why authentication? What happens today without it?
Context: Do you have an existing user model? Session management?
Scope: Email/password only, or also OAuth? Password reset via email?
Constraints: Any compliance requirements? Rate limiting?
Success: How will you know this works? What does "done" look like?
Anti-goals: What should this explicitly NOT do?
```

No code is read, no agents are spawned. Purely conversational. You answer, the LLM asks follow-ups until the problem space is clear. This conversation becomes the raw material for the spec.

### 3. Debate tradeoffs (optional)

```
/df:debate auth-strategy
```

Four AI perspectives argue about your approach before you commit to a spec:

- **User Advocate** — "Password reset flow needs to be frictionless, not just functional"
- **Tech Skeptic** — "Rolling your own auth is a liability. Have you considered an auth provider?"
- **Systems Thinker** — "Session tokens need to scale with your infrastructure"
- **LLM Efficiency** — "This spec can be split into two smaller specs for better execution"

A fifth agent synthesizes consensus, tensions, and open decisions. Output saved to `specs/.debate-auth-strategy.md`. You read it, adjust your thinking, and move on.

### 4. Generate the spec

```
/df:spec auth
```

Now — after discovering and debating — the conversation context is rich enough to produce a solid spec. Creates `specs/auth.md` with structured requirements (REQ-N format), acceptance criteria, constraints, and out-of-scope items. Validated before writing.

### 5. Generate the plan

```
/df:plan
```

Compares specs against your codebase:
- Finds what's already implemented
- Checks past experiments (won't repeat failed approaches)
- If risky work exists, generates a spike task first
- Creates prioritized task list in `PLAN.md`
- Renames: `auth.md` → `doing-auth.md`

### 6. Execute

```
/df:execute
```

Creates an isolated git worktree and runs tasks:
- Independent tasks run in parallel
- Dependent tasks wait for blockers
- Each task = one atomic commit
- Health checks (build/tests/typecheck/lint) after each commit

### 7. Verify

```
/df:verify
```

Checks that specs are satisfied:
- L0: Build passes
- L1: All planned files in diff
- L2: Coverage didn't drop
- L4: Tests pass

On success: merges worktree to main, extracts architectural decisions to `.deepflow/decisions.md`.

## Project Structure

After running deepflow:

```
your-project/
├── specs/
│   └── doing-auth.md    # Active spec
├── PLAN.md              # Task checklist
└── .deepflow/
    ├── config.yaml      # Optional configuration
    ├── decisions.md     # Extracted decisions
    └── experiments/     # Spike results (pass/fail)
```

## Next Steps

- Read [Concepts](./concepts.md) to understand the philosophy
- See [Configuration](./configuration.md) for customization
