# Spike: YAML Frontmatter Parsing Compatibility for `derives-from`

**Hypothesis**: Adding `derives-from: done-some-spec` in YAML frontmatter at the top of a spec `.md` file does NOT break `computeLayer` or `validateSpec`.

**Status**: PASS — no changes needed to `df-spec-lint.js`

---

## How `df-spec-lint.js` Parses Spec Files

File: `hooks/df-spec-lint.js`

The linter receives the raw file content as a string and operates entirely via line-by-line iteration. There are three key parsing paths:

### 1. `computeLayer(content)` — lines 45–79

Scans every line for the pattern `/^##\s+(.+)/i`. It only collects `##`-level headings. Lines that don't match are silently ignored.

A YAML frontmatter block looks like:
```
---
derives-from: done-auth
---
```

None of these lines match `/^##\s+/`. The `---` delimiters are plain dashes. The `derives-from: done-auth` line contains a colon but no `##` prefix. **All frontmatter lines pass through without any effect on `headersFound`.**

The `hasInlineAC` check uses `/\*AC[:.]/.test(content)` — a `derives-from:` value would only trigger this if it literally contained `*AC:`, which it never will.

### 2. `validateSpec(content, opts)` — lines 89–237

Re-runs the same `##` heading scan (lines 99–106) to populate `headersFound`. Same conclusion: frontmatter lines are invisible to this scan.

Additional checks that could be affected:
- **REQ-N identifier check** (line 138): uses `extractSection` to find the `Requirements` section, then tests for `/REQ-\d+/`. A `derives-from:` frontmatter line does not match `REQ-\d+`, so no false positive.
- **Duplicate REQ-N check** (lines 164–173): regex `/\*{0,2}(REQ-\d+[a-z]?)\*{0,2}\s*(?:[:\u2014]|—)/g` requires a `REQ-N` prefix. `derives-from:` doesn't match.
- **Line count advisory** (line 178–181): adds 3 lines (two `---` + one key-value). A spec already near 200 lines could tip over, but this is an advisory-only warning, never a hard fail.
- **Dependencies section check** (lines 214–229): looks for `depends_on:` inside a `## Dependencies` section. Frontmatter `derives-from:` is outside any `##` section capture window, so it is never passed to `extractSection`. No false match.

### 3. `extractSection(content, sectionName)` — lines 243–272

Walks lines top-to-bottom. `capturing` is only set `true` when a `##` header matching the target section name is found. Lines before the first matching `##` header (i.e., the frontmatter block) are silently skipped because `capturing` starts as `false`.

---

## Mental Test: Spec With Frontmatter

Given this file content:

```markdown
---
derives-from: done-auth
---
# My Spec Title

## Objective
Fix the auth flow.

## Requirements
- REQ-1: Something

## Acceptance Criteria
- [ ] AC-1: It works
```

Walkthrough of `computeLayer`:
1. Line `---` → no `##` match → skip
2. Line `derives-from: done-auth` → no `##` match → skip
3. Line `---` → no `##` match → skip
4. Line `# My Spec Title` → `#` not `##` → skip
5. Line `## Objective` → match → `headersFound = ['objective']`
6. Line `## Requirements` → match → `headersFound = ['objective', 'requirements']`
7. Line `## Acceptance Criteria` → match → `headersFound = [..., 'acceptance criteria']`

Result: L2 (Objective + Requirements + Acceptance Criteria all present). Correct, no interference.

---

## Conclusion

**`derives-from` frontmatter is fully compatible with both `computeLayer` and `validateSpec` as-is.**

The linter is pattern-blind to everything that isn't a `## heading` line or a specific content pattern. YAML frontmatter lines are invisible to all parsing paths.

**No changes required to `hooks/df-spec-lint.js` for T14.**

---

## Recommendation for T14

T14 can safely add `derives-from: done-{name}` to the top of any spec file without modifying the linter. The implementation should:

1. Write frontmatter with a `---` block at the very top of the spec file.
2. Place `derives-from: {parent-spec-name}` as a key inside the block.
3. No linter changes needed — it already ignores non-`##` lines at the file top.

The only caveat: frontmatter adds ~3 lines to line count. If a spec is at 198+ lines, the advisory "Spec exceeds 200 lines" warning may fire. This is advisory-only and does not affect the health gate.

---

## Code References

| Location | Line | Relevance |
|---|---|---|
| `hooks/df-spec-lint.js` | 47–53 | `computeLayer` header scan — only matches `##` prefix |
| `hooks/df-spec-lint.js` | 99–106 | `validateSpec` header scan — same pattern, same safety |
| `hooks/df-spec-lint.js` | 254–268 | `extractSection` — only captures after a `##` match, frontmatter is pre-capture |
| `hooks/df-spec-lint.js` | 178–181 | Line count advisory — only risk; advisory only, not a hard fail |
