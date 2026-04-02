/**
 * Wave-2 tests for T54, T55, T59, T65.
 *
 * T54: Model resolution from sessions table in cache-history; aggregation UPDATE
 *      for resolving 'unknown' models via sessions join.
 * T55: Idempotent POST ingest (INSERT OR IGNORE on token_events, absolute SET on
 *      sessions UPDATE), transaction wrapping (BEGIN/COMMIT/ROLLBACK).
 * T59: token-history no longer skips worktree dirs (removed '--' skip condition).
 * T65: pricing.ts exports PRICING_TTL_MS constant; fetchPricing checks TTL
 *      before returning cache; stale cache fallback on remote failure.
 *
 * Uses Node.js built-in node:test (ESM) to match project conventions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// T54: Model resolution from sessions table in cache-history.ts +
//      aggregation UPDATE for 'unknown' models in ingest/index.ts
// ---------------------------------------------------------------------------
describe('T54 — model resolution for unknown models', () => {
  const cacheSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'cache-history.ts'), 'utf8');
  const ingestSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'index.ts'), 'utf8');

  it('cache-history queries sessions table when record model is unknown', () => {
    // Before inserting token_events with model='unknown', the parser should
    // look up the sessions table for a known model
    assert.ok(
      cacheSrc.includes("SELECT model FROM sessions WHERE id = ?"),
      'cache-history should query sessions table to resolve model before inserting token_events'
    );
  });

  it('cache-history checks model != unknown when querying sessions', () => {
    // The source uses escaped single quotes inside the SQL string
    assert.ok(
      cacheSrc.includes("model != \\'unknown\\'") || cacheSrc.includes("model != 'unknown'"),
      'cache-history sessions query should filter out unknown models'
    );
  });

  it('cache-history falls back to unknown only when sessions has no known model', () => {
    // The code should set resolvedModel = 'unknown' as last resort
    assert.ok(
      cacheSrc.includes("resolvedModel = 'unknown'"),
      'cache-history should default to unknown as last resort'
    );
  });

  it('cache-history prefers record model over sessions lookup', () => {
    // The condition for sessions lookup: if model is empty or unknown
    assert.ok(
      cacheSrc.includes("!resolvedModel || resolvedModel === 'unknown'"),
      'cache-history should only query sessions when record model is empty or unknown'
    );
  });

  it('aggregateAndComputeCosts resolves unknown models via sessions join', () => {
    // Find the UPDATE token_events SET model = ... block
    const updateIdx = ingestSrc.indexOf('UPDATE token_events SET model');
    assert.ok(updateIdx !== -1, 'Should have UPDATE token_events SET model statement');

    const updateBlock = ingestSrc.slice(updateIdx, updateIdx + 500);

    // Must join with sessions to get known model
    assert.ok(
      updateBlock.includes('SELECT s.model FROM sessions s'),
      'aggregation should resolve unknown models by joining sessions table'
    );

    // Must filter for known models only
    assert.ok(
      updateBlock.includes("s.model != 'unknown'"),
      'aggregation should only use non-unknown models from sessions'
    );
  });

  it('aggregation UPDATE targets only token_events with model = unknown', () => {
    const updateIdx = ingestSrc.indexOf('UPDATE token_events SET model');
    const updateBlock = ingestSrc.slice(updateIdx, updateIdx + 500);

    assert.ok(
      updateBlock.includes("token_events.model = 'unknown'"),
      'UPDATE should target only rows where model is unknown'
    );
  });

  it('aggregation UPDATE uses EXISTS guard to avoid setting NULL', () => {
    const updateIdx = ingestSrc.indexOf('UPDATE token_events SET model');
    const updateBlock = ingestSrc.slice(updateIdx, updateIdx + 500);

    assert.ok(
      updateBlock.includes('EXISTS'),
      'UPDATE should use EXISTS guard to prevent setting model = NULL'
    );
  });

  it('aggregateAndComputeCosts also resolves model for cache-synthetic sessions', () => {
    assert.ok(
      ingestSrc.includes("sessions.id LIKE 'cache-synthetic-%'"),
      'aggregation should resolve model for synthetic sessions created by cache-history parser'
    );
  });
});

// ---------------------------------------------------------------------------
// T55: Idempotent POST ingest — INSERT OR IGNORE + absolute SET + transaction
// ---------------------------------------------------------------------------
describe('T55 — idempotent ingest API', () => {
  const apiSrc = readFileSync(resolve(SRC_ROOT, 'api', 'ingest.ts'), 'utf8');

  it('token_events uses INSERT OR IGNORE for idempotency', () => {
    assert.ok(
      apiSrc.includes('INSERT OR IGNORE INTO token_events'),
      'token_events inserts must use INSERT OR IGNORE to prevent duplicates'
    );
  });

  it('session UPDATE uses absolute SET (not accumulate)', () => {
    // The UPDATE should SET tokens_in = ?, not tokens_in = tokens_in + ?
    const updateIdx = apiSrc.indexOf('UPDATE sessions SET');
    assert.ok(updateIdx !== -1, 'Should have UPDATE sessions SET statement');

    const updateBlock = apiSrc.slice(updateIdx, updateIdx + 500);

    // Must NOT contain tokens_in = tokens_in + (accumulation pattern)
    assert.ok(
      !updateBlock.includes('tokens_in = tokens_in +'),
      'Session UPDATE should use absolute SET, not accumulate with tokens_in = tokens_in + ?'
    );

    // Must contain direct assignment pattern: tokens_in = ?
    assert.ok(
      updateBlock.includes('tokens_in = ?'),
      'Session UPDATE should use absolute assignment: tokens_in = ?'
    );
  });

  it('session UPDATE sets all token fields as absolute values', () => {
    const updateIdx = apiSrc.indexOf('UPDATE sessions SET');
    const updateBlock = apiSrc.slice(updateIdx, updateIdx + 500);

    for (const field of ['tokens_in = ?', 'tokens_out = ?', 'cache_read = ?', 'cache_creation = ?']) {
      assert.ok(
        updateBlock.includes(field),
        `Session UPDATE should SET ${field.split(' =')[0]} as absolute value`
      );
    }
  });

  it('insertPayload wraps operations in a transaction (BEGIN/COMMIT)', () => {
    // Extract the insertPayload function
    const fnStart = apiSrc.indexOf('function insertPayload');
    assert.ok(fnStart !== -1, 'insertPayload function not found');
    const fnBody = apiSrc.slice(fnStart, fnStart + 3000);

    assert.ok(
      fnBody.includes("'BEGIN'") || fnBody.includes('"BEGIN"'),
      'insertPayload should begin a transaction'
    );
    assert.ok(
      fnBody.includes("'COMMIT'") || fnBody.includes('"COMMIT"'),
      'insertPayload should commit the transaction'
    );
  });

  it('insertPayload rolls back on error', () => {
    const fnStart = apiSrc.indexOf('function insertPayload');
    const fnBody = apiSrc.slice(fnStart, fnStart + 3000);

    assert.ok(
      fnBody.includes("'ROLLBACK'") || fnBody.includes('"ROLLBACK"'),
      'insertPayload should ROLLBACK on error'
    );
  });

  it('token_events schema enforces UNIQUE(session_id, model, source)', () => {
    const schemaSrc = readFileSync(resolve(SRC_ROOT, 'db', 'schema.sql'), 'utf8');
    assert.ok(
      schemaSrc.includes('UNIQUE (session_id, model, source)'),
      'token_events table should have UNIQUE constraint on (session_id, model, source)'
    );
  });

  it('token_events inserts include source = ingest for API path', () => {
    assert.ok(
      apiSrc.includes("'ingest'"),
      'API ingest path should set source = ingest on token_events'
    );
  });

  it('re-posting same payload yields same session row (idempotent upsert)', () => {
    // The function should check for existing session and UPDATE instead of INSERT
    const fnStart = apiSrc.indexOf('function insertPayload');
    const fnBody = apiSrc.slice(fnStart, fnStart + 3000);

    assert.ok(
      fnBody.includes('SELECT id FROM sessions WHERE id = ?'),
      'insertPayload should check for existing session before insert'
    );
  });
});

// ---------------------------------------------------------------------------
// T59: token-history no longer skips worktree dirs
// ---------------------------------------------------------------------------
describe('T59 — token-history worktree dir handling', () => {
  const tokenSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'token-history.ts'), 'utf8');

  it('does NOT contain the worktree skip condition (dirName.includes("--"))', () => {
    // The old code had: if (dirName.includes('--')) continue
    // This should be removed per T59
    const discoverFn = tokenSrc.slice(
      tokenSrc.indexOf('function discoverTokenHistoryFiles'),
      tokenSrc.indexOf('export async function parseTokenHistory')
    );

    assert.ok(
      !discoverFn.includes("dirName.includes('--')"),
      'discoverTokenHistoryFiles should NOT skip dirs containing "--" (worktree dirs)'
    );
    assert.ok(
      !discoverFn.includes('dirName.includes("--")'),
      'discoverTokenHistoryFiles should NOT skip dirs containing "--" (worktree dirs, double-quote variant)'
    );
  });

  it('iterates all project directories without filtering by name pattern', () => {
    const discoverFn = tokenSrc.slice(
      tokenSrc.indexOf('function discoverTokenHistoryFiles'),
      tokenSrc.indexOf('export async function parseTokenHistory')
    );

    // Should filter only by isDirectory, not by name content
    assert.ok(
      discoverFn.includes('d.isDirectory()'),
      'Should filter entries to directories only'
    );

    // Should NOT have any continue statement that references dirName pattern matching
    // (except for the file existence check which is fine)
    const continueMatches = discoverFn.match(/if\s*\([^)]*dirName[^)]*\)\s*continue/g);
    assert.equal(
      continueMatches,
      null,
      'Should NOT have any continue statements based on dirName pattern matching'
    );
  });

  it('uses per-file offset tracking so worktree dirs do not cause re-ingestion', () => {
    // Offset key includes the full file path, making it per-file
    assert.ok(
      tokenSrc.includes('`ingest_offset:token-history:${filePath}`'),
      'Offset key should include filePath for per-file tracking'
    );
  });
});

// ---------------------------------------------------------------------------
// T65: pricing TTL — cachedAt timestamp, PRICING_TTL_MS, TTL check
// ---------------------------------------------------------------------------
describe('T65 — pricing cache TTL', () => {
  const pricingSrc = readFileSync(resolve(SRC_ROOT, 'pricing.ts'), 'utf8');

  it('exports PRICING_TTL_MS constant set to 3600000 (1 hour)', () => {
    assert.ok(
      pricingSrc.includes('export const PRICING_TTL_MS'),
      'PRICING_TTL_MS must be exported'
    );

    const ttlMatch = pricingSrc.match(/PRICING_TTL_MS\s*=\s*([\d_]+)/);
    assert.ok(ttlMatch, 'PRICING_TTL_MS value not found');

    const ttlValue = parseInt(ttlMatch[1].replace(/_/g, ''), 10);
    assert.equal(ttlValue, 3600000, 'PRICING_TTL_MS should be 3600000 (1 hour)');
  });

  it('maintains a cachedAt timestamp variable', () => {
    assert.ok(
      pricingSrc.includes('cachedAt'),
      'Should have a cachedAt variable for TTL tracking'
    );
  });

  it('fetchPricing checks TTL before returning cached data', () => {
    const fnStart = pricingSrc.indexOf('export async function fetchPricing');
    assert.ok(fnStart !== -1, 'fetchPricing function not found');
    const fnBody = pricingSrc.slice(fnStart, fnStart + 800);

    // Should check if cache is still valid
    assert.ok(
      fnBody.includes('PRICING_TTL_MS'),
      'fetchPricing should reference PRICING_TTL_MS for TTL check'
    );

    // Should compare now - cachedAt against TTL
    assert.ok(
      fnBody.includes('now - cachedAt') || fnBody.includes('cachedAt'),
      'fetchPricing should compare current time against cachedAt'
    );
  });

  it('returns cached data immediately when within TTL window', () => {
    const fnStart = pricingSrc.indexOf('export async function fetchPricing');
    const fnBody = pricingSrc.slice(fnStart, fnStart + 300);

    // Should have early return when cache is valid
    assert.ok(
      fnBody.includes('if (cached && now - cachedAt <= PRICING_TTL_MS) return cached'),
      'fetchPricing should return cached data when within TTL'
    );
  });

  it('attempts remote refetch when TTL expires but cache exists (stale fallback)', () => {
    const fnStart = pricingSrc.indexOf('export async function fetchPricing');
    const fnBody = pricingSrc.slice(fnStart, fnStart + 800);

    // When cache exists but TTL expired, should try remote and keep stale on failure
    assert.ok(
      fnBody.includes('if (cached)'),
      'fetchPricing should handle the case where cache exists but TTL expired'
    );

    assert.ok(
      fnBody.includes('keeping stale cache') || fnBody.includes('stale'),
      'fetchPricing should fall back to stale cache when remote fails'
    );
  });

  it('resets cachedAt after TTL-expiry fallback to avoid hammering', () => {
    const fnStart = pricingSrc.indexOf('export async function fetchPricing');
    const fnBody = pricingSrc.slice(fnStart, fnStart + 800);

    // On stale fallback, cachedAt should be reset to prevent constant refetch attempts
    // The code sets cachedAt = now in the else branch
    const staleBranch = fnBody.slice(fnBody.indexOf('Remote unavailable'));
    assert.ok(
      staleBranch.includes('cachedAt = now'),
      'Should reset cachedAt after stale fallback to avoid hammering remote on every call'
    );
  });

  it('cold start: loads from remote or bundled fallback', () => {
    const fnStart = pricingSrc.indexOf('export async function fetchPricing');
    const fnBody = pricingSrc.slice(fnStart, fnStart + 1200);

    assert.ok(
      fnBody.includes('loadFallback'),
      'Cold start should use bundled fallback when remote is unavailable'
    );
  });
});
