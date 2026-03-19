---
name: df:report
description: Generate session cost report with token usage, cache hit ratio, per-task costs, and quota impact
allowed-tools: [Read, Write, Bash]
---

# /df:report — Session Cost Report

## Orchestrator Role

Aggregate token usage data and produce a structured report.

**NEVER:** Spawn agents, use Task tool, use AskUserQuestion, run git, EnterPlanMode, ExitPlanMode

**ONLY:** Read data files, compute aggregates, write `.deepflow/report.json` and `.deepflow/report.md`

## Behavior

### 1. LOAD DATA SOURCES

Read each source gracefully — missing files yield zero/empty values, never error out.

| Source | Path | Shell injection | Key fields |
|--------|------|-----------------|------------|
| Token history | `.deepflow/token-history.jsonl` | `` !`cat .deepflow/token-history.jsonl 2>/dev/null \|\| echo ''` `` | `timestamp`, `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `used_percentage`, `model`, `session_id` |
| Quota history | `~/.claude/quota-history.jsonl` | `` !`tail -5 ~/.claude/quota-history.jsonl 2>/dev/null \|\| echo ''` `` | `timestamp`, `event`, API payload |
| Task results | `.deepflow/results/T*.yaml` | `` !`ls .deepflow/results/T*.yaml 2>/dev/null \|\| echo ''` `` | `tokens` block: `start_percentage`, `end_percentage`, `delta_percentage`, `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| Session metadata | `.deepflow/auto-memory.yaml` | `` !`cat .deepflow/auto-memory.yaml 2>/dev/null \|\| echo ''` `` | session_id, start time (optional) |

### 2. COMPUTE AGGREGATES

```
total_input_tokens  = sum(input_tokens)
total_cache_creation = sum(cache_creation_input_tokens)
total_cache_read    = sum(cache_read_input_tokens)
total_tokens_all    = total_input_tokens + total_cache_creation + total_cache_read
cache_hit_ratio     = total_cache_read / total_tokens_all  (0 if denominator=0, clamp [0,1], round 4 decimals)
peak_context_percentage = max(used_percentage)
model               = most recent line's model
```

### 3. WRITE `.deepflow/report.json`

Structure: `{ version: 1, generated: ISO-8601-UTC, session_summary: {total_input_tokens, total_cache_creation, total_cache_read, cache_hit_ratio, peak_context_percentage, model}, tasks: [{task_id, start_percentage, end_percentage, delta_percentage, input_tokens, cache_creation, cache_read}], quota: {available: bool, ...API fields if available} }`

Rules: `version` always 1. `tasks` = `[]` if no results found. `quota.available` = false if missing. All token fields integers >= 0. `cache_hit_ratio` float in [0,1].

### 4. WRITE `.deepflow/report.md`

Required sections with exact headings:

**## Session Summary** — Table: Model, Total Input Tokens, Cache Creation Tokens, Cache Read Tokens, Cache Hit Ratio (with %), Peak Context Usage %.

**## Per-Task Costs** — Table: Task, Start %, End %, Delta %, Input Tokens, Cache Creation, Cache Read. Show `_(No task data available)_` if empty.

**## Quota Impact** — Quota fields table if `quota.available=true`, else exactly: `Not available (non-macOS or no token)`.

### 5. CONFIRM

```
Report generated:
  .deepflow/report.json  — machine-readable (version=1)
  .deepflow/report.md    — human-readable summary
```

List missing data sources as a note if any were absent.

## Rules

- Graceful degradation — missing files yield zero/empty, never error
- No hallucination — only values from actual file contents; 0 for missing fields
- Idempotent — re-running overwrites both files with fresh data
- ISO 8601 UTC timestamps for `generated` field
