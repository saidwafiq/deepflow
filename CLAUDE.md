# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is deepflow

A spec-driven iterative development framework for Claude Code. It treats development as discovery — specs are living hypotheses evolved through two loops:

- **Human loop** (interactive): `/df:discover` → `/df:debate` → `/df:spec` → `specs/*.md`
- **AI loop** (autonomous): `/df:plan` → `/df:execute` → `/df:verify` → merged code

Core principle: **metrics decide, not opinions** — no LLM judges another LLM. Only objective health checks (build/test/typecheck/lint) determine success.

## Installation & Development

```bash
npx deepflow              # Install commands/skills/agents/hooks
npx deepflow --uninstall  # Remove installed files
```

The installer (`bin/install.js`) copies markdown files to `~/.claude/` (global) or `.claude/` (project):
- Commands: `src/commands/df/*.md` → `commands/df/`
- Skills: `src/skills/*/SKILL.md` → `skills/`
- Agents: `src/agents/*.md` → `agents/`
- Hooks: `hooks/*.js` → `hooks/` (global only)

There is no build step, no compiled output, no test suite. The framework is markdown documents consumed by Claude Code's skill system.

## Architecture

```
Commands (src/commands/df/)     User-facing slash commands with YAML frontmatter
Skills (src/skills/)            Reusable capabilities (browse-fetch, browse-verify, atomic-commits, etc.)
Agents (src/agents/)            Specialized agent definitions (reasoner = Opus-based)
Hooks (hooks/)                  Event-driven checks (invariant, spec-lint, worktree-guard, statusline)
Templates (templates/)          Scaffolds for specs, plans, experiments, config
```

**Data flow:** Specs (`specs/*.md`) → PLAN.md (task list) → worktree execution → verification → merge to main

**Persistent state** lives in `.deepflow/`:
- `decisions.md` — extracted architectural decisions
- `auto-memory.yaml` — cross-cycle state for autonomous mode
- `auto-snapshot.txt` — pre-existing test file baseline (ratchet pattern)
- `experiments/` — spike results (`{topic}--{hypothesis}--{status}.md`)
- `results/` — task result archives
- `worktrees/` — isolated execution branches

## Key Design Patterns

- **Ratchet pattern**: Pre-existing tests are snapshotted before execution. Agents can't game metrics by writing trivial tests — only pre-existing tests count for the health gate.
- **Shell injection**: Commands load state via `` !`cat file 2>/dev/null || echo 'NOT_FOUND'` `` instead of tool calls, reducing context usage.
- **Attention U-curve**: Prompts place critical info (task, failure history, ACs) at START and END zones; less critical info (deps, impact) in the MIDDLE.
- **Context-fork skills**: High input:output ratio skills (browse-fetch, browse-verify) run in forked context to prevent rot.
- **LSP-first impact analysis**: `/df:plan` uses `findReferences`/`incomingCalls` over grep for precise caller detection.
- **Spike-first planning**: Risky work gets small proof-of-concept tasks before full implementation.
- **Onion-layer specs**: Specs have a computed layer (L0–L3) based on which sections exist. L0 specs (just an objective) immediately generate spikes. Spikes discover constraints, deepening the spec to L2+ which unlocks implementation tasks. Less upfront guessing, more learning-by-doing.

## Conventions

**Spec file naming:** `{name}.md` (planned) → `doing-{name}.md` (in progress) → `done-{name}.md` (completed)

**Command/skill/agent files** use YAML frontmatter:
```yaml
---
name: df:discover
description: Explore problem space deeply
allowed-tools: [AskUserQuestion, Read]
---
```

**Commit format** (via atomic-commits skill): `{type}({scope}): {description}` where type ∈ {feat, fix, refactor, test, docs}

**Decision tags** in `.deepflow/decisions.md`: `[APPROACH]`, `[PROVISIONAL]`, `[FUTURE]`, `[UPDATE]`

**Task blocking** in PLAN.md uses `Blocked by: T{n}` — blocked tasks cannot start until dependencies complete.

## Verification Levels (df:verify)

- **L0**: Build passes
- **L1**: Files in diff match spec scope
- **L2**: Coverage didn't drop
- **L4**: Tests pass
- **L5**: Browser verification via Playwright a11y tree assertions (optional, deterministic)

## Configuration

Project config lives in `.deepflow/config.yaml` (scaffolded from `templates/config-template.yaml`). Key settings: `build_command`, `test_command`, `dev_command`, `dev_port`, `max_consecutive_reverts`, parallelism limits.
