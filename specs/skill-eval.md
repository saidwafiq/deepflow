# skill-eval

## Objective

Autonomous Karpathy-pattern optimization loop for deepflow skills: 1 target metric, 1 change per iteration, accept if improved, revert if not, git-as-memory.

## Requirements

- **REQ-1**: 3-level metric model — **guard** (binary: fixture tests + ratchet, fail = auto-revert before any metric check), **target** (one numeric metric that decides keep/revert), **secondary** (numeric, logged in git commit message, inform mutator, never decide)
- **REQ-2**: Fixture design — microcosmo realista (deepflow-like, 10-15 files). Tests inside the fixture ARE the quality guards against Goodhart's law. `/df:eval --scaffold` creates fixture structure from template; human populates content
- **REQ-3**: Karpathy loop (`/df:eval --loop N --target <metric> --skill <path> --bench <dir>`) — mutate skill file, run fixture, measure, keep/revert. One target metric per iteration. No threshold, no probes, no plateau detection, no smoothing
- **REQ-4**: Mutator receives complete metrics table (confirmed + rejected experiments, ALL metrics including secondaries). Mutator prompt follows attention U-curve: skill file + current hypothesis at START, experiment history in MIDDLE, mutation instructions at END. History capped at `max_history_tokens` (~4000 tokens)
- **REQ-5**: Git-as-memory — results logged exclusively in git commit messages with `experiment:` prefix. Format: `experiment({skill}): {hypothesis} | {target}={value} delta={delta}% {status} | {secondary metrics}`. `git log --grep="experiment:"` is the only query interface. No external state files (no TSV)
- **REQ-6**: Hypotheses are human-supplied in v1 via `--hypothesis "..."` flag or `hypotheses.md` file in benchmark dir
- **REQ-7**: Experiments run on isolated branch via existing worktree infrastructure. `git revert` (not reset) to preserve failed experiments in history. Commit before verify to have a clean rollback point
- **REQ-8**: Metric pivot — human switches target metric via new `--target` invocation. On pivot, `git log --grep="experiment:"` is parsed and previously-reverted experiments with positive delta on new target are surfaced as candidates
- **REQ-9**: Backtrack — on stall, return to best known state. Stall handling via heuristics in mutator prompt only, no mechanical stall detection code
- **REQ-10**: Metric collection from existing hooks — eval runner reads `.deepflow/token-history.jsonl` (cache_read_input_tokens, input_tokens → cache_ratio; total tokens) and `~/.claude/tool-usage.jsonl` (output_size_est_tokens) post-execution to compute all metrics. No new hooks needed
- **REQ-11**: Rework as future secondary metric — when spec-lineage tracking exists (see `specs/spec-lineage.md`), the count of `derives-from` specs linked to implementations produced by a skill variant becomes a quality proxy. Not implemented in v1; acknowledged as the real metric of skill quality

## Constraints

- No LLM judges another LLM — only mechanical metrics (guard pass/fail, numeric target) decide
- Full file replacement per iteration — no partial prompt edits
- One target metric per iteration (atomic causality)
- Eval loop is independent from section 5.9 optimize cycle — different purpose, own mechanics

## Out of Scope

- AI hypothesis generation (v2 — after variance is characterized empirically)
- A/B comparison infrastructure (two single runs, no dedicated infra needed)
- Threshold / smoothing / probes / mechanical plateau detection
- Reuse of section 5.9 optimize cycle
- Telemetry-driven hypothesis generation (v2 — hooks as metric source stays in scope; hooks as hypothesis source is v2)
- Dashboard UI (git log sufficient)
- External state files (TSV, JSON) — git is the single source of truth
- Rework metric automation (depends on spec-lineage, see `specs/spec-lineage.md`)

## Acceptance Criteria

- [ ] AC-1 (REQ-1): Guard failure auto-reverts before any metric comparison; logged as `status:guard_fail`
- [ ] AC-2 (REQ-1): Target metric improvement keeps the commit; regression reverts it; logged as `status:kept` or `status:reverted`
- [ ] AC-3 (REQ-1): Secondary metrics appear in experiment commit message but never trigger keep/revert
- [ ] AC-4 (REQ-2): `/df:eval --scaffold benchmarks/my-bench/` creates dirs `fixture/`, `tests/`, files `spec.md`, `config.yaml`; fixture contains 10-15 file deepflow-like codebase skeleton
- [ ] AC-5 (REQ-2): Fixture tests execute via the project's configured test command and their pass/fail constitutes the guard check
- [ ] AC-6 (REQ-3): `/df:eval --loop 10 --target cache_ratio --skill skills/atomic-commits/SKILL.md --bench benchmarks/simple-feat/` runs 10 iterations producing exactly 10 experiment commits
- [ ] AC-7 (REQ-3): Reverted experiments remain in git history via `git revert` (not `git reset`)
- [ ] AC-8 (REQ-4): Mutator prompt contains: skill file and hypothesis in first 20% of tokens, experiment history in middle, mutation instructions in final 20%
- [ ] AC-9 (REQ-4): Experiment history passed to mutator is truncated to `max_history_tokens` (default 4000), most recent experiments prioritized
- [ ] AC-10 (REQ-5): Each experiment produces exactly one git commit with message format `experiment({skill}): {hypothesis} | {target}={value} delta={delta}% {status} | {secondaries}`. `git log --grep="experiment:"` returns the complete experiment history
- [ ] AC-11 (REQ-6): Loop accepts `--hypothesis` flag; without it, reads `hypotheses.md` from benchmark dir
- [ ] AC-12 (REQ-7): All experiments run on a worktree-isolated branch, not main
- [ ] AC-13 (REQ-7): Each iteration commits before running verification, providing a clean revert target
- [ ] AC-14 (REQ-8): After `--target` pivot, `git log --grep="experiment:"` is parsed and previously-reverted experiments with positive delta on new target are logged to stdout as candidates
- [ ] AC-15 (REQ-9): On stall (no improvement for N iterations), loop resets skill file to best-known commit state before next mutation
- [ ] AC-16 (REQ-10): After each iteration, eval runner reads `.deepflow/token-history.jsonl` from the fixture's execution to compute cache_ratio (`cache_read / input_tokens`) and total_tokens
- [ ] AC-17 (REQ-10): Metrics are sourced from existing hook outputs — no new instrumentation hooks are installed by the eval framework
- [ ] AC-18 (REQ-11): Technical Notes document fix count as future secondary metric dependent on spec-lineage; no implementation required in v1

## Technical Notes

- **First target skill**: `atomic-commits` — well-scoped, has measurable token/cache metrics, representative of skill optimization use case
- **Fixture as Goodhart guard**: The fixture's own test suite prevents the optimizer from gaming the target metric. If a mutation improves cache ratio but breaks the fixture tests, the guard catches it. Fixture tests must cover real skill behavior, not just syntax
- **Git-as-memory**: Every experiment committed with `experiment:` prefix. `git log --grep="experiment:"` surfaces full history. Reverts preserve the failed experiment's diff for the mutator to learn from
- **Mutator prompt template**: Follows the codebase's attention U-curve pattern — critical info (task, hypothesis, current skill) at START and END zones; less critical info (history table) in MIDDLE
- **max_history_tokens**: ~4000 tokens fits ~15 experiments parsed from git log. Older experiments are summarized or dropped, most recent always included
- **Orchestration flow per iteration**: (1) mutator generates new skill .md → (2) commit with `experiment:` prefix → (3) copy fixture to temp dir, swap skill file → (4) run fixture via `/df:execute` or `claude` CLI → (5) guard check: fixture tests + ratchet pass? No → `git revert`, log `guard_fail`, next iteration → (6) collect metrics: read `.deepflow/token-history.jsonl` from fixture execution → compute cache_ratio, total_tokens, etc. → (7) target improved? Yes → keep, log `kept`. No → `git revert`, log `reverted` → (8) all metrics already in commit message → (9) next iteration
- **Metric source mapping**: `cache_ratio` = `cache_read_input_tokens / input_tokens` from token-history.jsonl; `total_tokens` = sum of input + output from token-history.jsonl; `wall_time` = timestamp delta; `revert_count` = running tally; `context_burn` = max `used_percentage` from token-history.jsonl
- **Worktree isolation**: Uses existing `.deepflow/worktrees/` infrastructure. Experiment branch named `eval/{skill-name}/{timestamp}`
- **Rework metric (future)**: When `spec-lineage` tracking is implemented, `derives-from` count becomes the ultimate quality signal. A skill variant that saves 40% tokens but generates 2 correction specs is worse than one that uses more tokens but gets it right first time. This inverts the naive "less tokens = better" optimization
