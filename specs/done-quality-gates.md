# Quality Gates Evolution

## Objective

Evolve deepflow's quality gates so that implementation agents produce working code — by enforcing existing mechanisms (bootstrap, invariant-check, worktree isolation), restructuring spike-to-implementation knowledge transfer, and adding independent test agents that validate each wave and the final spec.

## Requirements

- REQ-1: Bootstrap enforcement — when `auto-snapshot.txt` is empty (zero test files), `df:execute` MUST trigger the bootstrap agent (§1.7) before any implementation wave. Currently the code path exists but was skipped in practice.
- REQ-2: Bootstrap Opus retry — if bootstrap fails with the default model, retry once with `model="opus"` before halting. First attempt uses project config model; second uses Opus explicitly.
- REQ-3: Worktree guard hook — new PostToolUse hook that blocks `Write`/`Edit` tool calls targeting files on `main` branch when any `df/*` worktree branch exists. Must `exit(1)` to block the tool call. Allowlist: `.deepflow/` state files, `PLAN.md`, `specs/` renames.
- REQ-4: Spike handoff restructure — move spike results from END zone to START zone in the agent prompt template (execute.md §6). Change format from prose to structured YAML using existing `auto-memory.yaml` `spike_insights` + `probe_learnings` schema.
- REQ-5: Invariant-check hook enforcement — `df-invariant-check.js` must `exit(1)` on hard failures when invoked as a PostToolUse hook, not only when run as CLI. Add a hook-compatible entry point.
- REQ-6: Wave test agent — after each wave's implementation agents pass ratchet, spawn an Opus test agent (white box) to write unit tests for the wave's code. If tests fail, report failure reasons and re-spawn implementer with feedback. Max 3 total attempts (1 initial + 2 retries) before revert.
- REQ-7: Final test agent — after all waves complete and before merge, spawn an Opus test agent (black box) that receives ONLY the spec + exported interfaces (no implementation source). Writes integration tests against ACs. All must pass before merge. No retry — failure requires human review.
- REQ-8: Two-phase ratchet — `auto-snapshot.txt` re-generated after each wave test agent commits. Later waves must not break earlier waves' tests. Wave N+1 ratchet includes wave N test files.

## Constraints

- All hooks must be pure JS (no build step), matching existing hook conventions
- Wave and final test agents use `Agent(model="opus")` explicitly
- Worktree guard must not block `.deepflow/` state files, `PLAN.md`, or `specs/` operations on main
- Max 3 attempts per task (REQ-6) is firm to bound cost
- No changes to the ratchet mechanism itself — only snapshot timing changes (REQ-8)
- PostToolUse hooks registered globally in `~/.claude/settings.json` via `bin/install.js`

## Out of Scope

- Mutation testing (StrykerJS) — deferred until test baseline exists
- Parallelizing wave test agents across waves
- Dashboard/UI changes for new hook outputs
- Modifying `df-spec-lint.js` behavior
- Changes to `df:verify` levels — only `df:execute` changes

## Acceptance Criteria

- [ ] REQ-1 AC-1: Given a project with zero test files, `/df:execute` triggers bootstrap before wave 1
- [ ] REQ-1 AC-2: Bootstrap re-snapshots `auto-snapshot.txt` on success; subsequent tasks use updated snapshot
- [ ] REQ-2 AC-3: Bootstrap failure with default model triggers Opus retry; double failure halts with message
- [ ] REQ-3 AC-4: PostToolUse hook blocks `Write`/`Edit` to main-branch files when `df/*` worktree exists, exits 1
- [ ] REQ-3 AC-5: Worktree guard does not block `.deepflow/`, `PLAN.md`, or `specs/` operations (no false positives)
- [ ] REQ-4 AC-6: Agent prompt template shows spike data in START zone as structured YAML; END zone has no spike prose
- [ ] REQ-5 AC-7: `df-invariant-check.js` exits 1 on hard failures when called as hook (not just CLI)
- [ ] REQ-6 AC-8: After wave ratchet passes, Opus test agent spawns and writes unit tests
- [ ] REQ-6 AC-9: Test failures trigger implementer re-spawn with failure feedback; max 3 attempts then revert
- [ ] REQ-7 AC-10: After all waves, Opus black-box test agent spawns with spec + exports only (no implementation)
- [ ] REQ-7 AC-11: Final integration tests must all pass before merge proceeds; failure blocks merge
- [ ] REQ-8 AC-12: `auto-snapshot.txt` re-generated after each wave test agent commits; wave N+1 ratchet includes wave N tests

## Technical Notes

- Worktree guard hook must inspect `tool_name` (Write/Edit) and `tool_input.file_path`. Detection via `git branch --list 'df/*'` and `git rev-parse --abbrev-ref HEAD`. Register in `settings.json` PostToolUse array via `bin/install.js`.
- Invariant-check (line 1024+) only does `exit(1)` in `require.main === module` block. Need a separate hook entry point that reads stdin (PostToolUse payload), extracts diff from last commit, loads spec, calls `checkInvariants()`, and exits accordingly.
- Spike handoff: execute.md prompt template line ~195 has `Spike results: {winner learnings}` in END zone. Move to START zone between task description and ACs. Schema: `{hypothesis, outcome, edge_cases, insight}` from `auto-memory.yaml`.
- Wave/final ordering: wave impl -> wave test -> ratchet update -> next wave -> ... -> final test -> merge. Strict sequential dependency within `df:execute` orchestrator.
- Wave test agent prompt: "You are a QA engineer. Write unit tests for the following code changes. Use {test_framework}. Test behavioral correctness, not implementation details. Commit as test({spec}): wave-{N} unit tests."
- Final test agent prompt: "You are an independent QA. You have ONLY the spec and exported interfaces below. Write integration tests that verify each AC. You cannot read implementation files. Commit as test({spec}): integration tests."
- Two-phase snapshot resolves the circular dependency identified in the debate — wave test agent's tests are excluded from ratchet of the same wave but included in the next wave's ratchet.
