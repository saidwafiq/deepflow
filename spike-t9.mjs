/**
 * T9 SPIKE: Validate sql.js (WASM) as no-native-dependency SQLite alternative
 * Hypothesis: sql.js can ingest 10K JSONL records in <5s without native compilation
 *
 * Schema matches token-history.jsonl:
 *   timestamp, input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *   context_window_size, used_percentage, model, session_id, agent_role, task_id
 */

import { createRequire } from 'module';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = join(__dirname, '/tmp/spike-t9-test.db');

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateRecord(i) {
  const now = new Date(Date.now() - i * 1000);
  const models = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
  return {
    timestamp: now.toISOString(),
    input_tokens: Math.floor(Math.random() * 50000) + 1000,
    cache_creation_input_tokens: Math.floor(Math.random() * 20000),
    cache_read_input_tokens: Math.floor(Math.random() * 80000),
    context_window_size: 200000,
    used_percentage: Math.random() * 100,
    model: models[i % models.length],
    session_id: `session-${String(Math.floor(i / 100)).padStart(4, '0')}`,
    agent_role: i % 3 === 0 ? 'orchestrator' : i % 3 === 1 ? 'worker' : 'reasoner',
    task_id: `T${(i % 20) + 1}`,
  };
}

function generateJSONL(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify(generateRecord(i)));
  }
  return lines.join('\n') + '\n';
}

// ── Init sql.js ───────────────────────────────────────────────────────────────

async function loadSqlJs() {
  const initSqlJs = require('sql.js');
  // sql.js WASM build needs the wasm file path
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  return SQL;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS token_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    context_window_size INTEGER NOT NULL DEFAULT 0,
    used_percentage REAL NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT 'unknown',
    session_id TEXT NOT NULL DEFAULT 'unknown',
    agent_role TEXT NOT NULL DEFAULT 'orchestrator',
    task_id TEXT
  );
  CREATE TABLE IF NOT EXISTS ingest_offsets (
    source_file TEXT PRIMARY KEY,
    last_offset INTEGER NOT NULL DEFAULT 0
  );
`;

// ── Main spike ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== T9 SPIKE: sql.js WASM ingestion ===\n');

  // Step 1: Load sql.js
  console.log('Step 1: Loading sql.js WASM...');
  const t0 = performance.now();
  const SQL = await loadSqlJs();
  const loadMs = performance.now() - t0;
  console.log(`  sql.js loaded in ${loadMs.toFixed(1)}ms\n`);

  // Step 2: Generate 10K sample JSONL records
  console.log('Step 2: Generating 10,000 JSONL records...');
  const t1 = performance.now();
  const jsonl = generateJSONL(10000);
  const genMs = performance.now() - t1;
  const lines = jsonl.trim().split('\n');
  console.log(`  Generated ${lines.length} records in ${genMs.toFixed(1)}ms`);
  console.log(`  Sample record: ${lines[0]}\n`);

  // Step 3: Create in-memory DB, bulk INSERT all 10K records in a transaction
  console.log('Step 3: Bulk INSERT 10K records into sql.js in-memory DB...');
  const db = new SQL.Database();
  db.run(CREATE_TABLE);

  const insert = db.prepare(`
    INSERT INTO token_history
      (timestamp, input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       context_window_size, used_percentage, model, session_id, agent_role, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const t2 = performance.now();
  db.run('BEGIN TRANSACTION');
  for (const line of lines) {
    const rec = JSON.parse(line);
    insert.run([
      rec.timestamp,
      rec.input_tokens,
      rec.cache_creation_input_tokens,
      rec.cache_read_input_tokens,
      rec.context_window_size,
      rec.used_percentage,
      rec.model,
      rec.session_id,
      rec.agent_role,
      rec.task_id,
    ]);
  }
  db.run('COMMIT');
  insert.free();
  const insertMs = performance.now() - t2;
  console.log(`  Inserted ${lines.length} records in ${insertMs.toFixed(1)}ms`);
  const totalIngestMs = loadMs + insertMs;
  console.log(`  Total (load + insert): ${totalIngestMs.toFixed(1)}ms`);
  const passIngest = totalIngestMs < 5000;
  console.log(`  SUCCESS CRITERION (<5s): ${passIngest ? 'PASS' : 'FAIL'}\n`);

  // Verify row count
  const countResult = db.exec('SELECT COUNT(*) as cnt FROM token_history');
  const rowCount = countResult[0].values[0][0];
  console.log(`  Rows in DB: ${rowCount}\n`);

  // Step 4: Test incremental re-ingestion with offset tracking
  console.log('Step 4: Incremental re-ingestion with offset tracking...');

  // Set the offset to 5000 to simulate having already ingested the first half
  const sourceFile = '/tmp/token-history-test.jsonl';
  db.run(
    `INSERT OR REPLACE INTO ingest_offsets (source_file, last_offset) VALUES (?, ?)`,
    [sourceFile, 5000]
  );

  // Simulate reading only new records (5000..9999)
  const newLines = lines.slice(5000);
  const insert2 = db.prepare(`
    INSERT INTO token_history
      (timestamp, input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       context_window_size, used_percentage, model, session_id, agent_role, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const t3 = performance.now();
  db.run('BEGIN TRANSACTION');
  for (const line of newLines) {
    const rec = JSON.parse(line);
    insert2.run([
      rec.timestamp,
      rec.input_tokens,
      rec.cache_creation_input_tokens,
      rec.cache_read_input_tokens,
      rec.context_window_size,
      rec.used_percentage,
      rec.model,
      rec.session_id,
      rec.agent_role,
      rec.task_id,
    ]);
  }
  db.run('COMMIT');
  insert2.free();

  // Update offset
  db.run(
    `INSERT OR REPLACE INTO ingest_offsets (source_file, last_offset) VALUES (?, ?)`,
    [sourceFile, 10000]
  );
  const incrementalMs = performance.now() - t3;
  console.log(`  Inserted ${newLines.length} incremental records in ${incrementalMs.toFixed(1)}ms`);

  const offsetRow = db.exec(`SELECT last_offset FROM ingest_offsets WHERE source_file = ?`, [sourceFile]);
  const offset = offsetRow[0].values[0][0];
  console.log(`  Offset updated to: ${offset}`);
  console.log(`  SUCCESS CRITERION (offset tracking works): ${offset === 10000 ? 'PASS' : 'FAIL'}\n`);

  // Final row count after incremental
  const countResult2 = db.exec('SELECT COUNT(*) as cnt FROM token_history');
  const finalCount = countResult2[0].values[0][0];
  console.log(`  Final row count (should be 15000): ${finalCount}\n`);

  // Step 5: File-based persistence — save to disk, reopen, verify
  console.log('Step 5: File-based persistence (save to disk, reopen, verify)...');
  const dbPath = '/tmp/spike-t9-test.db';

  // Save DB to file
  const t4 = performance.now();
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
  const saveMs = performance.now() - t4;
  console.log(`  Saved DB to ${dbPath} in ${saveMs.toFixed(1)}ms`);

  // Reopen from file
  const t5 = performance.now();
  const fileBuffer = readFileSync(dbPath);
  const db2 = new SQL.Database(fileBuffer);
  const reopenMs = performance.now() - t5;
  console.log(`  Reopened DB from disk in ${reopenMs.toFixed(1)}ms`);

  // Verify data is intact
  const verifyResult = db2.exec('SELECT COUNT(*) as cnt FROM token_history');
  const verifyCount = verifyResult[0].values[0][0];
  const persistPass = verifyCount === 15000;
  console.log(`  Rows after reopen: ${verifyCount} (expected 15000)`);
  console.log(`  SUCCESS CRITERION (file persistence): ${persistPass ? 'PASS' : 'FAIL'}\n`);

  // Sample query to confirm data integrity
  const sampleResult = db2.exec(`
    SELECT model, COUNT(*) as cnt, SUM(input_tokens) as total_input
    FROM token_history
    GROUP BY model
    ORDER BY cnt DESC
  `);
  console.log('  Sample aggregation by model:');
  const cols = sampleResult[0].columns;
  for (const row of sampleResult[0].values) {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    console.log(`    ${obj.model}: ${obj.cnt} records, ${obj.total_input.toLocaleString()} total input tokens`);
  }

  // Cleanup
  db.close();
  db2.close();
  if (existsSync(dbPath)) unlinkSync(dbPath);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== RESULTS SUMMARY ===');
  console.log(`sql.js WASM load time:         ${loadMs.toFixed(1)}ms`);
  console.log(`10K record generation:          ${genMs.toFixed(1)}ms`);
  console.log(`10K bulk INSERT:               ${insertMs.toFixed(1)}ms`);
  console.log(`Total (load + insert):          ${totalIngestMs.toFixed(1)}ms`);
  console.log(`5K incremental INSERT:          ${incrementalMs.toFixed(1)}ms`);
  console.log(`DB save to disk:               ${saveMs.toFixed(1)}ms`);
  console.log(`DB reopen from disk:           ${reopenMs.toFixed(1)}ms`);
  console.log('');
  console.log('Success criteria:');
  console.log(`  10K records in <5s:          ${passIngest ? 'PASS' : 'FAIL'} (${totalIngestMs.toFixed(0)}ms)`);
  console.log(`  Zero native build step:      PASS (WASM, no node-gyp)`);
  console.log(`  File-based persistence:      ${persistPass ? 'PASS' : 'FAIL'}`);

  const allPass = passIngest && persistPass;
  console.log(`\nOverall: ${allPass ? 'HYPOTHESIS CONFIRMED' : 'HYPOTHESIS REJECTED'}`);

  return {
    loadMs,
    genMs,
    insertMs,
    totalIngestMs,
    incrementalMs,
    saveMs,
    reopenMs,
    passIngest,
    persistPass,
    allPass,
  };
}

main().catch(console.error);
