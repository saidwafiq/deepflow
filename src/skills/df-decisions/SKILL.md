---
name: df-decisions
description: Encapsulates the DECISIONS: tagging protocol for architectural decision documentation in task outputs
---

# DECISIONS Tagging Protocol

The `DECISIONS:` line documents architectural choices and key assumptions made during task execution. This protocol standardizes how agents capture non-obvious decisions so they can be extracted and archived incrementally.

## Location & Format

Place the `DECISIONS:` line **in your task output as the second-to-last line, immediately before `TASK_STATUS:`**:

```
DECISIONS: [TAG] {decision} — {rationale} | [TAG] {decision2} — {rationale2}

TASK_STATUS:pass
```

Multiple decisions are separated by ` | ` (space-pipe-space). Each decision is **atomic**; only valid entries are written to `.deepflow/decisions.md`.

## Tag Definitions

| Tag | Use When | Example |
|-----|----------|---------|
| `[APPROACH]` | You chose X over Y for architectural/design reasons | `[APPROACH] Used immutable state snapshots over reactive refs — enables clean recovery and testability` |
| `[PROVISIONAL]` | Solution works now but won't scale or needs revisit | `[PROVISIONAL] Hardcoded registry; refactor to dynamic discovery when >10 providers exist` |
| `[ASSUMPTION]` | You assumed X is true; if wrong, Y breaks | `[ASSUMPTION] Assumed file format never changes; if schema evolves, migration logic required` |
| `[FUTURE]` | You deferred X because Y; document revisit trigger | `[FUTURE] Deferred caching because auth service not finalized; add when auth.md ships` |
| `[UPDATE]` | You changed a prior decision from X to Y | `[UPDATE] Changed from sync API to async to avoid blocking UI renders (discovered via profiling)` |

## When to Include Decisions

**Include `DECISIONS:` when:**
- Task effort is `medium` or `high` (non-mechanical work)
- You made non-obvious architectural or design choices
- You introduced scaling limitations or technical debt
- You made assumptions that could break if conditions change
- You deferred work with specific revisit triggers

**Skip `DECISIONS:` when:**
- Task effort is `low` (mechanical extraction, formatting, simple bug fixes)
- Task is purely mechanical (renaming, copying, trivial refactors)
- No non-obvious choices were made

**Validation rule:** If a task has effort ≥ `medium` and no `DECISIONS:` line appears in your output, the orchestrator will emit SALVAGEABLE (indicating potential architectural choices were not documented).

## Decision Extraction & Storage

The orchestrator runs decision extraction after each ratchet pass:

1. **Parse:** Extract `DECISIONS:` line from agent output
2. **Validate:** Each entry must start with `[TAG]` where TAG ∈ {APPROACH, PROVISIONAL, ASSUMPTION, FUTURE, UPDATE}
3. **Format:** `[TAG] description — rationale` (must contain ` — ` separator)
4. **Store:** Append to `.deepflow/decisions.md` under dated section:
   ```
   ### 2026-04-21 — spec-name
   - [APPROACH] description — rationale
   - [PROVISIONAL] description — rationale
   ```
5. **Invalid entries:** Skipped and trigger SALVAGEABLE; valid entries still written

## Examples

### Multiple decisions
```
DECISIONS: [APPROACH] Inline config over external YAML — reduces deployment complexity | [PROVISIONAL] Hardcoded max_retries=3; bump when traffic patterns change | [FUTURE] Defer distributed tracing until observability service exists
```

### Single decision
```
DECISIONS: [ASSUMPTION] Assumes event ordering is guaranteed by broker; add dedup if semantics change
```

### None (mechanical task)
```
DECISIONS: (omitted for low-effort task)
```

## Rationale Format

The `— rationale` portion should be concise (1–2 sentences) answering **why**:
- For `[APPROACH]`: Why X is better than alternatives
- For `[PROVISIONAL]`: What condition triggers revisit
- For `[ASSUMPTION]`: What breaks if assumption is violated
- For `[FUTURE]`: What blocker prevents doing it now; what unblocks it
- For `[UPDATE]`: What caused the change in direction

## Related

- **Verification:** Execute.md §5.5.2 validates tag syntax and extracts to `.deepflow/decisions.md`
- **Reporting:** Decisions are archived per-spec and per-date for architectural review
- **Coverage:** Tags are NOT part of AC_COVERAGE (different reporting stream)
