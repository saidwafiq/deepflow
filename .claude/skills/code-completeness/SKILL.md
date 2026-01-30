---
name: code-completeness
description: Finds incomplete code in codebase. Use when analyzing for TODOs, stubs, placeholders, skipped tests, or missing implementations. Helps compare specs against actual code state.
---

# Code Completeness

Find incomplete work in codebase.

## Explicit Markers

| Pattern | Meaning |
|---------|---------|
| `TODO` | Planned, not done |
| `FIXME` | Known broken |
| `HACK` | Temporary workaround |
| `XXX` | Needs attention |

## Implicit Incompleteness

| Pattern | Example |
|---------|---------|
| Stub return | `return null`, `return []` |
| Not implemented | `throw new Error('not implemented')` |
| Empty body | `function foo() {}` |
| Hardcoded | `return "test"`, `return 42` |

## Test Markers

| Pattern | Language |
|---------|----------|
| `it.skip`, `test.skip` | JavaScript |
| `describe.skip` | JavaScript |
| `@pytest.mark.skip` | Python |
| `t.Skip()` | Go |

## Classification

| Status | Criteria | Action |
|--------|----------|--------|
| **DONE** | Fully implemented | None |
| **PARTIAL** | Has TODO/stub | Task to complete |
| **MISSING** | Not in codebase | Task to create |
| **CONFLICT** | Contradicts spec | Flag for review |

## Report Format

```
REQ-1: {requirement}
Status: PARTIAL
Found: src/api/upload.ts:45 — `// TODO: validation`
Action: Complete validation

REQ-2: {requirement}
Status: MISSING
Action: Create src/services/storage.ts
```

## Rules

- Search before assuming missing
- Check test files too
- Note file:line for findings
