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
