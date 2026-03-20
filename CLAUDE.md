# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is deepflow

A spec-driven iterative development framework for Claude Code (v0.1.88). It treats development as discovery — specs are living hypotheses evolved through two loops:

- **Human loop** (interactive): `/df:discover` → `/df:debate` → `/df:spec` → `specs/*.md`
- **AI loop** (autonomous): `/df:plan` → `/df:execute` → `/df:verify` → merged code

Core principle: **metrics decide, not opinions** — no LLM judges another LLM. Only objective health checks (build/test/typecheck/lint) determine success.

## Installation & Development

```bash
npx deepflow              # Install commands/skills/agents/hooks
npx deepflow --uninstall  # Remove installed files
```

The installer (`bin/install.js`) copies markdown files to `~/.claude/` (global) or `.claude/` (project-local):
- Commands: `src/commands/df/*.md` → `commands/df/`
- Skills: `src/skills/*/SKILL.md` → `skills/`
- Agents: `src/agents/*.md` → `agents/`
- Hooks: `hooks/*.js` → `hooks/` (global only)
- Templates: `templates/*.md|yaml` → `templates/`

The installer also enables LSP tools via `ENABLE_LSP_TOOL=1` in settings JSON and grants granular permissions for read, write, git, and health-check execution.

There is no build step, no compiled output, no test suite. The framework is markdown documents + JS hooks consumed by Claude Code's skill system. Single runtime dependency: Playwright (for browser automation skills).

## Repository Structure

```
bin/
  install.js                    Entry point (npm bin). Copies files to ~/.claude/ or .claude/
  archived/deepflow-auto.sh     Deprecated shell orchestrator (replaced by /df:auto)

src/
  commands/df/                  13 user-facing slash commands (YAML frontmatter)
    discover.md                 Explore problem space (Socratic questioning)
    debate.md                   Multi-perspective analysis (4 reasoner agents + synthesizer)
    spec.md                     Transform conversation into structured spec
    plan.md                     Generate prioritized tasks from specs (LSP-first analysis)
    execute.md                  Execute tasks with agent spawning and worktree isolation
    verify.md                   Machine-verifiable checks (L0–L5)
    auto.md                     Launch fully autonomous execution loop
    auto-cycle.md               Single autonomous cycle (called by /loop)
    resume.md                   Session continuity briefing
    note.md                     Capture ad-hoc decisions
    consolidate.md              Clean up decisions.md
    report.md                   Generate session cost report
    update.md                   Update or uninstall deepflow

  skills/                       5 reusable capabilities
    atomic-commits/SKILL.md     One logical change per commit, clean messages
    browse-fetch/SKILL.md       Headless browser content retrieval (fork context)
    browse-verify/SKILL.md      Playwright a11y tree assertions, L5 verification (fork context)
    code-completeness/SKILL.md  Find TODOs, stubs, incomplete code
    gap-discovery/SKILL.md      Proactive requirement gap identification

  agents/
    reasoner.md                 Opus-based complex reasoning agent (used by debate, plan, execute)

hooks/                          8 event-driven hooks (JS, global install only)
  df-spec-lint.js               Validate specs against hard/advisory invariants, compute layer
  df-invariant-check.js         Check implementation diffs against spec invariants
  df-statusline.js              Claude Code statusline (model, project, context usage)
  df-consolidation-check.js     Auto-consolidate decisions.md
  df-check-update.js            Prompt for deepflow updates
  df-quota-logger.js            Log API quota/usage (macOS Keychain)
  df-tool-usage.js              Log tool usage to .deepflow/tool-usage.jsonl
  df-tool-usage-spike.js        Capture raw PostToolUse payloads for analysis

templates/                      6 scaffolds
  spec-template.md              Spec scaffold (onion-layer model)
  plan-template.md              PLAN.md scaffold with task format
  state-template.md             STATE.md scaffold (optional project context)
  experiment-template.md        Spike experiment scaffold
  config-template.yaml          Full configuration reference with defaults
  explore-agent.md              Explore agent protocol documentation

docs/                           Reference documentation
  getting-started.md            Quick start (7-step workflow)
  concepts.md                   Philosophy and design rationale
  configuration.md              Full config reference

examples/mood-board/            Sample project (specs, plan, state)
```

## Key Design Patterns

- **Ratchet pattern**: Pre-existing tests are snapshotted before execution. Agents can't game metrics by writing trivial tests — only pre-existing tests count for the health gate.
- **Shell injection**: Commands load state via `` !`cat file 2>/dev/null || echo 'NOT_FOUND'` `` instead of tool calls, reducing context usage.
- **Attention U-curve**: Prompts place critical info (task, failure history, ACs) at START and END zones; less critical info (deps, impact) in the MIDDLE.
- **Context-fork skills**: High input:output ratio skills (`browse-fetch`, `browse-verify`) run in forked context to prevent context rot.
- **LSP-first impact analysis**: `/df:plan` uses `findReferences`/`incomingCalls` over grep for precise caller detection.
- **Spike-first planning**: Risky work gets small proof-of-concept tasks before full implementation.
- **Onion-layer specs**: Specs have a computed layer (L0–L3) based on which sections exist. L0 specs (just an objective) immediately generate spikes. Spikes discover constraints, deepening the spec to L2+ which unlocks implementation tasks.

## Persistent State (.deepflow/)

Generated at runtime (gitignored), not committed to the repo:
- `config.yaml` — Project configuration (from `templates/config-template.yaml`)
- `decisions.md` — Extracted architectural decisions (tags: `[APPROACH]`, `[PROVISIONAL]`, `[FUTURE]`, `[UPDATE]`)
- `auto-memory.yaml` — Cross-cycle state for autonomous mode
- `auto-snapshot.txt` — Pre-existing test file baseline (ratchet pattern)
- `experiments/` — Spike results (`{topic}--{hypothesis}--{status}.md`)
- `results/` — Task result archives
- `worktrees/` — Isolated execution branches
- `tool-usage.jsonl` — Tool usage logs
- `report.json` / `report.md` — Session cost reports
- `checkpoint.json` — Execution checkpoint (for `/df:resume`)

The repo ships with 7 active experiments in `.deepflow/experiments/` covering agent teams, autonomous mode, browse-fetch, browse-verify, and invariant checking.

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

Skills may declare `context: fork` to run in isolated context (prevents high I/O from polluting the main conversation).

**Commit format** (via `atomic-commits` skill): `{type}({scope}): {description}` where type ∈ {feat, fix, refactor, test, docs}

**Task blocking** in PLAN.md uses `Blocked by: T{n}` — blocked tasks cannot start until dependencies complete.

## Verification Levels (df:verify)

- **L0**: Build passes
- **L1**: Files in diff match spec scope
- **L2**: Coverage didn't drop
- **L4**: Tests pass
- **L5**: Browser verification via Playwright a11y tree assertions (optional, deterministic)

## Autonomous Mode

- `/df:auto` starts a loop via `/loop 1m /df:auto-cycle` (fresh context each cycle)
- Cross-cycle state persisted in `.deepflow/auto-memory.yaml`
- Circuit breaker after N consecutive reverts per task (`max_consecutive_reverts` in config)
- Advisory hook warnings escalate to hard failures in auto mode
- On task completion: `/df:verify`, merge to main, extract decisions

## Configuration

Project config lives in `.deepflow/config.yaml` (scaffolded from `templates/config-template.yaml`). Key settings:
- `build_command`, `test_command`, `dev_command`, `dev_port`
- `max_consecutive_reverts` — circuit breaker for autonomous mode
- Parallelism limits, quality gates, worktree isolation settings
- Model overrides, gitignore entries, commit conventions

## Important Notes for AI Assistants

- This is a **markdown-first framework** — all commands, skills, and agents are `.md` files with YAML frontmatter. There is no TypeScript/JavaScript compilation step.
- The only JS files are hooks (`hooks/*.js`) and the installer (`bin/install.js`).
- `.claude/` is gitignored — installed commands are per-installation, not committed.
- `specs/`, `PLAN.md`, `STATE.md`, and `.deepflow/` are gitignored in user projects (they are runtime artifacts).
- The `examples/` directory is NOT gitignored so sample projects ship with the package.
- Published to npm as `deepflow` — the `files` field includes `bin/`, `src/`, `hooks/`, `templates/`.
- Node.js >= 16.0.0 required. Single dependency: `playwright` (^1.58.2).
