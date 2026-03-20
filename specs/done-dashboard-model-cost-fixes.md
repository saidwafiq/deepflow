# Dashboard Model & Cost Fixes

## Objective
Fix two data accuracy bugs: the Models page only shows opus (costs API queries token_events which only has the top-level model), and cache tokens are double-counted in cost computation (aggregation conflates input_tokens with cache then passes cache again separately).

## Requirements
- REQ-1: Costs API per-model totals must aggregate from `sessions` table instead of `token_events`, since session JSONLs contain all model variants (opus, haiku, sonnet) while token-history.jsonl only logs the top-level model
- REQ-2: `aggregateAndComputeCosts()` in `ingest/index.ts` must set `tokens_in = SUM(te.input_tokens)` only — not `SUM(te.input_tokens + te.cache_read_tokens + te.cache_creation_tokens)`. Cache tokens already stored separately
- REQ-3: `parseExecutionHistory` in `execution-history.ts` must accumulate `tokensIn` as `input_tokens` only, not `input_tokens + cache_read_tokens + cache_creation_tokens`
- REQ-4: One-time migration wipes sessions, task_attempts, and their ingest offsets so fixed parsers re-process with corrected token accounting

## Constraints
- Do not change the database schema — all columns already exist
- Do not change `computeCost()` signature — it correctly expects input separate from cache
- Do not change sessions parser (`sessions.ts`) — it already handles tokens correctly
- Costs API rewrite must preserve existing response shape: `{ models, daily, projects }`
- Migration must be idempotent (tracked via `_meta` key)

## Out of Scope
- Adding new models to pricing alias map
- Changing the frontend Models view component
- Modifying token-history.jsonl ingestion to capture sub-agent models
- Per-model breakdown within a single session

## Acceptance Criteria
- [ ] `GET /api/costs` returns entries for >= 2 distinct models when session data contains multiple models (REQ-1)
- [ ] After ingestion, `tokens_in` equals sum of only `input_tokens` from source events, not including cache (REQ-2)
- [ ] `ingest/index.ts` aggregation uses `SUM(te.input_tokens)` not `SUM(te.input_tokens + cache)` — code inspection (REQ-2)
- [ ] `execution-history.ts` accumulates `tokensIn` from `input_tokens` only — code inspection (REQ-3)
- [ ] Migration key `migration:cost_reparse_v1` exists in `_meta` after first run (REQ-4)
- [ ] `npm run build` exits 0

## Technical Notes

### Files to change
| File | Change |
|------|--------|
| `src/api/costs.ts` | Replace token_events-based model query with sessions-based aggregation |
| `src/ingest/index.ts` | Fix aggregation: `SUM(te.input_tokens)` only + add migration |
| `src/ingest/parsers/execution-history.ts` | Fix: `tokensIn += input_tokens` only |

### Patterns to follow
- Session parser (`sessions.ts`) is the reference implementation for correct token accumulation
- `computeCost(pricing, model, inputTokens, outputTokens, cacheRead, cacheCreation)` — all 4 token types separate
- Migration pattern: `_meta` key check, idempotent wipe+re-ingest (see `session_reparse_v1`)
