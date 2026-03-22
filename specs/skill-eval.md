# skill-eval

## Objective

Enable autonomous, metric-driven optimization of deepflow's own skills, commands, and agent prompts — closing the feedback loop between the telemetry deepflow already collects and the prompt engineering that produces it.

## Requirements

- **REQ-1**: `/df:eval` command runs A/B comparisons of two skill/command variants against a reproducible benchmark suite
- **REQ-2**: Benchmark suites are defined as directories containing a spec, a codebase fixture, and expected health outcomes (ratchet pass, token budget, cache ratio target)
- **REQ-3**: Metrics collected per variant run: ratchet pass/fail, total tokens (input + output), cache hit ratio (`cache_read / input_tokens`), revert count, wall-clock time, context burn rate (% consumed per wave)
- **REQ-4**: Auto-research loop mode (`/df:eval --loop N`) iterates autonomously: mutate prompt → run benchmark → measure → keep/revert → log — following the Karpathy autoresearch pattern (one atomic change per iteration, mechanical verification only, git-as-memory)
- **REQ-5**: Results logged in TSV format (`eval-results.tsv`) with columns: iteration, variant, commit, metric_name, metric_value, delta, status — consistent with autoresearch logging conventions
- **REQ-6**: Auto-research loop generates hypotheses from telemetry patterns (e.g., low cache hit → reorder prompt for stable prefix; high context burn → extract to context-fork skill)
- **REQ-7**: Guard constraint support — variant must still pass ratchet on all benchmark fixtures; metric improvement that breaks health gate is auto-reverted
- **REQ-8**: Integrates with existing `df-quota-logger.js`, `df-tool-usage.js`, and `df-execution-history.js` hooks as data sources for hypothesis generation

## Constraints

- No LLM judges another LLM's output quality — only mechanical metrics (token count, cache ratio, ratchet exit code, timing) decide winners
- Benchmark fixtures must be small, fast codebases (< 30s per ratchet run) to enable high iteration throughput (~12 experiments/hour, matching Karpathy's 5-min-budget pattern)
- Auto-research loop uses the same git-as-memory pattern: each experiment committed with `experiment:` prefix, reverted experiments preserved in git history
- Skill variants are file-level diffs (full replacement of one .md file per iteration) — no partial prompt edits to maintain atomic causality
- Maximum one change per iteration (autoresearch rule #3)
- The eval framework itself must not depend on specific models — benchmark definition specifies which model tier to use

## Dependencies

<!-- None — this is a new capability orthogonal to existing execute/verify flow -->

## Out of Scope

- Optimizing non-prompt artifacts (wave-runner.js, ratchet.js logic) — this spec targets markdown skill/command/agent files only
- Multi-GPU or distributed benchmarking
- Subjective quality evaluation (code readability, style) — only mechanical metrics
- Production A/B testing with real user workloads (benchmarks are synthetic fixtures)
- Dashboard UI for eval results (TSV + git log is sufficient for v1)

## Acceptance Criteria

<!-- REQ-1: A/B comparison -->
- [ ] AC-1 (REQ-1): `/df:eval --a skills/atomic-commits/SKILL.md --b variants/atomic-commits-v2.md --bench benchmarks/simple-feat/` runs both variants against the benchmark and outputs a comparison table to stdout
- [ ] AC-2 (REQ-1): Comparison table includes columns: variant, ratchet_result, total_tokens, cache_hit_ratio, reverts, wall_time_s

<!-- REQ-2: Benchmark suites -->
- [ ] AC-3 (REQ-2): A benchmark directory contains `spec.md`, `fixture/` (codebase), and `expected.yaml` (pass criteria: `ratchet: pass`, `max_tokens: N`, `min_cache_ratio: 0.X`)
- [ ] AC-4 (REQ-2): `templates/benchmark-template/` scaffold exists with example spec, fixture, and expected.yaml

<!-- REQ-3: Metric collection -->
- [ ] AC-5 (REQ-3): After a variant run, all six metrics (ratchet pass/fail, total tokens, cache ratio, revert count, wall time, context burn %) are written to `eval-results.tsv`
- [ ] AC-6 (REQ-3): Metrics are sourced from existing hook outputs (`token-history.jsonl`, `context.json`) — no new instrumentation hooks needed

<!-- REQ-4: Auto-research loop -->
- [ ] AC-7 (REQ-4): `/df:eval --loop 10 --target cache_ratio --skill skills/atomic-commits/SKILL.md --bench benchmarks/simple-feat/` runs 10 iterations, each mutating the skill, benchmarking, and keeping/reverting based on target metric improvement
- [ ] AC-8 (REQ-4): Each iteration produces exactly one `experiment:` prefixed git commit; reverted experiments remain in git history
- [ ] AC-9 (REQ-4): Loop logs every 10 iterations with progress summary (baseline → current best → delta)

<!-- REQ-5: TSV logging -->
- [ ] AC-10 (REQ-5): `eval-results.tsv` is append-only and parseable by standard TSV tools; header row written once on creation

<!-- REQ-6: Hypothesis generation -->
- [ ] AC-11 (REQ-6): When `--loop` starts, the system reads `token-history.jsonl` and `tool-usage` logs to generate an initial hypothesis list (e.g., "cache_read ratio below 30% suggests unstable prompt prefix")
- [ ] AC-12 (REQ-6): Hypotheses are logged to `eval-hypotheses.md` with status: `tested`, `confirmed`, `rejected`

<!-- REQ-7: Guard constraint -->
- [ ] AC-13 (REQ-7): If a mutated variant fails ratchet on any benchmark fixture, the change is auto-reverted and logged as status `reverted:guard_fail`
- [ ] AC-14 (REQ-7): Guard check runs before metric comparison — a variant that improves metrics but breaks health is never accepted

<!-- REQ-8: Telemetry integration -->
- [ ] AC-15 (REQ-8): Hypothesis generator reads from `.deepflow/token-history.jsonl` and `.deepflow/tool-usage/` without requiring new hook installations

## Technical Notes

- **Benchmark fixture design**: Each fixture is a minimal git repo with a known-good state. The eval runner copies it to a temp dir, applies the spec via `/df:execute`, and measures outcomes. Fixture size should target ~5-10 files to keep ratchet runs under 30s.
- **Prompt mutation strategy**: The auto-research agent receives the current skill .md, the hypothesis, and past experiment results. It produces a complete replacement file (not a diff). This keeps changes atomic and causality clear — one file, one change, one measurement.
- **Cache optimization pattern**: The primary expected use case. Prompts in deepflow use shell injection (`!cat file`) which produces variable content at the top. Moving stable content (instructions, rules) above variable content (task-specific state) should improve cache prefix matching. The eval loop can discover this automatically.
- **Git-as-memory**: Following Karpathy's pattern, every experiment is committed. The agent can `git log --grep="experiment:"` to see all prior attempts, including reverted ones. Failed experiments are as valuable as successful ones for guiding future hypotheses.
- **Integration with /df:auto**: Long-term, `/df:eval --loop` could run via `/loop 1m /df:eval-cycle` using the same autonomous pattern as `/df:auto-cycle`. Deferred to v2.
- **eval-runner.js**: New script at `bin/eval-runner.js` following the wave-runner.js/ratchet.js pattern. Handles: fixture setup, variant file swap, `/df:execute` invocation, metric collection from hook outputs, TSV logging, git commit/revert.
