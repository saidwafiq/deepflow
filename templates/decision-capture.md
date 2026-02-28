# Decision Capture — Shared Pattern

## Common Flow
Extract up to 4 candidates → `AskUserQuestion(multiSelect: true)` → append confirmed to `.deepflow/decisions.md`.
Each option: `label: "[TAG] <decision>"`, `description: "<rationale>"`. Tags: `[APPROACH]` `[PROVISIONAL]` `[ASSUMPTION]`.
Format: `### {YYYY-MM-DD} — {command}` / `- [TAG] decision text — rationale`

## Variant: default
Used by: discover, debate, spec, plan, note.
Append confirmed decisions to `.deepflow/decisions.md` (create if missing). Max 4 candidates.
If a decision contradicts a prior entry, note conflict inline; never delete prior entries.

## Variant: main-tree
Used by: execute.
Same as default but write to **main tree** `.deepflow/decisions.md` (repo root, parent of `.deepflow/worktrees/`), not the worktree path.

## Variant: success-path-only
Used by: verify.
Same as default but **only run this step when verification passes**. Skip entirely on failure.
