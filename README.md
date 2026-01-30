```
     _                      __ _
  __| | ___  ___ _ __      / _| | _____      __
 / _` |/ _ \/ _ \ '_ \    | |_| |/ _ \ \ /\ / /
| (_| |  __/  __/ |_) |   |  _| | (_) \ V  V /
 \__,_|\___|\___| .__/    |_| |_|\___/ \_/\_/
               |_|
```

<p align="center">
  <strong>Stay in flow state — spec-driven task orchestration for Claude Code</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#the-flow">The Flow</a> •
  <a href="#commands">Commands</a> •
  <a href="docs/getting-started.md">Docs</a>
</p>

---

## Philosophy

- **Stay in flow** — Minimize context switches, maximize deep work
- **Conversational ideation** with proactive gap discovery
- **Specs define intent**, tasks close reality gaps
- **Parallel execution** with dependency awareness
- **Atomic commits** for clean rollback
- **Minimal ceremony** — 4 commands, not 27

## Quick Start

```bash
# Install
npx deepflow

# In your project
claude

# 1. Discuss what you want to build (conversation)
# 2. Generate spec when ready
/df:spec image-upload

# 3. Compare specs to code, generate tasks
/df:plan

# 4. Execute tasks with parallel agents
/df:execute

# 5. Verify specs are satisfied
/df:verify
```

## The Flow

```
CONVERSATION
    │ Describe what you want
    │ LLM asks gap questions (scope, edge cases, constraints)
    ▼
/df:spec <name>
    │ Generates specs/{name}.md
    ▼
/df:plan
    │ Compares specs to codebase
    │ Finds TODOs, stubs, missing implementations
    │ Outputs PLAN.md with prioritized tasks
    ▼
/df:execute
    │ Runs tasks respecting dependencies
    │ Parallel for independent tasks
    │ Atomic commit per task
    ▼
/df:verify
    │ Checks spec requirements met
    │ Updates PLAN.md status
```

## File Structure

After running deepflow, your project will have:

```
your-project/
├── specs/
│   ├── feature-a.md
│   └── feature-b.md
├── PLAN.md          # Task checklist
└── STATE.md         # Decisions & learnings
```

## Commands

| Command | Purpose |
|---------|---------|
| `/df:spec <name>` | Generate spec from conversation |
| `/df:plan` | Compare specs to code, create tasks |
| `/df:execute` | Run tasks with parallel agents |
| `/df:verify` | Check specs satisfied |

## Configuration

Create `.deepflow/config.yaml` in your project:

```yaml
project:
  source_dir: src/
  specs_dir: specs/

planning:
  search_patterns:
    - "TODO"
    - "FIXME"
    - "stub"
    - "placeholder"

parallelism:
  max_search_agents: 50
  max_write_agents: 5

models:
  search: sonnet
  implement: sonnet
  reason: opus
```

## Principles

1. **Stay in flow** — Uninterrupted deep work
2. **Confirm before assume** — Search code before creating "missing" tasks
3. **Complete implementations** — No stubs, no placeholders
4. **Atomic commits** — One task = one commit
5. **Single writer per file** — Avoid race conditions

## License

MIT
