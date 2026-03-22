/**
 * Unit tests for T2 (cache-history enrichment-only rewrite) and T4
 * (cache_hit_ratio in sessions API).
 *
 * T2 validates:
 *   - parseCacheHistory only UPDATEs existing sessions (no INSERTs)
 *   - Bracket suffixes are stripped from model names
 *   - Last value per session wins when multiple records exist
 *   - Records without a session_id are skipped
 *   - Records referencing unknown sessions are silently skipped (no new rows)
 *   - Malformed JSON lines are skipped without crashing
 *   - Offset tracking via _meta persists across calls
 *
 * T4 validates:
 *   - cache_hit_ratio is included in sessions API allowedFields
 *   - GET /api/sessions?fields=cache_hit_ratio returns the column
 *   - Sessions with cache_hit_ratio set return the value in full rows
 *
 * Strategy: In-memory SQLite via initDatabase() + temp dirs with JSONL fixtures
 * for cache-history, then Hono app.request() for sessions API tests.
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Import from dist (compiled ESM)
const { initDatabase, run, get, all } = await import(resolve(ROOT, 'dist', 'db', 'index.js'));
const { parseCacheHistory } = await import(resolve(ROOT, 'dist', 'ingest', 'parsers', 'cache-history.js'));
const { createApiRouter } = await import(resolve(ROOT, 'dist', 'api', 'index.js'));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpDir;
let app;

/** Create a fresh temp directory for each test suite */
function makeTmpDir() {
  const dir = resolve(tmpdir(), `deepflow-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write cache-history.jsonl with given lines */
function writeCacheHistory(dir, lines) {
  writeFileSync(resolve(dir, 'cache-history.jsonl'), lines.join('\n') + '\n');
}

/** Build db helpers object matching DbHelpers interface */
function dbHelpers() {
  return { run, get, all };
}

/** Seed a session into the DB */
function seedSession(id, opts = {}) {
  const defaults = {
    user: 'testuser',
    project: 'proj',
    model: 'claude-sonnet-4-20250514',
    tokens_in: 100,
    tokens_out: 50,
    cache_read: 0,
    cache_creation: 0,
    cost: 0.01,
    started_at: '2026-03-20T10:00:00Z',
    agent_role: 'unknown',
  };
  const s = { ...defaults, ...opts };
  run(
    `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, s.user, s.project, s.model, s.tokens_in, s.tokens_out, s.cache_read, s.cache_creation, s.cost, s.started_at, s.agent_role]
  );
}

/** Clean up test sessions and reset cache-history offset */
function cleanupTestData() {
  run("DELETE FROM sessions WHERE user = 'testuser'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:cache-history'");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(async () => {
  await initDatabase('serve');

  // Create Hono app for sessions API tests
  const { Hono } = await import('hono');
  app = new Hono();
  app.route('/api', createApiRouter({ mode: 'serve' }));
});

// ===========================================================================
// T2: parseCacheHistory — enrichment-only behavior
// ===========================================================================

describe('T2: parseCacheHistory enrichment-only rewrite', () => {

  afterEach(() => {
    cleanupTestData();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('UPDATEs cache_hit_ratio on existing session (no new rows created)', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-enrich-1');

    const countBefore = all('SELECT COUNT(*) as cnt FROM sessions')[0].cnt;

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-enrich-1', cache_hit_ratio: 0.85, agent_breakdown: { agent_role: 'coder', model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const countAfter = all('SELECT COUNT(*) as cnt FROM sessions')[0].cnt;
    assert.equal(countAfter, countBefore, 'No new sessions should be created');

    const row = get('SELECT cache_hit_ratio, agent_role, model FROM sessions WHERE id = ?', ['sess-enrich-1']);
    assert.equal(row.cache_hit_ratio, 0.85);
    assert.equal(row.agent_role, 'coder');
    assert.equal(row.model, 'claude-sonnet-4-20250514');
  });

  it('does NOT insert sessions for records referencing unknown session IDs', async () => {
    tmpDir = makeTmpDir();

    const countBefore = all('SELECT COUNT(*) as cnt FROM sessions')[0].cnt;

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'non-existent-sess', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'coder', model: 'some-model' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const countAfter = all('SELECT COUNT(*) as cnt FROM sessions')[0].cnt;
    assert.equal(countAfter, countBefore, 'No sessions should be inserted for unknown session IDs');

    const row = get('SELECT * FROM sessions WHERE id = ?', ['non-existent-sess']);
    assert.equal(row, undefined, 'Unknown session should not exist in DB');
  });

  it('skips records without a session_id', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-no-id-test');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ cache_hit_ratio: 0.9, agent_breakdown: { agent_role: 'reviewer', model: 'some-model' } }),
      JSON.stringify({ session_id: 'sess-no-id-test', cache_hit_ratio: 0.7, agent_breakdown: { agent_role: 'coder', model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    // The record without session_id should be skipped; only sess-no-id-test should be updated
    const row = get('SELECT cache_hit_ratio FROM sessions WHERE id = ?', ['sess-no-id-test']);
    assert.equal(row.cache_hit_ratio, 0.7);

    // No synthetic session should be created
    const synthetics = all("SELECT * FROM sessions WHERE id LIKE 'cache-synthetic-%'");
    assert.equal(synthetics.length, 0, 'No synthetic sessions should be created');
  });

  it('strips bracket suffixes from model names (e.g. "claude-opus-4-6[1m]" → "claude-opus-4-6")', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-bracket-1');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-bracket-1', cache_hit_ratio: 0.6, agent_breakdown: { agent_role: 'coder', model: 'claude-opus-4-6[1m]' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-bracket-1']);
    assert.equal(row.model, 'claude-opus-4-6', 'Bracket suffix should be stripped');
  });

  it('strips various bracket patterns from model names', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-bracket-2');
    seedSession('sess-bracket-3');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-bracket-2', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'coder', model: 'claude-sonnet-4-20250514[200k]' } }),
      JSON.stringify({ session_id: 'sess-bracket-3', cache_hit_ratio: 0.4, agent_breakdown: { agent_role: 'reviewer', model: 'some-model[beta]' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row2 = get('SELECT model FROM sessions WHERE id = ?', ['sess-bracket-2']);
    assert.equal(row2.model, 'claude-sonnet-4-20250514');

    const row3 = get('SELECT model FROM sessions WHERE id = ?', ['sess-bracket-3']);
    assert.equal(row3.model, 'some-model');
  });

  it('model without brackets is left unchanged', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-nobracket');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-nobracket', cache_hit_ratio: 0.3, agent_breakdown: { agent_role: 'coder', model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-nobracket']);
    assert.equal(row.model, 'claude-sonnet-4-20250514');
  });

  it('last value per session wins when multiple records exist for same session', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-multi');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-multi', cache_hit_ratio: 0.1, agent_breakdown: { agent_role: 'coder', model: 'model-a[1m]' } }),
      JSON.stringify({ session_id: 'sess-multi', cache_hit_ratio: 0.9, agent_breakdown: { agent_role: 'reviewer', model: 'model-b' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT cache_hit_ratio, agent_role, model FROM sessions WHERE id = ?', ['sess-multi']);
    assert.equal(row.cache_hit_ratio, 0.9, 'Last cache_hit_ratio should win');
    assert.equal(row.agent_role, 'reviewer', 'Last agent_role should win');
    assert.equal(row.model, 'model-b', 'Last model should win');
  });

  it('last-value-wins preserves earlier fields when later record has nulls', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-partial');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-partial', cache_hit_ratio: 0.75, agent_breakdown: { agent_role: 'coder', model: 'model-x' } }),
      // Second record has cache_hit_ratio but no agent_breakdown fields
      JSON.stringify({ session_id: 'sess-partial', cache_hit_ratio: 0.80 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT cache_hit_ratio, agent_role, model FROM sessions WHERE id = ?', ['sess-partial']);
    assert.equal(row.cache_hit_ratio, 0.80, 'Later cache_hit_ratio should override');
    assert.equal(row.agent_role, 'coder', 'Earlier agent_role should be preserved when later is null');
    assert.equal(row.model, 'model-x', 'Earlier model should be preserved when later is null');
  });

  it('skips malformed JSON lines without crashing', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-malformed');

    writeCacheHistory(tmpDir, [
      'not valid json {{{',
      JSON.stringify({ session_id: 'sess-malformed', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'coder', model: 'good-model' } }),
      '}{also bad',
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT cache_hit_ratio FROM sessions WHERE id = ?', ['sess-malformed']);
    assert.equal(row.cache_hit_ratio, 0.5, 'Valid records should still be processed after malformed lines');
  });

  it('stores offset in _meta after processing', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-offset-1');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-offset-1', cache_hit_ratio: 0.3, agent_breakdown: { agent_role: 'coder', model: 'model-a' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const offsetRow = get("SELECT value FROM _meta WHERE key = 'ingest_offset:cache-history'");
    assert.ok(offsetRow, 'Offset should be stored in _meta after processing');
    const offsetVal = parseInt(offsetRow.value, 10);
    assert.ok(offsetVal > 0, 'Offset should be a positive number');
  });

  it('skips already-processed lines on second call (offset-based incremental ingest)', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-incr-1');
    seedSession('sess-incr-2');

    // First ingest: one line
    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-incr-1', cache_hit_ratio: 0.3, agent_breakdown: { agent_role: 'coder', model: 'model-a' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row1 = get('SELECT cache_hit_ratio FROM sessions WHERE id = ?', ['sess-incr-1']);
    assert.equal(row1.cache_hit_ratio, 0.3);

    // Now overwrite sess-incr-1 ratio in DB manually, then re-run parseCacheHistory
    // on the SAME file. If offset works, the old line should NOT be re-processed.
    run('UPDATE sessions SET cache_hit_ratio = 0.11 WHERE id = ?', ['sess-incr-1']);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row2 = get('SELECT cache_hit_ratio FROM sessions WHERE id = ?', ['sess-incr-1']);
    assert.equal(row2.cache_hit_ratio, 0.11, 'Already-processed lines should be skipped — manual update should persist');
  });

  it('handles missing cache-history.jsonl gracefully (no crash)', async () => {
    tmpDir = makeTmpDir();
    // Don't create any file — parseCacheHistory should return early
    await parseCacheHistory(dbHelpers(), tmpDir);
    // No assertions needed — just verifying no exception
  });

  it('does not create token_events rows (enrichment-only)', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-no-events');

    const eventsBefore = all('SELECT COUNT(*) as cnt FROM token_events')[0].cnt;

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-no-events', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'coder', model: 'some-model' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const eventsAfter = all('SELECT COUNT(*) as cnt FROM token_events')[0].cnt;
    assert.equal(eventsAfter, eventsBefore, 'No token_events should be created by enrichment-only parser');
  });

  it('supports sessionId (camelCase) as alternative to session_id', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-camel');

    writeCacheHistory(tmpDir, [
      JSON.stringify({ sessionId: 'sess-camel', cache_hit_ratio: 0.65, agent_breakdown: { agent_role: 'coder', model: 'model-camel' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT cache_hit_ratio, model FROM sessions WHERE id = ?', ['sess-camel']);
    assert.equal(row.cache_hit_ratio, 0.65);
    assert.equal(row.model, 'model-camel');
  });
});

// ===========================================================================
// T4: cache_hit_ratio in sessions API
// ===========================================================================

describe('T4: cache_hit_ratio in sessions API', () => {

  before(() => {
    // Seed sessions with cache_hit_ratio for API tests
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role, cache_hit_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sess-api-chr-1', 'apiuser', 'proj-api', 'claude-sonnet-4-20250514', 100, 50, 0, 0, 0.01, '2026-03-21T10:00:00Z', 'coder', 0.75]
    );
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role, cache_hit_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sess-api-chr-2', 'apiuser', 'proj-api', 'claude-sonnet-4-20250514', 200, 100, 0, 0, 0.02, '2026-03-21T11:00:00Z', 'reviewer', null]
    );
  });

  async function getJson(path) {
    const res = await app.request(path);
    assert.equal(res.status, 200, `Expected 200 for ${path}, got ${res.status}`);
    return res.json();
  }

  it('cache_hit_ratio is returned in full session rows', async () => {
    const json = await getJson('/api/sessions?user=apiuser');
    const session = json.data.find((s) => s.id === 'sess-api-chr-1');
    assert.ok(session, 'Session should exist in response');
    assert.equal(session.cache_hit_ratio, 0.75, 'cache_hit_ratio should be included in response');
  });

  it('cache_hit_ratio is null when not set', async () => {
    const json = await getJson('/api/sessions?user=apiuser');
    const session = json.data.find((s) => s.id === 'sess-api-chr-2');
    assert.ok(session, 'Session should exist in response');
    assert.equal(session.cache_hit_ratio, null, 'cache_hit_ratio should be null when not set');
  });

  it('cache_hit_ratio is in allowedFields (fields=cache_hit_ratio works)', async () => {
    const json = await getJson('/api/sessions?user=apiuser&fields=cache_hit_ratio');
    assert.ok(json.data.length > 0, 'Should return at least one row');
    const row = json.data[0];
    // When selecting only cache_hit_ratio, other fields should not be present
    assert.ok('cache_hit_ratio' in row, 'cache_hit_ratio should be a selectable field');
    assert.equal(Object.keys(row).length, 1, 'Only cache_hit_ratio should be returned when selected alone');
  });

  it('cache_hit_ratio can be selected alongside other fields', async () => {
    const json = await getJson('/api/sessions?user=apiuser&fields=cache_hit_ratio,cost,model');
    assert.ok(json.data.length > 0);
    const row = json.data[0];
    assert.ok('cache_hit_ratio' in row);
    assert.ok('cost' in row);
    assert.ok('model' in row);
    assert.equal(Object.keys(row).length, 3, 'Exactly three fields should be returned');
  });
});
