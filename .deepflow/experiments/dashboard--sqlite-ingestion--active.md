# Experiment: better-sqlite3 JSONL ingestion performance

**Topic**: dashboard
**Hypothesis**: sqlite-ingestion
**Status**: active

## Hypothesis

better-sqlite3 can ingest 10K JSONL records into a typed schema with incremental offset tracking in <2s on macOS.

## Method

1. Generated 10K sample JSONL records matching token-history.jsonl schema
2. Created SQLite DB with WAL mode + synchronous OFF
3. Bulk INSERT via prepared statement in a transaction
4. Measured full ingestion time
5. Tested incremental ingestion via file offset tracking

## Results

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Full ingestion (10K records) | 29.1ms | <2000ms | PASS |
| Incremental ingestion (100 records) | 3.0ms | — | PASS |
| Query (GROUP BY + ORDER BY + LIMIT) | 1.1ms | — | PASS |
| Incremental correctness | Only new records ingested | — | PASS |

## Key Findings

1. **Performance is exceptional** — 29ms is ~69x faster than the 2s target. WAL mode + transaction batching is the key pattern.
2. **Incremental offset tracking works** — store byte offset after ingestion, read only new bytes on next run.
3. **Native build required** — better-sqlite3 uses node-gyp (C++ addon). This adds install complexity but provides the best performance.
4. **Pragmas matter** — `journal_mode = WAL` and `synchronous = OFF` are critical for write performance.

## Verdict

**Hypothesis: CONFIRMED**

better-sqlite3 is dramatically faster than required. The native build requirement is the only trade-off.
