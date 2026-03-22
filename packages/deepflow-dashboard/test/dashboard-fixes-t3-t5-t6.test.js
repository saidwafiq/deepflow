/**
 * Wave-3 unit tests for dashboard-fixes T3, T5, T6.
 *
 * T3: aggregateAndComputeCosts is removed; computeSessionCosts only sets cost
 *     where cost = 0 or NULL — never overwrites tokens_in/tokens_out/cache_read/
 *     cache_creation.
 *
 * T5: Cache API (/api/cache) returns AVG(cache_hit_ratio) from stored column,
 *     not derived from token columns. Daily trend also uses stored values.
 *
 * T6: SessionList renders exactly 8 <th> elements. Removed columns:
 *     cache_read, cache_creation, messages, tool_calls, tokens_out, user.
 *     Added columns: agent_role, cache_hit_ratio (Cache Hit %).
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_ROOT = resolve(ROOT, 'src');

// ===========================================================================
// T3: aggregateAndComputeCosts removed, computeSessionCosts is the replacement
// ===========================================================================
describe('T3 — aggregateAndComputeCosts removed, computeSessionCosts replaces it', () => {
  const ingestSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'index.ts'), 'utf8');

  it('aggregateAndComputeCosts function no longer exists in ingest/index.ts', () => {
    assert.ok(
      !ingestSrc.includes('aggregateAndComputeCosts'),
      'aggregateAndComputeCosts should be completely removed'
    );
  });

  it('computeSessionCosts function exists in ingest/index.ts', () => {
    assert.ok(
      ingestSrc.includes('async function computeSessionCosts'),
      'computeSessionCosts should be defined as an async function'
    );
  });

  it('computeSessionCosts is called in the ingest pipeline', () => {
    assert.ok(
      ingestSrc.includes('await computeSessionCosts()'),
      'computeSessionCosts should be called during ingestion'
    );
  });

  it('computeSessionCosts only targets sessions where cost = 0 or cost IS NULL', () => {
    // The SQL query should filter for sessions with zero or null cost
    assert.ok(
      ingestSrc.includes('cost = 0 OR cost IS NULL'),
      'computeSessionCosts should only update sessions with cost = 0 or NULL'
    );
  });

  it('computeSessionCosts requires tokens_in > 0 OR tokens_out > 0 before computing', () => {
    assert.ok(
      ingestSrc.includes('tokens_in > 0 OR tokens_out > 0'),
      'computeSessionCosts should skip sessions with zero tokens'
    );
  });

  it('computeSessionCosts only UPDATEs cost column, not token columns', () => {
    // Extract the computeSessionCosts function body
    const fnStart = ingestSrc.indexOf('async function computeSessionCosts');
    assert.ok(fnStart !== -1, 'computeSessionCosts should exist');
    const fnEnd = ingestSrc.indexOf('\n}', fnStart + 50);
    const fnBody = ingestSrc.slice(fnStart, fnEnd);

    // The UPDATE should only set cost
    assert.ok(
      fnBody.includes('UPDATE sessions SET cost = ?'),
      'UPDATE should only set the cost column'
    );

    // It should NOT contain UPDATE statements that write token columns
    const updateStatements = fnBody.split('UPDATE sessions SET');
    for (const stmt of updateStatements.slice(1)) {
      const setCols = stmt.split('WHERE')[0];
      assert.ok(
        !setCols.includes('tokens_in ='),
        'computeSessionCosts should NOT overwrite tokens_in'
      );
      assert.ok(
        !setCols.includes('tokens_out ='),
        'computeSessionCosts should NOT overwrite tokens_out'
      );
      assert.ok(
        !setCols.includes('cache_read ='),
        'computeSessionCosts should NOT overwrite cache_read'
      );
      assert.ok(
        !setCols.includes('cache_creation ='),
        'computeSessionCosts should NOT overwrite cache_creation'
      );
    }
  });

  it('no token_events aggregation SQL exists in computeSessionCosts', () => {
    // The old aggregateAndComputeCosts had SUM queries on token_events
    // The new function reads from sessions directly
    const fnStart = ingestSrc.indexOf('async function computeSessionCosts');
    const fnEnd = ingestSrc.indexOf('\n}', fnStart + 50);
    const fnBody = ingestSrc.slice(fnStart, fnEnd);

    assert.ok(
      !fnBody.includes('token_events'),
      'computeSessionCosts should not reference token_events table'
    );
    assert.ok(
      !fnBody.includes('SUM('),
      'computeSessionCosts should not aggregate token_events with SUM'
    );
  });

  it('computeSessionCosts reads tokens from sessions table (SELECT)', () => {
    const fnStart = ingestSrc.indexOf('async function computeSessionCosts');
    const fnEnd = ingestSrc.indexOf('\n}', fnStart + 50);
    const fnBody = ingestSrc.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('SELECT') && fnBody.includes('FROM sessions'),
      'computeSessionCosts should SELECT from sessions table'
    );
    assert.ok(
      fnBody.includes('tokens_in') && fnBody.includes('tokens_out'),
      'computeSessionCosts should read token columns from sessions'
    );
  });

  it('cost computation uses pricing-based formula (per-million tokens)', () => {
    const fnStart = ingestSrc.indexOf('async function computeSessionCosts');
    const fnEnd = ingestSrc.indexOf('\n}', fnStart + 50);
    const fnBody = ingestSrc.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('1_000_000'),
      'Cost computation should divide by 1_000_000 (per-million pricing)'
    );
    assert.ok(
      fnBody.includes('fetchPricing'),
      'computeSessionCosts should use fetchPricing for model prices'
    );
  });
});

// ===========================================================================
// T5: Cache API uses stored cache_hit_ratio, not derived from tokens
// ===========================================================================
describe('T5 — cache API uses stored cache_hit_ratio', () => {
  const cacheSrc = readFileSync(resolve(SRC_ROOT, 'api', 'cache.ts'), 'utf8');

  it('overall hit ratio uses AVG(cache_hit_ratio) from sessions', () => {
    assert.ok(
      cacheSrc.includes('AVG('),
      'Cache API should use AVG() for cache_hit_ratio'
    );
    assert.ok(
      cacheSrc.includes('cache_hit_ratio'),
      'Cache API should reference cache_hit_ratio column'
    );
  });

  it('overall hit ratio does NOT compute from token columns (no division formula)', () => {
    // The old formula was: cache_read / (total_input + cache_read)
    // There should be no such division in the hit ratio computation
    const hitRatioLine = cacheSrc.split('\n').find(l =>
      l.includes('hitRatio') && l.includes('=') && !l.includes('//')
    );
    assert.ok(hitRatioLine, 'hitRatio assignment should exist');
    assert.ok(
      !hitRatioLine.includes('totalCacheRead / ') &&
      !hitRatioLine.includes('/ denominator') &&
      !hitRatioLine.includes('totalInput +'),
      'hitRatio should not be computed from token columns via division'
    );
  });

  it('hitRatio is assigned from avg_cache_hit_ratio query result', () => {
    assert.ok(
      cacheSrc.includes('avg_cache_hit_ratio'),
      'Cache API should extract avg_cache_hit_ratio from SQL result'
    );
    assert.ok(
      cacheSrc.includes('totals.avg_cache_hit_ratio'),
      'hitRatio should be read from totals.avg_cache_hit_ratio'
    );
  });

  it('daily trend uses AVG(cache_hit_ratio) per day, not token-derived formula', () => {
    // The daily SQL should use AVG on cache_hit_ratio, with a CASE WHEN for NULLs
    assert.ok(
      cacheSrc.includes("AVG(CASE WHEN cache_hit_ratio IS NOT NULL"),
      'Daily trend should use AVG(CASE WHEN cache_hit_ratio IS NOT NULL ...) to skip NULLs'
    );
  });

  it('daily trend query aliases the result as hit_ratio', () => {
    assert.ok(
      cacheSrc.includes('AS hit_ratio'),
      'Daily trend AVG result should be aliased as hit_ratio'
    );
  });

  it('no denominator variable exists for token-based hit ratio computation', () => {
    assert.ok(
      !cacheSrc.includes('denominator'),
      'There should be no denominator variable (old token-based formula is gone)'
    );
  });

  it('overall query selects avg_cache_hit_ratio alongside token totals', () => {
    // The SELECT should include both token sums and AVG(cache_hit_ratio)
    assert.ok(
      cacheSrc.includes('SUM(tokens_in)') &&
      cacheSrc.includes('SUM(cache_read)') &&
      cacheSrc.includes('AVG(CASE WHEN cache_hit_ratio IS NOT NULL'),
      'Overall query should select token sums and AVG(cache_hit_ratio) together'
    );
  });

  it('hitRatio defaults to 0 when avg_cache_hit_ratio is null', () => {
    assert.ok(
      cacheSrc.includes('?? 0'),
      'hitRatio should default to 0 via nullish coalescing when no sessions have cache_hit_ratio'
    );
  });
});

// ===========================================================================
// T5 (runtime): Cache API returns correct values from stored cache_hit_ratio
// ===========================================================================
describe('T5 (runtime) — cache API returns AVG of stored cache_hit_ratio', () => {
  let app;

  before(async () => {
    const { initDatabase, run } = await import(resolve(ROOT, 'dist', 'db', 'index.js'));
    const { createApiRouter } = await import(resolve(ROOT, 'dist', 'api', 'index.js'));
    const { Hono } = await import('hono');

    await initDatabase('serve');

    // Clean test data
    run("DELETE FROM sessions WHERE user = 't5user'");

    // Insert sessions with known cache_hit_ratio values
    const baseDate = '2026-03-21';
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, cache_hit_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['t5-sess-1', 't5user', 'proj', 'claude-sonnet-4-20250514', 1000, 200, 500, 50, 0.05, `${baseDate}T10:00:00Z`, 0.80]
    );
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, cache_hit_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['t5-sess-2', 't5user', 'proj', 'claude-sonnet-4-20250514', 2000, 400, 100, 10, 0.10, `${baseDate}T11:00:00Z`, 0.40]
    );
    // Session with NULL cache_hit_ratio — should be excluded from AVG
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, cache_hit_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['t5-sess-3', 't5user', 'proj', 'claude-sonnet-4-20250514', 500, 100, 800, 200, 0.03, `${baseDate}T12:00:00Z`, null]
    );

    app = new Hono();
    app.route('/api', createApiRouter({ mode: 'serve' }));
  });

  it('hit_ratio reflects AVG of stored cache_hit_ratio, not token-based computation', async () => {
    const res = await app.request('/api/cache?user=t5user&days=30');
    assert.equal(res.status, 200);
    const json = await res.json();

    // AVG of 0.80 and 0.40 (NULL excluded) = 0.60
    // Returned as percentage with 2 decimal places: 60.00
    const expectedPct = 60.00;
    assert.ok(
      Math.abs(json.summary.hit_ratio - expectedPct) < 0.1,
      `hit_ratio should be ~${expectedPct}% (AVG of stored values), got ${json.summary.hit_ratio}%`
    );
  });

  it('hit_ratio does NOT equal a token-derived value', async () => {
    const res = await app.request('/api/cache?user=t5user&days=30');
    const json = await res.json();

    // If it were token-derived: cache_read / (tokens_in + cache_read) = (500+100+800) / (1000+2000+500 + 500+100+800) = 1400/4900 ≈ 28.57%
    const tokenDerived = (1400 / 4900) * 100;
    assert.ok(
      Math.abs(json.summary.hit_ratio - tokenDerived) > 1.0,
      `hit_ratio (${json.summary.hit_ratio}) should differ from token-derived value (${tokenDerived.toFixed(2)})`
    );
  });

  it('daily trend entries have hit_ratio from stored values', async () => {
    const res = await app.request('/api/cache?user=t5user&days=30');
    const json = await res.json();

    assert.ok(json.daily.length > 0, 'Daily trend should have entries');
    const dayEntry = json.daily.find(d => d.day === '2026-03-21');
    assert.ok(dayEntry, 'Should have entry for 2026-03-21');
    assert.ok(
      dayEntry.hit_ratio !== null && dayEntry.hit_ratio !== undefined,
      'Daily trend entry should have hit_ratio'
    );
    // AVG of 0.80 and 0.40 (NULL excluded) = 0.60
    assert.ok(
      Math.abs(dayEntry.hit_ratio - 0.60) < 0.01,
      `Daily hit_ratio should be ~0.60 (AVG of stored values), got ${dayEntry.hit_ratio}`
    );
  });
});

// ===========================================================================
// T6: SessionList reduced to 8 columns
// ===========================================================================
describe('T6 — SessionList reduced to 8 columns', () => {
  const sessionListSrc = readFileSync(
    resolve(SRC_ROOT, 'client', 'views', 'SessionList.tsx'),
    'utf8'
  );

  it('renders exactly 8 <th> elements (ColHeader + StaticHeader)', () => {
    // Count all ColHeader and StaticHeader usages inside <thead>
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    assert.ok(theadMatch, 'SessionList should have a <thead> block');
    const thead = theadMatch[0];

    const colHeaders = (thead.match(/<ColHeader/g) || []).length;
    const staticHeaders = (thead.match(/<StaticHeader/g) || []).length;
    const totalHeaders = colHeaders + staticHeaders;

    assert.equal(
      totalHeaders,
      8,
      `Expected exactly 8 header components (ColHeader + StaticHeader), got ${totalHeaders}`
    );
  });

  it('has the correct 8 columns: Started, Project, Model, Agent Role, Cache Hit %, Duration, Total Tokens, Cost', () => {
    const expectedColumns = [
      'Started',
      'Project',
      'Model',
      'Agent Role',
      'Cache Hit %',
      'Duration',
      'Total Tokens',
      'Cost',
    ];

    for (const col of expectedColumns) {
      assert.ok(
        sessionListSrc.includes(`"${col}"`),
        `SessionList should have a "${col}" column header`
      );
    }
  });

  it('does NOT have a user column', () => {
    // The old SessionList had a "User" column header
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    const thead = theadMatch[0];
    assert.ok(
      !thead.includes('"User"'),
      'SessionList should NOT have a User column header'
    );
    // Also check there's no s.user rendering in the tbody
    assert.ok(
      !sessionListSrc.includes('{s.user'),
      'SessionList should NOT render s.user in table rows'
    );
  });

  it('does NOT have cache_read column', () => {
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    const thead = theadMatch[0];
    assert.ok(
      !thead.includes('Cache Read') && !thead.includes('cache_read'),
      'SessionList should NOT have a Cache Read column header'
    );
    assert.ok(
      !sessionListSrc.includes('{s.cache_read}') &&
      !sessionListSrc.includes('s.cache_read'),
      'SessionList should NOT reference s.cache_read'
    );
  });

  it('does NOT have cache_creation column', () => {
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    const thead = theadMatch[0];
    assert.ok(
      !thead.includes('Cache Creation') && !thead.includes('cache_creation'),
      'SessionList should NOT have a Cache Creation column header'
    );
    assert.ok(
      !sessionListSrc.includes('{s.cache_creation}') &&
      !sessionListSrc.includes('s.cache_creation'),
      'SessionList should NOT reference s.cache_creation'
    );
  });

  it('does NOT have messages column', () => {
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    const thead = theadMatch[0];
    assert.ok(
      !thead.includes('"Messages"'),
      'SessionList should NOT have a Messages column header'
    );
  });

  it('does NOT have tool_calls column', () => {
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    const thead = theadMatch[0];
    assert.ok(
      !thead.includes('"Tool Calls"') && !thead.includes('tool_calls'),
      'SessionList should NOT have a Tool Calls column header'
    );
  });

  it('does NOT have a standalone tokens_out column', () => {
    // tokens_out should not be its own column header — it's now part of "Total Tokens"
    const theadMatch = sessionListSrc.match(/<thead[\s\S]*?<\/thead>/);
    const thead = theadMatch[0];
    assert.ok(
      !thead.includes('"Tokens Out"') && !thead.includes('"Output Tokens"'),
      'SessionList should NOT have a separate Tokens Out column'
    );
  });

  it('Session interface does NOT include user, messages, tool_calls, cache_read, cache_creation', () => {
    // Extract the Session interface
    const ifaceMatch = sessionListSrc.match(/interface Session \{[\s\S]*?\}/);
    assert.ok(ifaceMatch, 'Session interface should exist');
    const iface = ifaceMatch[0];

    const removedFields = ['user:', 'messages:', 'tool_calls:', 'cache_read:', 'cache_creation:'];
    for (const field of removedFields) {
      assert.ok(
        !iface.includes(field),
        `Session interface should NOT include ${field}`
      );
    }
  });

  it('Session interface includes agent_role and cache_hit_ratio', () => {
    const ifaceMatch = sessionListSrc.match(/interface Session \{[\s\S]*?\}/);
    const iface = ifaceMatch[0];

    assert.ok(iface.includes('agent_role'), 'Session interface should include agent_role');
    assert.ok(iface.includes('cache_hit_ratio'), 'Session interface should include cache_hit_ratio');
  });

  it('SortKey type only includes started_at, cost, duration_ms, tokens_in', () => {
    const sortKeyMatch = sessionListSrc.match(/type SortKey\s*=\s*([^;]+);/);
    assert.ok(sortKeyMatch, 'SortKey type should exist');
    const sortKeyDef = sortKeyMatch[1];

    const expectedKeys = ['started_at', 'cost', 'duration_ms', 'tokens_in'];
    for (const key of expectedKeys) {
      assert.ok(
        sortKeyDef.includes(`'${key}'`),
        `SortKey should include '${key}'`
      );
    }

    // Removed sort keys
    const removedKeys = ['messages', 'tool_calls', 'tokens_out', 'user'];
    for (const key of removedKeys) {
      assert.ok(
        !sortKeyDef.includes(`'${key}'`),
        `SortKey should NOT include '${key}'`
      );
    }
  });

  it('empty state colSpan is set to 8', () => {
    assert.ok(
      sessionListSrc.includes('colSpan={8}'),
      'Empty state td should span 8 columns'
    );
  });
});
