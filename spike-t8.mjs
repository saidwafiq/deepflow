#!/usr/bin/env node
/**
 * T8 Spike: Validate better-sqlite3 + JSONL ingestion performance
 * Hypothesis: 10K records ingested in <2s with incremental offset tracking
 */

import Database from 'better-sqlite3';
import { writeFileSync, appendFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RECORD_COUNT = 10_000;
const INCREMENTAL_COUNT = 100;
const tmpDir = tmpdir();
const jsonlPath = join(tmpDir, 'spike-t8-sample.jsonl');
const dbPath = join(tmpDir, 'spike-t8.db');
const offsetPath = join(tmpDir, 'spike-t8-offset.json');

// Cleanup
for (const f of [jsonlPath, dbPath, offsetPath]) {
  if (existsSync(f)) unlinkSync(f);
}

// Generate sample JSONL matching token-history.jsonl schema
console.log(`Generating ${RECORD_COUNT} sample records...`);
const lines = [];
for (let i = 0; i < RECORD_COUNT; i++) {
  lines.push(JSON.stringify({
    timestamp: new Date(Date.now() - (RECORD_COUNT - i) * 1000).toISOString(),
    input_tokens: Math.floor(Math.random() * 50000),
    cache_creation_input_tokens: Math.floor(Math.random() * 10000),
    cache_read_input_tokens: Math.floor(Math.random() * 40000),
    context_window_size: 200000,
    used_percentage: Math.round(Math.random() * 100),
    model: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'][i % 3],
    session_id: `session-${Math.floor(i / 100)}`,
    agent_role: ['orchestrator', 'execute-agent', 'verify-agent'][i % 3],
    task_id: i % 5 === 0 ? null : `T${(i % 10) + 1}`
  }));
}
writeFileSync(jsonlPath, lines.join('\n') + '\n');
console.log(`Written ${RECORD_COUNT} records to ${jsonlPath}`);

// Create DB and table
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');

db.exec(`
  CREATE TABLE IF NOT EXISTS token_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_creation_input_tokens INTEGER NOT NULL,
    cache_read_input_tokens INTEGER NOT NULL,
    context_window_size INTEGER NOT NULL,
    used_percentage REAL NOT NULL,
    model TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_role TEXT,
    task_id TEXT
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_session ON token_history(session_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp ON token_history(timestamp)`);

// Bulk insert with prepared statement + transaction
const insert = db.prepare(`
  INSERT INTO token_history (timestamp, input_tokens, cache_creation_input_tokens,
    cache_read_input_tokens, context_window_size, used_percentage, model,
    session_id, agent_role, task_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

console.log(`\nIngesting ${RECORD_COUNT} records...`);
const startFull = performance.now();

const content = readFileSync(jsonlPath, 'utf8');
const recordLines = content.trimEnd().split('\n');

const insertMany = db.transaction((records) => {
  for (const line of records) {
    const r = JSON.parse(line);
    insert.run(r.timestamp, r.input_tokens, r.cache_creation_input_tokens,
      r.cache_read_input_tokens, r.context_window_size, r.used_percentage,
      r.model, r.session_id, r.agent_role, r.task_id);
  }
});

insertMany(recordLines);
const elapsedFull = performance.now() - startFull;

const count = db.prepare('SELECT COUNT(*) as cnt FROM token_history').get();
console.log(`Full ingestion: ${count.cnt} records in ${elapsedFull.toFixed(1)}ms`);
console.log(`Result: ${elapsedFull < 2000 ? 'PASS' : 'FAIL'} (target: <2000ms)`);

// Save offset for incremental
const fileSize = Buffer.byteLength(content, 'utf8');
writeFileSync(offsetPath, JSON.stringify({ offset: fileSize }));

// Append incremental records
console.log(`\nAppending ${INCREMENTAL_COUNT} new records for incremental test...`);
const newLines = [];
for (let i = 0; i < INCREMENTAL_COUNT; i++) {
  newLines.push(JSON.stringify({
    timestamp: new Date().toISOString(),
    input_tokens: Math.floor(Math.random() * 50000),
    cache_creation_input_tokens: Math.floor(Math.random() * 10000),
    cache_read_input_tokens: Math.floor(Math.random() * 40000),
    context_window_size: 200000,
    used_percentage: Math.round(Math.random() * 100),
    model: 'claude-sonnet-4-6',
    session_id: `session-incremental-${i}`,
    agent_role: 'orchestrator',
    task_id: null
  }));
}
appendFileSync(jsonlPath, newLines.join('\n') + '\n');

// Incremental ingestion — read only from offset
const startIncr = performance.now();
const { offset } = JSON.parse(readFileSync(offsetPath, 'utf8'));
const fullContent = readFileSync(jsonlPath, 'utf8');
const newContent = fullContent.slice(offset);
const newRecordLines = newContent.trimEnd().split('\n').filter(l => l.length > 0);

insertMany(newRecordLines);
const elapsedIncr = performance.now() - startIncr;

const countAfter = db.prepare('SELECT COUNT(*) as cnt FROM token_history').get();
console.log(`Incremental ingestion: ${newRecordLines.length} new records in ${elapsedIncr.toFixed(1)}ms`);
console.log(`Total records now: ${countAfter.cnt}`);
console.log(`Incremental only ingested new: ${countAfter.cnt - count.cnt === INCREMENTAL_COUNT ? 'PASS' : 'FAIL'}`);

// Query performance test
const startQuery = performance.now();
const sessions = db.prepare(`
  SELECT session_id, COUNT(*) as cnt, AVG(used_percentage) as avg_pct
  FROM token_history GROUP BY session_id ORDER BY cnt DESC LIMIT 10
`).all();
const elapsedQuery = performance.now() - startQuery;
console.log(`\nQuery (top 10 sessions by count): ${elapsedQuery.toFixed(1)}ms`);
console.log(`Sample:`, sessions[0]);

db.close();

// Summary
console.log('\n=== RESULTS ===');
console.log(`Full ingestion (${RECORD_COUNT} records): ${elapsedFull.toFixed(1)}ms — ${elapsedFull < 2000 ? 'PASS' : 'FAIL'}`);
console.log(`Incremental (${INCREMENTAL_COUNT} records): ${elapsedIncr.toFixed(1)}ms`);
console.log(`Query: ${elapsedQuery.toFixed(1)}ms`);
console.log(`Native build: required (better-sqlite3 uses node-gyp)`);
