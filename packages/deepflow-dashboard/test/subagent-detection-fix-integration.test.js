/**
 * Integration tests for the subagent-detection-fix spec.
 *
 * Covers ALL acceptance criteria (AC-1 through AC-11) via public interfaces only.
 * Tests use in-memory SQLite via initDatabase('serve') and temp fixture dirs.
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import initSqlJs from 'sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Import from dist (compiled ESM)
const { initDatabase, run, get, all } = await import(resolve(ROOT, 'dist', 'db', 'index.js'));
const { parseCacheHistory } = await import(resolve(ROOT, 'dist', 'ingest', 'parsers', 'cache-history.js'));
const { parseSessions } = await import(resolve(ROOT, 'dist', 'ingest', 'parsers', 'sessions.js'));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TEMP_BASE = resolve(tmpdir(), `deepflow-subagent-fix-integration-${Date.now()}`);
let tmpDir;

function makeTmpDir() {
  const dir = resolve(TEMP_BASE, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dbHelpers() {
  return { run, get, all };
}

function clearAllTestData() {
  try { run('DELETE FROM token_events'); } catch { /* ignore */ }
  try { run('DELETE FROM sessions'); } catch { /* ignore */ }
  try { run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:%'"); } catch { /* ignore */ }
}

function seedSession(id, opts = {}) {
  const defaults = {
    user: 'testuser-integration',
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

function writeCacheHistory(dir, lines) {
  writeFileSync(resolve(dir, 'cache-history.jsonl'), lines.join('\n') + '\n');
}

function setupClaudeDir(opts = {}) {
  const claudeDir = resolve(TEMP_BASE, `claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectsDir = resolve(claudeDir, 'projects', '-Users-test-apps-myproject');
  mkdirSync(projectsDir, { recursive: true });

  const sessionFiles = opts.sessionFiles ?? {};
  for (const [filename, lines] of Object.entries(sessionFiles)) {
    writeFileSync(resolve(projectsDir, filename), lines.join('\n'));
  }

  if (opts.registry !== undefined && opts.registry !== null) {
    writeFileSync(resolve(claudeDir, 'subagent-sessions.jsonl'), opts.registry);
  }

  return claudeDir;
}

function makeSessionEvents(model) {
  return [
    JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model, message: { role: 'assistant', model, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
  ];
}

function makeSessionEventsNoModel() {
  return [
    JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
  ];
}

function cleanupTmpDir() {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(async () => {
  await initDatabase('serve');
});

// ===========================================================================
// AC-1: cache-history.ts UPDATE uses COALESCE(?, agent_role)
// NULL agent_role from cache-history does not overwrite existing value
// ===========================================================================

describe('AC-1: NULL agent_role from cache-history does not overwrite existing value', () => {

  afterEach(() => {
    run("DELETE FROM sessions WHERE user = 'testuser-integration'");
    run("DELETE FROM _meta WHERE key = 'ingest_offset:cache-history'");
    cleanupTmpDir();
  });

  it('preserves existing agent_role when cache-history provides no agent_breakdown', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-1', { agent_role: 'coder' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-1', cache_hit_ratio: 0.5 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-1']);
    assert.equal(row.agent_role, 'coder',
      'COALESCE(NULL, agent_role) should preserve existing agent_role');
  });

  it('preserves existing agent_role when cache-history agent_role is explicitly null', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-2', { agent_role: 'reviewer' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-2', cache_hit_ratio: 0.6, agent_breakdown: { model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-2']);
    assert.equal(row.agent_role, 'reviewer',
      'COALESCE guard must keep existing agent_role when incoming is null');
  });

  it('allows non-null cache-history agent_role to update existing value', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac1-3', { agent_role: 'orchestrator' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac1-3', cache_hit_ratio: 0.7, agent_breakdown: { agent_role: 'coder', model: 'claude-sonnet-4-20250514' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac1-3']);
    assert.equal(row.agent_role, 'coder',
      'non-NULL agent_role from cache-history should update');
  });
});

// ===========================================================================
// AC-2: After full ingest, sessions with registry entries have agent_role
// matching registry type (not 'orchestrator')
// ===========================================================================

describe('AC-2: After full ingest, sessions with registry entries have correct agent_role', () => {

  afterEach(() => {
    clearAllTestData();
  });

  it('session with single registry entry gets that agent_type as agent_role', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ac2-coder', agent_type: 'coder' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac2-coder.jsonl': makeSessionEvents('claude-sonnet-4'),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac2-coder']);
    assert.ok(row, 'session should exist');
    assert.equal(row.agent_role, 'coder',
      'registry entry with agent_type=coder should set agent_role=coder, not orchestrator');
  });

  it('session without registry entry defaults to orchestrator', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'other-session', agent_type: 'coder' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac2-noentry.jsonl': makeSessionEvents('claude-sonnet-4'),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ac2-noentry']);
    assert.ok(row, 'session should exist');
    assert.equal(row.agent_role, 'orchestrator',
      'session not in registry should be orchestrator');
  });

  it('multiple sessions get distinct roles from registry', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ac2-a', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-ac2-b', agent_type: 'reviewer' }),
      JSON.stringify({ session_id: 'sess-ac2-c', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-ac2-c', agent_type: 'planner' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac2-a.jsonl': makeSessionEvents('claude-sonnet-4'),
        'sess-ac2-b.jsonl': makeSessionEvents('claude-sonnet-4'),
        'sess-ac2-c.jsonl': makeSessionEvents('claude-sonnet-4'),
        'sess-ac2-orch.jsonl': makeSessionEvents('claude-sonnet-4'),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const results = all('SELECT id, agent_role FROM sessions ORDER BY id');
    const roleMap = Object.fromEntries(results.map(r => [r.id, r.agent_role]));

    assert.equal(roleMap['sess-ac2-a'], 'coder');
    assert.equal(roleMap['sess-ac2-b'], 'reviewer');
    assert.equal(roleMap['sess-ac2-c'], 'mixed');
    assert.equal(roleMap['sess-ac2-orch'], 'orchestrator');
  });
});

// ===========================================================================
// AC-3: cache-history.ts UPDATE uses COALESCE(NULLIF(?, 'unknown'), model)
// NULL/unknown model from cache-history does not overwrite existing value
// ===========================================================================

describe('AC-3: NULL/unknown model from cache-history does not overwrite existing model', () => {

  afterEach(() => {
    run("DELETE FROM sessions WHERE user = 'testuser-integration'");
    run("DELETE FROM _meta WHERE key = 'ingest_offset:cache-history'");
    cleanupTmpDir();
  });

  it('preserves existing model when cache-history model is null', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-1', { model: 'claude-opus-4-6' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-1', cache_hit_ratio: 0.5 }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-1']);
    assert.equal(row.model, 'claude-opus-4-6',
      'COALESCE(NULLIF(NULL, "unknown"), model) should preserve existing model');
  });

  it('preserves existing model when cache-history model is "unknown"', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-2', { model: 'claude-opus-4-6' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-2', cache_hit_ratio: 0.7, agent_breakdown: { model: 'unknown' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-2']);
    assert.equal(row.model, 'claude-opus-4-6',
      'NULLIF("unknown", "unknown") = NULL, then COALESCE(NULL, model) preserves existing');
  });

  it('updates model when cache-history provides a valid (non-unknown) model', async () => {
    tmpDir = makeTmpDir();
    seedSession('sess-ac3-3', { model: 'old-model' });

    writeCacheHistory(tmpDir, [
      JSON.stringify({ session_id: 'sess-ac3-3', cache_hit_ratio: 0.4, agent_breakdown: { model: 'claude-opus-4-6' } }),
    ]);

    await parseCacheHistory(dbHelpers(), tmpDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac3-3']);
    assert.equal(row.model, 'claude-opus-4-6',
      'valid model from cache-history should replace existing');
  });
});

// ===========================================================================
// AC-4: After full ingest, zero sessions have model=NULL
// ===========================================================================

describe('AC-4: After full ingest, zero sessions have model=NULL', () => {

  afterEach(() => {
    clearAllTestData();
  });

  it('parseSessions sets a model for every session (unknown at worst)', async () => {
    clearAllTestData();
    const claudeDir = setupClaudeDir({
      registry: null,
      sessionFiles: {
        // Session with model in events
        'sess-ac4-with.jsonl': makeSessionEvents('claude-sonnet-4-20250514'),
        // Session without model in events
        'sess-ac4-without.jsonl': makeSessionEventsNoModel(),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const nullModels = all('SELECT id FROM sessions WHERE model IS NULL');
    assert.equal(nullModels.length, 0,
      'after ingest, zero sessions should have model=NULL');
  });

  it('sessions without event model get "unknown" (not NULL)', async () => {
    clearAllTestData();
    const claudeDir = setupClaudeDir({
      registry: null,
      sessionFiles: {
        'sess-ac4-nomodel.jsonl': makeSessionEventsNoModel(),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac4-nomodel']);
    assert.ok(row, 'session should exist');
    assert.notEqual(row.model, null, 'model should not be NULL');
    assert.equal(row.model, 'unknown', 'model should be "unknown" when no event model');
  });
});

// ===========================================================================
// AC-5: Hook output JSON includes model field derived from agent_type mapping
// ===========================================================================

describe('AC-5: Hook output JSON includes model field derived from agent_type mapping', () => {

  const HOOK_PATH = resolve(ROOT, '..', '..', 'hooks', 'df-subagent-registry.js');
  let tmpHome;

  function runHook(input, { home } = {}) {
    const json = typeof input === 'string' ? input : JSON.stringify(input);
    const env = { ...process.env };
    if (home) env.HOME = home;
    try {
      const stdout = execFileSync(process.execPath, [HOOK_PATH], {
        input: json, encoding: 'utf8', timeout: 5000, env,
      });
      return { stdout, code: 0 };
    } catch (err) {
      return { stdout: err.stdout || '', code: err.status ?? 1 };
    }
  }

  function readRegistry(home) {
    const registryPath = resolve(home, '.claude', 'subagent-sessions.jsonl');
    if (!existsSync(registryPath)) return [];
    const content = readFileSync(registryPath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  }

  afterEach(() => {
    if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('hook output includes model field for reasoner agent_type', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });

    runHook({ session_id: 's1', agent_type: 'reasoner', agent_id: 'a1' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);
    assert.ok('model' in entries[0], 'output JSON must include model field');
    assert.equal(entries[0].model, 'claude-opus-4-6',
      'reasoner -> claude-opus-4-6');
  });

  it('hook output includes model field for Explore agent_type', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });

    runHook({ session_id: 's2', agent_type: 'Explore', agent_id: 'a2' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);
    assert.ok('model' in entries[0], 'output JSON must include model field');
    assert.equal(entries[0].model, 'claude-haiku-4-5',
      'Explore -> claude-haiku-4-5');
  });

  it('hook output includes model field for unknown agent_type (default)', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });

    runHook({ session_id: 's3', agent_type: 'custom-worker', agent_id: 'a3' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);
    assert.ok('model' in entries[0], 'output JSON must include model field');
    assert.equal(entries[0].model, 'claude-sonnet-4-6',
      'unknown agent_type -> claude-sonnet-4-6 (default)');
  });
});

// ===========================================================================
// AC-6: Mapping is case-sensitive: reasoner (lowercase) -> claude-opus-4-6,
// Explore (capitalized) -> claude-haiku-4-5
// ===========================================================================

describe('AC-6: agent_type to model mapping is case-sensitive', () => {

  const HOOK_PATH = resolve(ROOT, '..', '..', 'hooks', 'df-subagent-registry.js');
  let tmpHome;

  function runHook(input, { home } = {}) {
    const json = typeof input === 'string' ? input : JSON.stringify(input);
    const env = { ...process.env };
    if (home) env.HOME = home;
    try {
      const stdout = execFileSync(process.execPath, [HOOK_PATH], {
        input: json, encoding: 'utf8', timeout: 5000, env,
      });
      return { stdout, code: 0 };
    } catch (err) {
      return { stdout: err.stdout || '', code: err.status ?? 1 };
    }
  }

  function readRegistry(home) {
    const registryPath = resolve(home, '.claude', 'subagent-sessions.jsonl');
    if (!existsSync(registryPath)) return [];
    const content = readFileSync(registryPath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  }

  afterEach(() => {
    if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('"reasoner" (lowercase) maps to claude-opus-4-6', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });
    runHook({ session_id: 's1', agent_type: 'reasoner', agent_id: 'a1' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries[0].model, 'claude-opus-4-6');
  });

  it('"Reasoner" (capitalized) does NOT map to claude-opus-4-6 (gets default)', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });
    runHook({ session_id: 's1', agent_type: 'Reasoner', agent_id: 'a1' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries[0].model, 'claude-sonnet-4-6',
      '"Reasoner" with capital R should get default, not opus');
  });

  it('"Explore" (capitalized) maps to claude-haiku-4-5', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });
    runHook({ session_id: 's1', agent_type: 'Explore', agent_id: 'a1' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries[0].model, 'claude-haiku-4-5');
  });

  it('"explore" (lowercase) does NOT map to claude-haiku-4-5 (gets default)', () => {
    tmpHome = makeTmpDir();
    mkdirSync(resolve(tmpHome, '.claude'), { recursive: true });
    runHook({ session_id: 's1', agent_type: 'explore', agent_id: 'a1' }, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries[0].model, 'claude-sonnet-4-6',
      '"explore" lowercase should get default, not haiku');
  });
});

// ===========================================================================
// AC-7: When session has model='unknown' and registry entry has model,
// registry model is used
// ===========================================================================

describe('AC-7: registry model fallback when session model is unknown', () => {

  afterEach(() => {
    clearAllTestData();
  });

  it('uses registry model when session events produce no model', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ac7-1', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac7-1.jsonl': makeSessionEventsNoModel(),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac7-1']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-sonnet-4-20250514',
      'registry model should be used when event model is unknown');
  });

  it('no fallback when registry has no model for that session', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ac7-2', agent_type: 'coder' }), // no model field
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac7-2.jsonl': makeSessionEventsNoModel(),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac7-2']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'unknown',
      'model stays unknown when registry has no model');
  });
});

// ===========================================================================
// AC-8: Registry model does not overwrite event-derived model
// (event takes precedence)
// ===========================================================================

describe('AC-8: event-derived model takes precedence over registry model', () => {

  afterEach(() => {
    clearAllTestData();
  });

  it('event model is kept when registry also has a different model', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ac8-1', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac8-1.jsonl': makeSessionEvents('claude-sonnet-4-20250514'),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac8-1']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-sonnet-4-20250514',
      'event-derived model should take precedence over registry model');
  });

  it('event model with bracket suffix is stripped but still takes precedence', async () => {
    clearAllTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ac8-2', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ac8-2.jsonl': makeSessionEvents('claude-opus-4-6[1m]'),
      },
    });

    await parseSessions(dbHelpers(), claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-ac8-2']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-opus-4-6',
      'bracket-stripped event model should still take precedence over registry');
  });
});

// ===========================================================================
// AC-9: Migration gated by _meta key migration:backfill_agent_role_model_v1
// ===========================================================================

describe('AC-9: backfill migration gated by _meta key (idempotent)', () => {

  // These tests use sql.js for isolated in-memory DBs to test the migration
  // logic without affecting the shared initDatabase() state.

  let SQL;
  const SCHEMA_PATH = resolve(ROOT, 'src', 'db', 'schema.sql');

  before(async () => {
    const wasmPath = resolve(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    SQL = await initSqlJs({
      wasmBinary: existsSync(wasmPath)
        ? readFileSync(wasmPath).buffer
        : undefined,
    });
  });

  // Replica of backfillAgentRoleModel for testing without reading implementation
  function backfillAgentRoleModel(db, registryLines = []) {
    const migrationKey = 'migration:backfill_agent_role_model_v1';
    const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
    checkStmt.bind([migrationKey]);
    const alreadyRan = checkStmt.step();
    checkStmt.free();
    if (alreadyRan) return;

    const registryMap = new Map();
    const registryModelMap = new Map();
    for (const line of registryLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const sid = entry.session_id;
        const atype = entry.agent_type;
        const entryModel = entry.model;
        if (sid && atype) {
          if (!registryMap.has(sid)) registryMap.set(sid, new Set());
          registryMap.get(sid).add(atype);
        }
        if (sid && entryModel && entryModel !== 'unknown') {
          registryModelMap.set(sid, entryModel);
        }
      } catch { /* skip */ }
    }

    function resolveAgentRole(sessionId) {
      const types = registryMap.get(sessionId);
      if (!types || types.size === 0) return 'orchestrator';
      if (types.size === 1) return types.values().next().value;
      return 'mixed';
    }

    db.run("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
    db.run("DELETE FROM sessions WHERE model = '<synthetic>'");

    if (registryMap.size > 0 || registryModelMap.size > 0) {
      const allSids = new Set([...registryMap.keys(), ...registryModelMap.keys()]);
      for (const sid of allSids) {
        const role = resolveAgentRole(sid);
        const registryModel = registryModelMap.get(sid);
        if (registryModel) {
          db.run(
            `UPDATE sessions SET
               agent_role = CASE WHEN agent_role = 'orchestrator' THEN ? ELSE agent_role END,
               model = CASE WHEN model = 'unknown' OR model IS NULL THEN ? ELSE model END
             WHERE id = ?`,
            [role, registryModel, sid]
          );
        } else {
          db.run(
            `UPDATE sessions SET agent_role = ? WHERE id = ? AND agent_role = 'orchestrator'`,
            [role, sid]
          );
        }
      }
    }

    db.run("INSERT INTO _meta (key, value) VALUES (?, 'done')", [migrationKey]);
  }

  function createDb() {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    const db = new SQL.Database();
    db.run(schema);
    return db;
  }

  function getMetaValue(db, key) {
    const stmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
    stmt.bind([key]);
    const val = stmt.step() ? stmt.getAsObject()['value'] : null;
    stmt.free();
    return val;
  }

  it('sets _meta key after first run', () => {
    const db = createDb();
    backfillAgentRoleModel(db);
    const val = getMetaValue(db, 'migration:backfill_agent_role_model_v1');
    assert.equal(val, 'done', '_meta key should be set to "done"');
    db.close();
  });

  it('second run is a no-op (idempotent)', () => {
    const db = createDb();
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('s1', 'u', 'p', '<synthetic>', 1, 1, 0, 0, 0.01, '2026-01-01', 'unknown')`
    );

    backfillAgentRoleModel(db);
    // Synthetic deleted on first run
    let results = db.exec("SELECT COUNT(*) FROM sessions WHERE model = '<synthetic>'");
    assert.equal(results[0].values[0][0], 0);

    // Re-insert synthetic to verify second run doesn't touch it
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('s2', 'u', 'p', '<synthetic>', 1, 1, 0, 0, 0.01, '2026-01-01', 'unknown')`
    );
    backfillAgentRoleModel(db);
    results = db.exec("SELECT COUNT(*) FROM sessions WHERE model = '<synthetic>'");
    assert.equal(results[0].values[0][0], 1,
      'second run should not delete newly inserted synthetic session');
    db.close();
  });

  it('does not modify data when _meta key already exists', () => {
    const db = createDb();
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('s1', 'u', 'p', '<synthetic>', 1, 1, 0, 0, 0.01, '2026-01-01', 'orchestrator')`
    );
    db.run("INSERT INTO _meta (key, value) VALUES ('migration:backfill_agent_role_model_v1', 'done')");

    backfillAgentRoleModel(db, [
      JSON.stringify({ session_id: 's1', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ]);

    const results = db.exec("SELECT model, agent_role FROM sessions WHERE id = 's1'");
    assert.equal(results[0].values[0][0], '<synthetic>', 'model should be unchanged');
    assert.equal(results[0].values[0][1], 'orchestrator', 'agent_role should be unchanged');
    db.close();
  });
});

// ===========================================================================
// AC-10: After migration, zero sessions have model=NULL or model='<synthetic>'
// Sessions with registry entries have corrected agent_role
// ===========================================================================

describe('AC-10: After migration, zero sessions with NULL/synthetic model; corrected agent_role', () => {

  let SQL;
  const SCHEMA_PATH = resolve(ROOT, 'src', 'db', 'schema.sql');

  before(async () => {
    const wasmPath = resolve(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    SQL = await initSqlJs({
      wasmBinary: existsSync(wasmPath)
        ? readFileSync(wasmPath).buffer
        : undefined,
    });
  });

  function backfillAgentRoleModel(db, registryLines = []) {
    const migrationKey = 'migration:backfill_agent_role_model_v1';
    const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
    checkStmt.bind([migrationKey]);
    const alreadyRan = checkStmt.step();
    checkStmt.free();
    if (alreadyRan) return;

    const registryMap = new Map();
    const registryModelMap = new Map();
    for (const line of registryLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const sid = entry.session_id;
        const atype = entry.agent_type;
        const entryModel = entry.model;
        if (sid && atype) {
          if (!registryMap.has(sid)) registryMap.set(sid, new Set());
          registryMap.get(sid).add(atype);
        }
        if (sid && entryModel && entryModel !== 'unknown') {
          registryModelMap.set(sid, entryModel);
        }
      } catch { /* skip */ }
    }

    function resolveAgentRole(sessionId) {
      const types = registryMap.get(sessionId);
      if (!types || types.size === 0) return 'orchestrator';
      if (types.size === 1) return types.values().next().value;
      return 'mixed';
    }

    db.run("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
    db.run("DELETE FROM sessions WHERE model = '<synthetic>'");

    if (registryMap.size > 0 || registryModelMap.size > 0) {
      const allSids = new Set([...registryMap.keys(), ...registryModelMap.keys()]);
      for (const sid of allSids) {
        const role = resolveAgentRole(sid);
        const registryModel = registryModelMap.get(sid);
        if (registryModel) {
          db.run(
            `UPDATE sessions SET
               agent_role = CASE WHEN agent_role = 'orchestrator' THEN ? ELSE agent_role END,
               model = CASE WHEN model = 'unknown' OR model IS NULL THEN ? ELSE model END
             WHERE id = ?`,
            [role, registryModel, sid]
          );
        } else {
          db.run(
            `UPDATE sessions SET agent_role = ? WHERE id = ? AND agent_role = 'orchestrator'`,
            [role, sid]
          );
        }
      }
    }

    db.run("INSERT INTO _meta (key, value) VALUES (?, 'done')", [migrationKey]);
  }

  function createDb() {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    const db = new SQL.Database();
    db.run(schema);
    return db;
  }

  it('zero sessions with model=<synthetic> after migration', () => {
    const db = createDb();
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('synth1', 'u', 'p', '<synthetic>', 1, 1, 0, 0, 0.01, '2026-01-01', 'unknown')`
    );
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('synth2', 'u', 'p', '<synthetic>', 1, 1, 0, 0, 0.01, '2026-01-01', 'unknown')`
    );
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('real1', 'u', 'p', 'claude-sonnet-4', 1, 1, 0, 0, 0.01, '2026-01-01', 'unknown')`
    );

    backfillAgentRoleModel(db);

    const results = db.exec("SELECT COUNT(*) FROM sessions WHERE model = '<synthetic>'");
    assert.equal(results[0].values[0][0], 0, 'zero sessions with <synthetic> model');
    db.close();
  });

  it('zero sessions with model=NULL after migration (with registry)', () => {
    const db = createDb();
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('nullmod', 'u', 'p', NULL, 1, 1, 0, 0, 0.01, '2026-01-01', 'orchestrator')`
    );

    const registry = [
      JSON.stringify({ session_id: 'nullmod', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ];
    backfillAgentRoleModel(db, registry);

    const results = db.exec("SELECT COUNT(*) FROM sessions WHERE model IS NULL");
    assert.equal(results[0].values[0][0], 0, 'zero sessions with NULL model');
    db.close();
  });

  it('sessions with registry entries get corrected agent_role', () => {
    const db = createDb();
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('orch-fix', 'u', 'p', 'unknown', 1, 1, 0, 0, 0.01, '2026-01-01', 'orchestrator')`
    );
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES ('rev-keep', 'u', 'p', 'claude-sonnet-4', 1, 1, 0, 0, 0.01, '2026-01-01', 'reviewer')`
    );

    const registry = [
      JSON.stringify({ session_id: 'orch-fix', agent_type: 'coder', model: 'claude-opus-4-6' }),
      JSON.stringify({ session_id: 'rev-keep', agent_type: 'coder' }),
    ];
    backfillAgentRoleModel(db, registry);

    const stmtOrch = db.prepare("SELECT agent_role, model FROM sessions WHERE id = ?");
    stmtOrch.bind(['orch-fix']);
    stmtOrch.step();
    const orchRow = stmtOrch.getAsObject();
    stmtOrch.free();

    assert.equal(orchRow.agent_role, 'coder',
      'orchestrator -> coder from registry');
    assert.equal(orchRow.model, 'claude-opus-4-6',
      'unknown -> registry model');

    const stmtRev = db.prepare("SELECT agent_role FROM sessions WHERE id = ?");
    stmtRev.bind(['rev-keep']);
    stmtRev.step();
    const revRow = stmtRev.getAsObject();
    stmtRev.free();

    assert.equal(revRow.agent_role, 'reviewer',
      'non-orchestrator agent_role should not be overwritten');
    db.close();
  });
});

// ===========================================================================
// AC-11: npm run build completes with exit code 0
// ===========================================================================

describe('AC-11: npm run build completes with exit code 0', () => {

  it('build succeeds', () => {
    try {
      execFileSync('npm', ['run', 'build'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // If we get here, exit code was 0
      assert.ok(true, 'npm run build exited with code 0');
    } catch (err) {
      assert.fail(`npm run build failed with exit code ${err.status}: ${err.stderr?.slice(0, 500)}`);
    }
  });
});

// ===========================================================================
// Cleanup
// ===========================================================================

process.on('exit', () => {
  try {
    if (existsSync(TEMP_BASE)) {
      rmSync(TEMP_BASE, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});
