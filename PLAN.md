# Plan

Generated: 2026-03-23

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 1 |
| Tasks created | 7 |
| Ready (no blockers) | 3 |
| Blocked | 4 |

## Spec Gaps

None identified.

## Tasks

### doing-plan-fanout

- [ ] **T1** [SPIKE]: Validate parallel sub-agent mini-plan generation and consolidation
  - Type: spike
  - Hypothesis: 3 parallel non-background Agent calls with mock spec content each return parseable mini-plan markdown that an Opus consolidator can renumber into valid PLAN.md format
  - Method: (1) Spawn 3 agents with hardcoded mock specs (2 small, 1 with file overlap). (2) Each agent returns a mini-plan with local T-numbering. (3) Feed outputs to Opus consolidator. (4) Validate output against wave-runner parser.
  - Success criteria: Consolidator output parses without error by wave-runner.js; global T-numbers are sequential with no gaps; file-conflict Blocked-by annotation appears for overlapping file
  - Time-box: 30 min
  - Files: .deepflow/experiments/plan-fanout--parallel-consolidation--active.md
  - Blocked by: none
  - Model: sonnet
  - Effort: high

- [ ] **T2** [SPIKE]: Validate naive single-prompt approach (no fan-out, enhanced monolithic)
  - Type: spike
  - Hypothesis: A single enhanced prompt (current monolithic path with per-spec sectioning) produces equivalent quality plans for 3 specs without needing sub-agents
  - Method: (1) Run current plan.md against 3 mock specs in sequence. (2) Compare output quality (task granularity, conflict detection, T-numbering) against T1 results. (3) Measure context usage.
  - Success criteria: Either (a) quality is equivalent proving fan-out unnecessary, or (b) measurable degradation in conflict detection or task specificity validating fan-out approach
  - Time-box: 30 min
  - Files: .deepflow/experiments/plan-fanout--monolithic-baseline--active.md
  - Blocked by: none
  - Model: sonnet
  - Effort: high

- [ ] **T3** [SPIKE]: Validate sub-agent format consistency without structured output
  - Type: spike
  - Hypothesis: Markdown-only sub-agent outputs (no JSON schema) are consistent enough across 5 parallel calls that a pattern-based consolidator can parse them without failures
  - Method: (1) Spawn 5 agents with identical prompt but different spec content. (2) Collect outputs. (3) Apply regex extraction for T-number lines, Files:, Blocked by:, Model:, Effort: fields. (4) Count parse failures.
  - Success criteria: 0 parse failures across 5 outputs; all required fields extracted from every task
  - Time-box: 30 min
  - Files: .deepflow/experiments/plan-fanout--format-consistency--active.md
  - Blocked by: none
  - Model: sonnet
  - Effort: high

- [ ] **T4**: Implement fan-out orchestration in plan.md (sub-agent spawn)
  - Type: implementation
  - Files: src/commands/df/plan.md
  - Blocked by: T1, T3
  - Model: opus
  - Effort: high
  - Description: Add fan-out section after §4.6. Contains: (a) count plannable specs, (b) if 1 spec → skip to existing §5, (c) if >5 → select first 5, report remainder, (d) spawn parallel non-background Task() calls — one per spec — each with sub-agent prompt embedding §1.5-§4.5 rules + that spec's content + project context. Sub-agents use sonnet model. (e) Collect return values as mini-plan strings.
  - Impact: Restructures plan.md flow; §5 becomes conditional (monolithic vs consolidator path)

- [ ] **T5**: Implement Opus consolidator replacing §5 reasoner
  - Type: implementation
  - Files: src/commands/df/plan.md
  - Blocked by: T1, T4 (file conflict: src/commands/df/plan.md)
  - Model: opus
  - Effort: high
  - Description: Rewrite §5 to: (a) receive mini-plans from fan-out, (b) renumber T-ids globally (spec priority order, then intra-spec), (c) run cross-spec file conflict detection (§4.6 elevated to cross-spec scope), (d) apply model/effort routing (§5.5), (e) produce Summary table, (f) output PLAN.md sections grouped by `### doing-{spec}`. Single Opus Task() call. Monolithic path (1 spec) retains current §5 unchanged.
  - Impact: Replaces existing §5 reasoner; must preserve REQ-12 (exactly one Opus invocation)

- [ ] **T6**: Add graceful degradation and cap logic
  - Type: implementation
  - Files: src/commands/df/plan.md
  - Blocked by: T5 (file conflict: src/commands/df/plan.md)
  - Model: sonnet
  - Effort: medium
  - Description: (a) Wrap sub-agent result handling: if agent returns error or unparseable output, log warning with spec name and continue. (b) Add cap check: if plannable specs >5, select first 5 by filesystem order, report remaining specs to user. (c) Ensure §8/§9 only process successfully planned specs.

- [ ] **T7**: Verify tests and end-to-end format compliance
  - Type: implementation
  - Files: bin/wave-runner.test.js, bin/ratchet.test.js (read-only verification)
  - Blocked by: T5
  - Model: haiku
  - Effort: low
  - Description: Run `node --test bin/wave-runner.test.js` and `node --test bin/ratchet.test.js`. Verify 0 failures. No test file modifications expected.
