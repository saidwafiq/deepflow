/**
 * Unit tests for schema migration v2 → v3 (T1: dashboard-fixes).
 *
 * Verifies:
 * - Fresh v3 DB has cache_hit_ratio column on sessions
 * - Fresh v3 DB sets schema_version to '3'
 * - v2→v3 migration adds cache_hit_ratio to existing sessions table
 * - v2→v3 migration sets schema_version to '3'
 * - v1→v3 chained migration (v1→v2→v3) works end-to-end
 * - Purge synthetic sessions removes cache-synthetic-* rows
 * - Purge is idempotent (gated by _meta key)
 * - Running migration on v3 DB is idempotent (no-op)
 *
 * Uses sql.js in-memory databases to test migration logic directly,
 * reproducing the exact SQL from schema.sql and db/index.ts migrateDatabase().
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
const WASM_PATH = resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let SQL;

// -------------------------------------------------------------------------
// V1 schema: the original schema (no agent_role, no cache_hit_ratio)
// -------------------------------------------------------------------------
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user             TEXT NOT NULL,
  project          TEXT,
  model            TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_creation   INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  messages         INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  cost             REAL    NOT NULL DEFAULT 0,
  started_at       TEXT    NOT NULL,
  ended_at         TEXT
);

CREATE TABLE IF NOT EXISTS token_events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT    NOT NULL REFERENCES sessions(id),
  model                  TEXT    NOT NULL,
  source                 TEXT    NOT NULL DEFAULT 'ingest',
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  timestamp              TEXT    NOT NULL,
  UNIQUE (session_id, model, source)
);
`;

// -------------------------------------------------------------------------
// V2 schema: has agent_role but no cache_hit_ratio
// -------------------------------------------------------------------------
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '2');

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user             TEXT NOT NULL,
  project          TEXT,
  model            TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_creation   INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  messages         INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  cost             REAL    NOT NULL DEFAULT 0,
  started_at       TEXT    NOT NULL,
  ended_at         TEXT,
  agent_role       TEXT    NOT NULL DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS token_events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT    NOT NULL REFERENCES sessions(id),
  model                  TEXT    NOT NULL,
  source                 TEXT    NOT NULL DEFAULT 'ingest',
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  timestamp              TEXT    NOT NULL,
  agent_role             TEXT    NOT NULL DEFAULT 'unknown',
  UNIQUE (session_id, model, source)
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_role ON sessions(agent_role);
`;

// -------------------------------------------------------------------------
// V3 schema: has agent_role + cache_hit_ratio (matches updated schema.sql)
// -------------------------------------------------------------------------
const V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '3');

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user             TEXT NOT NULL,
  project          TEXT,
  model            TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_creation   INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  messages         INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  cost             REAL    NOT NULL DEFAULT 0,
  started_at       TEXT    NOT NULL,
  ended_at         TEXT,
  agent_role       TEXT    NOT NULL DEFAULT 'unknown',
  cache_hit_ratio  REAL    DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS token_events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT    NOT NULL REFERENCES sessions(id),
  model                  TEXT    NOT NULL,
  source                 TEXT    NOT NULL DEFAULT 'ingest',
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  timestamp              TEXT    NOT NULL,
  agent_role             TEXT    NOT NULL DEFAULT 'unknown',
  UNIQUE (session_id, model, source)
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_role ON sessions(agent_role);
`;

// -------------------------------------------------------------------------
// migrateDatabase: exact replica of the function from src/db/index.ts (v3)
// -------------------------------------------------------------------------
function migrateDatabase(db) {
  const stmt = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
  const version = stmt.step() ? stmt.getAsObject()['value'] : '1';
  stmt.free();

  if (version === '1') {
    db.run("ALTER TABLE sessions ADD COLUMN agent_role TEXT DEFAULT 'unknown'");
    db.run("ALTER TABLE token_events ADD COLUMN agent_role TEXT DEFAULT 'unknown'");
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_agent_role ON sessions(agent_role)");
    db.run("UPDATE _meta SET value = '2' WHERE key = 'schema_version'");
    // Fall through to apply v2→v3 as well
  }

  const currentVersion = (() => {
    const s = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
    const v = s.step() ? s.getAsObject()['value'] : '1';
    s.free();
    return v;
  })();

  if (currentVersion === '2') {
    // v2 → v3: add cache_hit_ratio column
    db.run("ALTER TABLE sessions ADD COLUMN cache_hit_ratio REAL DEFAULT NULL");
    db.run("UPDATE _meta SET value = '3' WHERE key = 'schema_version'");
  }

  // One-time purge of synthetic sessions (idempotent — gated by _meta key)
  const purgeKey = 'migration:purge_synthetic_sessions_v1';
  const purgeStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  purgeStmt.bind([purgeKey]);
  const purgeExists = purgeStmt.step();
  purgeStmt.free();

  if (!purgeExists) {
    db.run("DELETE FROM token_events WHERE session_id LIKE 'cache-synthetic-%'");
    db.run("DELETE FROM sessions WHERE id LIKE 'cache-synthetic-%'");
    db.run("INSERT INTO _meta (key, value) VALUES (?, 'done')", [purgeKey]);
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Create an in-memory DB with v1 schema */
function createV1Db() {
  const db = new SQL.Database();
  db.run(V1_SCHEMA);
  return db;
}

/** Create an in-memory DB with v2 schema */
function createV2Db() {
  const db = new SQL.Database();
  db.run(V2_SCHEMA);
  return db;
}

/** Create an in-memory DB with current (v3) schema */
function createFreshV3Db() {
  const db = new SQL.Database();
  db.run(V3_SCHEMA);
  return db;
}

/** Get column names for a table */
function getColumnNames(db, table) {
  const results = db.exec(`PRAGMA table_info(${table})`);
  if (!results.length) return [];
  return results[0].values.map(row => row[1]);
}

/** Get column info (name, type, notnull, dflt_value) for a specific column */
function getColumnInfo(db, table, columnName) {
  const results = db.exec(`PRAGMA table_info(${table})`);
  if (!results.length) return null;
  // columns: cid, name, type, notnull, dflt_value, pk
  const row = results[0].values.find(r => r[1] === columnName);
  if (!row) return null;
  return { name: row[1], type: row[2], notnull: row[3], dflt_value: row[4], pk: row[5] };
}

/** Get schema_version from _meta */
function getSchemaVersion(db) {
  const stmt = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
  const version = stmt.step() ? stmt.getAsObject()['value'] : null;
  stmt.free();
  return version;
}

/** Get a _meta value by key */
function getMetaValue(db, key) {
  const stmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  stmt.bind([key]);
  const value = stmt.step() ? stmt.getAsObject()['value'] : null;
  stmt.free();
  return value;
}

/** Count rows in a table with optional WHERE clause */
function countRows(db, table, where = '') {
  const sql = `SELECT COUNT(*) as cnt FROM ${table}${where ? ' WHERE ' + where : ''}`;
  const results = db.exec(sql);
  return results[0].values[0][0];
}

// -------------------------------------------------------------------------
// Init sql.js once
// -------------------------------------------------------------------------
before(async () => {
  SQL = await initSqlJs({
    wasmBinary: existsSync(WASM_PATH)
      ? readFileSync(WASM_PATH).buffer
      : undefined,
  });
});

// =========================================================================
// Tests
// =========================================================================

describe('Schema migration v2 → v3', () => {

  // -----------------------------------------------------------------------
  // Fresh v3 DB
  // -----------------------------------------------------------------------
  describe('fresh v3 DB (schema.sql applied to empty DB)', () => {
    it('sessions table has cache_hit_ratio column', () => {
      const db = createFreshV3Db();
      const cols = getColumnNames(db, 'sessions');
      assert.ok(cols.includes('cache_hit_ratio'), `sessions columns: ${cols.join(', ')}`);
      db.close();
    });

    it('cache_hit_ratio column is REAL type with NULL default', () => {
      const db = createFreshV3Db();
      const info = getColumnInfo(db, 'sessions', 'cache_hit_ratio');
      assert.ok(info, 'cache_hit_ratio column should exist');
      assert.equal(info.type, 'REAL');
      assert.equal(info.notnull, 0, 'cache_hit_ratio should be nullable');
      assert.equal(info.dflt_value, 'NULL');
      db.close();
    });

    it('schema_version is 3', () => {
      const db = createFreshV3Db();
      assert.equal(getSchemaVersion(db), '3');
      db.close();
    });

    it('sessions table still has agent_role column', () => {
      const db = createFreshV3Db();
      const cols = getColumnNames(db, 'sessions');
      assert.ok(cols.includes('agent_role'), `sessions columns: ${cols.join(', ')}`);
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // v2 → v3 migration
  // -----------------------------------------------------------------------
  describe('v2→v3 migration via migrateDatabase()', () => {
    it('adds cache_hit_ratio column to sessions', () => {
      const db = createV2Db();
      assert.ok(!getColumnNames(db, 'sessions').includes('cache_hit_ratio'));
      migrateDatabase(db);
      assert.ok(getColumnNames(db, 'sessions').includes('cache_hit_ratio'));
      db.close();
    });

    it('sets schema_version to 3', () => {
      const db = createV2Db();
      assert.equal(getSchemaVersion(db), '2');
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '3');
      db.close();
    });

    it('pre-existing session rows get NULL cache_hit_ratio', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s2', 'bob', '2025-01-02T00:00:00Z')`);

      migrateDatabase(db);

      const stmt = db.prepare("SELECT cache_hit_ratio FROM sessions ORDER BY id");
      const ratios = [];
      while (stmt.step()) {
        ratios.push(stmt.getAsObject()['cache_hit_ratio']);
      }
      stmt.free();

      assert.equal(ratios.length, 2);
      assert.equal(ratios[0], null);
      assert.equal(ratios[1], null);
      db.close();
    });

    it('preserves existing agent_role values during migration', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at, agent_role) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z', 'orchestrator')`);

      migrateDatabase(db);

      const stmt = db.prepare("SELECT agent_role FROM sessions WHERE id = 's1'");
      stmt.step();
      const role = stmt.getAsObject()['agent_role'];
      stmt.free();

      assert.equal(role, 'orchestrator');
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // v1 → v3 chained migration
  // -----------------------------------------------------------------------
  describe('v1→v3 chained migration', () => {
    it('migrates from v1 all the way to v3 in one call', () => {
      const db = createV1Db();
      assert.equal(getSchemaVersion(db), '1');
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '3');
      db.close();
    });

    it('v1 DB gains both agent_role and cache_hit_ratio after migration', () => {
      const db = createV1Db();
      migrateDatabase(db);
      const cols = getColumnNames(db, 'sessions');
      assert.ok(cols.includes('agent_role'), 'should have agent_role');
      assert.ok(cols.includes('cache_hit_ratio'), 'should have cache_hit_ratio');
      db.close();
    });

    it('pre-existing v1 rows get defaults for both new columns', () => {
      const db = createV1Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);

      migrateDatabase(db);

      const stmt = db.prepare("SELECT agent_role, cache_hit_ratio FROM sessions WHERE id = 's1'");
      stmt.step();
      const row = stmt.getAsObject();
      stmt.free();

      assert.equal(row['agent_role'], 'unknown');
      assert.equal(row['cache_hit_ratio'], null);
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Purge synthetic sessions
  // -----------------------------------------------------------------------
  describe('purge synthetic sessions', () => {
    it('deletes sessions with id LIKE cache-synthetic-%', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-synthetic-001', 'sys', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-synthetic-002', 'sys', '2025-01-02T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('real-session-001', 'alice', '2025-01-03T00:00:00Z')`);

      migrateDatabase(db);

      assert.equal(countRows(db, 'sessions'), 1);
      const stmt = db.prepare("SELECT id FROM sessions");
      stmt.step();
      assert.equal(stmt.getAsObject()['id'], 'real-session-001');
      stmt.free();
      db.close();
    });

    it('deletes token_events for synthetic sessions', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-synthetic-001', 'sys', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('real-session-001', 'alice', '2025-01-02T00:00:00Z')`);
      db.run(`INSERT INTO token_events (session_id, model, timestamp) VALUES ('cache-synthetic-001', 'opus', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO token_events (session_id, model, timestamp) VALUES ('real-session-001', 'opus', '2025-01-02T00:00:00Z')`);

      migrateDatabase(db);

      assert.equal(countRows(db, 'token_events'), 1);
      const stmt = db.prepare("SELECT session_id FROM token_events");
      stmt.step();
      assert.equal(stmt.getAsObject()['session_id'], 'real-session-001');
      stmt.free();
      db.close();
    });

    it('sets _meta key migration:purge_synthetic_sessions_v1 to done', () => {
      const db = createV2Db();
      migrateDatabase(db);
      assert.equal(getMetaValue(db, 'migration:purge_synthetic_sessions_v1'), 'done');
      db.close();
    });

    it('does not delete non-synthetic sessions', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('real-1', 'alice', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-real-1', 'bob', '2025-01-02T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('synthetic-not-cache', 'carol', '2025-01-03T00:00:00Z')`);

      migrateDatabase(db);

      assert.equal(countRows(db, 'sessions'), 3, 'all non-synthetic sessions should remain');
      db.close();
    });

    it('handles DB with no synthetic sessions gracefully', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('normal-1', 'alice', '2025-01-01T00:00:00Z')`);

      assert.doesNotThrow(() => migrateDatabase(db));
      assert.equal(countRows(db, 'sessions'), 1);
      assert.equal(getMetaValue(db, 'migration:purge_synthetic_sessions_v1'), 'done');
      db.close();
    });

    it('purge is idempotent — second run does not re-delete', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-synthetic-001', 'sys', '2025-01-01T00:00:00Z')`);

      migrateDatabase(db);
      assert.equal(countRows(db, 'sessions'), 0);

      // Insert a new session with cache-synthetic prefix AFTER purge
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-synthetic-new', 'sys', '2025-01-04T00:00:00Z')`);

      // Run migration again — purge should NOT fire because _meta key exists
      migrateDatabase(db);
      assert.equal(countRows(db, 'sessions'), 1, 'newly inserted synthetic session should survive second run');
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency: running migration on already-v3 DB is a no-op
  // -----------------------------------------------------------------------
  describe('idempotency — migration on v3 DB is a no-op', () => {
    it('running migrateDatabase on a fresh v3 DB does not throw', () => {
      const db = createFreshV3Db();
      assert.doesNotThrow(() => migrateDatabase(db));
      db.close();
    });

    it('schema_version remains 3 after double migration', () => {
      const db = createV2Db();
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '3');
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '3');
      db.close();
    });

    it('cache_hit_ratio column is not duplicated after double migration', () => {
      const db = createV2Db();
      migrateDatabase(db);
      migrateDatabase(db);

      const sessionCols = getColumnNames(db, 'sessions');
      const cacheHitCount = sessionCols.filter(c => c === 'cache_hit_ratio').length;
      assert.equal(cacheHitCount, 1, 'cache_hit_ratio should appear exactly once in sessions');
      db.close();
    });

    it('data is preserved after double migration', () => {
      const db = createV2Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);

      migrateDatabase(db);
      db.run("UPDATE sessions SET cache_hit_ratio = 0.85 WHERE id = 's1'");

      // Run migration again — should not reset cache_hit_ratio
      migrateDatabase(db);

      const stmt = db.prepare("SELECT cache_hit_ratio FROM sessions WHERE id = 's1'");
      stmt.step();
      const ratio = stmt.getAsObject()['cache_hit_ratio'];
      stmt.free();

      assert.equal(ratio, 0.85, 'cache_hit_ratio should not be reset on re-migration');
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('cache_hit_ratio accepts valid float values', () => {
      const db = createFreshV3Db();
      db.run(`INSERT INTO sessions (id, user, started_at, cache_hit_ratio) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z', 0.0)`);
      db.run(`INSERT INTO sessions (id, user, started_at, cache_hit_ratio) VALUES ('s2', 'bob', '2025-01-02T00:00:00Z', 1.0)`);
      db.run(`INSERT INTO sessions (id, user, started_at, cache_hit_ratio) VALUES ('s3', 'carol', '2025-01-03T00:00:00Z', 0.5432)`);

      const stmt = db.prepare("SELECT cache_hit_ratio FROM sessions ORDER BY id");
      const values = [];
      while (stmt.step()) {
        values.push(stmt.getAsObject()['cache_hit_ratio']);
      }
      stmt.free();

      assert.equal(values[0], 0.0);
      assert.equal(values[1], 1.0);
      assert.ok(Math.abs(values[2] - 0.5432) < 0.0001);
      db.close();
    });

    it('cache_hit_ratio defaults to NULL when not specified', () => {
      const db = createFreshV3Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);

      const stmt = db.prepare("SELECT cache_hit_ratio FROM sessions WHERE id = 's1'");
      stmt.step();
      const ratio = stmt.getAsObject()['cache_hit_ratio'];
      stmt.free();

      assert.equal(ratio, null);
      db.close();
    });

    it('purge handles multiple synthetic sessions with associated token_events', () => {
      const db = createV2Db();
      // Create several synthetic sessions with events
      for (let i = 1; i <= 5; i++) {
        db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('cache-synthetic-${String(i).padStart(3, '0')}', 'sys', '2025-01-0${i}T00:00:00Z')`);
        db.run(`INSERT INTO token_events (session_id, model, source, timestamp) VALUES ('cache-synthetic-${String(i).padStart(3, '0')}', 'opus', 'source${i}', '2025-01-0${i}T00:00:00Z')`);
      }
      // Plus one real
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('real-1', 'alice', '2025-01-06T00:00:00Z')`);
      db.run(`INSERT INTO token_events (session_id, model, timestamp) VALUES ('real-1', 'opus', '2025-01-06T00:00:00Z')`);

      migrateDatabase(db);

      assert.equal(countRows(db, 'sessions'), 1);
      assert.equal(countRows(db, 'token_events'), 1);
      db.close();
    });
  });
});
