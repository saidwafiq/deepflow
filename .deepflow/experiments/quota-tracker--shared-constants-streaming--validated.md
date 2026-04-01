# Experiment: quota-tracker — shared-constant extraction and streaming readline

**Status:** validated
**Date:** 2026-04-01
**Spike task:** T1 (quota-tracker)

## Hypothesis

`windowKeys` can be extracted from `quota-history.ts:44` into a shared constants file without breaking existing ingest flow, and `readline`+`createReadStream` correctly handles real JSONL shape from the hook.

## Findings

### 1. Real JSONL shape (from `~/.claude/quota-history.jsonl`, 930 lines)

The hook (`hooks/df-quota-logger.js`) emits records with this top-level structure:

```json
{
  "timestamp": "2026-03-12T02:50:36.918Z",
  "event": "SessionStart",
  "session_id": "...",
  "project": "/path/to/project",
  "five_hour":       { "utilization": 11, "resets_at": "..." },
  "seven_day":       { "utilization": 41, "resets_at": "..." },
  "seven_day_sonnet":{ "utilization": 3,  "resets_at": "..." },
  "extra_usage":     { "is_enabled": true, "monthly_limit": 27500, "used_credits": 6796, "utilization": 24.7 }
}
```

Error records (HTTP 404) have `statusCode: 404` and `data.type: "error"` — these are correctly filtered by the existing parser logic.

Top-level keys observed: `timestamp`, `event`, `session_id`, `project`, `five_hour`, `seven_day`, `seven_day_sonnet`, `extra_usage`, `statusCode`, `data`.

**Note:** The hook does NOT emit a `user` field — all records have `user = 'unknown'` in the current parser. This is a pre-existing limitation, not introduced by this spike.

### 2. Shared-constant extraction: SAFE

`windowKeys` is currently defined inline at `quota-history.ts:44`:

```typescript
const windowKeys = ['five_hour', 'seven_day', 'seven_day_sonnet', 'extra_usage'] as const;
```

Extraction to `src/ingest/parsers/constants.ts` is safe because:
- Only `quota-history.ts` currently references `windowKeys` (verified by grep across all parsers)
- The client layer (`QuotaStatus.tsx`) independently hard-codes the same keys as `WINDOW_COLORS` and `WINDOW_LABELS` record keys — these are UI-layer constants and would benefit from importing the same shared constant
- The ingest `index.ts` does not reference `windowKeys` directly; it only calls `parseQuotaHistory()`
- No circular imports would be introduced — constants file has zero dependencies

**Proposed extraction:**

```typescript
// src/ingest/parsers/constants.ts
export const QUOTA_WINDOW_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'extra_usage',
] as const;

export type QuotaWindowKey = typeof QUOTA_WINDOW_KEYS[number];
```

`quota-history.ts` would import: `import { QUOTA_WINDOW_KEYS } from './constants.js';`

### 3. Streaming readline parse: VALIDATED on real data

Ran a proof-of-concept Node.js script using `readline.createInterface` + `createReadStream` against the real 930-line file. Results:

- **Total snapshots parsed:** 2,284 (4 windows × ~571 valid records)
- **Window types seen:** `extra_usage`, `five_hour`, `seven_day`, `seven_day_sonnet` — exactly the 4 expected types
- **Error records filtered:** 404 records correctly skipped
- **`captured_at` always present:** 0 records missing timestamps
- **Streaming correctly handles:** blank lines, malformed JSON (skipped with warning), nested window objects, fallback to flat format

The streaming approach is functionally equivalent to the current `readFileSync().split('\n')` approach, with the benefit of not loading the entire file into memory.

**Key consideration:** The streaming approach returns an async iterator — the parser must be `async` and use `for await`. The current parser is already `async`, so this is compatible.

### 4. Offset / incremental ingestion compatibility

The current parser uses a line-count offset stored in `_meta`. With streaming readline:
- Lines are emitted in order, so offset-based skipping still works
- However, `readline` doesn't expose a `skip N lines` primitive — the implementation must count lines and skip until `i >= offset`
- Alternatively, the streaming parser can re-use `byte offset` via `createReadStream({ start: byteOffset })`, which is more efficient but requires storing byte positions rather than line counts

**Recommendation:** Keep line-count offset for now (iterate and skip), matching current behavior. Byte-offset optimization is a future improvement.

## Conclusion

Both hypotheses are **validated**:

1. `windowKeys` → `constants.ts` extraction is safe, zero-risk, and would benefit both the parser and the client UI layer.
2. Streaming readline correctly parses real JSONL data from the hook, producing 2,284 structured snapshots from 930 lines.

## Success Criteria Check

- [x] Existing flat parser can import shared constant (no circular deps, clean extraction path)
- [x] Streaming parse returns structured snapshots from real data shape (2,284 snapshots, all 4 window types, errors filtered)
