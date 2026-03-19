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

  // Persist after schema init
  persistDatabase();

  console.log(`[db] Opened database at ${_dbPath}`);
  return _db;
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
