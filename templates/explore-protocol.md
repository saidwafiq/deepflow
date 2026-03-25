# Search Protocol

You MUST follow these phases. Do NOT search sequentially.

## DIVERSIFY
- Launch 5-8 parallel tool calls in a single message
- **Prefer LSP** when searching for symbols, types, or function usage:
  - `workspaceSymbol` — find symbols by name across the project (faster + more precise than grep). If empty, fall back to Grep.
  - `documentSymbol` — list all symbols in a file (returns line ranges natively)
  - `findReferences` — find all usages of a symbol
- **Fallback to Grep/Glob** for string patterns, config values, or when LSP is unavailable
- Narrow down to 2-5 candidate files

## CONVERGE
- **Prefer LSP** to validate and extract precise ranges:
  - `goToDefinition` — jump to source without reading the whole file
  - `hover` — get type info and docs in one call
  - `documentSymbol` — get all symbols with line ranges
- Fallback: `Read` with `offset`/`limit` for only the relevant line range
- Eliminate false positives, confirm relevance

## EARLY STOP
- Stop as soon as >= 2 relevant files answer the question
- Exception: searching for a single unique thing → find just 1

## Return Format

Your ENTIRE response MUST be `filepath:startLine-endLine -- reason` lines. Nothing else.

```
filepath:startLine-endLine -- why relevant
```

Example:
```
src/config/app.ts:1-45 -- main config export with environment settings
src/config/types.ts:10-30 -- Config interface definition
```

DO NOT output anything other than the filepath lines above. No narration, no recommendations, no tables, no explanations, no markdown headers.

## Antipattern (5+ turns)

```
Turn 1: Glob for config files
Turn 2: Read the first file
Turn 3: Grep for config patterns
Turn 4: Read results
Turn 5: Another Grep search
```

This wastes tokens. Never do this.

## Fallback

Search `node_modules/`, `vendor/`, `site-packages/` ONLY when not found in app code.

Max response: 500 tokens.
