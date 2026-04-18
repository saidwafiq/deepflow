# kanban-regex — determinism — pass

**Hypothesis:** Two pure regex functions (`columnOf`, `subStateOf`) can deterministically map spec filenames and content markers to kanban column/sub-state with no ambiguity on all representative edge cases.

**Result:** PASS — 22/22 fixtures green. Script: `kanban-regex--determinism--spike.js`

---

## Proposed Regexes for T11

### columnOf(filePath)
```js
function columnOf(filePath) {
  const base = filePath.split('/').pop(); // basename only
  if (/^done-/.test(base))  return 'done';
  if (/^doing-/.test(base)) return 'doing';
  return 'backlog';
}
```

### subStateOf(content)
```js
const SUB_STATE_RE = /<!--\s*sub_state:\s*(doing|waiting)\s*-->/i;

function subStateOf(content) {
  const m = SUB_STATE_RE.exec(content);
  return m ? m[1].toLowerCase() : null;
}
```

---

## Fixture Table

### columnOf

| Input path                              | Expected  | Actual   | OK  |
|-----------------------------------------|-----------|----------|-----|
| `specs/foo.md`                          | backlog   | backlog  | ✓   |
| `specs/doing-foo.md`                    | doing     | doing    | ✓   |
| `specs/done-foo.md`                     | done      | done     | ✓   |
| `specs/doing-foo-bar-baz.md`            | doing     | doing    | ✓   |
| `specs/done-my-feature--v2.md`          | done      | done     | ✓   |
| `.deepflow/specs-done/old-spec.md`      | backlog   | backlog  | ✓   |
| `specs/doingfoo.md`                     | backlog   | backlog  | ✓   |
| `specs/done.md`                         | backlog   | backlog  | ✓   |
| `doing-foo.md`                          | doing     | doing    | ✓   |
| `a/b/c/done-nested.md`                  | done      | done     | ✓   |

### subStateOf

| Input (truncated)                             | Expected   | OK  |
|-----------------------------------------------|------------|-----|
| `<!-- sub_state: doing -->`                   | "doing"    | ✓   |
| `<!-- sub_state: waiting -->`                 | "waiting"  | ✓   |
| `<!--sub_state:doing-->`                      | "doing"    | ✓   |
| `<!--  sub_state:  waiting  -->`              | "waiting"  | ✓   |
| `<!-- SUB_STATE: DOING -->` (uppercase)       | "doing"    | ✓   |
| inline in surrounding text                    | "waiting"  | ✓   |
| no marker                                     | null       | ✓   |
| `<!-- sub_state: unknown -->`                 | null       | ✓   |
| `<!-- kanban:sub_state=doing -->` (old draft) | null       | ✓   |
| two markers (first wins)                      | "waiting"  | ✓   |
| `<!-- sub_state doing -->` (no colon)         | null       | ✓   |
| `<!-- sub_state: -->` (empty value)           | null       | ✓   |

---

## Edge-Case Decisions

1. **`.deepflow/specs-done/` archived files**: `columnOf` operates on basename only. The directory name `specs-done` does not influence the result — the basename has no `done-` prefix, so it maps to `backlog`. T11 must handle archiving as a separate transition event if needed (out of scope for basic column detection).

2. **Multiple sub-state markers**: `RegExp.exec` stops at first match; first marker wins. This is deterministic and mirrors spec intent ("scanned on first match").

3. **`done.md` / `doing.md` (bare prefix with no hyphen)**: Return `backlog`. The prefix pattern requires a trailing hyphen (`/^done-/`, `/^doing-/`), so bare names without a slug component are treated as plain backlog specs. This prevents false positives.

4. **`kanban:sub_state=X` format** (seen in task prompt): This is **not** the canonical marker format. AC-2 and Technical Notes both specify `<!-- sub_state: (doing|waiting) -->`. Old draft variant correctly yields `null`.

5. **Case insensitivity for sub-state**: The `i` flag is applied so `<!-- SUB_STATE: DOING -->` is accepted. Output is always lowercased via `.toLowerCase()`.

---

DECISIONS:
- APPROACH: `columnOf` uses basename-only matching via `.split('/').pop()` — avoids false positives from directory names like `specs-done/`.
- APPROACH: `subStateOf` restricts allowed values to `(doing|waiting)` in the regex capture group — unknown values like `blocked` or `review` yield null rather than leaking unsupported states.
- PROVISIONAL: Archived specs (`.deepflow/specs-done/`) map to `backlog` column by basename logic; T11 may need a fourth column `archived` if the hook compares directory paths explicitly.
- ASSUMPTION: `<!-- sub_state: ... -->` is the canonical marker format per AC-2 and Technical Notes line 40; the `kanban:sub_state=X` form seen in the task prompt is an outdated draft and is intentionally excluded.
