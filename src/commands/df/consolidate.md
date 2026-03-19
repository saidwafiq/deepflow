---
name: df:consolidate
description: Remove duplicates and superseded entries from decisions file, promote stale provisionals
---

# /df:consolidate — Consolidate Decisions

Remove duplicates, superseded entries, and promote stale provisionals. Keep decisions.md dense and useful.

**NEVER:** use EnterPlanMode, ExitPlanMode

## Behavior

### 1. LOAD
Read `.deepflow/decisions.md` via `` !`cat .deepflow/decisions.md 2>/dev/null || echo 'NOT_FOUND'` ``. If missing/empty, report and exit.

### 2. ANALYZE (model-driven, not regex)
- Identify duplicates (same meaning, different wording)
- Identify superseded entries (later contradicts earlier)
- Identify stale `[PROVISIONAL]` entries (>30 days old, no resolution)

### 3. CONSOLIDATE
- Remove duplicates (keep more precise wording)
- Remove superseded entries (later decision wins)
- Promote stale `[PROVISIONAL]` → `[DEBT]`
- Preserve `[APPROACH]` unless superseded, `[ASSUMPTION]` unless invalidated
- Target: 200-500 lines if currently longer
- When in doubt, keep both entries (conservative)

### 4. WRITE
- Rewrite `.deepflow/decisions.md` with consolidated content
- Write `{ "last_consolidated": "{ISO-8601}" }` to `.deepflow/last-consolidated.json`

### 5. REPORT
`✓ Consolidated: {before} → {after} lines, {n} removed, {n} promoted to [DEBT]`

## Rules

- Conservative: when in doubt, keep both entries
- Never add new decisions — only remove, merge, or re-tag
- `[DEBT]` is only produced by consolidation, never manually assigned
- Preserve chronological ordering within sections
