# Plan

Generated: 2026-03-18

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 1 |
| Tasks created | 9 |
| Tasks completed | 4 |
| Tasks pending | 5 |

### doing-dashboard

- [x] **T8** [SPIKE]: Validate better-sqlite3 + JSONL ingestion performance — 10K in 29ms, PASS
- [x] **T9** [SPIKE] [PROBE_WINNER]: Validate sql.js as no-native-dependency alternative — 10K in 51ms, PASS, zero native deps
- [x] **T10** [SPIKE]: Validate Hono + Vite React SPA serving — API + SPA confirmed, PASS
- [x] **T11** [SPIKE]: Document Claude Code ~/.claude/ file schemas — all schemas documented, PASS

#### Spike Decisions

- **SQLite library**: sql.js (WASM) — chosen over better-sqlite3 for zero native build requirement. Both fast enough (51ms vs 29ms for 10K records). Aligns with deepflow's zero-dependency install philosophy.
- **SPA architecture**: Hono + Vite React — single Node.js entry point serves API routes + pre-built React SPA.
- **File schemas**: All ~/.claude/ JSONL files have stable append-only schemas ready for SQLite normalization.

- [ ] **T12-T20**: Dashboard implementation tasks (9 tasks — deferred)
  - **Deferred** — task breakdown generated after spikes T8-T11 resolve. Spike results determine: SQLite library choice, SPA serving architecture, and ingestion schemas.
  - Estimated scope: ~9 tasks covering package scaffold, SQLite layer, ingestion pipeline, API routes, React views (7 views), SessionEnd hook, /df:dashboard command, backfill CLI
  - Model: sonnet/opus (TBD per task)
  - Effort: medium/high (TBD per task)
  - Blocked by: T8, T9, T10, T11

## Spec Gaps Flagged

1. **dashboard.md — REQ-19**: No explicit AC for `--port` CLI flag, `DASHBOARD_PORT` env var, or auto-detect fallback
2. **dashboard.md — /df:dashboard command**: Referenced in Constraints but not listed as a REQ
3. **dashboard.md — /api/ingest payload schema**: REQ-4 lists fields but does not define JSON shape
