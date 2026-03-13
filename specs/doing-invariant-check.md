# Invariant Check

## Objective

Detect when AI agents silently reduce scope during execution by running mechanical, LSP-powered checks against spec requirements at both per-commit (ratchet) and cumulative (verify) stages.

## Requirements

- **REQ-1 — Mock detection**: Scan non-test production files in the diff for mock usage patterns (`jest.fn()`, `vi.fn()`, `sinon.stub()`, `= mock(`, `jest.mock(`, `vi.mock(`, `sinon.mock(`, `jest.spyOn(`, `createMock(`, `mockImplementation(`). Use LSP `findReferences` + `documentSymbol` to confirm call sites are mock factory invocations, not identifier name matches. Hard fail always. Bootstrap tasks exempt (mocks in test files allowed regardless of task type).

- **REQ-2 — REQ coverage**: For every `REQ-N` in the active spec, verify at least one test file references that identifier (string match in describe/it/test block or comment). Each such test must contain >=2 `expect`/`assert`/`assert_eq`/`assertEqual` calls, counted via LSP `documentSymbol`. Hard fail when any REQ-N has zero test references.

- **REQ-3 — Hardcoded detection**: Parse spec for requirements containing "configurable" or "dynamic" (case-insensitive). For those REQ-Ns, scan the diff for new numeric/string literals assigned to module-level constants or returned directly. Use LSP `hover` to confirm the symbol is a constant, not an enum or type. Advisory in interactive mode, hard in auto mode.

- **REQ-4 — Cumulative cross-file checks (L5)**: Run after L0-L4 in verify.md. Four sub-checks:
  - **REQ-4a**: Mock covering implementation gap — test file mocks module X, but module X has no non-test changes in the total diff.
  - **REQ-4b**: REQ only in tests — REQ-N appears in test files but never in production source.
  - **REQ-4c**: Phantom imports — file imports a module added in the diff that exports zero non-stub symbols (LSP `documentSymbol` returns only empty bodies or stub returns).
  - **REQ-4d**: Edit scope coverage — every file/glob declared in spec `edit_scope` was touched in the total diff.

- **REQ-5 — LSP integration**: Auto-start the appropriate language server based on project files. If LSP is unavailable or fails to start, emit hard failure instructing user to install. No regex fallback, no silent degradation.

- **REQ-6 — Architecture**: Create a new file `hooks/df-invariant-check.js` exporting `checkInvariants(diff, specContent, opts)`. Same dual-mode: callable as module, runnable via CLI (`node df-invariant-check.js --invariants <spec> <diff-file>`). Same `{ hard: [], advisory: [] }` return shape. Import and reuse `extractSection()` from `df-spec-lint.js`.

- **REQ-7 — Output format**: Emit `file:line: [TAG] description` where TAG is `MOCK`, `MISSING_TEST`, `HARDCODED`, `STUB`, `PHANTOM`, `SCOPE_GAP`. Failures only. Cap at 15 lines; if more, append `... and N more invariant violations`.

- **REQ-8 — Task-type awareness**: Read task type from orchestrator context (bootstrap/spike/implementation). Bootstrap: mock detection skipped for test files. Spike: mock detection applies to production files. Implementation: all checks enforced.

- **REQ-9 — Escalation**: Auto mode promotes all advisory to hard failures (same `advisory.splice` pattern as existing `validateSpec`). Interactive mode: advisory warns but does not block.

## Constraints

- `checkInvariants()` goes in a new separate file (`hooks/df-invariant-check.js`), NOT in `df-spec-lint.js`; it may import/reuse `extractSection` from `df-spec-lint.js`
- No LLM for any classification or judgment
- LSP is the only code analysis backend; no AST parser libraries added
- Per-commit checks must complete in <30s for a typical 10-file diff
- No allowlist or escape valve

## Out of Scope

- Assertion quality analysis (content of assertions not evaluated)
- Runtime behavior verification (static analysis only)
- Languages without a supported LSP server
- Automatic fix or rewrite of violations
- Changes to verify.md or execute.md prose (integration is prompt-level)

## Acceptance Criteria

- [ ] `checkInvariants()` exported from `hooks/df-invariant-check.js`, callable with `(diff, specContent, { mode, taskType })` (REQ-6)
- [ ] CLI mode `--invariants <spec> <diff-file>` exits non-zero on hard failures (REQ-6)
- [ ] Mock usage patterns in non-test files produce `[MOCK]` hard failure (REQ-1)
- [ ] Bootstrap task type suppresses mock detection in test files (REQ-1, REQ-8)
- [ ] Every REQ-N in spec has test reference with >=2 assertions, else `[MISSING_TEST]` (REQ-2)
- [ ] "configurable"/"dynamic" requirements with new literals produce `[HARDCODED]` advisory (REQ-3)
- [ ] L5 detects mock covering implementation gap (REQ-4a)
- [ ] L5 detects REQ only in tests, never in production source (REQ-4b)
- [ ] L5 detects phantom imports with empty/stub exports (REQ-4c)
- [ ] L5 detects edit_scope files not touched in diff (REQ-4d)
- [ ] Missing LSP produces hard failure with install instructions (REQ-5)
- [ ] Output is `file:line: [TAG] description`, max 15 lines with truncation (REQ-7)
- [ ] Auto mode escalates advisory to hard (REQ-9)

## Technical Notes

- `extractSection(content, 'Requirements')` already parses requirements; reuse for REQ-3 keyword scan
- LSP operations: `documentSymbol` (structure), `findReferences` (usage), `hover` (type info)
- Ratchet insertion: execute.md section 5.5, after lint, before edit-scope validation
- L5 insertion: verify.md section 2, after L4, before report generation
- Diff input: `git diff HEAD~1` (per-commit) or `git diff main...HEAD` (cumulative L5)
- `checkInvariants` must return `{ hard, advisory }` for orchestrator compatibility

## Decisions

- [APPROACH] LSP as hard dependency — spike validated 18ms latency, no fallback needed
- [APPROACH] Separate file (hooks/df-invariant-check.js) — debate consensus, keeps df-spec-lint.js focused
- [APPROACH] No escape hatch or allowlist — violations must be fixed, not suppressed
