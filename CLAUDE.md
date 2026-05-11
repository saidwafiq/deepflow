# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** This branch (`v2-rewrite`) is the in-progress v2 minimalist rewrite. See `PLAN-V2.md` for the full plan. The v1 architecture (curator orchestrator, sub-agents, shared worktree) is gone — current state is documented below.

## What is deepflow

A spec-driven iterative development framework for Claude Code. It treats development as discovery — specs are living hypotheses evolved through two phases:

- **Human phase** (interactive): `/df:discover` → `/df:spec` → `specs/*.md` (curated tasks live in the spec)
- **AI phase**: `/df:execute` → `/df:verify` → merged code

Core principle: **metrics decide, not opinions** — no LLM judges another LLM. Only objective health checks (build/test/typecheck/lint) determine success.

In v2, the AI phase runs **serially in the main Claude conversation** — no sub-agent fan-out, no shared worktree, no orchestrator role. The implementer is the same Claude that read the spec.

## Installation & Development

```bash
npx deepflow              # Install commands/skills/hooks
npx deepflow --uninstall  # Remove installed files
```

The installer (`bin/install.js`) copies markdown files to `~/.claude/` (global) or `.claude/` (project):
- Commands: `src/commands/df/*.md` → `commands/df/`
- Skills: `src/skills/*/SKILL.md` → `skills/`
- Hooks: `hooks/*.js` → `hooks/` (global only)

The framework is markdown documents consumed by Claude Code's skill system, plus a small set of Node hooks for observability and gating.

## Architecture (v2)

```
Commands (src/commands/df/)   6 user-facing slash commands (discover, spec, execute, verify, map, eval)
Skills (src/skills/)          7 reusable capabilities (atomic-commits, df-decisions, df-ac-coverage,
                              browse-fetch, browse-verify, gap-discovery, repo-inspect)
Hooks (hooks/)                8 lifecycle hooks (~2.4k LOC). No sub-agents, no policing.
Templates (templates/)        Scaffolds for specs, sketch/impact/findings artifacts, experiment template
```

**Data flow:** Specs (`specs/*.md` with `## Tasks (curated)`) → `/df:execute` runs tasks serially in-place on the current branch → `/df:verify` runs L0–L4 gates → merge.

**Persistent state** lives in `.deepflow/`:
- `decisions.md` — extracted architectural decisions
- `auto-snapshot.txt` — pre-existing test file baseline (ratchet pattern, refreshed per task)
- `experiments/` — spike results (`{topic}--{hypothesis}--{status}.md`)
- `spec-outcomes/{YYYY-MM-DD}-{spec}/outcome.json` — per-spec completion metadata (feeds future Meta-Harness feedback loop)
- `codebase/` — pre-computed STACK/ARCHITECTURE/CONVENTIONS docs via `/df:map`
- `bash-telemetry.jsonl`, `events.jsonl`, `token-history.jsonl` — observability traces

## Surviving hooks (v2)

| Hook | Event | Purpose |
|---|---|---|
| `df-codebase-inject.js` | PreToolUse | Inject `.deepflow/codebase/*.md` into prompt |
| `df-bash-telemetry.js` | PostToolUse | Log every bash command pattern to `bash-telemetry.jsonl` |
| `df-codebase-staleness.js` | PostToolUse | Invalidate codebase cache when source changes |
| `spec-transition.js` | PostToolUse | Rename `doing-{spec}.md` → `done-{spec}.md` on completion |
| `ac-coverage.js` | PostToolUse | Tag tests with AC refs for `/df:verify` L3 |
| `df-spec-lint.js` | PostToolUse | Validate `## Tasks (curated)` structure |
| `df-check-update.js` | SessionStart | Notify when new deepflow version is available |
| `df-statusline.js` | statusLine | UX + writes to `token-history.jsonl` + `events.jsonl` |

## Key Design Patterns

- **Ratchet pattern**: Pre-existing tests are snapshotted before each task. Only pre-existing tests count for the health gate — implementers can't game metrics by writing trivial new tests.
- **Filesystem-first**: Implementer reads files directly via Read/Bash. No context inlining, no compressed bundles passed between agents.
- **Shell injection**: Commands load state via `` !`cat file 2>/dev/null || echo 'NOT_FOUND'` `` instead of tool calls, reducing context usage.
- **Attention U-curve**: Prompts place critical info (task, failure history, ACs) at START and END zones; less critical info (deps, impact) in the MIDDLE.
- **Context-fork skills**: High input:output ratio skills (browse-fetch, browse-verify) run in forked context to prevent rot.
- **LSP-first impact analysis**: `/df:spec`'s blast-radius pass uses `findReferences`/`incomingCalls` (via `bin/lsp-query.js`) over grep for precise caller detection.
- **Spike-first planning**: Risky work gets small proof-of-concept tasks before full implementation.
- **Outcome logging**: Every `/df:execute` run writes `.deepflow/spec-outcomes/`, providing the data substrate for future Meta-Harness (Mode B) corpus growth.

## Conventions

**Spec file naming:** `{name}.md` (planned) → `doing-{name}.md` (in progress) → `done-{name}.md` (completed)

**Command/skill files** use YAML frontmatter:
```yaml
---
name: df:discover
description: Explore problem space deeply
allowed-tools: [AskUserQuestion, Read]
---
```

**Commit format** (via atomic-commits skill): `{type}({scope}): {description}` where type ∈ {feat, fix, refactor, test, docs}

**Decision tags** in `.deepflow/decisions.md`: `[APPROACH]`, `[PROVISIONAL]`, `[FUTURE]`, `[UPDATE]`

**Task ordering** in `## Tasks (curated)`: `Blocked by: T{n}` declares dependencies. `[P]` markers are advisory (v2 runs serial regardless).

## Verification Levels (df:verify)

- **L0**: Build passes
- **L1**: Files in diff match spec scope
- **L2**: Coverage didn't drop
- **L4**: Tests pass
- **L5**: Browser verification via Playwright a11y tree assertions (optional, deterministic)

## Configuration

Project config lives in `.deepflow/config.yaml` (scaffolded from `templates/config-template.yaml`). Key settings: `build_command`, `test_command`, `dev_command`, `dev_port`, `max_consecutive_reverts`.

## What was removed in v2 (v1 → v2)

- All 9 sub-agents (`df-implement`, `df-integration`, `df-spike`, etc.) and `DELEGATION.md`
- 20 hooks (~20k LOC): bash-rewrite, bash-scope, *-protocol, delegation-contract, snapshot-guard, worktree-guard, artifact-validate, invariant-check, etc.
- Shared worktree (`.deepflow/worktrees/curator-active/`)
- Wave parallelism, probe diversity, optimize cycle, haiku git-ops
- `/df:debate`, `/df:fix`, `/df:dashboard`, `/df:update` commands
- `prompt-compose.js`, `worktree-deps.js`, `df-filter-suggest.js`, `lineage-ingest.js`

Rollback: `git checkout v0.1.140-pre-v2`.
