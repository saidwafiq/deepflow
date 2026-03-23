# Plan Fan-Out Generation

## Objective

Improve `/df:plan` task quality by generating tasks per-spec in isolated sub-agent contexts, then consolidating into a single PLAN.md via an Opus agent.

## Requirements

- REQ-1: `/df:plan` must spawn one sub-agent per plannable spec (no `doing-`/`done-` prefix, passes `validateSpec`), each receiving only that spec's content plus project context (config.yaml, source_dir listing) — not other specs
- REQ-2: Each sub-agent must produce a mini-plan following the same task format as `templates/plan-template.md`, using local numbering (T1, T2, ...) within its mini-plan
- REQ-3: An Opus consolidator agent must receive all mini-plans and produce the final PLAN.md with globally unique T-numbers (T1 through TN across all specs)
- REQ-4: The consolidator must detect cross-spec file conflicts (same file in multiple specs' task lists) and add `Blocked by:` annotations per existing section 4.6 rules
- REQ-5: The consolidator must resolve cross-spec ordering by applying the same priority logic (Dependencies > Impact > Risk)
- REQ-6: When only one plannable spec exists, skip fan-out entirely and run the current monolithic plan.md path unchanged
- REQ-7: Mini-plans are ephemeral — stored only in sub-agent return values, never written to disk (no files in `.deepflow/`, `plans/`, or elsewhere)
- REQ-8: PLAN.md output format must remain unchanged: single flat file, `### doing-{spec-name}` grouping, `- [ ] **T{N}**: {description}` task format with `Files:`, `Blocked by:`, `Model:`, `Effort:` annotations
- REQ-9: Each sub-agent must independently perform layer-gated task generation (§1.5), experiment checks (§2), project context detection (§3), impact analysis (§4, L3 only), and targeted exploration (§4.5) for its spec
- REQ-10: Existing parser tests in `bin/wave-runner.test.js` and `bin/ratchet.test.js` must continue to pass after all changes
- REQ-11: If a sub-agent fails or returns unparseable output, the orchestrator must log a warning and proceed with remaining mini-plans (graceful degradation)
- REQ-12: The consolidator replaces the existing section 5 reasoner — there must be exactly one Opus invocation (the consolidator), not an additional one
- REQ-13: Sections 8 (cleanup) and 9 (output/rename) remain in the orchestrator, executing after consolidation produces the final PLAN.md
- REQ-14: When >5 plannable specs exist, fan-out processes the first 5 (by filesystem order); remaining specs are reported to the user for a subsequent `/df:plan` run

## Constraints

- Changes limited to `src/commands/df/plan.md` (primary) and possibly `templates/plan-template.md` (if sub-agent template needed)
- No changes to `bin/wave-runner.js`, `bin/ratchet.js`, `src/commands/df/execute.md`, or PLAN.md format
- Sub-agents must be spawned in ONE message as parallel non-background `Task()` calls per explore-agent.md pattern (NOT `run_in_background=true`, which causes late notification issues)
- Consolidator must use `Task(subagent_type="reasoner", model="opus")`
- No new npm dependencies
- Mini-plan format must be parseable by consolidator without structured output — markdown only
- Cap at 5 specs per fan-out cycle; report remainder to user

## Out of Scope

- Umbrella plans or hierarchical PLAN.md structures
- Cross-spec dependency declarations in spec files
- Splitting PLAN.md into multiple files (`plans/` directory)
- Changes to `/df:execute` or `/df:verify`
- DAG-based inter-spec dependency management
- Parallel execution changes (that is `/df:execute` territory)

## Acceptance Criteria

- [ ] AC-1 (REQ-1): plan.md spawns one sub-agent per plannable spec (validated, no doing-/done- prefix)
- [ ] AC-2 (REQ-2): Sub-agent prompt includes plan-template format rules; output uses local T-numbering
- [ ] AC-3 (REQ-3): Consolidator produces PLAN.md with globally sequential T-numbers (T1...TN), no gaps or duplicates
- [ ] AC-4 (REQ-4): Given two specs with overlapping `Files:` entries, consolidator adds `Blocked by:` with `(file conflict: {filename})` annotation
- [ ] AC-5 (REQ-5): Consolidator uses reasoner (Opus) for cross-spec prioritization
- [ ] AC-6 (REQ-6): Single spec runs current monolithic path with no fan-out overhead
- [ ] AC-7 (REQ-7): No mini-plan files exist on disk after `/df:plan` completes
- [ ] AC-8 (REQ-8): Fan-out-generated PLAN.md parseable by wave-runner.js (verified by running `node bin/wave-runner.js` against output)
- [ ] AC-9 (REQ-9): Sub-agent prompt includes layer-gating, experiment-check, project context, impact analysis, targeted exploration
- [ ] AC-10 (REQ-10): `node --test bin/wave-runner.test.js` and `node --test bin/ratchet.test.js` exit 0
- [ ] AC-11 (REQ-11): Sub-agent failure logs warning and continues with remaining specs
- [ ] AC-12 (REQ-12): Only one Opus invocation exists in the fan-out path (the consolidator)
- [ ] AC-13 (REQ-13): Cleanup and rename run after consolidation, not inside sub-agents
- [ ] AC-14 (REQ-14): >5 specs triggers partial fan-out with user-facing message listing queued specs

## Technical Notes

- **Sub-agent prompt:** Each needs: (1) single spec content, (2) `source_dir` detection, (3) experiment state for that spec's topic, (4) layer-gating rules (§1.5), (5) plan-template format, (6) project context (§3), (7) impact analysis instructions for L3 (§4). Subset of current plan.md §1-6.
- **Consolidator input:** Mini-plans arrive as sub-agent output strings. Must: renumber T-ids globally, merge `### doing-{spec}` sections, run cross-spec file conflict detection (§4.6 logic), apply model/effort routing (§5.5), produce Summary table.
- **T-number assignment order:** By spec priority (§5 output), then by task order within spec. Preserves invariant: lower T-numbers = higher priority.
- **Spec rename timing:** `doing-*` rename (plan.md §9) must happen after consolidation succeeds. If consolidation fails, specs stay unmodified.
- **Risk — sub-agent format drift:** Sub-agents may produce slightly different markdown. Consolidator must normalize against plan-template.md canonical format.
- **Existing tests:** `bin/wave-runner.test.js` and `bin/ratchet.test.js` already cover parser logic — no new test infrastructure needed, just verify they pass.
- **Conflict resolved:** `run_in_background=true` contradicts `explore-agent.md:5` pattern. Use parallel non-background spawning instead.
- **Consolidator replaces §5 reasoner:** The existing single Opus call in §5 (COMPARE & PRIORITIZE) is absorbed into the consolidator — no duplicate Opus invocations.
