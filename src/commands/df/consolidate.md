# /df:consolidate — Consolidate Decisions

## Purpose
Remove duplicates, superseded entries, and promote stale provisionals. Keep decisions.md dense and useful.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Usage
```
/df:consolidate          # Consolidate decisions.md
```

## Behavior

### 1. LOAD
Read `.deepflow/decisions.md`. If missing or empty, report and exit.

### 2. ANALYZE
Model-driven analysis (not regex):
- Identify duplicate decisions (same meaning, different wording)
- Identify superseded decisions (later entry contradicts earlier)
- Identify stale `[PROVISIONAL]` entries (>30 days old, no resolution)

### 3. CONSOLIDATE
- Remove duplicates (keep the more precise wording)
- Silently remove superseded entries (the later decision wins)
- Promote stale `[PROVISIONAL]` to `[DEBT]` (needs revisiting)
- Preserve all `[APPROACH]` entries unless superseded
- Preserve all `[ASSUMPTION]` entries unless invalidated
- Target: 200-500 lines (if currently longer)
- When in doubt, keep both entries (conservative)

### 4. WRITE
- Rewrite `.deepflow/decisions.md` with consolidated content
- Write timestamp to `.deepflow/last-consolidated.json`:
  ```json
  { "last_consolidated": "{ISO-8601 timestamp}" }
  ```

### 5. REPORT
```
✓ Consolidated: {before} → {after} lines, {n} removed, {n} promoted to [DEBT]
```

## Tags
| Tag | Meaning | Source |
|-----|---------|--------|
| `[APPROACH]` | Firm decision | Auto-extraction, /df:note |
| `[PROVISIONAL]` | Revisit later | Auto-extraction, /df:note |
| `[ASSUMPTION]` | Unverified | Auto-extraction, /df:note |
| `[DEBT]` | Needs revisiting | Consolidation only |

## Rules
- Conservative: when in doubt, keep both entries
- Never add new decisions — only remove, merge, or re-tag
- [DEBT] is never manually assigned — only produced by consolidation
- Preserve chronological ordering within sections
- decisions.md stays a single flat file, human-readable
