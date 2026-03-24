/**
 * Unit tests for T4: backfillAgentRoleModel migration (AC-9, AC-10).
 *
 * AC-9: Migration gated by _meta key `migration:backfill_agent_role_model_v1` — idempotent.
 * AC-10: After migration, zero sessions have model=NULL or model='<synthetic>'.
 *        Sessions with registry entries have corrected agent_role.
 *
 * Strategy: In-memory SQLite via sql.js, replicating the backfillAgentRoleModel
 * logic from src/db/index.ts. Tests verify behavioral outcomes, not implementation.
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '..', 'src', 'db', 'schema.sql');

let SQL;

// ---------------------------------------------------------------------------
// backfillAgentRoleModel: replica of the function from src/db/index.ts
// Accepts an optional registryLines array (simulates subagent-sessions.jsonl)
// instead of reading from disk, to make tests deterministic.
// ---------------------------------------------------------------------------

function backfillAgentRoleModel(db, registryLines = []) {
  const migrationKey = 'migration:backfill_agent_role_model_v1';
  const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  checkStmt.bind([migrationKey]);
  const alreadyRan = checkStmt.step();
  checkStmt.free();

  if (alreadyRan) return;

  // Load registry from provided lines (instead of file)
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
    } catch {
      // skip malformed lines
    }
  }

  function resolveAgentRole(sessionId) {
    const types = registryMap.get(sessionId);
    if (!types || types.size === 0) return 'orchestrator';
    if (types.size === 1) return types.values().next().value;
    return 'mixed';
  }

  // (c) Delete sessions with model='<synthetic>'
  db.run("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
  db.run("DELETE FROM sessions WHERE model = '<synthetic>'");

  // (a) + (b) Re-resolve agent_role and model from registry
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb() {
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  const db = new SQL.Database();
  db.run(schema);
  return db;
}

function insertSession(db, id, opts = {}) {
  const defaults = {
    user: 'testuser-backfill',
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
  db.run(
    `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, s.user, s.project, s.model, s.tokens_in, s.tokens_out, s.cache_read, s.cache_creation, s.cost, s.started_at, s.agent_role]
  );
}

function insertTokenEvent(db, sessionId, model, opts = {}) {
  const defaults = {
    source: 'ingest',
    input_tokens: 50,
    output_tokens: 25,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    timestamp: '2026-03-20T10:00:00Z',
    agent_role: 'unknown',
  };
  const e = { ...defaults, ...opts };
  db.run(
    `INSERT INTO token_events (session_id, model, source, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp, agent_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, model, e.source, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_creation_tokens, e.timestamp, e.agent_role]
  );
}

function getSession(db, id) {
  const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function countSessions(db, where = '1=1') {
  const results = db.exec(`SELECT COUNT(*) as cnt FROM sessions WHERE ${where}`);
  return results.length ? results[0].values[0][0] : 0;
}

function countTokenEvents(db, where = '1=1') {
  const results = db.exec(`SELECT COUNT(*) as cnt FROM token_events WHERE ${where}`);
  return results.length ? results[0].values[0][0] : 0;
}

function getMetaValue(db, key) {
  const stmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  stmt.bind([key]);
  const val = stmt.step() ? stmt.getAsObject()['value'] : null;
  stmt.free();
  return val;
}

// ---------------------------------------------------------------------------
// Init sql.js once
// ---------------------------------------------------------------------------

before(async () => {
  const wasmPath = resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  SQL = await initSqlJs({
    wasmBinary: existsSync(wasmPath)
      ? readFileSync(wasmPath).buffer
      : undefined,
  });
});

// ===========================================================================
// AC-9: Migration gated by _meta key — idempotent
// ===========================================================================

describe('AC-9: backfill migration gated by _meta key and idempotent', () => {

  it('sets _meta key migration:backfill_agent_role_model_v1 after first run', () => {
    const db = createDb();
    backfillAgentRoleModel(db);

    const val = getMetaValue(db, 'migration:backfill_agent_role_model_v1');
    assert.equal(val, 'done', '_meta key should be set to "done" after migration');
    db.close();
  });

  it('is idempotent — second run is a no-op', () => {
    const db = createDb();
    insertSession(db, 'sess-idem-1', { model: '<synthetic>' });

    backfillAgentRoleModel(db);
    assert.equal(countSessions(db, "model = '<synthetic>'"), 0, 'synthetic sessions deleted on first run');

    // Re-insert a synthetic session to verify second run does NOT process it
    insertSession(db, 'sess-idem-2', { model: '<synthetic>' });
    backfillAgentRoleModel(db);
    assert.equal(countSessions(db, "model = '<synthetic>'"), 1, 'second run should not delete the newly inserted synthetic session');
    db.close();
  });

  it('does not throw when called on DB with no sessions', () => {
    const db = createDb();
    assert.doesNotThrow(() => backfillAgentRoleModel(db));
    assert.equal(getMetaValue(db, 'migration:backfill_agent_role_model_v1'), 'done');
    db.close();
  });

  it('does not throw when called with empty registry lines', () => {
    const db = createDb();
    insertSession(db, 'sess-empty-reg', { agent_role: 'orchestrator' });
    assert.doesNotThrow(() => backfillAgentRoleModel(db, []));

    const row = getSession(db, 'sess-empty-reg');
    assert.equal(row.agent_role, 'orchestrator', 'agent_role should remain unchanged with empty registry');
    db.close();
  });

  it('does not modify data when _meta key already exists', () => {
    const db = createDb();
    insertSession(db, 'sess-pre-gated', { model: '<synthetic>', agent_role: 'orchestrator' });

    // Pre-set the gate
    db.run("INSERT INTO _meta (key, value) VALUES ('migration:backfill_agent_role_model_v1', 'done')");

    backfillAgentRoleModel(db, [
      JSON.stringify({ session_id: 'sess-pre-gated', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ]);

    // Synthetic session should still exist — migration was skipped
    const row = getSession(db, 'sess-pre-gated');
    assert.ok(row, 'session should still exist — migration was gated');
    assert.equal(row.model, '<synthetic>', 'model should be unchanged');
    assert.equal(row.agent_role, 'orchestrator', 'agent_role should be unchanged');
    db.close();
  });
});

// ===========================================================================
// AC-10: After migration, zero sessions with model=NULL or model='<synthetic>'
//        and sessions with registry entries have corrected agent_role
// ===========================================================================

describe('AC-10: synthetic session deletion', () => {

  it('deletes sessions with model=<synthetic>', () => {
    const db = createDb();
    insertSession(db, 'sess-synth-1', { model: '<synthetic>' });
    insertSession(db, 'sess-synth-2', { model: '<synthetic>' });
    insertSession(db, 'sess-real-1', { model: 'claude-sonnet-4-20250514' });

    backfillAgentRoleModel(db);

    assert.equal(countSessions(db, "model = '<synthetic>'"), 0, 'no sessions should have model=<synthetic>');
    assert.equal(countSessions(db), 1, 'only the real session should remain');
    assert.ok(getSession(db, 'sess-real-1'), 'real session should survive');
    db.close();
  });

  it('deletes token_events for synthetic sessions', () => {
    const db = createDb();
    insertSession(db, 'sess-synth-te', { model: '<synthetic>' });
    insertTokenEvent(db, 'sess-synth-te', '<synthetic>');
    insertSession(db, 'sess-real-te', { model: 'claude-sonnet-4-20250514' });
    insertTokenEvent(db, 'sess-real-te', 'claude-sonnet-4-20250514');

    backfillAgentRoleModel(db);

    assert.equal(countTokenEvents(db, "session_id = 'sess-synth-te'"), 0, 'token_events for synthetic session should be deleted');
    assert.equal(countTokenEvents(db, "session_id = 'sess-real-te'"), 1, 'token_events for real session should survive');
    db.close();
  });

  it('handles mixed synthetic and non-synthetic sessions correctly', () => {
    const db = createDb();
    insertSession(db, 'sess-mix-synth', { model: '<synthetic>' });
    insertSession(db, 'sess-mix-real', { model: 'claude-opus-4-6' });
    insertSession(db, 'sess-mix-unknown', { model: 'unknown' });

    backfillAgentRoleModel(db);

    assert.equal(countSessions(db, "model = '<synthetic>'"), 0);
    assert.ok(getSession(db, 'sess-mix-real'));
    assert.ok(getSession(db, 'sess-mix-unknown'));
    db.close();
  });
});

describe('AC-10: agent_role correction from registry', () => {

  it('re-resolves agent_role from registry for sessions with agent_role=orchestrator', () => {
    const db = createDb();
    insertSession(db, 'sess-orch-1', { agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ session_id: 'sess-orch-1', agent_type: 'coder' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-orch-1');
    assert.equal(row.agent_role, 'coder', 'agent_role should be updated from registry');
    db.close();
  });

  it('does not change agent_role for sessions that are not orchestrator', () => {
    const db = createDb();
    insertSession(db, 'sess-coder-keep', { agent_role: 'reviewer' });

    const registry = [
      JSON.stringify({ session_id: 'sess-coder-keep', agent_type: 'coder' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-coder-keep');
    assert.equal(row.agent_role, 'reviewer', 'non-orchestrator agent_role should be preserved');
    db.close();
  });

  it('resolves to mixed when registry has multiple agent_types for one session', () => {
    const db = createDb();
    insertSession(db, 'sess-mixed-role', { agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ session_id: 'sess-mixed-role', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-mixed-role', agent_type: 'reviewer' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-mixed-role');
    assert.equal(row.agent_role, 'mixed', 'multiple agent_types should resolve to mixed');
    db.close();
  });

  it('keeps orchestrator when session has no registry entries', () => {
    const db = createDb();
    insertSession(db, 'sess-no-reg', { agent_role: 'orchestrator' });

    backfillAgentRoleModel(db, []);

    const row = getSession(db, 'sess-no-reg');
    assert.equal(row.agent_role, 'orchestrator', 'no registry entries means role stays orchestrator');
    db.close();
  });
});

describe('AC-10: model correction from registry', () => {

  it('updates model from unknown to registry value', () => {
    const db = createDb();
    insertSession(db, 'sess-model-unk', { model: 'unknown', agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ session_id: 'sess-model-unk', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-model-unk');
    assert.equal(row.model, 'claude-opus-4-6', 'model should be updated from registry');
    db.close();
  });

  it('updates NULL model to registry value', () => {
    const db = createDb();
    // Insert with explicit NULL model
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ['sess-model-null', 'testuser-backfill', 'proj', 100, 50, 0, 0, 0.01, '2026-03-20T10:00:00Z', 'orchestrator']
    );

    const registry = [
      JSON.stringify({ session_id: 'sess-model-null', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-model-null');
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'NULL model should be filled from registry');
    db.close();
  });

  it('does not overwrite valid model with registry model', () => {
    const db = createDb();
    insertSession(db, 'sess-model-valid', { model: 'claude-opus-4-6', agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ session_id: 'sess-model-valid', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-model-valid');
    assert.equal(row.model, 'claude-opus-4-6', 'valid model should not be overwritten by registry');
    db.close();
  });

  it('skips registry entries with model=unknown', () => {
    const db = createDb();
    insertSession(db, 'sess-reg-unk', { model: 'unknown', agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ session_id: 'sess-reg-unk', agent_type: 'coder', model: 'unknown' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-reg-unk');
    // Registry model 'unknown' is filtered out, so model stays 'unknown'
    assert.equal(row.model, 'unknown', 'registry model=unknown should not be used as replacement');
    db.close();
  });
});

describe('AC-10: combined agent_role + model correction', () => {

  it('corrects both agent_role and model in single migration pass', () => {
    const db = createDb();
    insertSession(db, 'sess-both-fix', { agent_role: 'orchestrator', model: 'unknown' });

    const registry = [
      JSON.stringify({ session_id: 'sess-both-fix', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-both-fix');
    assert.equal(row.agent_role, 'coder');
    assert.equal(row.model, 'claude-opus-4-6');
    db.close();
  });

  it('handles multiple sessions with different correction needs', () => {
    const db = createDb();
    insertSession(db, 'sess-multi-a', { agent_role: 'orchestrator', model: 'unknown' });
    insertSession(db, 'sess-multi-b', { agent_role: 'orchestrator', model: 'claude-sonnet-4-20250514' });
    insertSession(db, 'sess-multi-c', { agent_role: 'reviewer', model: 'unknown' });
    insertSession(db, 'sess-multi-d', { agent_role: 'orchestrator', model: '<synthetic>' });

    const registry = [
      JSON.stringify({ session_id: 'sess-multi-a', agent_type: 'coder', model: 'claude-opus-4-6' }),
      JSON.stringify({ session_id: 'sess-multi-b', agent_type: 'reviewer' }),
      JSON.stringify({ session_id: 'sess-multi-c', agent_type: 'coder', model: 'claude-haiku-4-5' }),
    ];
    backfillAgentRoleModel(db, registry);

    // sess-multi-a: orchestrator->coder, unknown->claude-opus-4-6
    const a = getSession(db, 'sess-multi-a');
    assert.equal(a.agent_role, 'coder');
    assert.equal(a.model, 'claude-opus-4-6');

    // sess-multi-b: orchestrator->reviewer, model stays (already valid)
    const b = getSession(db, 'sess-multi-b');
    assert.equal(b.agent_role, 'reviewer');
    assert.equal(b.model, 'claude-sonnet-4-20250514');

    // sess-multi-c: reviewer stays (not orchestrator), unknown->claude-haiku-4-5
    const c = getSession(db, 'sess-multi-c');
    assert.equal(c.agent_role, 'reviewer');
    assert.equal(c.model, 'claude-haiku-4-5');

    // sess-multi-d: deleted (synthetic)
    const d = getSession(db, 'sess-multi-d');
    assert.equal(d, null, 'synthetic session should be deleted');
    db.close();
  });

  it('after migration, zero sessions have model=NULL or model=<synthetic>', () => {
    const db = createDb();
    // Seed various dirty states
    insertSession(db, 'sess-null-model', { model: 'unknown', agent_role: 'orchestrator' });
    db.run(
      `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ['sess-actual-null', 'testuser-backfill', 'proj', 100, 50, 0, 0, 0.01, '2026-03-20T10:00:00Z', 'orchestrator']
    );
    insertSession(db, 'sess-synth-final', { model: '<synthetic>' });
    insertSession(db, 'sess-clean', { model: 'claude-sonnet-4-20250514' });

    const registry = [
      JSON.stringify({ session_id: 'sess-null-model', agent_type: 'coder', model: 'claude-opus-4-6' }),
      JSON.stringify({ session_id: 'sess-actual-null', agent_type: 'reviewer', model: 'claude-haiku-4-5' }),
    ];
    backfillAgentRoleModel(db, registry);

    assert.equal(countSessions(db, "model = '<synthetic>'"), 0, 'zero sessions with model=<synthetic>');
    assert.equal(countSessions(db, "model IS NULL"), 0, 'zero sessions with model=NULL');
    db.close();
  });
});

describe('AC-10: edge cases and error handling', () => {

  it('handles malformed registry lines gracefully', () => {
    const db = createDb();
    insertSession(db, 'sess-malformed', { agent_role: 'orchestrator', model: 'unknown' });

    const registry = [
      'not valid json',
      '{"incomplete',
      '',
      JSON.stringify({ session_id: 'sess-malformed', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-malformed');
    assert.equal(row.agent_role, 'coder', 'valid entry should still be processed despite malformed lines');
    assert.equal(row.model, 'claude-opus-4-6');
    db.close();
  });

  it('handles registry entries without session_id', () => {
    const db = createDb();
    insertSession(db, 'sess-no-sid', { agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ agent_type: 'coder', model: 'claude-opus-4-6' }),  // no session_id
    ];
    assert.doesNotThrow(() => backfillAgentRoleModel(db, registry));

    const row = getSession(db, 'sess-no-sid');
    assert.equal(row.agent_role, 'orchestrator', 'session should be unchanged');
    db.close();
  });

  it('handles registry entries without agent_type', () => {
    const db = createDb();
    insertSession(db, 'sess-no-atype', { agent_role: 'orchestrator', model: 'unknown' });

    const registry = [
      JSON.stringify({ session_id: 'sess-no-atype', model: 'claude-opus-4-6' }),  // no agent_type
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-no-atype');
    // No agent_type means registryMap has no entry, resolveAgentRole returns 'orchestrator'
    // But registryModelMap has the model, so model gets updated
    assert.equal(row.agent_role, 'orchestrator', 'agent_role stays orchestrator without agent_type');
    assert.equal(row.model, 'claude-opus-4-6', 'model should still be updated from registry');
    db.close();
  });

  it('handles session in registry that does not exist in DB', () => {
    const db = createDb();
    insertSession(db, 'sess-exists', { agent_role: 'orchestrator' });

    const registry = [
      JSON.stringify({ session_id: 'sess-ghost', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ];
    assert.doesNotThrow(() => backfillAgentRoleModel(db, registry));

    // sess-exists should be unchanged, sess-ghost just gets a no-op UPDATE
    const row = getSession(db, 'sess-exists');
    assert.equal(row.agent_role, 'orchestrator');
    assert.equal(getSession(db, 'sess-ghost'), null, 'ghost session should not be created');
    db.close();
  });

  it('synthetic session deletion happens before agent_role resolution', () => {
    const db = createDb();
    // Synthetic session that also has a registry entry
    insertSession(db, 'sess-synth-reg', { model: '<synthetic>', agent_role: 'orchestrator' });
    insertTokenEvent(db, 'sess-synth-reg', '<synthetic>');

    const registry = [
      JSON.stringify({ session_id: 'sess-synth-reg', agent_type: 'coder', model: 'claude-opus-4-6' }),
    ];
    backfillAgentRoleModel(db, registry);

    // Session should be deleted despite having registry entry
    assert.equal(getSession(db, 'sess-synth-reg'), null, 'synthetic session should be deleted even with registry entry');
    assert.equal(countTokenEvents(db, "session_id = 'sess-synth-reg'"), 0);
    db.close();
  });

  it('preserves agent_role=unknown when session has no registry entry', () => {
    const db = createDb();
    insertSession(db, 'sess-unk-noreg', { agent_role: 'unknown', model: 'claude-sonnet-4-20250514' });

    backfillAgentRoleModel(db, []);

    const row = getSession(db, 'sess-unk-noreg');
    assert.equal(row.agent_role, 'unknown', 'unknown agent_role without registry should stay unknown');
    db.close();
  });

  it('last registry entry wins for model when multiple entries for same session', () => {
    const db = createDb();
    insertSession(db, 'sess-multi-reg', { agent_role: 'orchestrator', model: 'unknown' });

    const registry = [
      JSON.stringify({ session_id: 'sess-multi-reg', agent_type: 'coder', model: 'model-first' }),
      JSON.stringify({ session_id: 'sess-multi-reg', agent_type: 'reviewer', model: 'model-second' }),
    ];
    backfillAgentRoleModel(db, registry);

    const row = getSession(db, 'sess-multi-reg');
    assert.equal(row.model, 'model-second', 'last registry entry model should win');
    assert.equal(row.agent_role, 'mixed', 'multiple agent_types should resolve to mixed');
    db.close();
  });
});
