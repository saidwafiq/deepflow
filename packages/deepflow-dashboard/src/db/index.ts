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
 * One-time backfill of dirty agent_role and model data (AC-9, AC-10 — REQ-5).
 * Gated by _meta key 'migration:backfill_agent_role_model_v1' — idempotent.
 *
 * Operations:
 *   (a) Re-resolve agent_role from registry for sessions currently 'orchestrator'
 *   (b) Re-resolve model from registry for sessions with model='unknown'
 *   (c) Delete sessions with model='<synthetic>'
 */
function backfillAgentRoleModel(db: Database): void {
  const migrationKey = 'migration:backfill_agent_role_model_v1';
  const checkStmt = db.prepare("SELECT value FROM _meta WHERE key = ?");
  checkStmt.bind([migrationKey]);
  const alreadyRan = checkStmt.step();
  checkStmt.free();

  if (alreadyRan) return;

  // Load registry: Map<session_id, Set<agent_type>> and Map<session_id, model>
  const registryPath = resolve(homedir(), '.claude', 'subagent-sessions.jsonl');
  const registryMap = new Map<string, Set<string>>();
  const registryModelMap = new Map<string, string>();

  if (existsSync(registryPath)) {
    try {
      const lines = readFileSync(registryPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          const sid = entry.session_id as string | undefined;
          const atype = entry.agent_type as string | undefined;
          const entryModel = entry.model as string | undefined;
          if (sid && atype) {
            if (!registryMap.has(sid)) registryMap.set(sid, new Set());
            registryMap.get(sid)!.add(atype);
          }
          if (sid && entryModel && entryModel !== 'unknown') {
            registryModelMap.set(sid, entryModel);
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch (err) {
      console.warn('[db:backfill] Cannot read subagent registry:', err);
    }
  }

  function resolveAgentRole(sessionId: string): string {
    const types = registryMap.get(sessionId);
    if (!types || types.size === 0) return 'orchestrator';
    if (types.size === 1) return types.values().next().value as string;
    return 'mixed';
  }

  // (c) Delete sessions with model='<synthetic>'
  db.run("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
  db.run("DELETE FROM sessions WHERE model = '<synthetic>'");

  // (a) Re-resolve agent_role for sessions currently 'orchestrator' that have registry entries
  // (b) Re-resolve model for sessions with model='unknown' that have registry entries
  if (registryMap.size > 0 || registryModelMap.size > 0) {
    const allSids = new Set([...registryMap.keys(), ...registryModelMap.keys()]);
    for (const sid of allSids) {
      const role = resolveAgentRole(sid);
      const registryModel = registryModelMap.get(sid);

      // Build update based on what registry provides
      if (registryModel) {
        // Update agent_role where it's 'orchestrator' AND update model where it's 'unknown'
        db.run(
          `UPDATE sessions SET
             agent_role = CASE WHEN agent_role = 'orchestrator' THEN ? ELSE agent_role END,
             model = CASE WHEN model = 'unknown' OR model IS NULL THEN ? ELSE model END
           WHERE id = ?`,
          [role, registryModel, sid]
        );
      } else {
        // Only update agent_role where it's 'orchestrator'
        db.run(
          `UPDATE sessions SET agent_role = ? WHERE id = ? AND agent_role = 'orchestrator'`,
          [role, sid]
        );
      }
    }
  }

  db.run("INSERT INTO _meta (key, value) VALUES (?, 'done')", [migrationKey]);
  console.log('[db:backfill] backfill_agent_role_model_v1 complete');
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
