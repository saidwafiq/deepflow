/**
 * Unit tests for T3: COALESCE guards in cache-history UPDATE.
 *
 * AC-1: COALESCE(?, agent_role) — NULL agent_role from cache-history
 *        does NOT overwrite an existing non-NULL agent_role.
 * AC-3: COALESCE(NULLIF(?, 'unknown'), model) — NULL or 'unknown' model
 *        from cache-history does NOT overwrite an existing non-NULL model.
 *
 * Strategy: In-memory SQLite via initDatabase() + temp dirs with JSONL fixtures.
 * Node.js built-in node:test (ESM).
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Import from dist (compiled ESM)
const { initDatabase, run, get, all } = await import(resolve(ROOT, 'dist', 'db', 'index.js'));
const { parseCacheHistory } = await import(resolve(ROOT, 'dist', 'ingest', 'parsers', 'cache-history.js'));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpDir;

function makeTmpDir() {
  const dir = resolve(tmpdir(), `deepflow-test-coalesce-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCacheHistory(dir, lines) {
  writeFileSync(resolve(dir, 'cache-history.jsonl'), lines.join('\n') + '\n');
}

function dbHelpers() {
  return { run, get, all };
}

function seedSession(id, opts = {}) {
  const defaults = {
    user: 'testuser-coalesce',
    project: 'proj',
    model: 'claude-sonnet-4-20250514',
    tokens_in: 100,
    tokens_out: 50,
    cache_read: 0,
    cache_creation: 0,
    cost: 0.01,
    started_at: '2026-03-20T10:00:00Z',
    agent_role: null,
  };
  const s = { ...defaults, ...opts };
  run(
    `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, s.user, s.project, s.model, s.tokens_in, s.tokens_out, s.cache_read, s.cache_creation, s.cost, s.started_at, s.agent_role]
  );
}

function cleanupTestData() {
  run("DELETE FROM sessions WHERE user = 'testuser-coalesce'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:cache-history'");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(async () => {
  await initDatabase('serve');
});

// ===========================================================================
// AC-1: COALESCE(?, agent_role) — NULL agent_role preservation
// ===========================================================================

describe('AC-1: NULL agent_role from cache-history does not overwrite existing value', () => {

  afterEach(() => {
    cleanupTestData();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves existing agent_role when cache-history record has no agent_breakdown', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-no-breakdown', { agent_role: 'coder' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-no-breakdown', cache_hit_ratio: 0.5 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-no-breakdown']);
    assert.equal(row.agent_role, 'coder', 'Existing agent_role should be preserved when cache-history has no agent_breakdown');
  });

  it('preserves existing agent_role when cache-history agent_role is null', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-null-role', { agent_role: 'reviewer' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-null-role', cache_hit_ratio: 0.6, agent_breakdown: { model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-null-role']);
    assert.equal(row.agent_role, 'reviewer', 'Existing agent_role should be preserved when cache-history agent_role is null');
  });

  it('overwrites agent_role when cache-history provides a non-NULL value', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-overwrite', { agent_role: 'orchestrator' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-overwrite', cache_hit_ratio: 0.7, agent_breakdown: { agent_role: 'coder', model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-overwrite']);
    assert.equal(row.agent_role, 'coder', 'agent_role should be updated when cache-history provides a non-NULL value');
  });

  it('sets agent_role when existing value is NULL and cache-history provides one', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-null-existing', { agent_role: null });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-null-existing', cache_hit_ratio: 0.4, agent_breakdown: { agent_role: 'coder', model: 'some-model' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-null-existing']);
    assert.equal(row.agent_role, 'coder', 'NULL agent_role should be filled from cache-history');
  });

  it('keeps default "unknown" agent_role when both seed and cache-history values are null', async () => {
    tmpDir = makeTmpDir();
    // agent_role column is NOT NULL DEFAULT 'unknown', so seeding with null stores 'unknown'
    seedSession('sess-ac1-both-null', { agent_role: null });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-both-null', cache_hit_ratio: 0.3 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-both-null']);
    assert.equal(row.agent_role, 'unknown', 'agent_role should remain "unknown" (DB default) when neither source provides a value');
  });

  it('preserves agent_role across multiple cache-history records when later ones lack it', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-multi', { agent_role: 'coder' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-multi', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'reviewer', model: 'model-a' } }),
      // Second record has no agent_breakdown — the enrichmentMap merge picks up null
      JSON.stringify({ session_id: 'sess-ac1-multi', cache_hit_ratio: 0.8 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role, cache_hit_ratio FROM sessions WHERE id = ?', ['sess-ac1-multi']);
    // The enrichmentMap preserves earlier agent_role when later is null (line 54 of source)
    // Then COALESCE guard preserves DB value if enrichmentMap value is null
    assert.equal(row.agent_role, 'reviewer', 'agent_role from first record should be preserved when second record lacks it');
    assert.equal(row.cache_hit_ratio, 0.8, 'cache_hit_ratio should reflect last record');
  });
});

// ===========================================================================
// AC-3: COALESCE(NULLIF(?, 'unknown'), model) — NULL/unknown model preservation
// ===========================================================================

describe('AC-3: NULL/unknown model from cache-history does not overwrite existing value', () => {

  afterEach(() => {
    cleanupTestData();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves existing model when cache-history record has no agent_breakdown', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-no-bd', { model: 'claude-opus-4-6' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-no-bd', cache_hit_ratio: 0.5 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-no-bd']);
    assert.equal(row.model, 'claude-opus-4-6', 'Existing model should be preserved when cache-history has no model');
  });

  it('preserves existing model when cache-history model is null', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-null-model', { model: 'claude-sonnet-4-20250514' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-null-model', cache_hit_ratio: 0.6, agent_breakdown: { agent_role: 'coder' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-null-model']);
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'Existing model should be preserved when cache-history model is null');
  });

  it('preserves existing model when cache-history model is "unknown"', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-unknown', { model: 'claude-opus-4-6' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-unknown', cache_hit_ratio: 0.7, agent_breakdown: { agent_role: 'coder', model: 'unknown' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-unknown']);
    assert.equal(row.model, 'claude-opus-4-6', 'Existing model should be preserved when cache-history model is "unknown"');
  });

  it('overwrites model when cache-history provides a valid (non-unknown, non-null) model', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-valid', { model: 'claude-sonnet-4-20250514' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-valid', cache_hit_ratio: 0.4, agent_breakdown: { agent_role: 'coder', model: 'claude-opus-4-6' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-valid']);
    assert.equal(row.model, 'claude-opus-4-6', 'Model should be updated when cache-history provides a valid value');
  });

  it('fills NULL model when cache-history provides a valid model', async () => {
    tmpDir = makeTmpDir();
    // Seed with model explicitly set to NULL via raw SQL
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ['sess-ac3-fill-null', 'testuser-coalesce', 'proj', 100, 50, 0, 0, 0.01, '2026-03-20T10:00:00Z', null]
    );

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-fill-null', cache_hit_ratio: 0.3, agent_breakdown: { agent_role: 'coder', model: 'claude-haiku-4-5' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-fill-null']);
    assert.equal(row.model, 'claude-haiku-4-5', 'NULL model should be filled from cache-history');
  });

  it('keeps existing model when cache-history model is "unknown" and existing is already set', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-unknown-keep', { model: 'claude-sonnet-4-20250514' });

    // Two records: first with valid model, second with 'unknown'
    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-unknown-keep', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'coder', model: 'unknown' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-unknown-keep']);
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'Model should not be overwritten by "unknown"');
  });

  it('bracket stripping + COALESCE interact correctly: stripped model still updates', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-bracket', { model: 'old-model' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-bracket', cache_hit_ratio: 0.8, agent_breakdown: { agent_role: 'coder', model: 'claude-opus-4-6[1m]' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-bracket']);
    assert.equal(row.model, 'claude-opus-4-6', 'Bracket-stripped model should still update existing model');
  });

  it('preserves model across multiple records when later record has unknown model', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-multi', { model: 'original-model' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-multi', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'coder', model: 'new-model' } }),
      // Second record has 'unknown' model — enrichmentMap merge should keep 'new-model'
      JSON.stringify({ session_id: 'sess-ac3-multi', cache_hit_ratio: 0.9, agent_breakdown: { agent_role: 'reviewer', model: 'unknown' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-multi']);
    // enrichmentMap keeps 'unknown' as model since it's not null (line 55 picks raw value)
    // But COALESCE(NULLIF('unknown', 'unknown'), model) = COALESCE(NULL, model) = existing model
    // After first UPDATE: model='new-model'. After second UPDATE with 'unknown': model stays 'new-model'
    // Wait — there's only ONE UPDATE per session (enrichmentMap collapses). The enrichmentMap
    // line 55: model: model ?? enrichmentMap.get(sessionId)?.model ?? null
    // 'unknown' is truthy, so it replaces 'new-model'. Then COALESCE(NULLIF('unknown','unknown'), model)
    // = COALESCE(NULL, 'new-model') — but at this point model in DB is 'original-model' (hasn't been updated yet).
    // Actually the first record sets model='new-model' in the map, second sets model='unknown'.
    // The UPDATE uses COALESCE(NULLIF('unknown','unknown'), model) = COALESCE(NULL, 'original-model') = 'original-model'.
    // So original-model is preserved!
    assert.equal(row.model, 'original-model', 'Model should fall back to DB value when enrichmentMap produces "unknown"');
  });
});

// ===========================================================================
// Combined AC-1 + AC-3: Both guards work together
// ===========================================================================

describe('AC-1 + AC-3 combined: both COALESCE guards work simultaneously', () => {

  afterEach(() => {
    cleanupTestData();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves both agent_role and model when cache-history has neither', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-both-1', { agent_role: 'coder', model: 'claude-opus-4-6' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-both-1', cache_hit_ratio: 0.9 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role, model, cache_hit_ratio FROM sessions WHERE id = ?', ['sess-both-1']);
    assert.equal(row.agent_role, 'coder', 'agent_role should be preserved');
    assert.equal(row.model, 'claude-opus-4-6', 'model should be preserved');
    assert.equal(row.cache_hit_ratio, 0.9, 'cache_hit_ratio should still be updated');
  });

  it('updates agent_role but preserves model when model is unknown', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-both-2', { agent_role: 'orchestrator', model: 'claude-sonnet-4-20250514' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-both-2', cache_hit_ratio: 0.5, agent_breakdown: { agent_role: 'reviewer', model: 'unknown' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role, model FROM sessions WHERE id = ?', ['sess-both-2']);
    assert.equal(row.agent_role, 'reviewer', 'agent_role should be updated to reviewer');
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'model should be preserved (unknown filtered by NULLIF)');
  });

  it('updates model but preserves agent_role when agent_role is null', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-both-3', { agent_role: 'coder', model: 'old-model' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-both-3', cache_hit_ratio: 0.6, agent_breakdown: { model: 'new-model' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role, model FROM sessions WHERE id = ?', ['sess-both-3']);
    assert.equal(row.agent_role, 'coder', 'agent_role should be preserved (no agent_role in breakdown)');
    assert.equal(row.model, 'new-model', 'model should be updated to new-model');
  });

  it('updates both when cache-history provides valid values for both', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-both-4', { agent_role: 'orchestrator', model: 'old-model' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-both-4', cache_hit_ratio: 0.7, agent_breakdown: { agent_role: 'coder', model: 'claude-opus-4-6' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role, model FROM sessions WHERE id = ?', ['sess-both-4']);
    assert.equal(row.agent_role, 'coder', 'agent_role should be updated');
    assert.equal(row.model, 'claude-opus-4-6', 'model should be updated');
  });
});
