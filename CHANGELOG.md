## v0.1.133 — 2026-05-01

The curator-pattern pivot lands. `/df:execute` no longer fans out per-spec PLAN.md sub-orchestrators — the orchestrator session itself acts as the curator, force-feeding inline context bundles to subagents that no longer have `Read`. Bench (`.deepflow/experiments/orchestration-vs-solo`) showed the previous fan-out was 4–5× more expensive and 3–4× slower than solo Opus with worse quality; the curator simulation matched solo cost while preserving the audit trail. Three commands are removed and `bin/migrate-legacy-plan.js` lands to convert old PLAN.md mini-plans into the new format.

### What's new

- **`/df:spec` curates tasks inline.** New `## Tasks (curated)` section in the spec carries `[P]` (parallel) markers, `Blocked by:` edges, and an `## Execution graph` for wave grouping — produced from file-ownership analysis at spec time. PLAN.md is gone; the spec is now the single source of truth from human handoff through merge.
- **`/df:execute` is a curator orchestrator.** Single shared worktree at `.deepflow/worktrees/curator-active/` (no more per-spec branches). The orchestrator reads each task's bundle, spawns subagents in parallel batches per `[P]` wave, collects outputs, commits, advances. Hard-errors on legacy specs missing `## Tasks (curated)`.
- **Subagents lose `Read`/`Grep`/`Glob`.** `df-implement`, `df-test`, `df-integration`, and `df-optimize` now consume the inline bundle the curator pre-built — no on-the-fly file discovery. If something's missing, the agent emits `CONTEXT_INSUFFICIENT: <file>` and stops; the curator augments the bundle and re-spawns (max 2 retries). `df-spike`, `df-spike-platform`, `df-haiku-ops`, and `reasoner` are unchanged.
- **`/df:plan`, `/df:auto`, `/df:auto-cycle` removed.** The autonomous-mode loop is replaced by the curator pattern (the orchestrator session IS the loop now). The `auto-cycle` skill, `bin/wave-runner.js`, `bin/plan-consolidator.js`, and `templates/plan-template.md` are deleted.
- **`npx deepflow migrate-legacy`.** New subcommand converts `.deepflow/plans/doing-{spec}.md` mini-plans into `## Tasks (curated)` sections appended to the matching `specs/doing-{spec}.md`. Best-effort — context bundles ship as TODO placeholders the curator must populate before `/df:execute`. Idempotent on already-migrated specs.
- **Installer auto-detects legacy plans.** After every install, `npx deepflow` checks the current directory for `.deepflow/plans/` and prompts to run the migrator (default Yes in TTY).
- **`/df:execute` warns on legacy plans dir.** Even after migration, if `.deepflow/plans/` is still present, the precheck emits a one-line stderr hint pointing at the migrator.

### Fixes & internals

- **`mode === 'auto'` escalation removed** from `df-invariant-check` and `df-artifact-validate`. The `--auto` CLI flag and `DEEPFLOW_AUTO=1` env signal — both set only by the now-deleted `/df:auto` — are gone. Strict-mode users get the same advisory→hard escalation that auto used to provide.
- **New `df-context-injection` PreToolUse hook** auto-discovered by `bin/install.js` via `@hook-event:` tag. Fires on Task spawn for restricted subagent types and validates that an inline bundle is present.
- **`DELEGATION.md` gains a Tool Inventory section** listing all 8 sub-agents (4 restricted + 4 unchanged) plus the `CONTEXT_INSUFFICIENT` escape contract.
- README, CLAUDE.md, and `docs/{concepts,configuration,getting-started}.md` rewritten to describe Two Phases (Human + AI) instead of Two Loops; data flow now goes specs → curator → curator-active worktree.
- 6 obsolete test files deleted (`command-cleanup{,-integration}`, `plan-fanout{,-integration,-v2-integration}`, `orchestrator-v2-integration`) — they tested removed commands and orchestrator behavior.
- 182/182 hook tests pass after the rewrite; 8/8 unit tests for the new migrator pass (including a regression test for a JS-regex `\z` bug that initially truncated step bodies at literal `z` chars).

## v0.1.132 — 2026-04-29

Follow-up to v0.1.130/131: implementation-class agents can now commit on their own `df/<spec>` branch (the `/df:execute` flow requires 1 task = 1 agent = 1 commit), and the unreliable transcript-walk role-inference fallback is removed.

### What's new

- **Impl-class agents commit their own work.** `df-implement`, `df-test`, `df-integration`, and `df-optimize` are now allowed to run `git add` and plain `git commit` (no `--amend`) inside their worktree. Previously every commit had to round-trip through `df-haiku-ops`, which conflicted with `/df:execute`'s 1-task = 1-agent = 1-commit contract.
- **History-rewriting still blocked.** `git push`, `merge`, `rebase`, `reset`, `revert`, `cherry-pick`, `branch`, `checkout`, `tag`, and `commit --amend` remain denied for impl-class agents — only forward commits on their own branch are permitted.

### Fixes & internals

- **Tier-2 transcript-walk dropped.** `hooks/lib/agent-role.js` no longer attempts to infer agent role by scanning sibling subagent metadata; the T7 spike was inconclusive and the heuristic was unreliable. Role inference is now Tier-1 only (cwd + branch). The `inferAgentRoleViaTranscript` export is kept as a no-op stub for backward compatibility.
- `GIT_MUTATING_DENY` renamed to `GIT_HISTORY_REWRITING_DENY` and split from a new `GIT_AMEND_DENY` list to make the policy intent explicit.
- Test suite reorganized: AC-3 / AC-9 tests inverted (now assert that `git add` / `git commit` are *allowed* for impl-class agents on `df/<spec>` branches); AC-12 / AC-14 / AC-15 added to lock down `--amend`, history rewriting, and cross-branch ops; AC-17 (`df-spike-platform` scope) verified via static SCOPES inspection until a real probe-T worktree exists.

## v0.1.131 — 2026-04-29

Hotfix: the v0.1.130 per-agent Bash hook shipped with a malformed `@hook-event` tag, so the installer copied the file but never registered it. The headline feature of v0.1.130 was inert until this release.

### Fixes

- **`df-bash-scope` now actually runs.** The hook header used `// @hook-event PreToolUse` (no colon); the installer's auto-wire regex requires the colon. Without it the hook was copied to `~/.claude/hooks/` but never added to `settings.json` PreToolUse:Bash, so per-agent Bash scoping silently did nothing in v0.1.130. Re-run `npx deepflow@latest` to register the hook.
- Test that asserted the buggy form was updated to match the installer's actual regex contract.

## v0.1.130 — 2026-04-29

Per-agent Bash scoping replaces the legacy implement-only guard, a new platform-spike agent unlocks unsandboxed proofs of concept, and `/df:spec` now consumes `/df:map` warm-up artifacts so requirement synthesis is grounded in real stack/architecture.

### What's new

- **Per-agent Bash allowlists** — new `df-bash-scope` PreToolUse hook enforces per-subagent command scopes (read-only for impl/test, mutations only for `df-haiku-ops`, arbitrary CLI for spikes within their worktree). Replaces the global `df-implement-bash-search-guard`.
- **`df-spike-platform` agent** — a new sub-agent with broader Bash scope for platform-level proof-of-concept work that the standard `df-spike` cannot run. Tagged with `[SPIKE-PLATFORM]` in PLAN.md and routed by `wave-runner`.
- **`/df:spec` warm-up** — when `.deepflow/codebase/` artifacts exist, `/df:spec` now injects `STACK.md` + `ARCHITECTURE.md` + `INTEGRATIONS.md` into the reasoner so requirements anchor to your real stack instead of guessing. Falls back gracefully if `/df:map` hasn't run yet.
- **Two-tier agent identity** — runtime agent role is inferred from cwd-branch first (worktree task agents) and falls back to transcript-walk metadata (haiku-ops and arbitrary-cwd subagents). No env-var injection required.
- **LSP diagnostics protocol** — `df-implement`, `df-integration`, and `df-optimize` now have a codified protocol for consuming LSP diagnostics during edit cycles.

### Fixes & internals

- `reasoner` no longer has direct Bash access — shell ops delegate through `df-haiku-ops`, shrinking the reasoning agent's blast radius.
- `DEEPFLOW_PERMISSIONS` global allowlist split: 9 mutation patterns (git commit/add/branch/checkout/merge/revert/stash/worktree, mkdir) removed from the global set and enforced per-agent via `df-bash-scope`. `git show` and `git rev-parse` added to the global read-only set.
- Test coverage: 10 ACs across 6 agents in `df-bash-scope.test.js`; explicit allow+deny tests for `df-spike-platform`.
- Install banner now reflects 8 sub-agents (was 7); cleaned up 5 duplicate `done-*.md` files already migrated to `.deepflow/specs-done/`.

## v0.1.129 — 2026-04-28

Five new specs land together: a **codebase-map** artifact pipeline (`/df:map` + injection), end-to-end **artifact validation**, a formal **agent delegation contract**, hash-stable **spike gates** with isolation, and **WHEN/THEN/SHALL** acceptance-criteria enforcement.

### What's new

**`/df:map` — codebase artifact pipeline**
- **`/df:map` slash command** — generates six codebase artifacts (sketch, findings, impact, etc.) with sha256 staleness detection and `[STALE]` markers.
- **Per-agent artifact injection** — PreToolUse hook injects only the artifact subset each subagent needs; ordering is `inject → delegation-contract` so contracts see the injected context.
- **Stale auto-regen** — injection hook detects stale maps and re-runs generation transparently.
- **Parallel-safety guard** — `/df:plan` now refuses `[P]` (parallel) tags on tasks touching shared resources, with rules encoded in the TESTING.md template.
- **Map invalidation on merge** — `.deepflow/maps/{spec}/` is invalidated on doing→done transitions so stale maps don't outlive their spec.
- **`gpt-tokenizer` runtime dep** — token-counting (`bin/count-tokens.js`) enforces AC-8 bounds (CLAUDE.md ≤5k, artifacts 15k–25k).

**Artifact chain (sketch → findings → impact)**
- **New scaffolds** — `sketch-template.md`, `findings-template.md`, `impact-template.md` populate the chain from `/df:discover` through `/df:plan`.
- **Plan template** — optional `Slice`, `Symbols`, `Impact edges` frontmatter fields for blast-radius traceability.
- **Per-task findings** — `/df:execute` now appends per-task findings blocks back into the artifact chain.

**Artifact validation hook (`df-artifact-validate.js`)**
- **Existence + scope-coverage predicates** — extracted into `hooks/lib/artifact-predicates.js` for greppability and reuse.
- **Drift checks** — canonical drift formula with frozen result-JSON schema (REQ-5).
- **Cross-consistency checks** between sketch/findings/impact/plan.
- **Enforcement modes + auto-escalation** — soft → hard escalation with skip-on-missing-artifact (REQ-7).
- **Pinned artifact filenames** — constants live in a shared module so templates and hooks can't drift.

**Agent delegation contract**
- **`DELEGATION.md`** at the repo root declares per-subagent `allowedInputs` / `forbiddenInputs` / `requiredOutputSchema` for 7 agents, with a Router-vs-Interpreter section (AC-9).
- **PreToolUse enforcement** — `hooks/df-delegation-contract.js` validates every Task spawn against the contract.
- **All `/df:*` commands conform** — discover, debate, plan, spec, execute spawn sites updated to honor the contract.

**Spike gates + isolation**
- **Schema validator** — `hooks/df-spike-validate.js` enforces REQ-5 spike result JSON.
- **Hash-stable spike gates** — `inputs_hash` canonical formula is stable across input reorderings; drift result JSON is frozen.
- **Spike isolation** — port-pool + tmpdir isolation under `max_parallel`; hash-based worktree cache; `df-experiment-immutable.js` PostToolUse hook locks completed experiments.
- **`spike.gate.*` and `spike.isolation.*`** config blocks added to the config template.

**WHEN/THEN/SHALL acceptance criteria**
- **`/df:spec` mandates** WHEN/THEN/SHALL phrasing for all generated ACs.
- **Spec-lint hook** — new `checkAcPhrasing` rejects free-form ACs.
- **Updated example ACs** in templates use the new phrasing.

### Fixes & internals

- **`/df:execute` parallelism** — removed the parallelism cap of 5 agents under <50% context.
- **Wave-runner** — extracts `task_detail_body` from mini-plan bullet lists *and* PLAN.md integration blocks.
- **Worktree isolation** — sub-agent worktree boundary now enforced across templates, sub-agents, and hooks (post wave-1 contamination recovery).
- **`/df:discover` & `/df:debate`** — refactored to eliminate orchestrator paraphrasing of agent outputs.
- **Decisions file index** — experiment template gains `files:` frontmatter; df-decisions skill documents the `Files:` tag.
- **`validate-tasks-gates`** — PreToolUse hook scaffolded with constants, parser, and three gates.
- **gitignore** — `node_modules` ignored; tracked symlink removed.

## v0.1.128 — 2026-04-23

Tighten `/df:verify` output contract to suppress LSP false-positives from worktree symlinks.

### What's new

- **No more LSP noise from `/df:verify`** — The prohibition on calling the LSP tool / `mcp__ide__getDiagnostics` (and the ban on narrating false positives as "these are false positives") is now at the top of the verify contract, next to the existing OUTPUT/NEVER block, so it reads before the 350+ lines of level definitions. L0/L4 rely solely on build/test exit codes; worktree `node_modules` symlinks no longer produce spurious TS 2307/2875 errors in your terminal.
- **Prescribed post-merge output** — `/df:verify`'s merge-status line is now fixed to a single `✓ Merged → main | ... | Ready: /df:spec <name>` format, with explicit prohibition on trailing congratulatory narration (e.g. "🎉 Spec merged successfully…").

## v0.1.127 — 2026-04-22

Three new specs shipped: auto-evolving bash filters (canary-driven promotion pipeline), implement-task guards (hook-enforced search and test-cap discipline), and slimmer execute output.

### What's new

**Auto-evolving bash filters**
- **Filter dispatch library** — `hooks/lib/filter-dispatch.js` extracts `dispatch(cmd)` from the bash-rewrite hook, enabling reusable named filters and clean `require()` consumers.
- **8 archetype templates** — `truncate-stable`, `group-by-prefix`, `json-project`, `resolve-and-report`, `failures-only`, `head-tail-window`, `summarize-tree`, `diff-stat-only` — each exports `{name, archetype, match, apply}` with a structured `{header, body, truncated?}` schema.
- **Telemetry hook** — `hooks/df-bash-telemetry.js` (PostToolUse) appends JSONL rows to `.deepflow/bash-telemetry.jsonl`; fires only when a filter rewrote the command.
- **Canary shadow runner** — `hooks/lib/canary-runner.js` forks a detached subprocess on every matched-filter dispatch to run both raw and proposed rewrites; emits `{signal_lost}` rows to `.deepflow/auto-filter-canary.jsonl` without blocking the hook.
- **Signal-loss detector** — `hooks/lib/signal-loss-detector.js` uses an error-line regex, unique path-token count, and diff-hunk markers to flag when a proposed filter suppresses meaningful output.
- **Auto-promotion** — `bin/df-filter-suggest.js --promote` graduates proposals from `filters-proposed.yaml` to `hooks/filters/generated/` once ≥ 20 clean canary rows (zero `signal_lost`) accumulate.
- **N ≥ 5 gate** — `df-filter-suggest` only proposes a new filter when it has seen ≥ 5 matching observations, preventing premature suggestions.
- **Pattern normalizer** — `normalize(cmd)` in filter-dispatch replaces typed arguments (paths, URLs, flags) with placeholders so similar commands cluster into the same proposal.

**Implement-task guards**
- **Bash search guard** — `hooks/df-implement-bash-search-guard.js` (PreToolUse) blocks `grep`/`rg`/`find`/`ag` inside `df-implement` subagents, enforcing direct-path reads over exploratory search.
- **Test-invocation cap** — `hooks/df-implement-test-invocation-cap.js` (PreToolUse) denies a second run of `build_command`/`test_command` for the same task ID, preventing runaway test loops.
- **Plan-consolidator filter** — `bin/plan-consolidator.js` now strips verify-shape tasks from consolidated output, keeping PLAN.md lean.

**Slimmer execute output**
- **Prompt-compose mute rule** — `--help` invocations of `prompt-compose` are now silently compressed, removing a common source of boilerplate in agent transcripts.
- **Ratchet warning guard** — The pre-install warning in `bin/ratchet.js` no longer fires on empty stderr, eliminating false-positive noise.

### Fixes & internals

- Canary hot-path latency fixed: proposals are now cached at module load (mtime-keyed), eliminating per-invocation `fs.readFileSync` that added ~25 ms p95 overhead.
- `src/commands/df/execute.md` gains a stdin-pipe usage example and removes the pre-spawn context echo that leaked internal orchestrator state into transcripts.

## v0.1.126 — 2026-04-21

Bash output compression now applies to every project, not just deepflow ones.

### What's new

- **Universal bash compression** — The hook that silently compresses verbose-but-confirmatory commands (`npm install`, `npm run build`, `pnpm install`, `yarn build`, `git stash`, `git worktree add`) now runs in any Claude Code project, reducing context rot for everyone.
- **Opt-out escape hatch** — Set `DF_BASH_REWRITE=0` in your environment to see full command output when you need it (e.g. debugging a dependency resolution issue).

### Fixes & internals

- Synced `package-lock.json`.
