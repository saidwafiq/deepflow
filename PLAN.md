# Plan

Generated: 2026-03-18

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 4 |
| Tasks created | 16 |
| Tasks completed | 7 |
| Tasks pending | 9 |

### done-discover-context

- [x] **T1**: Add on-demand context-fetch capability to /df:discover
  - Files: src/commands/df/discover.md
  - Model: sonnet
  - Effort: high
  - REQs: REQ-1 (preserve), REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7
  - Changes:
    1. Add `Agent` to frontmatter `allowed-tools`
    2. Rewrite NEVER/ONLY rules — permit on-demand agent spawning, keep proactive prohibition
    3. Add "On-Demand Context Fetching" section between Rules and "When the User Wants to Move On"
    4. Sub-agent prompt template: factual-only summaries, ~4000 token bound
    5. Socratic resumption instructions after context receipt
    6. Unified detection logic (file paths → Explore agent, URLs → browse-fetch skill)
  - Impact:
    - Callers: none (leaf command, no imports)
    - Duplicates: none
  - Blocked by: none

### doing-caching

- [x] **T2**: Fix process.cwd() bug in writeContextUsage and writeTokenHistory
  - Files: hooks/df-statusline.js
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-1
  - Changes:
    1. Pass `data` to `writeContextUsage(percentage)` → `writeContextUsage(percentage, data)`
    2. In both `writeContextUsage` and `writeTokenHistory`, resolve `.deepflow/` via `data.workspace?.current_dir || process.cwd()`
  - Impact:
    - Callers: `buildContextMeter` (same file, line 56 and 78) — only internal caller
    - Duplicates: none
    - Data flow: writes to `.deepflow/context.json` and `.deepflow/token-history.jsonl` — consumed by `/df:report`, `/df:execute` ratchet, and future dashboard
  - Blocked by: none

- [x] **T3**: Add agent_role and task_id fields to token history records
  - Files: hooks/df-statusline.js
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-2
  - Changes:
    1. Read `process.env.DEEPFLOW_AGENT_ROLE || 'orchestrator'` and `process.env.DEEPFLOW_TASK_ID || null`
    2. Add both fields to the `record` object in `writeTokenHistory`
    3. Backwards-compatible: missing fields in legacy records default on read
  - Impact:
    - Callers: same as T2 (internal only)
    - Data flow: token-history.jsonl consumers must tolerate new fields (additive, no breakage)
  - Blocked by: T2 (file conflict: hooks/df-statusline.js)

- [x] **T4**: Add cross-session cache history persistence
  - Files: hooks/df-statusline.js
  - Model: sonnet
  - Effort: high
  - REQs: REQ-3
  - Changes:
    1. Add `writeCacheHistory(data)` function — compute session-level cache hit ratio from `contextWindow.current_usage` fields
    2. Append one summary record `{timestamp, session_id, cache_hit_ratio, total_tokens, agent_breakdown}` to `~/.claude/cache-history.jsonl`
    3. Dedup: only write if `session_id` differs from last written record (read last line of file)
    4. Call from `buildContextMeter` alongside existing writes
  - Impact:
    - Callers: internal (buildContextMeter)
    - Data flow: `~/.claude/cache-history.jsonl` → consumed by future dashboard (REQ-10 of dashboard.md)
  - Blocked by: T3 (file conflict: hooks/df-statusline.js)

### doing-token-instrumentation

- [x] **T5** [SPIKE]: Validate PostToolUse hook stdin payload shape
  - Type: spike
  - Hypothesis: PostToolUse hook receives JSON on stdin with fields including tool_name, tool_response (or output), session_id, and cwd — similar to StatusLine hook pattern
  - Method: Create minimal `hooks/df-tool-usage.js` that dumps raw stdin to `/tmp/df-posttooluse-payload.json`, register as PostToolUse hook, invoke any tool in Claude Code, inspect dump
  - Success criteria: Dump contains identifiable tool_name, tool output/response, and session_id fields
  - Time-box: 15 min
  - Files: .deepflow/experiments/tool-usage--posttooluse-stdin--active.md
  - Model: sonnet
  - Effort: high
  - Blocked by: none

- [x] **T6**: Create df-tool-usage.js PostToolUse hook
  - Files: hooks/df-tool-usage.js
  - Model: sonnet
  - Effort: high
  - REQs: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5
  - Changes:
    1. Read stdin JSON, extract tool_name, tool_response, session_id, cwd (field names from spike T5)
    2. Compute `output_size_est_tokens = Math.ceil(JSON.stringify(tool_response).length / 4)`
    3. Phase detection: parse cwd for `.deepflow/worktrees/` pattern → "execute"/"verify", else "manual"
    4. Task ID extraction: regex on worktree dir name (e.g. `T3-feature` → `"T3"`)
    5. Bash command extraction: `tool_name === 'Bash' ? command : null`
    6. Append JSONL record with 8 fields to `~/.claude/tool-usage.jsonl`
    7. All errors silently caught, sync writes, <50ms
  - Impact:
    - Callers: none (new hook, invoked by Claude Code runtime)
    - Data flow: `~/.claude/tool-usage.jsonl` → consumed by dashboard REQ-22 (Token by Tool view)
  - Blocked by: T5

- [x] **T7**: Register PostToolUse hook in installer and uninstaller
  - Files: bin/install.js
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-6, REQ-7, REQ-8
  - Changes:
    1. In `configureHooks()` (~line 339): add PostToolUse hook block — filter existing by `df-tool-usage`, then push new entry
    2. In `toRemove` array (~line 521): add `'hooks/df-tool-usage.js'`
    3. In uninstall cleanup (~line 547-564): add `PostToolUse` filter block matching `df-tool-usage` substring
  - Impact:
    - Callers: `main()` calls `configureHooks()`, `uninstall()` reads `toRemove`
    - Duplicates: follows exact pattern of SessionStart/SessionEnd hooks (lines 291-338)
  - Blocked by: T6

### doing-dashboard

- [ ] **T8** [SPIKE]: Validate better-sqlite3 + JSONL ingestion performance
  - Type: spike
  - Role: Contradictory-A (native SQLite via better-sqlite3)
  - Hypothesis: better-sqlite3 can ingest 10K JSONL records into a typed schema with incremental offset tracking in <2s on macOS
  - Method: Init better-sqlite3 DB, create sessions table, parse sample JSONL, bulk INSERT, measure time. Test offset-based incremental re-ingestion.
  - Success criteria: 10K records ingested in <2s, re-run ingests only new records
  - Time-box: 30 min
  - Files: .deepflow/experiments/dashboard--sqlite-ingestion--active.md
  - Model: sonnet
  - Effort: high
  - Blocked by: T4, T7

- [ ] **T9** [SPIKE]: Validate sql.js as no-native-dependency alternative
  - Type: spike
  - Role: Contradictory-B (WASM SQLite, opposing T8 — avoids native build)
  - Hypothesis: sql.js (WASM) can ingest 10K records in <5s without native compilation requirements
  - Method: Same test as T8 but using sql.js instead of better-sqlite3. Compare install friction and performance.
  - Success criteria: 10K records in <5s, zero native build step, file-based persistence works
  - Time-box: 30 min
  - Files: .deepflow/experiments/dashboard--sqljs-ingestion--active.md
  - Model: sonnet
  - Effort: high
  - Blocked by: T4, T7

- [ ] **T10** [SPIKE]: Validate Hono + Vite React SPA serving from single npx entry point
  - Type: spike
  - Role: Naive (tests if Hono can serve both API + pre-built SPA without complexity)
  - Hypothesis: A single Node.js entry point can serve Hono JSON API routes + a Vite-built React SPA from the same port, invocable via `npx`
  - Method: Create minimal package with Hono server, one `/api/health` route, and a pre-built React page. Serve via `node server.js`. Verify both API and SPA load.
  - Success criteria: `curl localhost:3333/api/health` returns JSON, browser at `localhost:3333` renders React component
  - Time-box: 30 min
  - Files: .deepflow/experiments/dashboard--hono-vite-spa--active.md
  - Model: sonnet
  - Effort: high
  - Blocked by: T4, T7

- [ ] **T11** [SPIKE]: Document Claude Code ~/.claude/ file schemas
  - Type: spike
  - Hypothesis: All 8 source files listed in REQ-3 have stable schemas mappable to SQLite tables
  - Method: Dump first 5 records of each file from a real ~/.claude/ installation, document field names and types, identify gaps
  - Success criteria: Schema documented for all files that exist; missing files cataloged with expected creation source
  - Time-box: 20 min
  - Files: .deepflow/experiments/dashboard--file-schemas--active.md
  - Model: haiku
  - Effort: low
  - Blocked by: T4, T7

- [ ] **T12-T20**: Dashboard implementation tasks (9 tasks — deferred)
  - **Deferred** — task breakdown generated after spikes T8-T11 resolve. Spike results determine: SQLite library choice, SPA serving architecture, and ingestion schemas.
  - Estimated scope: ~9 tasks covering package scaffold, SQLite layer, ingestion pipeline, API routes, React views (7 views), SessionEnd hook, /df:dashboard command, backfill CLI
  - Model: sonnet/opus (TBD per task)
  - Effort: medium/high (TBD per task)
  - Blocked by: T8, T9, T10, T11

## Dependency Graph

```
T2 (caching: cwd fix)
 └→ T3 (caching: agent_role/task_id)
     └→ T4 (caching: cache-history.jsonl)
         ├→ T8 (dashboard spike: better-sqlite3)
         ├→ T9 (dashboard spike: sql.js)
         ├→ T10 (dashboard spike: Hono+Vite)
         └→ T11 (dashboard spike: file schemas)
              └→ T12-T20 (dashboard impl — deferred)

T5 (token spike: PostToolUse stdin)
 └→ T6 (token: df-tool-usage.js)
     └→ T7 (token: installer/uninstaller)
         ├→ T8, T9, T10, T11 (dashboard spikes)
         └→ T12-T20 (dashboard impl — deferred)
```

## Spec Gaps Flagged

1. **dashboard.md — REQ-19**: No explicit AC for `--port` CLI flag, `DASHBOARD_PORT` env var, or auto-detect fallback
2. **dashboard.md — /df:dashboard command**: Referenced in Constraints but not listed as a REQ
3. **dashboard.md — /api/ingest payload schema**: REQ-4 lists fields but does not define JSON shape
4. **token-instrumentation.md — PostToolUse stdin schema**: Assumed to follow StatusLine pattern; spike T5 will confirm
