# Plan

Generated: 2026-03-18
Updated: 2026-03-19

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 1 |
| Tasks created | 13 |
| Tasks completed | 4 |
| Tasks pending | 9 |

### doing-dashboard

#### Spike Decisions

- **SQLite library**: sql.js (WASM) — chosen over better-sqlite3 for zero native build requirement. Both fast enough (51ms vs 29ms for 10K records). Aligns with deepflow's zero-dependency install philosophy.
- **SPA architecture**: Hono + Vite React — single Node.js entry point serves API routes + pre-built React SPA.
- **File schemas**: All ~/.claude/ JSONL files have stable append-only schemas ready for SQLite normalization.

- [x] **T8** [SPIKE]: Validate better-sqlite3 + JSONL ingestion performance — 10K in 29ms, PASS
- [x] **T9** [SPIKE] [PROBE_WINNER]: Validate sql.js as no-native-dependency alternative — 10K in 51ms, PASS, zero native deps
- [x] **T10** [SPIKE]: Validate Hono + Vite React SPA serving — API + SPA confirmed, PASS
- [x] **T11** [SPIKE]: Document Claude Code ~/.claude/ file schemas — all schemas documented, PASS

---

- [ ] **T12**: Package scaffold + CLI entry point + sql.js database layer
  - Files: packages/deepflow-dashboard/package.json, packages/deepflow-dashboard/bin/cli.js, packages/deepflow-dashboard/src/server.ts, packages/deepflow-dashboard/src/db/schema.sql, packages/deepflow-dashboard/src/db/index.ts, packages/deepflow-dashboard/src/pricing.ts, packages/deepflow-dashboard/src/data/pricing-fallback.json, packages/deepflow-dashboard/tsconfig.json, packages/deepflow-dashboard/vite.config.ts, packages/deepflow-dashboard/tailwind.config.js, packages/deepflow-dashboard/postcss.config.js
  - Model: sonnet
  - Effort: high
  - REQs: REQ-1, REQ-2, REQ-7, REQ-19
  - Changes:
    1. Create package dir with deps: sql.js, hono, @hono/node-server, react, react-dom, recharts, tailwindcss, vite, @vitejs/plugin-react
    2. CLI entry: arg parsing for `local` (default), `serve`, `backfill --url`; port resolution (--port > DASHBOARD_PORT > config > 3333 > auto-detect)
    3. Hono app setup, static SPA serving, mode detection (local vs team)
    4. sql.js init, WASM loader, schema migration runner, db path resolution
    5. DDL: sessions, token_events, quota_snapshots, task_results, tool_usage, command_history, _meta
    6. pricing.json fetch from GitHub with bundled fallback
  - Impact:
    - Callers: none (new standalone package)
    - Data flow: foundation for all other dashboard tasks
  - Blocked by: none

- [ ] **T13**: Local ingestion pipeline (8 file sources + incremental offset)
  - Files: packages/deepflow-dashboard/src/ingest/index.ts, packages/deepflow-dashboard/src/ingest/parsers/quota-history.ts, packages/deepflow-dashboard/src/ingest/parsers/history.ts, packages/deepflow-dashboard/src/ingest/parsers/token-history.ts, packages/deepflow-dashboard/src/ingest/parsers/sessions.ts, packages/deepflow-dashboard/src/ingest/parsers/cache-history.ts, packages/deepflow-dashboard/src/ingest/parsers/tool-usage.ts, packages/deepflow-dashboard/src/ingest/parsers/task-results.ts, packages/deepflow-dashboard/src/ingest/parsers/stats-cache.ts
  - Model: sonnet
  - Effort: high
  - REQs: REQ-3
  - Changes:
    1. Orchestrator: runs all parsers, tracks offsets in _meta table
    2. Per-source parsers: quota-history.jsonl, history.jsonl, token-history.jsonl, session JSONLs, cache-history.jsonl, tool-usage.jsonl, T*.yaml results, stats-cache.json
    3. Incremental: read offset from _meta, seek to position, parse only new records
    4. Graceful: missing files log warning, malformed records skip, never crash
  - Impact:
    - Callers: T12 server.ts calls ingest on startup
    - Data flow: ~/.claude/* + .deepflow/* → SQLite tables
  - Blocked by: T12

- [ ] **T14**: API routes (GET endpoints for all views)
  - Files: packages/deepflow-dashboard/src/api/sessions.ts, packages/deepflow-dashboard/src/api/costs.ts, packages/deepflow-dashboard/src/api/quota.ts, packages/deepflow-dashboard/src/api/tasks.ts, packages/deepflow-dashboard/src/api/activity.ts, packages/deepflow-dashboard/src/api/cache.ts, packages/deepflow-dashboard/src/api/tools.ts, packages/deepflow-dashboard/src/api/index.ts, packages/deepflow-dashboard/src/server.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-8 through REQ-16, REQ-17, REQ-22
  - Changes:
    1. GET /api/sessions — list with filters, pagination, user filter for team
    2. GET /api/costs — per-model totals, time series, per-project breakdown
    3. GET /api/quota — latest quota snapshots per window
    4. GET /api/tasks — task results with cost, status, execution count
    5. GET /api/activity — daily aggregates for 52-week heatmap
    6. GET /api/cache — hit ratios, cache token breakdown, trends
    7. GET /api/tools — per-tool token consumption, call counts
    8. Mount all routes on Hono app in server.ts
  - Impact:
    - Callers: React SPA views (T16-T18) consume these endpoints
    - Data flow: SQLite queries → JSON responses
  - Blocked by: T12, T13 (file conflict: server.ts with T12)

- [ ] **T15**: React SPA shell + theme + auto-refresh + navigation
  - Files: packages/deepflow-dashboard/src/client/index.html, packages/deepflow-dashboard/src/client/main.tsx, packages/deepflow-dashboard/src/client/App.tsx, packages/deepflow-dashboard/src/client/hooks/usePolling.ts, packages/deepflow-dashboard/src/client/hooks/useTheme.ts, packages/deepflow-dashboard/src/client/hooks/useApi.ts, packages/deepflow-dashboard/src/client/context/DashboardContext.tsx, packages/deepflow-dashboard/src/client/components/UserFilter.tsx, packages/deepflow-dashboard/src/client/components/Sidebar.tsx, packages/deepflow-dashboard/src/client/globals.css, packages/deepflow-dashboard/src/client/lib/utils.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-17, REQ-18, REQ-21
  - Changes:
    1. React root + router setup
    2. Layout shell: sidebar nav, header with user filter (team mode), content area
    3. Dark/light theme via prefers-color-scheme
    4. Auto-refresh polling hook (pause when tab hidden)
    5. Global context: mode, selected user, refresh interval
    6. Tailwind CSS + shadcn/ui theme tokens
  - Impact:
    - Callers: none (new SPA entry point)
    - Data flow: fetches from API routes, renders views
  - Blocked by: T12

- [ ] **T16**: Dashboard views — Cost Overview + Session List + Cache Efficiency
  - Files: packages/deepflow-dashboard/src/client/views/CostOverview.tsx, packages/deepflow-dashboard/src/client/views/SessionList.tsx, packages/deepflow-dashboard/src/client/views/CacheEfficiency.tsx, packages/deepflow-dashboard/src/client/components/charts/StackedAreaChart.tsx, packages/deepflow-dashboard/src/client/components/MetricCard.tsx, packages/deepflow-dashboard/src/client/App.tsx
  - Model: sonnet
  - Effort: high
  - REQs: REQ-8, REQ-9, REQ-10
  - Changes:
    1. Cost Overview: per-model totals, stacked area chart (Recharts), per-project table
    2. Session List: sortable table with duration, messages, tool calls, tokens, cost
    3. Cache Efficiency: hit ratio metric card, cache token breakdown chart, trend line
    4. Reusable StackedAreaChart and MetricCard components
    5. Add route entries in App.tsx
  - Impact:
    - Callers: API routes /api/costs, /api/sessions, /api/cache
  - Blocked by: T14, T15 (file conflict: App.tsx with T15)

- [ ] **T17**: Dashboard views — Activity Heatmap + Model Donut + Cost Stacked + Peak Hours
  - Files: packages/deepflow-dashboard/src/client/views/ActivityHeatmap.tsx, packages/deepflow-dashboard/src/client/views/ModelDonut.tsx, packages/deepflow-dashboard/src/client/views/CostStacked.tsx, packages/deepflow-dashboard/src/client/views/PeakHours.tsx, packages/deepflow-dashboard/src/client/components/charts/HeatmapGrid.tsx, packages/deepflow-dashboard/src/client/components/charts/DonutChart.tsx, packages/deepflow-dashboard/src/client/App.tsx
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-12, REQ-13, REQ-14, REQ-15
  - Changes:
    1. Activity Heatmap: 52-week GitHub-style grid, team/user toggle
    2. Model Donut: pie/donut chart for token/cost distribution by model
    3. Cost Stacked: daily stacked bar chart by model
    4. Peak Hours: 24-bucket bar chart for hourly usage
    5. Reusable HeatmapGrid and DonutChart components
    6. Add route entries in App.tsx
  - Impact:
    - Callers: API routes /api/activity, /api/costs
  - Blocked by: T14, T15 (file conflict: App.tsx with T16)

- [ ] **T18**: Dashboard views — Task Tracking + Quota Status + Token by Tool
  - Files: packages/deepflow-dashboard/src/client/views/TaskTracking.tsx, packages/deepflow-dashboard/src/client/views/QuotaStatus.tsx, packages/deepflow-dashboard/src/client/views/TokenByTool.tsx, packages/deepflow-dashboard/src/client/components/charts/BarChart.tsx, packages/deepflow-dashboard/src/client/components/QuotaGauge.tsx, packages/deepflow-dashboard/src/client/App.tsx
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-11, REQ-16, REQ-22
  - Changes:
    1. Task Tracking: task table with cost, status, execution count
    2. Quota Status: 4 gauge/progress bars for quota windows + reset countdowns
    3. Token by Tool: sortable table + horizontal bar chart
    4. Reusable BarChart and QuotaGauge components
    5. Add route entries in App.tsx
  - Impact:
    - Callers: API routes /api/tasks, /api/quota, /api/tools
  - Blocked by: T14, T15 (file conflict: App.tsx with T17)

- [ ] **T19**: Team mode — POST /api/ingest + SessionEnd hook + backfill CLI
  - Files: packages/deepflow-dashboard/src/api/ingest.ts, packages/deepflow-dashboard/src/backfill.ts, hooks/df-dashboard-push.js, packages/deepflow-dashboard/src/api/index.ts, packages/deepflow-dashboard/src/server.ts, packages/deepflow-dashboard/bin/cli.js, templates/config-template.yaml, bin/install.js
  - Model: sonnet
  - Effort: high
  - REQs: REQ-4, REQ-5, REQ-6, REQ-20
  - Changes:
    1. POST /api/ingest: validate required fields, batch insert, return 200/400
    2. Backfill CLI: read local ~/.claude/ data, transform to ingest payload, POST in batches of 100
    3. SessionEnd hook: collect session summary, attach git user.name, POST to dashboard_url
    4. Enable ingest route only in team mode
    5. Wire backfill subcommand in CLI
    6. Add dashboard_url and dashboard_port to config template
    7. Register df-dashboard-push.js in bin/install.js SessionEnd hooks
  - Impact:
    - Callers: bin/install.js (adds hook registration), templates/config-template.yaml (adds 2 fields)
    - Data flow: dev machines → SessionEnd hook → team server → SQLite
  - Blocked by: T13, T14 (file conflict: server.ts, api/index.ts, bin/cli.js)

- [ ] **T20**: /df:dashboard command + /df:report deprecation
  - Files: src/commands/df/dashboard.md, src/commands/df/report.md
  - Model: haiku
  - Effort: low
  - REQs: REQ-1 (command UX)
  - Changes:
    1. Create dashboard.md: YAML frontmatter command, local mode runs npx deepflow-dashboard, team mode opens dashboard_url
    2. Deprecate report.md: redirect notice to /df:dashboard
  - Impact:
    - Callers: none (user-invoked commands)
    - Duplicates: report.md [active — redirect to dashboard]
  - Blocked by: T12

## Dependency Graph

```
T12 (scaffold + db + CLI + pricing)
 ├→ T13 (ingestion pipeline)
 │   ├→ T14 (API routes) ← also needs T12
 │   │   ├→ T16 (views: cost/session/cache) ← also needs T15
 │   │   │   └→ T17 (views: heatmap/donut/stacked/peak) [App.tsx conflict]
 │   │   │       └→ T18 (views: task/quota/tool) [App.tsx conflict]
 │   │   └→ T19 (team mode) ← also needs T13
 │   └→ T19 (team mode)
 ├→ T15 (SPA shell) ← parallel with T13
 │   ├→ T16, T17, T18 (views, serial)
 └→ T20 (command + docs) ← parallel with everything
```

## Parallelism Opportunities

- **Wave 1**: T12 (scaffold)
- **Wave 2**: T13 (ingestion) + T15 (SPA shell) + T20 (command) — all parallel
- **Wave 3**: T14 (API routes) — needs T12 + T13
- **Wave 4**: T16 (core views) + T19 (team mode) — parallel, no shared files
- **Wave 5**: T17 (chart views) — after T16 (App.tsx conflict)
- **Wave 6**: T18 (remaining views) — after T17 (App.tsx conflict)

## File Conflict Matrix

| File | Tasks | Resolution |
|------|-------|------------|
| server.ts | T12 (create), T14 (modify), T19 (modify) | T12 → T14 → T19 |
| api/index.ts | T14 (create), T19 (modify) | T14 → T19 |
| bin/cli.js | T12 (create), T19 (modify) | T12 → T19 |
| App.tsx | T15 (create), T16 (modify), T17 (modify), T18 (modify) | T15 → T16 → T17 → T18 |

## Spec Gaps Flagged

1. **REQ-2 deviation**: Spec says better-sqlite3, spikes chose sql.js — update spec or note in decisions
2. **REQ-19**: No explicit AC for `--port` CLI flag, `DASHBOARD_PORT` env var, or auto-detect fallback
3. **/df:dashboard command**: Referenced in Constraints but not listed as a REQ
4. **/api/ingest payload schema**: REQ-4 lists fields but does not define JSON shape
