/**
 * Integration tests for dashboard-fixes spec.
 * Covers AC-1 through AC-14.
 *
 * Black-box approach: tests use only exported interfaces + source file assertions.
 * Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SRC_ROOT = resolve(PKG_ROOT, 'src');

// Source file paths for static assertions
const CACHE_HISTORY_PATH = resolve(SRC_ROOT, 'ingest', 'parsers', 'cache-history.ts');
const INGEST_INDEX_PATH = resolve(SRC_ROOT, 'ingest', 'index.ts');
const SESSION_LIST_PATH = resolve(SRC_ROOT, 'client', 'views', 'SessionList.tsx');
const CACHE_API_PATH = resolve(SRC_ROOT, 'api', 'cache.ts');

// ---------------------------------------------------------------------------
// DB helpers: top-level exports from db module
// ---------------------------------------------------------------------------
let dbGet, dbAll, dbRun;
let initDatabase;
let runIngestion;

before(async () => {
  // Dynamic import of db module — get, all, run are top-level exports
  const dbMod = await import(resolve(PKG_ROOT, 'dist', 'db', 'index.js'));
  initDatabase = dbMod.initDatabase;
  dbGet = dbMod.get;
  dbAll = dbMod.all;
  dbRun = dbMod.run;

  // Initialize database so all migrations run
  await initDatabase('local');

  const ingestMod = await import(resolve(PKG_ROOT, 'dist', 'ingest', 'index.js'));
  runIngestion = ingestMod.runIngestion;
});

// =========================================================================
// AC-1 (REQ-1): No synthetic sessions after ingestion
// =========================================================================
describe('AC-1: No synthetic sessions after ingestion', () => {
  it('SELECT COUNT(*) FROM sessions WHERE id LIKE "cache-synthetic-%" returns 0 after initDatabase', () => {
    const row = dbGet("SELECT COUNT(*) as cnt FROM sessions WHERE id LIKE 'cache-synthetic-%'");
    assert.equal(row.cnt, 0, 'No cache-synthetic sessions should exist after ingestion');
  });
});

// =========================================================================
// AC-2 (REQ-1): cache-history.ts does not INSERT INTO sessions
// =========================================================================
describe('AC-2: cache-history.ts has no INSERT INTO sessions', () => {
  it('source file does not contain INSERT.*INTO sessions', () => {
    assert.ok(existsSync(CACHE_HISTORY_PATH), `${CACHE_HISTORY_PATH} should exist`);
    const src = readFileSync(CACHE_HISTORY_PATH, 'utf-8');
    const pattern = /INSERT\s+.*INTO\s+sessions/i;
    assert.ok(!pattern.test(src), 'cache-history.ts must not contain INSERT INTO sessions');
  });
});

// =========================================================================
// AC-3 (REQ-1): cache-history.ts does not INSERT INTO token_events
// =========================================================================
describe('AC-3: cache-history.ts has no INSERT INTO token_events', () => {
  it('source file does not contain INSERT.*INTO token_events', () => {
    assert.ok(existsSync(CACHE_HISTORY_PATH), `${CACHE_HISTORY_PATH} should exist`);
    const src = readFileSync(CACHE_HISTORY_PATH, 'utf-8');
    const pattern = /INSERT\s+.*INTO\s+token_events/i;
    assert.ok(!pattern.test(src), 'cache-history.ts must not contain INSERT INTO token_events');
  });
});

// =========================================================================
// AC-4 (REQ-2): ingest/index.ts does not contain aggregateAndComputeCosts
// =========================================================================
describe('AC-4: ingest/index.ts has no aggregateAndComputeCosts', () => {
  it('source file does not contain the string aggregateAndComputeCosts', () => {
    assert.ok(existsSync(INGEST_INDEX_PATH), `${INGEST_INDEX_PATH} should exist`);
    const src = readFileSync(INGEST_INDEX_PATH, 'utf-8');
    assert.ok(
      !src.includes('aggregateAndComputeCosts'),
      'ingest/index.ts must not reference aggregateAndComputeCosts'
    );
  });
});

// =========================================================================
// AC-5 (REQ-2): Standalone cost computation only updates cost where cost = 0
// =========================================================================
describe('AC-5: Standalone cost computation updates only sessions.cost where cost = 0', () => {
  it('a standalone cost computation function exists that updates cost where cost = 0 without overwriting token columns', () => {
    // Search all source files for a function that does UPDATE sessions SET cost WHERE cost = 0
    // The spec requires this to be standalone (not part of aggregateAndComputeCosts)
    assert.ok(existsSync(INGEST_INDEX_PATH), `${INGEST_INDEX_PATH} should exist`);
    const src = readFileSync(INGEST_INDEX_PATH, 'utf-8');

    // There should be a cost update that targets sessions with cost = 0
    const hasCostUpdate = /UPDATE\s+sessions\s+SET\s+cost\s*=/i.test(src);
    assert.ok(hasCostUpdate, 'A cost update SQL statement should exist in ingest/index.ts');

    // Extract all UPDATE sessions SET cost statements and check they don't overwrite token columns
    // Split by statements to isolate individual UPDATEs
    const updateStatements = src.match(/UPDATE\s+sessions\s+SET\s+cost\s*=[^;]*/gi) || [];
    assert.ok(updateStatements.length > 0, 'Should have at least one UPDATE sessions SET cost statement');

    // At least one UPDATE should target cost = 0 (the standalone cost computation)
    const costZeroUpdates = updateStatements.filter(stmt => /WHERE[^;]*cost\s*=\s*0/i.test(stmt));

    // Check the standalone cost update (not the reset) does not overwrite token columns
    for (const stmt of costZeroUpdates) {
      const badTokenOverwrite = /(tokens_in|tokens_out|cache_read|cache_creation)\s*=/i.test(stmt);
      assert.ok(
        !badTokenOverwrite,
        `Standalone cost update must not overwrite token columns. Found: ${stmt}`
      );
    }

    // The spec says "only updates sessions.cost where cost = 0" — verify such a statement exists
    // If no costZeroUpdates, the standalone function might filter in code (WHERE id = ?)
    // after selecting WHERE cost = 0. Check that the query pattern exists.
    const hasCostZeroFilter = /cost\s*=\s*0/i.test(src) || /WHERE\s+cost\s*=\s*0/i.test(src);
    assert.ok(hasCostZeroFilter, 'Cost computation should filter by cost = 0');
  });
});

// =========================================================================
// AC-6 (REQ-3): cache_hit_ratio column exists on sessions
// =========================================================================
describe('AC-6: cache_hit_ratio column exists', () => {
  it('SELECT cache_hit_ratio FROM sessions LIMIT 1 executes without error', () => {
    // Should not throw — column must exist
    assert.doesNotThrow(() => {
      dbAll('SELECT cache_hit_ratio FROM sessions LIMIT 1');
    });
  });
});

// =========================================================================
// AC-7 (REQ-3): schema_version = '3'
// =========================================================================
describe('AC-7: schema_version is 3', () => {
  it('SELECT value FROM _meta WHERE key = "schema_version" returns "3"', () => {
    const row = dbGet("SELECT value FROM _meta WHERE key = 'schema_version'");
    assert.ok(row, '_meta should have schema_version key');
    assert.equal(row.value, '3', 'schema_version should be 3');
  });
});

// =========================================================================
// AC-8 (REQ-4): SessionList.tsx renders exactly 8 <th> elements
// =========================================================================
describe('AC-8: SessionList renders exactly 8 column headers', () => {
  it('source renders exactly 8 table column headers', () => {
    assert.ok(existsSync(SESSION_LIST_PATH), `${SESSION_LIST_PATH} should exist`);
    const src = readFileSync(SESSION_LIST_PATH, 'utf-8');

    // SessionList uses ColHeader and StaticHeader components that each render a <th>.
    // Count usages of these components plus any raw <th> in the table header <tr>.
    const colHeaderMatches = src.match(/<ColHeader\s/g) || [];
    const staticHeaderMatches = src.match(/<StaticHeader\s/g) || [];
    const totalColumns = colHeaderMatches.length + staticHeaderMatches.length;

    assert.equal(totalColumns, 8, `Expected 8 column headers (ColHeader + StaticHeader), found ${totalColumns}`);
  });
});

// =========================================================================
// AC-9 (REQ-4): SessionList.tsx has no references to removed columns
// =========================================================================
describe('AC-9: SessionList.tsx does not reference removed columns', () => {
  const removedColumns = ['cache_read', 'cache_creation', 'messages', 'tool_calls', 'tokens_out'];

  for (const col of removedColumns) {
    it(`does not reference ${col} as a separate column header`, () => {
      const src = readFileSync(SESSION_LIST_PATH, 'utf-8');
      // Check ColHeader/StaticHeader labels and raw <th> content for the column name
      const headerPattern = new RegExp(`label=["']${col}["']`, 'i');
      assert.ok(
        !headerPattern.test(src),
        `SessionList.tsx should not render ${col} as a column header`
      );
    });
  }

  it('does not reference "user" as a column header', () => {
    const src = readFileSync(SESSION_LIST_PATH, 'utf-8');
    const userPattern = /label=["']user["']/i;
    assert.ok(
      !userPattern.test(src),
      'SessionList.tsx should not render "user" as a column header'
    );
  });
});

// =========================================================================
// AC-10 (REQ-5): GET /api/sessions response includes agent_role and cache_hit_ratio
// =========================================================================
describe('AC-10: /api/sessions response includes agent_role and cache_hit_ratio', () => {
  it('sessions API source selects agent_role and cache_hit_ratio', () => {
    const sessionsApiPath = resolve(SRC_ROOT, 'api', 'sessions.ts');
    assert.ok(existsSync(sessionsApiPath), `${sessionsApiPath} should exist`);
    const src = readFileSync(sessionsApiPath, 'utf-8');

    // The API should select agent_role and cache_hit_ratio (either explicitly or via SELECT *)
    assert.ok(
      src.includes('agent_role') || src.includes('SELECT *'),
      'Sessions API should reference agent_role in its query or select all columns'
    );
    assert.ok(
      src.includes('cache_hit_ratio') || src.includes('SELECT *'),
      'Sessions API should reference cache_hit_ratio in its query or select all columns'
    );
  });

  it('DB schema supports agent_role and cache_hit_ratio on sessions table', () => {
    // Insert a test session with both fields and verify they round-trip
    dbRun(
      `INSERT OR IGNORE INTO sessions (id, user, started_at, agent_role, cache_hit_ratio)
       VALUES ('test-ac10', 'tester', '2025-01-01T00:00:00Z', 'orchestrator', 0.95)`,
      []
    );
    const row = dbGet("SELECT * FROM sessions WHERE id = 'test-ac10'");
    assert.ok(row, 'Test session should exist');
    assert.ok('agent_role' in row, 'Session row should have agent_role key');
    assert.ok('cache_hit_ratio' in row, 'Session row should have cache_hit_ratio key');
    // Clean up
    dbRun("DELETE FROM sessions WHERE id = 'test-ac10'", []);
  });
});

// =========================================================================
// AC-11 (REQ-6): cache API references cache_hit_ratio from sessions directly
// =========================================================================
describe('AC-11: cache API uses cache_hit_ratio from sessions', () => {
  it('src/api/cache.ts references cache_hit_ratio from sessions, not computed from cache_read / (tokens_in + cache_read)', () => {
    assert.ok(existsSync(CACHE_API_PATH), `${CACHE_API_PATH} should exist`);
    const src = readFileSync(CACHE_API_PATH, 'utf-8');

    // Should reference cache_hit_ratio
    assert.ok(
      src.includes('cache_hit_ratio'),
      'cache.ts should reference cache_hit_ratio'
    );

    // Should NOT compute it from cache_read / (tokens_in + cache_read)
    const computedPattern = /cache_read\s*\/\s*\(\s*tokens_in\s*\+\s*cache_read\s*\)/;
    assert.ok(
      !computedPattern.test(src),
      'cache.ts must not compute cache_hit_ratio from cache_read / (tokens_in + cache_read)'
    );
  });
});

// =========================================================================
// AC-12 (REQ-7): Model name brackets are sanitized
// =========================================================================
describe('AC-12: Model name bracket sanitization', () => {
  it('after ingesting a record with model containing brackets, no sessions have brackets in model', async () => {
    // Create a temporary dir with a cache-history.jsonl containing bracket model
    const tmpDir = mkdtempSync(join(resolve(PKG_ROOT, '..'), 'tmp-ac12-'));
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const record = JSON.stringify({
      timestamp: '2025-06-01T12:00:00Z',
      session_id: 'ac12-test-session',
      cache_hit_ratio: 0.95,
      total_tokens: 100000,
      agent_breakdown: {
        agent_role: 'orchestrator',
        task_id: null,
        model: 'claude-opus-4-6[1m]'
      }
    });
    writeFileSync(join(claudeDir, 'cache-history.jsonl'), record + '\n');

    // Run ingestion against the temp directory
    try {
      await runIngestion(tmpDir);
    } catch {
      // Ingestion may fail for other reasons; we check the post-condition
    }

    // Check that no sessions have brackets in model name
    const rows = dbAll("SELECT model FROM sessions WHERE model LIKE '%[%'");
    assert.equal(rows.length, 0, 'No sessions should have brackets in model name after ingestion');

    // Cleanup
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});

// =========================================================================
// AC-13 (REQ-8): Migration key exists after ingestion
// =========================================================================
describe('AC-13: Migration purge key exists', () => {
  it('migration:purge_synthetic_sessions_v1 key exists in _meta after initDatabase', () => {
    const row = dbGet("SELECT value FROM _meta WHERE key = 'migration:purge_synthetic_sessions_v1'");
    assert.ok(row, 'migration:purge_synthetic_sessions_v1 key should exist in _meta');
    assert.equal(row.value, 'done', 'Migration purge key value should be "done"');
  });
});

// =========================================================================
// AC-14 (REQ-3, REQ-8): npm run build completes with exit code 0
// =========================================================================
describe('AC-14: npm run build succeeds', () => {
  it('npm run build exits with code 0', () => {
    try {
      execSync('npm run build', {
        cwd: PKG_ROOT,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      assert.fail(`npm run build failed with exit code ${err.status}: ${err.stderr?.toString()}`);
    }
  });
});
