/**
 * Wave-3 tests for T57 and T68.
 *
 * T57: Bearer token auth on POST /api/ingest via resolveIngestSecret().
 *      - resolveIngestSecret checks DEEPFLOW_INGEST_SECRET env, then .deepflow/config.yaml
 *      - Returns 401 when secret is configured but bearer is missing/wrong
 *      - Allows 200 when bearer matches
 *      - Skips auth entirely when no secret is configured
 *      - backfill.ts threads secret through to POST Authorization header
 *
 * T68: GET /api/quota/history endpoint.
 *      - Accepts ?window_type= and ?days= query params
 *      - Queries quota_snapshots WHERE captured_at > cutoff ORDER BY captured_at
 *      - Returns utilization_pct alongside rows
 *      - QuotaStatus.tsx consumes the /api/quota/history response shape
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
// T57: resolveIngestSecret + bearer auth enforcement on POST /api/ingest
// ---------------------------------------------------------------------------
describe('T57 — bearer token auth on POST /api/ingest', () => {
  const ingestSrc = readFileSync(resolve(SRC_ROOT, 'api', 'ingest.ts'), 'utf8');
  const backfillSrc = readFileSync(resolve(SRC_ROOT, 'backfill.ts'), 'utf8');

  // -- resolveIngestSecret source priority --

  it('resolveIngestSecret checks DEEPFLOW_INGEST_SECRET env var first', () => {
    const fnStart = ingestSrc.indexOf('function resolveIngestSecret');
    assert.ok(fnStart !== -1, 'resolveIngestSecret function not found');
    const fnBody = ingestSrc.slice(fnStart, fnStart + 600);

    assert.ok(
      fnBody.includes('process.env.DEEPFLOW_INGEST_SECRET'),
      'resolveIngestSecret should check DEEPFLOW_INGEST_SECRET env var'
    );

    // Env var check must come before config.yaml check
    const envIdx = fnBody.indexOf('process.env.DEEPFLOW_INGEST_SECRET');
    const configIdx = fnBody.indexOf('config.yaml');
    assert.ok(
      envIdx < configIdx,
      'Env var should be checked before config.yaml (priority order)'
    );
  });

  it('resolveIngestSecret falls back to .deepflow/config.yaml', () => {
    const fnStart = ingestSrc.indexOf('function resolveIngestSecret');
    const fnBody = ingestSrc.slice(fnStart, fnStart + 600);

    assert.ok(
      fnBody.includes("'.deepflow', 'config.yaml'") || fnBody.includes("'.deepflow', \"config.yaml\""),
      'resolveIngestSecret should resolve .deepflow/config.yaml path'
    );
  });

  it('resolveIngestSecret uses regex to extract ingest_secret from YAML', () => {
    const fnStart = ingestSrc.indexOf('function resolveIngestSecret');
    const fnBody = ingestSrc.slice(fnStart, fnStart + 600);

    // Should use a regex pattern that matches ingest_secret: value
    assert.ok(
      fnBody.includes('ingest_secret'),
      'Should look for ingest_secret key in config.yaml'
    );
    assert.ok(
      fnBody.includes('.match('),
      'Should use regex match to extract the secret value'
    );
  });

  it('resolveIngestSecret regex handles quoted and unquoted values', () => {
    const fnStart = ingestSrc.indexOf('function resolveIngestSecret');
    const fnBody = ingestSrc.slice(fnStart, fnStart + 600);

    // The regex pattern should account for optional quotes around the value
    const regexMatch = fnBody.match(/raw\.match\(([^)]+)\)/);
    assert.ok(regexMatch, 'Should have a raw.match() call');

    const regexStr = regexMatch[1];
    // The regex should handle both quoted and unquoted secret values
    assert.ok(
      regexStr.includes("[\"']?"),
      'Regex should handle optional quotes around the secret value'
    );
  });

  it('resolveIngestSecret returns undefined when no secret is configured', () => {
    const fnStart = ingestSrc.indexOf('function resolveIngestSecret');
    const fnBody = ingestSrc.slice(fnStart, fnStart + 600);

    assert.ok(
      fnBody.includes('return undefined'),
      'resolveIngestSecret should return undefined when no secret is found'
    );
  });

  // -- Auth enforcement in router --

  it('router checks Authorization header when secret is configured', () => {
    // The auth block sits after rate limiting in the router handler
    const authStart = ingestSrc.indexOf('Bearer token auth');
    assert.ok(authStart !== -1, 'Bearer token auth comment not found');
    const authBlock = ingestSrc.slice(authStart, authStart + 300);

    assert.ok(
      authBlock.includes("'Authorization'") || authBlock.includes('"Authorization"'),
      'Router should check Authorization header'
    );
  });

  it('router extracts bearer token from Authorization header', () => {
    const authStart = ingestSrc.indexOf('Bearer token auth');
    const authBlock = ingestSrc.slice(authStart, authStart + 300);

    assert.ok(
      authBlock.includes("'Bearer '") || authBlock.includes('"Bearer "'),
      'Router should look for Bearer prefix in Authorization header'
    );

    // Should extract the token after "Bearer "
    assert.ok(
      authBlock.includes('.slice(7)'),
      'Router should extract token by slicing after "Bearer " (7 chars)'
    );
  });

  it('returns 401 when secret is configured but token does not match', () => {
    const authStart = ingestSrc.indexOf('Bearer token auth');
    const authBlock = ingestSrc.slice(authStart, authStart + 300);

    assert.ok(
      authBlock.includes('401'),
      'Router should return 401 for unauthorized requests'
    );
    assert.ok(
      authBlock.includes("'Unauthorized'") || authBlock.includes('"Unauthorized"'),
      'Router should return Unauthorized error message'
    );
  });

  it('returns 401 when secret is configured but Authorization header is missing', () => {
    const authStart = ingestSrc.indexOf('Bearer token auth');
    const authBlock = ingestSrc.slice(authStart, authStart + 300);

    // When header is missing, the extracted token will be empty string
    // which won't match the secret, so 401 is returned
    assert.ok(
      authBlock.includes("c.req.header('Authorization') ?? ''") ||
      authBlock.includes('c.req.header("Authorization") ?? ""'),
      'Missing Authorization header should default to empty string'
    );

    // token !== secret check covers both wrong and missing cases
    assert.ok(
      authBlock.includes('token !== secret'),
      'Should compare extracted token against the configured secret'
    );
  });

  it('skips auth entirely when no secret is configured', () => {
    const authStart = ingestSrc.indexOf('Bearer token auth');
    const authBlock = ingestSrc.slice(authStart, authStart + 300);

    // The auth block is guarded by `if (secret)`
    assert.ok(
      authBlock.includes('if (secret)'),
      'Auth check should be gated by if (secret) — skipped when undefined'
    );
  });

  it('resolves secret once at router creation, not per-request', () => {
    // Secret resolution happens in createIngestRouter, not inside the route handler
    const createFnStart = ingestSrc.indexOf('export function createIngestRouter');
    assert.ok(createFnStart !== -1, 'createIngestRouter function not found');
    const createFnBody = ingestSrc.slice(createFnStart, createFnStart + 300);

    assert.ok(
      createFnBody.includes('resolveIngestSecret()'),
      'Secret should be resolved once in createIngestRouter'
    );

    // The handler closure captures `secret`, not calling resolveIngestSecret again
    const handlerStart = ingestSrc.indexOf("router.post('/'");
    const handlerBody = ingestSrc.slice(handlerStart, handlerStart + 500);
    assert.ok(
      !handlerBody.includes('resolveIngestSecret'),
      'Handler should use captured secret, not call resolveIngestSecret per-request'
    );
  });

  // -- backfill.ts threads secret --

  it('backfill postBatch accepts optional secret parameter', () => {
    assert.ok(
      backfillSrc.includes('secret?: string'),
      'postBatch should accept an optional secret parameter'
    );
  });

  it('backfill sets Authorization: Bearer header when secret is provided', () => {
    const postFnStart = backfillSrc.indexOf('async function postBatch');
    assert.ok(postFnStart !== -1, 'postBatch function not found');
    const postFnBody = backfillSrc.slice(postFnStart, postFnStart + 800);

    assert.ok(
      postFnBody.includes('if (secret)'),
      'postBatch should conditionally add auth header'
    );
    assert.ok(
      postFnBody.includes('`Bearer ${secret}`'),
      'postBatch should format Authorization header as Bearer token'
    );
    assert.ok(
      postFnBody.includes("'Authorization'") || postFnBody.includes('"Authorization"'),
      'postBatch should set Authorization header'
    );
  });

  it('backfill runBackfill resolves secret from opts or env', () => {
    const runFnStart = backfillSrc.indexOf('export async function runBackfill');
    assert.ok(runFnStart !== -1, 'runBackfill function not found');
    const runFnBody = backfillSrc.slice(runFnStart, runFnStart + 500);

    assert.ok(
      runFnBody.includes('opts.secret ?? process.env.DEEPFLOW_INGEST_SECRET'),
      'runBackfill should resolve secret from opts.secret or DEEPFLOW_INGEST_SECRET env'
    );
  });

  it('backfill passes secret through to sendInBatchesWithOffset', () => {
    const runFnStart = backfillSrc.indexOf('export async function runBackfill');
    const runFnBody = backfillSrc.slice(runFnStart, runFnStart + 2000);

    // sendInBatchesWithOffset calls should include secret as last arg
    const sendCalls = runFnBody.match(/sendInBatchesWithOffset\(/g);
    assert.ok(sendCalls && sendCalls.length >= 2, 'runBackfill should call sendInBatchesWithOffset at least twice');

    // Extract both call blocks and verify secret is passed
    let searchFrom = runFnStart;
    for (let i = 0; i < 2; i++) {
      const callIdx = backfillSrc.indexOf('sendInBatchesWithOffset(', searchFrom);
      const callEnd = backfillSrc.indexOf(');', callIdx);
      const callBlock = backfillSrc.slice(callIdx, callEnd);
      assert.ok(
        callBlock.includes('secret'),
        `sendInBatchesWithOffset call #${i + 1} should pass secret`
      );
      searchFrom = callEnd + 1;
    }
  });

  it('BackfillOptions interface includes secret field', () => {
    assert.ok(
      backfillSrc.includes('export interface BackfillOptions'),
      'BackfillOptions interface should be exported'
    );
    const ifaceStart = backfillSrc.indexOf('export interface BackfillOptions');
    const ifaceEnd = backfillSrc.indexOf('}', ifaceStart);
    const ifaceBody = backfillSrc.slice(ifaceStart, ifaceEnd);

    assert.ok(
      ifaceBody.includes('secret?:'),
      'BackfillOptions should have an optional secret field'
    );
  });
});

// ---------------------------------------------------------------------------
// T68: GET /api/quota/history endpoint
// ---------------------------------------------------------------------------
describe('T68 — GET /api/quota/history endpoint', () => {
  const quotaSrc = readFileSync(resolve(SRC_ROOT, 'api', 'quota.ts'), 'utf8');
  const quotaStatusSrc = readFileSync(
    resolve(SRC_ROOT, 'client', 'views', 'QuotaStatus.tsx'), 'utf8'
  );

  // -- Endpoint definition --

  it('/history route is defined on quotaRouter', () => {
    assert.ok(
      quotaSrc.includes("quotaRouter.get('/history'") || quotaSrc.includes('quotaRouter.get("/history"'),
      'quotaRouter should define a GET /history route'
    );
  });

  // -- Query parameters --

  it('accepts window_type query parameter', () => {
    const historyStart = quotaSrc.indexOf("'/history'") || quotaSrc.indexOf('"/history"');
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    assert.ok(
      historyBody.includes("c.req.query('window_type')") || historyBody.includes('c.req.query("window_type")'),
      '/history should read window_type query parameter'
    );
  });

  it('accepts days query parameter with default of 7', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    assert.ok(
      historyBody.includes("c.req.query('days')") || historyBody.includes('c.req.query("days")'),
      '/history should read days query parameter'
    );

    // Default should be 7
    assert.ok(
      historyBody.includes("?? '7'") || historyBody.includes('?? "7"'),
      'days should default to 7 when not provided'
    );
  });

  // -- SQL query structure --

  it('queries quota_snapshots table', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    assert.ok(
      historyBody.includes('FROM quota_snapshots'),
      '/history should query quota_snapshots table'
    );
  });

  it('filters by captured_at > cutoff date', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    assert.ok(
      historyBody.includes('captured_at > ?'),
      'Query should filter by captured_at > cutoff'
    );
  });

  it('computes cutoff from days parameter', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    // cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    assert.ok(
      historyBody.includes('days * 24 * 60 * 60 * 1000'),
      'Cutoff should be computed as days * 24 * 60 * 60 * 1000'
    );
  });

  it('optionally filters by window_type when provided', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    // When windowType is provided, it adds a condition
    assert.ok(
      historyBody.includes("'window_type = ?'") || historyBody.includes('"window_type = ?"'),
      'Query should optionally filter by window_type when provided'
    );

    // Should conditionally push, not always include
    assert.ok(
      historyBody.includes('if (windowType)'),
      'window_type filter should only be added when param is present'
    );
  });

  it('orders results by captured_at', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    assert.ok(
      historyBody.includes('ORDER BY captured_at'),
      'Results should be ordered by captured_at'
    );
  });

  it('selects captured_at, window_type, used, and limit_val columns', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    for (const col of ['captured_at', 'window_type', 'used', 'limit_val']) {
      assert.ok(
        historyBody.includes(col),
        `Query should select ${col} column`
      );
    }
  });

  // -- Response shape --

  it('response includes utilization_pct computed from used/limit_val', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 800);

    assert.ok(
      historyBody.includes('utilization_pct'),
      'Response should include utilization_pct field'
    );

    // utilization_pct = Math.round((used / limit_val) * 1000) / 10
    assert.ok(
      historyBody.includes('r.used') && historyBody.includes('r.limit_val'),
      'utilization_pct should be computed from used and limit_val'
    );
  });

  it('response wraps rows in { data } envelope', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 1000);

    // Uses JS shorthand: c.json({ data }) which is equivalent to { data: data }
    assert.ok(
      historyBody.includes('c.json({ data }'),
      'Response should wrap data in { data } envelope via shorthand property'
    );
  });

  it('utilization_pct falls back to null when limit_val is falsy and used is zero', () => {
    const historyStart = quotaSrc.indexOf("'/history'");
    const historyBody = quotaSrc.slice(historyStart, historyStart + 1000);

    // The ternary returns null as the final fallback
    assert.ok(
      historyBody.includes(': null'),
      'utilization_pct should be null when no meaningful calculation is possible'
    );
  });

  // -- QuotaStatus.tsx consumes /api/quota/history --

  it('QuotaStatus.tsx defines WindowRow interface with pct fields', () => {
    assert.ok(
      quotaStatusSrc.includes('interface WindowRow'),
      'QuotaStatus should define WindowRow interface'
    );

    const ifaceStart = quotaStatusSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaStatusSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaStatusSrc.slice(ifaceStart, ifaceEnd);

    assert.ok(
      ifaceBody.includes('five_hour_pct'),
      'WindowRow should include five_hour_pct field'
    );
    assert.ok(
      ifaceBody.includes('startedAt'),
      'WindowRow should include startedAt field'
    );
    assert.ok(
      ifaceBody.includes('isActive'),
      'WindowRow should include isActive field'
    );
  });

  it('QuotaStatus.tsx defines WindowsResponse with data array', () => {
    assert.ok(
      quotaStatusSrc.includes('interface WindowsResponse'),
      'QuotaStatus should define WindowsResponse interface'
    );

    const ifaceStart = quotaStatusSrc.indexOf('interface WindowsResponse');
    const ifaceEnd = quotaStatusSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaStatusSrc.slice(ifaceStart, ifaceEnd);

    assert.ok(
      ifaceBody.includes('data: WindowRow[]'),
      'WindowsResponse should have data: WindowRow[]'
    );
  });

  it('WindowRow pct fields allow null (for missing match cases)', () => {
    const ifaceStart = quotaStatusSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaStatusSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaStatusSrc.slice(ifaceStart, ifaceEnd);

    assert.ok(
      ifaceBody.includes('number | null'),
      'pct fields in WindowRow should be typed as number | null'
    );
  });
});
