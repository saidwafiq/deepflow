'use strict';

/**
 * Tests for T52: negative value validation and clamping across the dashboard
 * instrumentation layer.
 *
 * Validates three defensive layers:
 *   1. schema.sql CHECK constraints reject negative values at DB level
 *   2. api/ingest.ts validatePayload() rejects negative token/cost values
 *   3. parsers (cache-history, token-history, sessions) clamp
 *      negative values via Math.max(0, v) with console.warn logging
 *
 * Strategy:
 *   - Source-level assertions for private functions (validatePayload, insertPayload)
 *   - Mock DbHelpers for parser integration tests
 *   - Schema CHECK constraint verification via source patterns
 *
 * Uses Node.js built-in node:test (CommonJS) to match project conventions.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'src', 'db', 'schema.sql');
const INGEST_SRC_PATH = path.join(ROOT, 'src', 'api', 'ingest.ts');
const CACHE_HISTORY_SRC = path.join(ROOT, 'src', 'ingest', 'parsers', 'cache-history.ts');
const TOKEN_HISTORY_SRC = path.join(ROOT, 'src', 'ingest', 'parsers', 'token-history.ts');
const SESSIONS_SRC = path.join(ROOT, 'src', 'ingest', 'parsers', 'sessions.ts');

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// ===========================================================================
// Layer 1: schema.sql CHECK constraints
// ===========================================================================

describe('Schema CHECK constraints for non-negative values', () => {
  const schema = readFile(SCHEMA_PATH);

  it('sessions.tokens_in has CHECK >= 0', () => {
    assert.match(schema, /tokens_in\s+INTEGER[^,]*CHECK\s*\(\s*tokens_in\s*>=\s*0\s*\)/);
  });

  it('sessions.tokens_out has CHECK >= 0', () => {
    assert.match(schema, /tokens_out\s+INTEGER[^,]*CHECK\s*\(\s*tokens_out\s*>=\s*0\s*\)/);
  });

  it('sessions.cache_read has CHECK >= 0', () => {
    assert.match(schema, /cache_read\s+INTEGER[^,]*CHECK\s*\(\s*cache_read\s*>=\s*0\s*\)/);
  });

  it('sessions.cache_creation has CHECK >= 0', () => {
    assert.match(schema, /cache_creation\s+INTEGER[^,]*CHECK\s*\(\s*cache_creation\s*>=\s*0\s*\)/);
  });

  it('sessions.cost has CHECK >= 0', () => {
    assert.match(schema, /cost\s+REAL[^,]*CHECK\s*\(\s*cost\s*>=\s*0\s*\)/);
  });

  it('token_events.input_tokens has CHECK >= 0', () => {
    assert.match(schema, /input_tokens\s+INTEGER[^,]*CHECK\s*\(\s*input_tokens\s*>=\s*0\s*\)/);
  });

  it('token_events.output_tokens has CHECK >= 0', () => {
    assert.match(schema, /output_tokens\s+INTEGER[^,]*CHECK\s*\(\s*output_tokens\s*>=\s*0\s*\)/);
  });

  it('token_events.cache_read_tokens has CHECK >= 0', () => {
    assert.match(schema, /cache_read_tokens\s+INTEGER[^,]*CHECK\s*\(\s*cache_read_tokens\s*>=\s*0\s*\)/);
  });

  it('token_events.cache_creation_tokens has CHECK >= 0', () => {
    assert.match(schema, /cache_creation_tokens\s+INTEGER[^,]*CHECK\s*\(\s*cache_creation_tokens\s*>=\s*0\s*\)/);
  });
});

// ===========================================================================
// Layer 2: validatePayload rejects negative values (source-level assertions)
// ===========================================================================

describe('api/ingest.ts validatePayload — negative value rejection', () => {
  const src = readFile(INGEST_SRC_PATH);

  it('checks token fields for negative values with val < 0', () => {
    assert.match(src, /typeof val === 'number' && val < 0/);
  });

  it('validates all four token sub-fields (input, output, cache_read, cache_creation)', () => {
    assert.match(src, /\['input', 'tokens_in'\]/);
    assert.match(src, /\['output', 'tokens_out'\]/);
    assert.match(src, /\['cache_read', 'cache_read'\]/);
    assert.match(src, /\['cache_creation', 'cache_creation'\]/);
  });

  it('produces descriptive error message including field name and value', () => {
    assert.match(src, /must be >= 0, got \$\{val\}/);
  });

  it('validates top-level cost field for negatives', () => {
    assert.match(src, /b\.cost !== undefined && typeof b\.cost === 'number' && b\.cost < 0/);
    assert.match(src, /cost must be >= 0, got \$\{b\.cost\}/);
  });
});

// ===========================================================================
// Layer 2b: insertPayload clamps values (source-level assertions)
// ===========================================================================

describe('api/ingest.ts insertPayload — clamping via Math.max(0, v)', () => {
  const src = readFile(INGEST_SRC_PATH);

  it('clamps input tokens with Math.max(0, ...)', () => {
    assert.match(src, /Math\.max\(0, usage\.input \?\? 0\)/);
  });

  it('clamps output tokens with Math.max(0, ...)', () => {
    assert.match(src, /Math\.max\(0, usage\.output \?\? 0\)/);
  });

  it('clamps cache_read with Math.max(0, ...)', () => {
    assert.match(src, /Math\.max\(0, usage\.cache_read \?\? 0\)/);
  });

  it('clamps cache_creation with Math.max(0, ...)', () => {
    assert.match(src, /Math\.max\(0, usage\.cache_creation \?\? 0\)/);
  });

  it('clamps top-level cost with Math.max(0, cost)', () => {
    assert.match(src, /Math\.max\(0, cost\)/);
  });
});

// ===========================================================================
// Layer 3: Parser clamping — cache-history.ts
// ===========================================================================

describe('parsers/cache-history.ts — clamping negative values', () => {
  const src = readFile(CACHE_HISTORY_SRC);

  it('clamps cache_read_tokens via Math.max(0, rawCacheRead)', () => {
    assert.match(src, /Math\.max\(0, rawCacheRead\)/);
  });

  it('clamps cache_creation_tokens via Math.max(0, rawCacheCreation)', () => {
    assert.match(src, /Math\.max\(0, rawCacheCreation\)/);
  });

  it('logs warning when cache_read_tokens is negative', () => {
    assert.match(src, /Clamping negative cache_read_tokens/);
    assert.match(src, /rawCacheRead < 0/);
  });

  it('logs warning when cache_creation_tokens is negative', () => {
    assert.match(src, /Clamping negative cache_creation_tokens/);
    assert.match(src, /rawCacheCreation < 0/);
  });

  it('inserts clamped values (not raw) into DB', () => {
    // Verify the INSERT uses clampedCacheRead/clampedCacheCreation, not raw
    assert.match(src, /clampedCacheRead,\n\s+clampedCacheCreation/);
  });
});

// ===========================================================================
// Layer 3: Parser clamping — token-history.ts
// ===========================================================================

describe('parsers/token-history.ts — clamping negative values', () => {
  const src = readFile(TOKEN_HISTORY_SRC);

  it('clamps all four token fields', () => {
    assert.match(src, /Math\.max\(0, rawInputTokens\)/);
    assert.match(src, /Math\.max\(0, rawOutputTokens\)/);
    assert.match(src, /Math\.max\(0, rawCacheRead\)/);
    assert.match(src, /Math\.max\(0, rawCacheCreation\)/);
  });

  it('logs warnings for each negative token field', () => {
    assert.match(src, /Clamping negative input_tokens/);
    assert.match(src, /Clamping negative output_tokens/);
    assert.match(src, /Clamping negative cache_read_tokens/);
    assert.match(src, /Clamping negative cache_creation_tokens/);
  });

  it('inserts clamped values into token_events', () => {
    assert.match(src, /clampedInputTokens,/);
    assert.match(src, /clampedOutputTokens,/);
    assert.match(src, /clampedCacheRead,/);
    assert.match(src, /clampedCacheCreation,/);
  });
});

// ===========================================================================
// Layer 3: Parser clamping — sessions.ts
// ===========================================================================

describe('parsers/sessions.ts — clamping negative values', () => {
  const src = readFile(SESSIONS_SRC);

  it('clamps accumulated tokensIn when negative', () => {
    assert.match(src, /tokensIn < 0/);
    assert.match(src, /tokensIn = 0/);
  });

  it('clamps accumulated tokensOut when negative', () => {
    assert.match(src, /tokensOut < 0/);
    assert.match(src, /tokensOut = 0/);
  });

  it('clamps accumulated cacheRead when negative', () => {
    assert.match(src, /cacheRead < 0/);
    assert.match(src, /cacheRead = 0/);
  });

  it('clamps accumulated cacheCreation when negative', () => {
    assert.match(src, /cacheCreation < 0/);
    assert.match(src, /cacheCreation = 0/);
  });

  it('clamps computed cost via Math.max(0, rawCost)', () => {
    assert.match(src, /Math\.max\(0, rawCost\)/);
  });

  it('logs warnings for negative token and cost clamping', () => {
    assert.match(src, /Clamping negative tokensIn/);
    assert.match(src, /Clamping negative tokensOut/);
    assert.match(src, /Clamping negative cacheRead/);
    assert.match(src, /Clamping negative cacheCreation/);
    assert.match(src, /Clamping negative cost/);
  });

  it('clamps BEFORE cost computation (defensive ordering)', () => {
    // The clamping of tokensIn/Out/cacheRead/cacheCreation happens before computeCost
    const clampIdx = src.indexOf('tokensIn = 0');
    const costIdx = src.indexOf('computeCost(');
    assert.ok(clampIdx > 0, 'tokensIn clamping found');
    assert.ok(costIdx > 0, 'computeCost call found');
    assert.ok(clampIdx < costIdx, 'token clamping must happen before cost computation');
  });
});

// ===========================================================================
// Cross-cutting: consistency checks
// ===========================================================================

describe('Cross-cutting consistency — all numeric fields protected', () => {
  const schema = readFile(SCHEMA_PATH);

  it('every CHECK-constrained column in sessions also has DEFAULT 0', () => {
    const checkedCols = ['tokens_in', 'tokens_out', 'cache_read', 'cache_creation', 'cost'];
    for (const col of checkedCols) {
      const regex = new RegExp(`${col}\\s+\\w+[^,]*DEFAULT\\s+0[^,]*CHECK`);
      assert.match(schema, regex, `${col} should have DEFAULT 0 before CHECK`);
    }
  });

  it('every CHECK-constrained column in token_events also has DEFAULT 0', () => {
    const checkedCols = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];
    for (const col of checkedCols) {
      const regex = new RegExp(`${col}\\s+INTEGER[^,]*DEFAULT\\s+0[^,]*CHECK`);
      assert.match(schema, regex, `${col} should have DEFAULT 0 before CHECK`);
    }
  });

  it('parsers use console.warn (not console.log or console.error) for clamping', () => {
    const parsers = [CACHE_HISTORY_SRC, STATS_CACHE_SRC, TOKEN_HISTORY_SRC, SESSIONS_SRC];
    for (const parserPath of parsers) {
      const src = readFile(parserPath);
      const clampingLines = src.split('\n').filter(l => l.includes('Clamping negative'));
      for (const line of clampingLines) {
        assert.ok(
          line.includes('console.warn'),
          `Clamping log in ${path.basename(parserPath)} should use console.warn: ${line.trim()}`
        );
      }
    }
  });
});

// ===========================================================================
// Behavioral test: parseCacheHistory with mock DbHelpers
// ===========================================================================

describe('parseCacheHistory — behavioral clamping with mock DB', () => {
  let tmpDir;
  let insertedParams;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cache-hist-'));
    insertedParams = [];
  });

  function makeMockDb() {
    return {
      run: (sql, params) => { if (sql.includes('INSERT INTO token_events')) insertedParams.push(params); },
      get: () => undefined,
      all: () => [],
    };
  }

  it('clamps negative cache_read_tokens to 0', async () => {
    const jsonlPath = path.join(tmpDir, 'cache-history.jsonl');
    fs.writeFileSync(jsonlPath, JSON.stringify({
      session_id: 'test-session-1',
      model: 'claude-3',
      cache_read_tokens: -500,
      cache_creation_tokens: 100,
      timestamp: '2025-01-01T00:00:00Z',
    }) + '\n');

    // Import the compiled ESM module
    const { parseCacheHistory } = await import(
      path.join(ROOT, 'dist', 'ingest', 'parsers', 'cache-history.js')
    );

    await parseCacheHistory(makeMockDb(), tmpDir);

    assert.equal(insertedParams.length, 1, 'should insert one token event');
    // params: [sessionId, model, 0, 0, clampedCacheRead, clampedCacheCreation, ts]
    const params = insertedParams[0];
    assert.equal(params[4], 0, 'negative cache_read_tokens should be clamped to 0');
    assert.equal(params[5], 100, 'positive cache_creation_tokens should pass through');
  });

  it('clamps negative cache_creation_tokens to 0', async () => {
    const jsonlPath = path.join(tmpDir, 'cache-history.jsonl');
    fs.writeFileSync(jsonlPath, JSON.stringify({
      session_id: 'test-session-2',
      model: 'claude-3',
      cache_read_tokens: 200,
      cache_creation_tokens: -300,
      timestamp: '2025-01-01T00:00:00Z',
    }) + '\n');

    const { parseCacheHistory } = await import(
      path.join(ROOT, 'dist', 'ingest', 'parsers', 'cache-history.js')
    );

    await parseCacheHistory(makeMockDb(), tmpDir);

    assert.equal(insertedParams.length, 1);
    const params = insertedParams[0];
    assert.equal(params[4], 200, 'positive cache_read_tokens should pass through');
    assert.equal(params[5], 0, 'negative cache_creation_tokens should be clamped to 0');
  });

  it('passes through positive values unchanged', async () => {
    const jsonlPath = path.join(tmpDir, 'cache-history.jsonl');
    fs.writeFileSync(jsonlPath, JSON.stringify({
      session_id: 'test-session-3',
      model: 'claude-3',
      cache_read_tokens: 1000,
      cache_creation_tokens: 500,
      timestamp: '2025-01-01T00:00:00Z',
    }) + '\n');

    const { parseCacheHistory } = await import(
      path.join(ROOT, 'dist', 'ingest', 'parsers', 'cache-history.js')
    );

    await parseCacheHistory(makeMockDb(), tmpDir);

    assert.equal(insertedParams.length, 1);
    const params = insertedParams[0];
    assert.equal(params[4], 1000, 'positive cache_read_tokens preserved');
    assert.equal(params[5], 500, 'positive cache_creation_tokens preserved');
  });
});

