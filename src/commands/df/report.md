---
name: df:report
description: Generate session cost report with token usage, cache hit ratio, per-task costs, and quota impact
allowed-tools: [Read, Write, Bash]
---

# /df:report — Session Cost Report

## Orchestrator Role

You aggregate token usage data from multiple sources and produce a structured report.

**NEVER:** Spawn agents, use Task tool, use AskUserQuestion, run git, use EnterPlanMode, use ExitPlanMode

**ONLY:** Read data files, compute aggregates, write `.deepflow/report.json` and `.deepflow/report.md`

---

## Purpose

Produce a cost and context report for the current session. Reads token-history.jsonl, quota-history.jsonl, per-task YAML result files, and auto-memory.yaml. Outputs a machine-readable JSON report and a human-readable Markdown summary.

## Usage

```
/df:report
```

No arguments. Operates on `.deepflow/` data written by the statusline hook, execute command, and quota logger.

---

## Behavior

### 1. LOAD DATA SOURCES

Read each source gracefully — if a file does not exist, treat it as empty and continue.

**a. Token history** — `.deepflow/token-history.jsonl`

Parse each newline-delimited JSON object. Each line has fields:
`timestamp`, `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `context_window_size`, `used_percentage`, `model`, `session_id`

Shell injection (use output directly):
- `` !`cat .deepflow/token-history.jsonl 2>/dev/null || echo ''` ``

Aggregate across all lines:
- `total_input_tokens` = sum of `input_tokens`
- `total_cache_creation` = sum of `cache_creation_input_tokens`
- `total_cache_read` = sum of `cache_read_input_tokens`
- `cache_hit_ratio` = `total_cache_read / (total_input_tokens + total_cache_creation + total_cache_read)` — clamp to `[0, 1]`, default `0` if denominator is 0
- `peak_context_percentage` = max of `used_percentage` across all lines
- `model` = value from the most recent line (last line)

**b. Quota history** — `~/.claude/quota-history.jsonl`

Parse the last 5 lines. Each line has `timestamp`, `event`, and API response payload fields.

Shell injection:
- `` !`tail -5 ~/.claude/quota-history.jsonl 2>/dev/null || echo ''` ``

Extract the most recent quota entry. If the file does not exist or is empty, set `quota.available = false`.

**c. Per-task results** — `.deepflow/results/T*.yaml`

Shell injection:
- `` !`ls .deepflow/results/T*.yaml 2>/dev/null || echo ''` ``

For each YAML file found, read and extract the `tokens` block:
```yaml
tokens:
  start_percentage: N
  end_percentage: N
  delta_percentage: N
  input_tokens: N
  cache_creation_input_tokens: N
  cache_read_input_tokens: N
```

Derive `task_id` from the filename (e.g., `T3.yaml` → `"T3"`).

If a file has no `tokens` block, skip it without error.

**d. Session metadata** — `.deepflow/auto-memory.yaml`

Shell injection:
- `` !`cat .deepflow/auto-memory.yaml 2>/dev/null || echo ''` ``

Read for context (session_id, start time, etc.) if available. Optional — do not fail if absent.

### 2. COMPUTE AGGREGATES

Using data from step 1:

```
total_tokens_all = total_input_tokens + total_cache_creation + total_cache_read
cache_hit_ratio  = total_cache_read / total_tokens_all   (0 if total_tokens_all == 0)
```

Round `cache_hit_ratio` to 4 decimal places.

### 3. WRITE `.deepflow/report.json`

Generate an ISO 8601 timestamp for the `generated` field (current time).

Schema:
```json
{
  "version": 1,
  "generated": "2026-03-17T12:00:00Z",
  "session_summary": {
    "total_input_tokens": 0,
    "total_cache_creation": 0,
    "total_cache_read": 0,
    "cache_hit_ratio": 0.0,
    "peak_context_percentage": 0,
    "model": "claude-sonnet-4-5"
  },
  "tasks": [
    {
      "task_id": "T1",
      "start_percentage": 0,
      "end_percentage": 0,
      "delta_percentage": 0,
      "input_tokens": 0,
      "cache_creation": 0,
      "cache_read": 0
    }
  ],
  "quota": {
    "available": false
  }
}
```

Rules:
- `version` is always `1`
- `tasks` is an empty array `[]` if no task result files were found or none had a `tokens` block
- `quota.available` is `false` if quota data is missing or could not be read; `true` with additional fields from the API payload if data was found
- All token fields are integers >= 0
- `cache_hit_ratio` is a float in `[0, 1]`

### 4. WRITE `.deepflow/report.md`

Generate a human-readable Markdown report. Use actual values from step 2.

Required section headings (exact text):

```markdown
## Session Summary

| Metric | Value |
|--------|-------|
| Model | {model} |
| Total Input Tokens | {total_input_tokens} |
| Cache Creation Tokens | {total_cache_creation} |
| Cache Read Tokens | {total_cache_read} |
| Cache Hit Ratio | {cache_hit_ratio} ({percentage}%) |
| Peak Context Usage | {peak_context_percentage}% |

## Per-Task Costs

| Task | Start % | End % | Delta % | Input Tokens | Cache Creation | Cache Read |
|------|---------|-------|---------|-------------|----------------|------------|
| T1   | 0       | 5     | 5       | 12000        | 3000           | 1000       |

_(No task data available)_ if tasks array is empty

## Quota Impact

{quota data table or "Not available (non-macOS or no token)"}
```

For **Quota Impact**:
- If `quota.available = true`: render a table with the quota fields from the API payload
- If `quota.available = false`: write exactly `Not available (non-macOS or no token)`

### 5. CONFIRM

Report to the user:

```
Report generated:
  .deepflow/report.json  — machine-readable (version=1)
  .deepflow/report.md    — human-readable summary
```

If any data source was missing, list them as a note:
```
Note: Missing data sources: token-history.jsonl, quota-history.jsonl
```

---

## Rules

- **Graceful degradation** — any missing file yields zero/empty values for that source; never error out
- **No hallucination** — only write values derived from actual file contents; use 0 for missing numeric fields
- **Idempotent** — re-running overwrites `.deepflow/report.json` and `.deepflow/report.md` with fresh data
- **cache_hit_ratio always in [0,1]** — clamp if arithmetic produces out-of-range value
- **ISO 8601 timestamps** — `generated` field uses UTC

---

## Example

```
USER: /df:report

CLAUDE: [Reads .deepflow/token-history.jsonl — 42 lines found]
[Reads ~/.claude/quota-history.jsonl — last 5 lines found]
[Reads .deepflow/results/T1.yaml, T2.yaml, T3.yaml — tokens blocks extracted]
[Reads .deepflow/auto-memory.yaml — session metadata found]

[Computes:
  total_input_tokens = 185000
  total_cache_creation = 45000
  total_cache_read = 320000
  cache_hit_ratio = 320000 / (185000 + 45000 + 320000) = 0.5818
  peak_context_percentage = 73
  model = claude-sonnet-4-5
]

[Writes .deepflow/report.json]
[Writes .deepflow/report.md]

Report generated:
  .deepflow/report.json  — machine-readable (version=1)
  .deepflow/report.md    — human-readable summary
```
