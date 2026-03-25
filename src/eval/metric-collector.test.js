'use strict';

/**
 * Tests for src/eval/metric-collector.js — T6: wave-2 unit tests
 *
 * Validates metric computation from JSONL token-history data:
 *   - cache_ratio = cache_read_input_tokens / input_tokens (AC-16)
 *   - total_tokens sums all token fields
 *   - context_burn picks max used_percentage
 *   - wall_time is timestamp delta
 *   - filterByRange filters by ISO timestamps
 *   - readJsonl parses multi-line JSONL
 *   - Edge cases: empty file, single entry, no entries in range
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');

const {
  collectMetrics,
  readJsonl,
  filterByRange,
} = require('./metric-collector');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metric-collector-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a JSONL file from an array of objects.
 */
function writeJsonl(filePath, entries) {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Build a token-history entry with sensible defaults.
 */
function makeEntry(overrides = {}) {
  return {
    timestamp: '2026-03-25T10:00:00.000Z',
    input_tokens: 1000,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 200,
    output_tokens: 300,
    used_percentage: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readJsonl
// ---------------------------------------------------------------------------

describe('readJsonl', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('parses multi-line JSONL correctly', async () => {
    const filePath = path.join(tmpDir, 'data.jsonl');
    const entries = [
      { a: 1, b: 'hello' },
      { a: 2, b: 'world' },
      { a: 3, b: 'foo' },
    ];
    writeJsonl(filePath, entries);

    const result = await readJsonl(filePath);
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { a: 1, b: 'hello' });
    assert.deepEqual(result[1], { a: 2, b: 'world' });
    assert.deepEqual(result[2], { a: 3, b: 'foo' });
  });

  test('returns empty array for empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '', 'utf8');

    const result = await readJsonl(filePath);
    assert.deepEqual(result, []);
  });

  test('skips blank lines and malformed JSON', async () => {
    const filePath = path.join(tmpDir, 'messy.jsonl');
    const content = [
      '{"valid": true}',
      '',
      'not-json',
      '   ',
      '{"also": "valid"}',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');

    const result = await readJsonl(filePath);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { valid: true });
    assert.deepEqual(result[1], { also: 'valid' });
  });

  test('rejects for non-existent file', async () => {
    const filePath = path.join(tmpDir, 'nope.jsonl');
    await assert.rejects(() => readJsonl(filePath), { code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------
// filterByRange
// ---------------------------------------------------------------------------

describe('filterByRange', () => {
  const entries = [
    { timestamp: '2026-03-25T10:00:00.000Z', val: 1 },
    { timestamp: '2026-03-25T11:00:00.000Z', val: 2 },
    { timestamp: '2026-03-25T12:00:00.000Z', val: 3 },
    { timestamp: '2026-03-25T13:00:00.000Z', val: 4 },
  ];

  const t10 = new Date('2026-03-25T10:00:00.000Z').getTime();
  const t11 = new Date('2026-03-25T11:00:00.000Z').getTime();
  const t12 = new Date('2026-03-25T12:00:00.000Z').getTime();
  const t13 = new Date('2026-03-25T13:00:00.000Z').getTime();

  test('filters entries within inclusive range', () => {
    const result = filterByRange(entries, t11, t12);
    assert.equal(result.length, 2);
    assert.equal(result[0].val, 2);
    assert.equal(result[1].val, 3);
  });

  test('open start bound returns entries up to end', () => {
    const result = filterByRange(entries, null, t11);
    assert.equal(result.length, 2);
    assert.equal(result[0].val, 1);
    assert.equal(result[1].val, 2);
  });

  test('open end bound returns entries from start onward', () => {
    const result = filterByRange(entries, t12, null);
    assert.equal(result.length, 2);
    assert.equal(result[0].val, 3);
    assert.equal(result[1].val, 4);
  });

  test('both bounds null returns all entries', () => {
    const result = filterByRange(entries, null, null);
    assert.equal(result.length, 4);
  });

  test('no entries in range returns empty array', () => {
    const futureStart = new Date('2030-01-01T00:00:00.000Z').getTime();
    const futureEnd = new Date('2030-12-31T00:00:00.000Z').getTime();
    const result = filterByRange(entries, futureStart, futureEnd);
    assert.deepEqual(result, []);
  });

  test('entries without valid timestamp are excluded', () => {
    const bad = [
      { val: 1 },
      { timestamp: 'not-a-date', val: 2 },
      { timestamp: '2026-03-25T10:00:00.000Z', val: 3 },
    ];
    const result = filterByRange(bad, null, null);
    assert.equal(result.length, 1);
    assert.equal(result[0].val, 3);
  });

  test('exact boundary timestamps are inclusive', () => {
    const result = filterByRange(entries, t10, t13);
    assert.equal(result.length, 4);
  });
});

// ---------------------------------------------------------------------------
// collectMetrics
// ---------------------------------------------------------------------------

describe('collectMetrics', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('computes correct cache_ratio from known data (AC-16)', async () => {
    // Two entries: input_tokens = 1000+2000 = 3000, cache_read = 500+1500 = 2000
    // cache_ratio = 2000 / 3000 = 0.6667
    const entries = [
      makeEntry({ input_tokens: 1000, cache_read_input_tokens: 500 }),
      makeEntry({ input_tokens: 2000, cache_read_input_tokens: 1500 }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result = await collectMetrics(tmpDir);
    assert.ok(Math.abs(result.cache_ratio - 2000 / 3000) < 1e-10,
      `Expected cache_ratio ~0.6667, got ${result.cache_ratio}`);
  });

  test('total_tokens sums all token fields correctly', async () => {
    const entries = [
      makeEntry({
        input_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        output_tokens: 400,
      }),
      makeEntry({
        input_tokens: 50,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 70,
        output_tokens: 80,
      }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result = await collectMetrics(tmpDir);
    // total = (100+200+300+400) + (50+60+70+80) = 1000 + 260 = 1260
    assert.equal(result.total_tokens, 1260);
  });

  test('context_burn picks max used_percentage', async () => {
    const entries = [
      makeEntry({ used_percentage: 25 }),
      makeEntry({ used_percentage: 75 }),
      makeEntry({ used_percentage: 50 }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result = await collectMetrics(tmpDir);
    assert.equal(result.context_burn, 75);
  });

  test('wall_time is timestamp delta in ms', async () => {
    const entries = [makeEntry()];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const start = 1000;
    const end = 6000;
    const result = await collectMetrics(tmpDir, start, end);
    assert.equal(result.wall_time, 5000);
  });

  test('wall_time is 0 when start or end is null', async () => {
    const entries = [makeEntry()];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result1 = await collectMetrics(tmpDir, null, 6000);
    assert.equal(result1.wall_time, 0);

    const result2 = await collectMetrics(tmpDir, 1000, null);
    assert.equal(result2.wall_time, 0);

    const result3 = await collectMetrics(tmpDir);
    assert.equal(result3.wall_time, 0);
  });

  test('entry_count reflects filtered entries', async () => {
    const t1 = '2026-03-25T10:00:00.000Z';
    const t2 = '2026-03-25T11:00:00.000Z';
    const t3 = '2026-03-25T12:00:00.000Z';
    const entries = [
      makeEntry({ timestamp: t1 }),
      makeEntry({ timestamp: t2 }),
      makeEntry({ timestamp: t3 }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const start = new Date(t2).getTime();
    const end = new Date(t2).getTime();
    const result = await collectMetrics(tmpDir, start, end);
    assert.equal(result.entry_count, 1);
  });

  test('empty file returns zero metrics', async () => {
    fs.writeFileSync(path.join(tmpDir, 'token-history.jsonl'), '', 'utf8');

    const result = await collectMetrics(tmpDir);
    assert.equal(result.cache_ratio, 0);
    assert.equal(result.total_tokens, 0);
    assert.equal(result.wall_time, 0);
    assert.equal(result.context_burn, 0);
    assert.equal(result.entry_count, 0);
  });

  test('single entry computes metrics correctly', async () => {
    const entries = [
      makeEntry({
        input_tokens: 800,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 100,
        output_tokens: 200,
        used_percentage: 42,
      }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result = await collectMetrics(tmpDir);
    assert.equal(result.cache_ratio, 600 / 800);
    assert.equal(result.total_tokens, 800 + 600 + 100 + 200);
    assert.equal(result.context_burn, 42);
    assert.equal(result.entry_count, 1);
  });

  test('no entries in range returns zero metrics', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-03-25T10:00:00.000Z' }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const futureStart = new Date('2030-01-01T00:00:00.000Z').getTime();
    const futureEnd = new Date('2030-12-31T00:00:00.000Z').getTime();
    const result = await collectMetrics(tmpDir, futureStart, futureEnd);
    assert.equal(result.cache_ratio, 0);
    assert.equal(result.total_tokens, 0);
    assert.equal(result.context_burn, 0);
    assert.equal(result.entry_count, 0);
  });

  test('handles missing token fields gracefully (treated as 0)', async () => {
    const entries = [
      { timestamp: '2026-03-25T10:00:00.000Z', input_tokens: 500 },
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result = await collectMetrics(tmpDir);
    // cache_read=0, cache_creation=0, output=0
    assert.equal(result.cache_ratio, 0);
    assert.equal(result.total_tokens, 500);
    assert.equal(result.context_burn, 0);
    assert.equal(result.entry_count, 1);
  });

  test('division by zero: cache_ratio is 0 when input_tokens is 0', async () => {
    const entries = [
      makeEntry({ input_tokens: 0, cache_read_input_tokens: 0 }),
    ];
    writeJsonl(path.join(tmpDir, 'token-history.jsonl'), entries);

    const result = await collectMetrics(tmpDir);
    assert.equal(result.cache_ratio, 0);
  });
});
