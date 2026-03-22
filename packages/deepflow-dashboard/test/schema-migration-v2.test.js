/**
 * Unit tests for schema migration v1 → v2 (T3: subagent-instrumentation).
 *
 * Verifies:
 * - Fresh v2 DB has agent_role columns on sessions and token_events
 * - v1→v2 migration adds agent_role to existing tables
 * - Migration sets schema_version to '2'
 * - Pre-existing rows get default 'unknown'
 * - Index idx_sessions_agent_role is created
 * - Running migration on v2 DB is idempotent (no-op)
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
const SCHEMA_PATH = resolve(__dirname, '..', 'src', 'db', 'schema.sql');

let SQL;

// -------------------------------------------------------------------------
// V1 schema: the schema.sql BEFORE the v2 changes (no agent_role columns)
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
// migrateDatabase: exact replica of the function from src/db/index.ts
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

/** Create an in-memory DB with current (v2) schema.sql */
function createFreshV2Db() {
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  const db = new SQL.Database();
  db.run(schema);
  return db;
}

/** Get column names for a table */
function getColumnNames(db, table) {
  const results = db.exec(`PRAGMA table_info(${table})`);
  if (!results.length) return [];
  // table_info columns: cid, name, type, notnull, dflt_value, pk
  return results[0].values.map(row => row[1]);
}

/** Get schema_version from _meta */
function getSchemaVersion(db) {
  const stmt = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
  const version = stmt.step() ? stmt.getAsObject()['value'] : null;
  stmt.free();
  return version;
}

/** Check if an index exists */
function indexExists(db, indexName) {
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?");
  stmt.bind([indexName]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

// -------------------------------------------------------------------------
// Init sql.js once
// -------------------------------------------------------------------------
before(async () => {
  const wasmPath = resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  SQL = await initSqlJs({
    wasmBinary: existsSync(wasmPath)
      ? readFileSync(wasmPath).buffer
      : undefined,
  });
});

// =========================================================================
// Tests
// =========================================================================

describe('Schema migration v1 → v2', () => {

  // -----------------------------------------------------------------------
  // Fresh v2 DB
  // -----------------------------------------------------------------------
  describe('fresh v2 DB (schema.sql applied to empty DB)', () => {
    it('sessions table has agent_role column', () => {
      const db = createFreshV2Db();
      const cols = getColumnNames(db, 'sessions');
      assert.ok(cols.includes('agent_role'), `sessions columns: ${cols.join(', ')}`);
      db.close();
    });

    it('token_events table has agent_role column', () => {
      const db = createFreshV2Db();
      const cols = getColumnNames(db, 'token_events');
      assert.ok(cols.includes('agent_role'), `token_events columns: ${cols.join(', ')}`);
      db.close();
    });

    it('schema_version is 2', () => {
      const db = createFreshV2Db();
      assert.equal(getSchemaVersion(db), '2');
      db.close();
    });

    it('idx_sessions_agent_role index exists', () => {
      const db = createFreshV2Db();
      assert.ok(indexExists(db, 'idx_sessions_agent_role'));
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // v1 → v2 migration
  // -----------------------------------------------------------------------
  describe('v1→v2 migration via migrateDatabase()', () => {
    it('adds agent_role column to sessions', () => {
      const db = createV1Db();
      // Before migration: no agent_role
      assert.ok(!getColumnNames(db, 'sessions').includes('agent_role'));
      migrateDatabase(db);
      assert.ok(getColumnNames(db, 'sessions').includes('agent_role'));
      db.close();
    });

    it('adds agent_role column to token_events', () => {
      const db = createV1Db();
      assert.ok(!getColumnNames(db, 'token_events').includes('agent_role'));
      migrateDatabase(db);
      assert.ok(getColumnNames(db, 'token_events').includes('agent_role'));
      db.close();
    });

    it('sets schema_version to 2', () => {
      const db = createV1Db();
      assert.equal(getSchemaVersion(db), '1');
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '2');
      db.close();
    });

    it('creates idx_sessions_agent_role index', () => {
      const db = createV1Db();
      assert.ok(!indexExists(db, 'idx_sessions_agent_role'));
      migrateDatabase(db);
      assert.ok(indexExists(db, 'idx_sessions_agent_role'));
      db.close();
    });

    it('pre-existing session rows get default agent_role = unknown', () => {
      const db = createV1Db();
      // Insert a row before migration
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s2', 'bob', '2025-01-02T00:00:00Z')`);

      migrateDatabase(db);

      const stmt = db.prepare("SELECT agent_role FROM sessions ORDER BY id");
      const roles = [];
      while (stmt.step()) {
        roles.push(stmt.getAsObject()['agent_role']);
      }
      stmt.free();

      assert.equal(roles.length, 2);
      assert.equal(roles[0], 'unknown');
      assert.equal(roles[1], 'unknown');
      db.close();
    });

    it('pre-existing token_events rows get default agent_role = unknown', () => {
      const db = createV1Db();
      // Need a session first for FK
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);
      db.run(`INSERT INTO token_events (session_id, model, timestamp) VALUES ('s1', 'opus', '2025-01-01T00:00:00Z')`);

      migrateDatabase(db);

      const stmt = db.prepare("SELECT agent_role FROM token_events");
      const found = stmt.step();
      assert.ok(found, 'should have a token_events row');
      const role = stmt.getAsObject()['agent_role'];
      stmt.free();

      assert.equal(role, 'unknown');
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency: running migration on already-v2 DB is a no-op
  // -----------------------------------------------------------------------
  describe('idempotency — migration on v2 DB is a no-op', () => {
    it('running migrateDatabase on a v2 DB does not throw', () => {
      const db = createFreshV2Db();
      // schema.sql already sets version to 2, so migrateDatabase should skip
      assert.doesNotThrow(() => migrateDatabase(db));
      db.close();
    });

    it('schema_version remains 2 after double migration', () => {
      const db = createV1Db();
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '2');
      // Run again — should be no-op
      migrateDatabase(db);
      assert.equal(getSchemaVersion(db), '2');
      db.close();
    });

    it('columns are not duplicated after double migration', () => {
      const db = createV1Db();
      migrateDatabase(db);
      migrateDatabase(db);

      const sessionCols = getColumnNames(db, 'sessions');
      const agentRoleCount = sessionCols.filter(c => c === 'agent_role').length;
      assert.equal(agentRoleCount, 1, 'agent_role should appear exactly once in sessions');

      const tokenCols = getColumnNames(db, 'token_events');
      const tokenRoleCount = tokenCols.filter(c => c === 'agent_role').length;
      assert.equal(tokenRoleCount, 1, 'agent_role should appear exactly once in token_events');

      db.close();
    });

    it('data is preserved after double migration', () => {
      const db = createV1Db();
      db.run(`INSERT INTO sessions (id, user, started_at) VALUES ('s1', 'alice', '2025-01-01T00:00:00Z')`);

      migrateDatabase(db);
      // Update to a non-default value
      db.run("UPDATE sessions SET agent_role = 'orchestrator' WHERE id = 's1'");

      // Run migration again — should not reset agent_role
      migrateDatabase(db);

      const stmt = db.prepare("SELECT agent_role FROM sessions WHERE id = 's1'");
      stmt.step();
      const role = stmt.getAsObject()['agent_role'];
      stmt.free();

      assert.equal(role, 'orchestrator', 'agent_role should not be reset on re-migration');
      db.close();
    });
  });
});
