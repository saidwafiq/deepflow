# Getting Started

## Installation

```bash
git clone https://github.com/yourname/deepflow.git
cd deepflow
./install.sh
```

This copies the commands to `~/.claude/commands/sf/`.

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

### 2. Let the LLM ask questions

deepflow will probe for gaps:

```
Before I create the spec, a few questions:

1. Password requirements? (min length, complexity)
2. Email verification required?
3. Session duration before auto-logout?
4. OAuth providers needed (Google, GitHub)?
```

Answer the questions. The LLM may ask follow-ups until requirements are clear.

### 3. Generate the spec

```
/df:spec auth
```

Creates `specs/auth.md` with structured requirements.

### 4. Generate the plan

```
/df:plan
```

Compares specs against your codebase:
- Finds what's already implemented
- Identifies missing pieces
- Creates prioritized task list in `PLAN.md`

### 5. Execute

```
/df:execute
```

Runs tasks with parallel agents:
- Independent tasks run in parallel
- Dependent tasks wait for blockers
- Each task = one atomic commit

### 6. Verify

```
/df:verify
```

Checks that specs are satisfied:
- Requirements covered
- Acceptance criteria met
- No stubs or TODOs left

## Project Structure

After running deepflow:

```
your-project/
├── specs/
│   └── auth.md           # Your spec
├── PLAN.md               # Task checklist
├── STATE.md              # Context for LLM continuity
└── .deepflow/
    └── config.yaml       # Optional configuration
```

## Next Steps

- Read [Concepts](./concepts.md) to understand the philosophy
- See [Configuration](./configuration.md) for customization
- Check [examples/](../examples/) for complete examples
