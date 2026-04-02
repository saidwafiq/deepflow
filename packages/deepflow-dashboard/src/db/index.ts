import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let SQL: SqlJsStatic | null = null;
let _db: Database | null = null;
let _dbPath: string | null = null;

/** Resolve database file path based on mode */
function resolveDatabasePath(mode: 'local' | 'serve'): string {
  if (mode === 'local') {
    const dir = resolve(homedir(), '.claude');
    mkdirSync(dir, { recursive: true });
    return resolve(dir, 'deepflow-dashboard.db');
  }
  return resolve(process.cwd(), 'deepflow-dashboard.db');
}

/** Read persisted DB from disk or return empty buffer */
function loadDbBuffer(dbPath: string): Buffer {
  if (existsSync(dbPath)) {
    return readFileSync(dbPath);
  }
  return Buffer.alloc(0);
}

/** Persist in-memory DB to disk */
export function persistDatabase(): void {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  writeFileSync(_dbPath, Buffer.from(data));
}

/** Initialize sql.js and open (or create) the database, running schema migrations */
export async function initDatabase(mode: 'local' | 'serve' = 'local'): Promise<Database> {
  if (_db) return _db;

  // Locate sql-wasm.wasm bundled with sql.js package
  const wasmPath = resolve(
    __dirname,
    '../../node_modules/sql.js/dist/sql-wasm.wasm'
  );

  SQL = await initSqlJs({
    // Provide WASM binary directly to avoid CDN fetch in Node
    wasmBinary: existsSync(wasmPath) ? (readFileSync(wasmPath).buffer as ArrayBuffer) : undefined,
  });

  _dbPath = resolveDatabasePath(mode);
  const buf = loadDbBuffer(_dbPath);
  _db = buf.length > 0 ? new SQL.Database(buf) : new SQL.Database();

  // Run schema migrations
  const schemaPath = resolve(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  _db.run(schema);

  // Upgrade v1 → v2: add agent_role columns and index
  migrateDatabase(_db);

  // One-time backfill of dirty agent_role and model data (REQ-5)
  backfillAgentRoleModel(_db);

  // One-time reset of model/cost on virtual sessions so re-ingest corrects them
  runMigrationSubagentModelFixV2(_db);

  // One-time deletion of stale ingest_offset:session:* keys so re-ingest starts clean
  runMigrationTokenDedupCorrectionV1(_db);

  // Persist after schema init
  persistDatabase();

  console.log(`[db] Opened database at ${_dbPath}`);
  return _db;
}

/** Run incremental schema migrations based on _meta.schema_version */
function migrateDatabase(db: Database): void {
  const stmt = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
  const version = stmt.step() ? (stmt.getAsObject()['value'] as string) : '1';
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
    const v = s.step() ? (s.getAsObject()['value'] as string) : '1';
    s.free();
    return v;
  })();

  if (currentVersion === '2') {
    // v2 → v3: add cache_hit_ratio column
    db.run("ALTER TABLE sessions ADD COLUMN cache_hit_ratio REAL DEFAULT NULL");
    db.run("UPDATE _meta SET value = '3' WHERE key = 'schema_version'");
  }

  // v3 → v4: add parent_session_id column for subagent → orchestrator join
  const v4Check = (() => {
    const s = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
    const v = s.step() ? (s.getAsObject()['value'] as string) : '1';
    s.free();
    return v;
  })();
  if (parseInt(v4Check) < 4) {
    try {
      db.run("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT NULL REFERENCES sessions(id)");
    } catch { /* column may already exist */ }
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)");
    db.run("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '4')");
  }

  // v4 → v5: add cache_creation_5m and cache_creation_1h columns
  const v5Check = (() => {
    const s = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'");
    const v = s.step() ? (s.getAsObject()['value'] as string) : '1';
    s.free();
    return v;
  })();
  if (parseInt(v5Check) < 5) {
    try {
      db.run("ALTER TABLE sessions ADD COLUMN cache_creation_5m INTEGER NOT NULL DEFAULT 0");
    } catch { /* column may already exist */ }
    try {
      db.run("ALTER TABLE sessions ADD COLUMN cache_creation_1h INTEGER NOT NULL DEFAULT 0");
    } catch { /* column may already exist */ }
    db.run("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '5')");
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

/**
 * One-time backfill: normalize agent_role and clean up stale data.
 * With virtual subagent sessions, parent sessions are always 'orchestrator'.
 */
function backfillAgentRoleModel(db: Database): void {
  const migrationKey = 'migration:backfill_agent_role_model_v4';
  const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  checkStmt.bind([migrationKey]);
  const alreadyRan = checkStmt.step();
  checkStmt.free();

  if (alreadyRan) return;

  // Delete sessions with model='<synthetic>'
  db.run("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
  db.run("DELETE FROM sessions WHERE model = '<synthetic>'");

  // All non-virtual sessions (no '::' in id) are orchestrators
  db.run("UPDATE sessions SET agent_role = 'orchestrator' WHERE id NOT LIKE '%::%' AND agent_role != 'orchestrator'");

  // Normalize unknown/null agent_role to orchestrator for non-virtual sessions
  db.run("UPDATE sessions SET agent_role = 'orchestrator' WHERE id NOT LIKE '%::%' AND (agent_role = 'unknown' OR agent_role IS NULL)");

  // Clean up old virtual sessions that had wrong model from previous backfills
  // (they'll be recreated correctly by the sessions parser)
  db.run("DELETE FROM sessions WHERE id LIKE '%::%' AND parent_session_id IS NULL");

  db.run("INSERT INTO _meta (key, value) VALUES (?, 'done')", [migrationKey]);
  console.log('[db:backfill] backfill_agent_role_model_v4 complete');
}

/**
 * One-time migration: reset model and cost on virtual sessions so re-ingest
 * picks up the corrected model values from JSONL.
 * Virtual sessions are identified by '::' in their id (e.g. session_id::agent_id).
 */
export function runMigrationSubagentModelFixV2(db: Database): void {
  const migrationKey = 'migration:subagent_model_fix_v2';
  const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  checkStmt.bind([migrationKey]);
  const alreadyRan = checkStmt.step();
  checkStmt.free();

  if (alreadyRan) return;

  db.run("UPDATE sessions SET model = 'unknown', cost = 0 WHERE id LIKE '%::%'");
  db.run("INSERT INTO _meta (key, value) VALUES (?, 'done')", [migrationKey]);
  console.log('[db:migration] subagent_model_fix_v2 complete');
}

/**
 * One-time migration: delete all stale ingest_offset:session:* keys from _meta
 * so that re-ingest starts from line 0 and avoids token double-counting.
 */
export function runMigrationTokenDedupCorrectionV1(db: Database): void {
  const migrationKey = 'migration:token_dedup_correction_v1';
  const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  checkStmt.bind([migrationKey]);
  const alreadyRan = checkStmt.step();
  checkStmt.free();

  if (alreadyRan) return;

  db.run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:session:%'");
  db.run("INSERT INTO _meta (key, value) VALUES (?, '1')", [migrationKey]);
  console.log('[db:migration] token_dedup_correction_v1 complete');
}

/** Get the initialized database instance (throws if not initialized) */
export function getDb(): Database {
  if (!_db) throw new Error('Database not initialized — call initDatabase() first');
  return _db;
}

// --- Query helpers ---

export type Row = Record<string, unknown>;

/** Shared db helper interface passed to ingest parsers */
export interface DbHelpers {
  run: (sql: string, params?: SqlValue[]) => void;
  get: (sql: string, params?: SqlValue[]) => Row | undefined;
  all: (sql: string, params?: SqlValue[]) => Row[];
}

/** Execute a statement with optional bind params (no result rows) */
export function run(sql: string, params: SqlValue[] = []): void {
  getDb().run(sql, params);
}

/** Return first matching row or undefined */
export function get(sql: string, params: SqlValue[] = []): Row | undefined {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row as Row | undefined;
}

/** Return all matching rows */
export function all(sql: string, params: SqlValue[] = []): Row[] {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const rows: Row[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Row);
  }
  stmt.free();
  return rows;
}
