# orchestrator-v2

## Objective

Reduce execute.md context rot by extracting mechanical orchestration work into scripts (wave-runner.js, enhanced ratchet.js) and replacing the IMPL_DIFF push model with pull-via-Read.

## Requirements

- REQ-1: wave-runner.js parses PLAN.md, resolves the task DAG into waves, and outputs briefing text (not JSON) for LLM consumption
- REQ-2: wave-runner.js supports `--recalc --failed T{N}` to recompute waves after a task failure
- REQ-3: Wave test agent reads its own diff via Read tool instead of receiving IMPL_DIFF inline in the prompt (pull model replaces push model)
- REQ-4: ratchet.js updates PLAN.md on PASS: marks task `[x]` and appends commit hash
- REQ-5: Heavy git ops (diff, stash) run in a context-forked haiku subagent that returns a one-line summary to the orchestrator
- REQ-6: Parallel agents within a wave use `isolation: "worktree"` for intra-wave isolation; cherry-pick merge back before next wave starts
- REQ-7: File conflict detection prevents parallel agents from writing the same file within a wave

## Constraints

- wave-runner.js and ratchet.js are standalone Node scripts in `bin/` (consistent with existing ratchet.js pattern)
- wave-runner.js output is plain text, not structured data — LLMs consume it directly
- ratchet.js changes are additive (existing JSON output and exit code contract preserved)
- verify.md continues to own spec finalization (merge, rename, cleanup, decisions extraction) — no finalize.js
- No Haiku subagent for impact analysis in v1 (deferred)
- Must not break existing ratchet.js consumers (exit codes 0/1/2 unchanged)

## Out of Scope

- Haiku subagent for impact analysis (premature for v1)
- finalize.js script (verify.md already handles this)
- Cross-wave worktree isolation (wave 2 needs wave 1 commits)
- Subjective UX legibility metric (not machine-testable; tracked as advisory only)

## Acceptance Criteria

<!-- REQ-1: wave-runner.js DAG resolution -->
- [ ] AC-1 (REQ-1): `node bin/wave-runner.js` given a PLAN.md with tasks and dependencies outputs text containing wave numbers and task assignments; exit 0
- [ ] AC-2 (REQ-1): wave-runner.js output includes all `[ ]` tasks from PLAN.md grouped by wave; no task appears before its blocking dependency's wave

<!-- REQ-2: wave-runner.js recalc -->
- [ ] AC-3 (REQ-2): `node bin/wave-runner.js --recalc --failed T3` recomputes waves excluding T3's dependents from ready status; exit 0

<!-- REQ-3: IMPL_DIFF push→pull -->
- [ ] AC-4 (REQ-3): execute.md wave test prompt references `Read tool` for diff retrieval; no inline `IMPL_DIFF` variable is built or injected into the prompt

<!-- REQ-4: ratchet.js PLAN.md update -->
- [ ] AC-5 (REQ-4): After ratchet PASS (exit 0), the task's line in PLAN.md changes from `[ ]` to `[x]` and contains a 7-char commit hash
- [ ] AC-6 (REQ-4): ratchet.js still outputs JSON with `result` field and uses exit codes 0/1/2 (backward compatible)

<!-- REQ-5: context-fork for git ops -->
- [ ] AC-7 (REQ-5): execute.md spawns a context-forked haiku agent for git diff/stash operations; orchestrator receives a one-line summary (not raw diff output)

<!-- REQ-6: intra-wave worktree isolation -->
- [ ] AC-8 (REQ-6): execute.md uses `isolation: "worktree"` for intra-wave parallel agents
- [ ] AC-9 (REQ-6): execute.md cherry-picks intra-wave agent commits back to shared worktree before next wave begins

<!-- REQ-7: file conflict detection -->
- [ ] AC-10 (REQ-7): execute.md checks `Files:` lists for overlap before spawning parallel agents; overlapping tasks log a deferral message matching pattern `deferred.*file conflict`

## Technical Notes

- **wave-runner.js**: New file at `bin/wave-runner.js`. Follow ratchet.js patterns: `#!/usr/bin/env node`, read PLAN.md via fs, parse `- [ ] T{N}:` lines and `Blocked by: T{N}` annotations, topological sort into waves. Accept `--plan` path arg (default `PLAN.md`). The `--recalc --failed` flag marks specified tasks as stuck and excludes their transitive dependents.
- **ratchet.js enhancement**: After the PASS path, add PLAN.md update logic. Requires `--task` flag to know which task line to mark. When `--task` is not provided, skip PLAN.md update (backward compat). Get commit hash via `git rev-parse --short HEAD`.
- **execute.md changes**: (1) Replace `IMPL_DIFF` construction with instruction for wave test agent to `Read` the diff itself using `git diff HEAD~1`. (2) Add `isolation: "worktree"` to Agent() calls for intra-wave tasks. (3) Add cherry-pick merge step between waves. (4) Replace direct git diff/stash calls with haiku subagent fork (context-fork pattern from browse-fetch skill).
- **install.js**: wave-runner.js needs to be added to the bin files distributed by the installer (same pattern as ratchet.js).
- **Advisory metric** (not an AC): context consumption per wave target <5% (current ~15-20%). Track manually during validation.
