---
name: df-ac-coverage
description: Tag tests with AC references so /df:verify L3 can confirm every spec AC is exercised by at least one test
---

# AC Test Tagging

`/df:verify` L3 is a lint, not a self-report. It checks that every AC in a spec is referenced by at least one test file (or explicitly marked `[advisory]`). Whether the test passes is L4's job — L3 only checks the tag exists.

## Format

In any test file (test name, comment, JSDoc, string literal — anywhere in the file), include the literal string:

```
specs/<slug>.md#AC-<n>
```

Where `<slug>` is the spec basename without the `doing-`/`done-` prefix and `.md` suffix.

## Examples

```js
// covers specs/upload.md#AC-1
test('rejects non-image MIME types', () => { /* ... */ });

/**
 * @covers specs/upload.md#AC-3
 */
function helper() {}

test('specs/upload.md#AC-5: error boundary catches render failures', () => {});
```

All three are valid — the regex looks for the literal `specs/<slug>.md#AC-N` substring anywhere in the file.

## Advisory ACs

Some ACs cannot be machine-verified (e.g. "code is readable" or "comments explain rationale"). Mark these in the spec by adding `[advisory]` to the AC bullet:

```
- [ ] **AC-7** — [advisory] WHEN reviewers read the diff THEN the rationale comments SHALL be clear.
```

L3 skips advisory ACs.

## Validation

`hooks/ac-coverage.js` (CLI mode) is invoked by `/df:verify` L3:

```sh
node "${HOME}/.claude/hooks/ac-coverage.js" --spec {spec_path} --snapshot .deepflow/auto-snapshot.txt --status pass
```

It also runs as a PostToolUse hook on `git commit` to catch drift mid-flight. Exit 2 with `OVERRIDE:SALVAGEABLE` lists untagged non-advisory ACs.

## What this replaces

Earlier versions asked agents to emit `AC_COVERAGE: … AC_COVERAGE_END` blocks in their output, which `execute.md` parsed into `.deepflow/results/T<n>.yaml` for L3 to read back. That was the agent grading itself — no real signal. This skill replaces the entire self-report path with a simple test-tag presence check.
