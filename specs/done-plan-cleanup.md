# Plan Cleanup

## Objective
Keep PLAN.md lean by removing completed spec sections after successful verification, instead of accumulating done tasks indefinitely.

## Requirements
- REQ-1: `/df:verify` must delete the verified spec's entire section (header through last task/metadata) from PLAN.md after successful merge
- REQ-2: `/df:verify` must recalculate the Summary table after removing the section; if no spec sections remain, delete PLAN.md entirely
- REQ-3: `/df:plan` step 8 safety net must be preserved unchanged (catches stale done-* sections from interrupted verifications)
- REQ-4: `/df:execute` step 8.2 must be reworded — verify owns PLAN.md cleanup, not execute

## Constraints
- Changes limited to `src/commands/df/verify.md` and `src/commands/df/execute.md` (markdown only)
- No archiving — git history is sufficient
- Cleanup must be idempotent (skip silently if PLAN.md missing or section already gone)

## Out of Scope
- Archiving completed sections to separate files
- Changing `/df:plan` step 8 behavior
- Modifying PLAN.md structure or task format
- Any build/test/hook changes

## Acceptance Criteria
- [x] AC-1: `verify.md` post-verification section includes a step that removes the spec's `### {name}` section from PLAN.md
- [x] AC-2: The removal step specifies: find the `### {spec-name}` header, delete through the line before the next `###` header (or EOF)
- [x] AC-3: After section removal, verify recalculates the Summary table (recount specs and tasks)
- [x] AC-4: If no spec sections remain after removal, PLAN.md is deleted entirely
- [x] AC-5: `plan.md` step 8 text is unchanged
- [x] AC-6: `execute.md` step 8.2 no longer claims ownership of PLAN.md section removal

## Technical Notes
- Verify post-verification flow currently has 5 steps (discover worktree, merge, cleanup worktree, rename spec, extract decisions). PLAN.md cleanup fits as step 6 after extract decisions.
- Section matching: PLAN.md uses `### doing-{name}` or `### done-{name}` headers. Match on the spec name stem (strip `doing-`/`done-` prefix).
- Summary recalculation: count remaining `### ` headers for spec count, count `- [ ]` and `- [x]` for task counts.
- Dual ownership conflict: `execute.md:380` says "Remove spec's ENTIRE section from PLAN.md" — must be reworded to defer to verify (AC-6).
