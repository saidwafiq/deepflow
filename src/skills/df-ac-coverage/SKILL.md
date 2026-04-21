---
name: df-ac-coverage
description: Encapsulates AC_COVERAGE block format for reporting acceptance criteria coverage in task outputs
---

# AC_COVERAGE Block Format

Acceptance Criteria (AC) coverage reporting standardizes how agents document which acceptance criteria from a spec have been satisfied by their implementation.

## Format

```
AC_COVERAGE:
AC-N:done
AC-N:done:covered by {detail} (specs/{slug}.md#AC-N)
AC-N:skip:{reason}
AC_COVERAGE_END
```

### Components

- **Opening marker:** `AC_COVERAGE:` (required, must appear on its own line)
- **Closing marker:** `AC_COVERAGE_END` (required, must appear on its own line)
- **Content lines:** One line per acceptance criterion, using one of three formats:
  - `AC-N:done` — criterion satisfied, minimal reporting
  - `AC-N:done:covered by {detail} (specs/{slug}.md#AC-N)` — criterion satisfied with evidence (test name, code section, or feature description)
  - `AC-N:skip:{reason}` — criterion intentionally skipped (e.g., deferred, out-of-scope, blocked by dependency)

### Rules

1. **One AC per line** — no wrapping or multi-line entries
2. **Sequential numbering** — AC-1, AC-2, AC-3, etc. (order matches spec)
3. **Completeness** — must include an entry for every AC in the spec
4. **No gaps** — if spec has AC-1 through AC-5, all five must be listed
5. **Evidence optional for `done`** — include `covered by` clause only if helpful; `AC-N:done` is valid
6. **Reason required for `skip`** — `AC-N:skip:{reason}` must explain why (e.g., "deferred to T2", "blocked by missing dependency", "out of scope")

## Example

Given a spec with 5 acceptance criteria:

```
AC_COVERAGE:
AC-1:done:covered by test_upload_validates_mimetype (specs/upload.md#AC-1)
AC-2:done
AC-3:done:covered by UserForm.tsx lines 42-68 (specs/upload.md#AC-3)
AC-4:skip:deferred to T5 pending auth refactor (specs/upload.md#AC-4)
AC-5:done:covered by ErrorBoundary integration (specs/upload.md#AC-5)
AC_COVERAGE_END
```

## Integration with Task Templates

- **When to include:** Every task targeting a spec with acceptance criteria
- **Placement:** Immediately before `DECISIONS:` line, which precedes `TASK_STATUS:` (see standard-task.md §9-16)
- **Validation:** execute.md §5.5.1 runs `ac-coverage.js` hook to verify all ACs are reported

## Acceptance Criteria Scope

An AC is "in scope" if it:
- Exists in the current spec being worked on (not a requirement from a dependent spec)
- Is not explicitly marked out-of-scope in the spec's "Out of Scope" section
- Has not been deferred via a `skip` in a prior task's AC_COVERAGE block (check `.deepflow/results/T{N}.yaml`)

If a prior task skipped an AC, your task may satisfy it (moving from `skip` to `done`) — this is expected behavior in iterative development.

## Automation

The `ac-coverage.js` hook (run via execute.md §5.5.1):
- Parses `AC_COVERAGE:` block from agent output
- Compares reported ACs against spec's acceptance criteria list
- Detects missed ACs (spec AC-N not in block, or block has unknown AC-M)
- On mismatch: logs summary, overrides status to SALVAGEABLE
- On pass: proceeds to decision extraction (§5.5.2)
