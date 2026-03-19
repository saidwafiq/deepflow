# Plan

Generated: 2026-03-18

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 1 |
| Tasks created | 9 |
| Tasks completed | 0 |
| Tasks pending | 9 |

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
