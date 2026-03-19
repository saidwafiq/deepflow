# Experiment: sql.js WASM JSONL Ingestion Performance

**Topic:** dashboard
**Hypothesis:** sql.js (WASM) can ingest 10K records in <5s without native compilation requirements
**Status:** active
**Date:** 2026-03-19
**Task:** T9

---

## Setup

- Library: `sql.js@1.12.0` (WASM build, `sql-wasm.js` + `sql-wasm.wasm`)
- Node.js: ESM (`import`) via `createRequire` for CJS interop
- Schema: `token_history` table matching `.deepflow/token-history.jsonl` fields:
  - `timestamp TEXT`, `input_tokens INTEGER`, `cache_creation_input_tokens INTEGER`,
    `cache_read_input_tokens INTEGER`, `context_window_size INTEGER`,
    `used_percentage REAL`, `model TEXT`, `session_id TEXT`,
    `agent_role TEXT`, `task_id TEXT`
- Additional: `ingest_offsets` table for incremental tracking (`source_file TEXT PRIMARY KEY`, `last_offset INTEGER`)

## Method

1. Load sql.js WASM via `initSqlJs({ locateFile: () => wasmPath })`
2. Generate 10,000 synthetic JSONL records matching the token-history schema
3. Bulk INSERT all 10K records in a single transaction (`BEGIN` / `COMMIT`)
4. Test incremental re-ingestion: set offset=5000, insert only remaining 5000 records, update offset to 10000
5. Save DB to disk via `db.export()` → `writeFileSync`, reopen with `new SQL.Database(buffer)`, verify row count

## Results

| Metric | Value |
|---|---|
| sql.js WASM load time | 15.7ms |
| 10K record generation | 12.0ms |
| 10K bulk INSERT | 34.9ms |
| **Total (load + insert)** | **50.5ms** |
| 5K incremental INSERT | 13.3ms |
| DB save to disk | 1.4ms |
| DB reopen from disk | 0.5ms |
| Rows verified after reopen | 15,000 ✓ |

## Success Criteria

| Criterion | Result |
|---|---|
| 10K records in <5s | **PASS** — 51ms (100× faster than limit) |
| Zero native build step | **PASS** — WASM only, no node-gyp |
| File-based persistence works | **PASS** — save/reopen verified with correct row count |

**Overall: HYPOTHESIS CONFIRMED**

## Key Findings

1. **Performance is exceptional**: 10K inserts in 35ms — ~100× faster than the 5s success bar. Even 100K records would likely fit within the threshold.
2. **WASM load is fast**: 15.7ms cold start. Not a meaningful overhead.
3. **No native build**: `npm install sql.js` adds a single package with no compilation step. Installs instantly on any platform (macOS, Linux, CI).
4. **File persistence works but differs from better-sqlite3**: sql.js uses a read-all-on-open / write-all-on-save model (`db.export()` + `writeFileSync`). This means the full DB is loaded into memory. For a usage dashboard with months of data this could become significant.
5. **Incremental tracking**: `ingest_offsets` table approach works cleanly for offset-based re-ingestion.

## Tradeoffs vs better-sqlite3 (T8)

| Dimension | sql.js (WASM) | better-sqlite3 |
|---|---|---|
| Install friction | None (no native build) | node-gyp required |
| CI/CD portability | Excellent | Requires build tools |
| Insert performance | ~285K rows/s | ~500K+ rows/s (est.) |
| Memory model | Full DB in RAM | mmap (OS-managed) |
| Large DB support | Limited (RAM bound) | Excellent |
| File I/O model | Explicit export/import | Transparent |
| Streaming writes | No | Yes |

## Recommendation

sql.js is suitable for the deepflow dashboard given:
- Expected DB size is small (usage history, not application data)
- Zero-dependency install aligns with deepflow's "install anywhere" philosophy
- Performance far exceeds requirements

If the DB grows beyond ~50MB, consider switching to better-sqlite3. For the initial dashboard implementation, sql.js is the lower-friction choice.

## Next Steps

- T10: Validate Hono + Vite serving architecture
- T11: Document Claude Code ~/.claude/ file schemas
- After T8/T9/T10/T11 resolved: T12-T20 dashboard implementation
