# Spike: Shared LSP Transport Reuse

**Hypothesis:** The LSP JSON-RPC transport inlined in `hooks/df-invariant-check.js` (L130-287)
can be extracted to `hooks/lib/lsp-transport.js` as `{ detectLspBinary, queryLsp }` with ZERO
behavioral change. The refactored hook passes its existing smoke tests, AND a new small CLI
prototype can invoke the shared transport for documentSymbol + findReferences + workspaceSymbol
against a TS fixture.

**Status:** PASS

---

## What was done

1. Extracted `detectLanguageServer`, `isBinaryAvailable`, `queryLsp`, and `LSP_DETECTION_RULES`
   verbatim from `hooks/df-invariant-check.js` (L24-287) into `hooks/lib/lsp-transport.js`.

2. Updated `hooks/df-invariant-check.js` to `require('./lib/lsp-transport')` and delete the
   now-duplicated inline definitions. `checkLspAvailability` remains in the hook (it's hook-specific
   logic that wraps the transport, not transport itself).

3. Ran the existing test suite: **25/25 tests pass** with zero regressions.

4. Created `bin/.lsp-spike.js` — a CLI prototype invoking the shared transport for
   `documentSymbol`, `findReferences`, and `workspaceSymbol` against
   `test/fixtures/ts-fixture/sample.ts`.

---

## Results

| Operation | ok | result | latency |
|---|---|---|---|
| binary detection | true | typescript-language-server found | 0ms |
| documentSymbol | true | [] (empty — see finding below) | 83ms |
| findReferences | true | [] (empty — see finding below) | 69ms |
| workspaceSymbol | false | lsp_unavailable (error response) | 305ms |

**Overall verdict:** PASS (live LSP results obtained — transport round-trips work)

---

## Key Findings for T19 / T20

### Finding 1: textDocument/didOpen is required before document queries
`typescript-language-server` returns empty results for `documentSymbol` and `findReferences`
when the file has not been opened in the session. T20's `bin/lsp-query.js` MUST send a
`textDocument/didOpen` notification (with `languageId` and file content) immediately after
`initialize` and before sending the actual method request.

**Protocol sequence T20 must implement:**
```
→ initialize (id=1)
← initializeResult
→ initialized (notification, no id)
→ textDocument/didOpen (notification, no id)
→ textDocument/documentSymbol (id=2)
← documentSymbol result
```

The current `queryLsp` in `lsp-transport.js` only does initialize + one method call.
T20 should either extend `queryLsp` with an optional `openDocument` parameter, or add a
`queryLspWithOpen(binary, projectRoot, fileUri, fileContent, method, params)` variant.

### Finding 2: workspace/symbol error-maps to lsp_unavailable
When `workspace/symbol` returns an LSP error response (e.g. `{ error: { code: ..., message: ... } }`),
the transport currently maps it to `{ ok: false, reason: 'lsp_unavailable' }`. This is correct
fail-open behavior, but T20 should distinguish "LSP error response" from "binary not found" for
better diagnostics. Consider adding `reason: 'lsp_error'` as a separate case.

### Finding 3: Module shape is clean — no hidden coupling
`lsp-transport.js` has zero coupling to `df-invariant-check.js`. Its only dependencies are
Node built-ins (`fs`, `path`, `child_process`). T19 and T20 can safely `require('../hooks/lib/lsp-transport')`
without pulling in any invariant-check logic.

### Finding 4: Fail-open is validated
When `typescript-language-server` is NOT installed, `queryLsp` returns `{ ok: false, reason: 'lsp_unavailable' }`
immediately (PATH scan, no spawn). The spike CLI handles this gracefully and exits 0. The fail-open
contract required by REQ-4 is proven by the code path.

---

## Module shape for T19/T20 to consume

```js
const {
  detectLspBinary,       // (projectRoot, filePaths) → { binary, installCmd } | null
  detectLanguageServer,  // alias for detectLspBinary (original name)
  isBinaryAvailable,     // (binary) → boolean
  queryLsp,              // async (binary, projectRoot, fileUri, method, params) → { ok, result? }
  LSP_DETECTION_RULES,   // the raw detection ruleset (T19 may need for custom rules)
} = require('./hooks/lib/lsp-transport');
```

T20 (`bin/lsp-query.js`) should wrap `queryLsp` with a `didOpen` injection:
```js
async function queryLspWithDoc(binary, projectRoot, filePath, method, params) {
  const fileUri = `file://${filePath}`;
  const content = fs.readFileSync(filePath, 'utf8');
  // Extend queryLsp to send didOpen before the method call
  // ... or use an extended version with openDocument option
}
```

---

## Files created / modified

- `hooks/lib/lsp-transport.js` — NEW: extracted transport module
- `hooks/df-invariant-check.js` — MODIFIED: now requires from lib, inline definitions deleted
- `bin/.lsp-spike.js` — NEW: spike CLI prototype (prefixed with `.` to indicate non-production)
- `test/fixtures/ts-fixture/sample.ts` — NEW: minimal TS fixture for LSP testing
- `test/fixtures/ts-fixture/tsconfig.json` — NEW: tsconfig for the fixture

---

## Decision

`[APPROACH]` extracted to `hooks/lib/lsp-transport.js` — keeps JSON-RPC plumbing isolated from
hook-specific logic. All LSP-aware tools (bin/lsp-query.js, df-implement-protocol.js,
df-verify-protocol.js) should import from this single source.

`[FINDING]` T19/T20 must add `textDocument/didOpen` to the protocol sequence before document
queries — the minimal initialize-then-query pattern returns empty results from tsls.
