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
