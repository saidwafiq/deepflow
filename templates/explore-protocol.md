# Search Protocol — MANDATORY

## STEP 1: Your first message MUST start with these LSP calls (parallel):

```
LSP(operation="workspaceSymbol", filePath="{any_file}", line=1, character=1)
LSP(operation="documentSymbol", filePath="{most_likely_file}", line=1, character=1)
LSP(operation="findReferences", filePath="{known_symbol_file}", line={symbol_line}, character={symbol_char})
Grep(pattern="...", path="...")
Glob(pattern="**/*keyword*")
```

Replace placeholders with values relevant to the search query. Launch ALL in parallel (one message, 5-8 calls).

If LSP returns errors or empty, ignore and use Grep/Glob results.

## STEP 2: CONVERGE on matches

- `LSP(operation="findReferences", ...)` on key symbols to trace usage
- `LSP(operation="documentSymbol", ...)` on matched files for line ranges
- `Read(offset=N, limit=M)` for only the relevant range — NEVER read full files

## STEP 3: EARLY STOP

Stop as soon as >= 2 relevant files answer the question.

---

Antipattern — NEVER do this:
```
Turn 1: Glob → Turn 2: Read full file → Turn 3: Grep → Turn 4: Read → Turn 5: Grep
```

Fallback: search `node_modules/`/`vendor/` ONLY when not found in app code.

---

## OUTPUT FORMAT — your ENTIRE response MUST be ONLY these lines:

```
filepath:startLine-endLine -- why relevant
```

Nothing else. No narration. No headers. No tables. No explanations. Max 500 tokens.
