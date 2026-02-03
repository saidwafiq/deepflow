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
  <a href="#commands">Commands</a>
</p>

---

## Philosophy

- **Stay in flow** — Minimize context switches, maximize deep work
- **Conversational ideation** with proactive gap discovery
- **Specs define intent**, tasks close reality gaps
- **Spike-first planning** — Validate risky hypotheses before full implementation
- **Worktree isolation** — Main branch stays clean during execution
- **Parallel execution** with context-aware checkpointing
- **Atomic commits** for clean rollback

## Quick Start

```bash
# Install (or update)
npx deepflow

# Uninstall
npx deepflow --uninstall

# In your project
claude

# 1. Discuss what you want to build
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
    │ LLM asks gap questions
    ▼
/df:spec <name>
    │ Creates specs/{name}.md
    ▼
/df:plan
    │ Checks past experiments (learn from failures)
    │ Risky work? → generates spike task first
    │ Creates PLAN.md with prioritized tasks
    │ Renames: feature.md → doing-feature.md
    ▼
/df:execute
    │ Creates isolated worktree (main stays clean)
    │ Spike tasks run first, verified before continuing
    │ Parallel agents, file conflicts serialize
    │ Context-aware (≥50% → checkpoint)
    ▼
/df:verify
    │ Checks requirements met
    │ Merges worktree to main, cleans up
    │ Renames: doing-feature.md → done-feature.md
```

## Spec Lifecycle

```
specs/
  feature.md        → new, needs /df:plan
  doing-feature.md  → in progress, has tasks in PLAN.md
  done-feature.md   → completed, history embedded
```

## Works With Any Project

**Greenfield:** Everything is new, agents create from scratch.

**Ongoing:** Detects existing patterns, follows conventions, integrates with current code.

## Spike-First Planning

For risky or uncertain work, `/df:plan` generates a **spike task** first:

```
Spike: Validate streaming upload handles 10MB+ files
  │ Run minimal experiment
  │ Pass? → Unblock implementation tasks
  │ Fail? → Record learning, generate new hypothesis
```

Experiments are tracked in `.deepflow/experiments/`. Failed approaches won't be repeated.

## Worktree Isolation

Execution happens in an isolated git worktree:
- Main branch stays clean during execution
- On failure, worktree preserved for debugging
- Resume with `/df:execute --continue`
- On success, `/df:verify` merges to main and cleans up

## Context-Aware Execution

Statusline shows context usage. At ≥50%:
- Waits for running agents
- Checkpoints state
- Resume with `/df:execute --continue`

## Commands

| Command | Purpose |
|---------|---------|
| `/df:spec <name>` | Generate spec from conversation |
| `/df:plan` | Compare specs to code, create tasks |
| `/df:execute` | Run tasks with parallel agents |
| `/df:verify` | Check specs satisfied |
| `/df:update` | Update deepflow to latest |

## File Structure

```
your-project/
├── specs/
│   ├── auth.md           # new spec
│   ├── doing-upload.md   # in progress
│   └── done-payments.md  # completed
├── PLAN.md               # active tasks
└── .deepflow/
    ├── config.yaml       # project settings
    ├── context.json      # context % tracking
    ├── experiments/      # spike results (pass/fail)
    └── worktrees/        # isolated execution
        └── upload/       # one worktree per spec
```

## Configuration

Create `.deepflow/config.yaml`:

```yaml
project:
  source_dir: src/
  specs_dir: specs/

parallelism:
  execute:
    max: 5              # max parallel agents

worktree:
  cleanup_on_success: true
  cleanup_on_fail: false  # preserve for debugging
```

## Principles

1. **Stay in flow** — Uninterrupted deep work
2. **Confirm before assume** — Search code before marking "missing"
3. **Complete implementations** — No stubs, no placeholders
4. **Atomic commits** — One task = one commit
5. **Context-aware** — Checkpoint before limits

## License

MIT
