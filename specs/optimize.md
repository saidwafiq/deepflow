# Optimize

## Objective
Add a metric-driven continuous improvement loop that actively optimizes any measurable code metric, using safe-to-fail probes (Cynefin) when progress plateaus.

## Requirements
- **REQ-1**: Planner recognizes metric ACs in specs (e.g., `coverage > 85%`) and generates tasks with an `Optimize:` block containing: `metric` (shell command returning a number), `target`, `direction` (higher/lower), `max_cycles`, `secondary_metrics`
- **REQ-2**: Execute implements a measure-change-measure-keep/revert cycle for Optimize tasks — one atomic change per cycle, ratchet AND metric must both pass to keep
- **REQ-3**: Metrics are shell commands outputting a single scalar number; `direction` determines whether higher or lower is better
- **REQ-4**: Loop stops on: target reached, max cycles, plateau (triggers probes), or circuit breaker (N consecutive reverts)
- **REQ-5**: On plateau, normal cycle pauses and safe-to-fail probes launch — auto-scaling (2→4→6), each set with minimum 1 contextualizada + 1 contraditoria + 1 ingenua; winner returns to normal cycle
- **REQ-6**: Secondary metrics are measured each cycle; regression beyond threshold (default 5%) generates a WARNING for human decision, does not auto-revert
- **REQ-7**: Cross-cycle state persisted in `auto-memory.yaml` (`optimize_state` section); failed hypotheses recorded in `.deepflow/experiments/`
- **REQ-8**: Cycle results appended to `auto-report.md` with metric deltas and probe results
- **REQ-9**: Optimize tasks use isolated worktrees (same as existing), with sub-worktrees for probes (same as spike probes)

## Constraints
- Ratchet complemented, not replaced — optimize adds metric gate ON TOP of existing ratchet (build/test/lint)
- Atomic changes only — one modification per cycle for diagnosability
- No LLM judges — winner selection uses machine-verifiable ranking (regressions > coverage > files_changed)
- One optimize task active at a time (inherently sequential)
- Context window aware — checkpoint at 50%, resume via auto-memory.yaml
- Probe diversity minimum: contraditoria + ingenua mandatory from 2 probes; contextualizada added from 3+

## Out of Scope
- ML/research optimization (no hyperparameter tuning, no model training)
- Multi-objective optimization (one primary metric; secondaries are advisory only)
- Safe-to-fail probes outside Optimize tasks (future expansion)
- Human-in-the-loop during cycle (only on circuit breaker, trade-off, or completion)
- Custom stop conditions beyond the four defined

## Acceptance Criteria
- [ ] `/df:plan` generates `Optimize:` tasks from spec ACs with numeric comparisons
- [ ] Execute runs measure→change→measure→keep/revert cycle with one atomic change per iteration
- [ ] Metric command output parsed as float; non-numeric = cycle failure
- [ ] Both ratchet (build/test/lint) AND metric improvement required to keep a change
- [ ] Target reached → task `[x]`; max cycles → task `[x]` with best value noted
- [ ] Plateau (3 cycles no improvement) → safe-to-fail probes launched, normal cycle paused
- [ ] Probes auto-scale (2→4→6) with diversity: contextualizada + contraditoria + ingenua
- [ ] Probe winner selected by metric improvement, merged back; losers preserved as `-failed` branches
- [ ] Secondary metric regression >5% generates WARNING in auto-report.md (no auto-revert)
- [ ] `optimize_state` in auto-memory.yaml survives context exhaustion; auto-cycle resumes optimize tasks
- [ ] Circuit breaker (3 consecutive reverts) halts loop, task stays `[ ]`

## Technical Notes
- **Extend plan.md**: Add `Optimize:` block generation and metric AC detection (pattern: `{metric} {operator} {number}`)
- **Extend execute.md**: Add optimize cycle handler branching on task type; reuse section 5.5 ratchet as gate + metric as additional gate
- **Reuse spike probe infra**: Sub-worktrees (execute.md:159-201), winner selection, branch preservation — add probe diversity enforcement
- **Extend auto-memory.yaml**: New `optimize_state` section: `task_id`, `baseline`, `current_best`, `cycles_run`, `cycles_without_improvement`, `probe_scale`, `history`
- **No standalone command**: Optimize integrates into the existing pipeline — specs define metric ACs, planner generates Optimize: tasks, execute runs the loop, auto-cycle orchestrates
- **Potential conflict**: Execute assumes 1 task = 1 commit (execute.md:365). Optimize tasks span N cycles. Resolution: optimize is a distinct execution mode, auto-cycle picks up same task repeatedly until stop condition
- **Config keys**: `optimize.plateau_threshold` (3), `optimize.max_cycles_default` (20), `optimize.secondary_regression_threshold` (5%)
- **Agent prompts**: Include current metric, target, recent attempt history, and failed hypotheses from experiments/ — follow START/MIDDLE/END attention-curve pattern
