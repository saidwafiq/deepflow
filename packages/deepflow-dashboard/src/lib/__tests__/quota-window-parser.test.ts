/**
 * Unit tests for quota-window-parser.ts covering AC-1 through AC-5.
 *
 * AC-1: 3 consecutive `five_hour` snapshots with same `resets_at` → 1 window,
 *       correct peakUtilization (max of all 3), finalUtilization (last snapshot),
 *       snapshotCount: 3.
 * AC-2: `resets_at` changes between snapshot 2 and 3 → 2 windows with correct
 *       boundary split.
 * AC-3: `extra_usage` entry with is_enabled:true → ExtraUsageWindow with
 *       correct usedCredits, monthlyLimit, peakUtilization.
 * AC-4: Malformed JSON line mid-file → warn to stderr, surrounding windows intact.
 * AC-5: `since` filter set to T → only windows with endsAt >= T returned.
 *
 * Uses Node.js built-in node:test (ESM + TypeScript stripping via
 * --experimental-strip-types) to match project conventions.
 *
 * Run with:
 *   node --experimental-strip-types --test src/lib/__tests__/quota-window-parser.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseQuotaWindows, type AnyQuotaWindow, type QuotaWindow, type ExtraUsageWindow } from '../quota-window-parser.js';

// ---------------------------------------------------------------------------
// Helper: collect async generator into array
// ---------------------------------------------------------------------------

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helper: write temp JSONL file and return path
// ---------------------------------------------------------------------------

function writeTempJsonl(lines: object[]): string {
  const tmpFile = path.join(os.tmpdir(), `quota-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(tmpFile, content, 'utf8');
  return tmpFile;
}

// ---------------------------------------------------------------------------
// AC-1: Three consecutive five_hour snapshots with same resets_at → 1 window
// ---------------------------------------------------------------------------

describe('AC-1: single window from 3 consecutive snapshots with same resets_at', () => {
  let tmpFile: string;

  before(() => {
    tmpFile = writeTempJsonl([
      {
        timestamp: '2025-01-01T00:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.3, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      {
        timestamp: '2025-01-01T01:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.7, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      {
        timestamp: '2025-01-01T02:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.5, resets_at: '2025-01-01T05:00:00.000Z' },
      },
    ]);
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('yields exactly 1 window', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour');
    assert.equal(fiveHourWindows.length, 1, 'should yield exactly 1 five_hour window');
  });

  it('snapshotCount is 3', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'five_hour') as QuotaWindow;
    assert.ok(w, 'five_hour window should exist');
    assert.equal(w.snapshotCount, 3, 'snapshotCount should be 3');
  });

  it('peakUtilization is the max across all 3 snapshots (0.7)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'five_hour') as QuotaWindow;
    assert.ok(w, 'five_hour window should exist');
    assert.equal(w.peakUtilization, 0.7, 'peakUtilization should be 0.7 (max)');
  });

  it('finalUtilization is the last snapshot value (0.5)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'five_hour') as QuotaWindow;
    assert.ok(w, 'five_hour window should exist');
    assert.equal(w.finalUtilization, 0.5, 'finalUtilization should be 0.5 (last snapshot)');
  });

  it('startedAt is the first snapshot timestamp', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'five_hour') as QuotaWindow;
    assert.ok(w, 'five_hour window should exist');
    assert.equal(w.startedAt, '2025-01-01T00:00:00.000Z', 'startedAt should be first snapshot');
  });

  it('endsAt is the last snapshot timestamp', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'five_hour') as QuotaWindow;
    assert.ok(w, 'five_hour window should exist');
    assert.equal(w.endsAt, '2025-01-01T02:00:00.000Z', 'endsAt should be last snapshot');
  });
});

// ---------------------------------------------------------------------------
// AC-2: resets_at changes between snapshot 2 and 3 → 2 windows
// ---------------------------------------------------------------------------

describe('AC-2: resets_at change between snapshot 2 and 3 splits into 2 windows', () => {
  let tmpFile: string;

  before(() => {
    tmpFile = writeTempJsonl([
      {
        timestamp: '2025-01-01T00:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.2, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      {
        timestamp: '2025-01-01T01:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.4, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      // resets_at changes here → new window boundary
      {
        timestamp: '2025-01-01T05:30:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.1, resets_at: '2025-01-01T10:00:00.000Z' },
      },
    ]);
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('yields exactly 2 five_hour windows', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour');
    assert.equal(fiveHourWindows.length, 2, 'should yield 2 five_hour windows');
  });

  it('window 1 has finalUtilization = snapshot 2 utilization (0.4)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour') as QuotaWindow[];
    const w1 = fiveHourWindows[0];
    assert.ok(w1, 'first window should exist');
    assert.equal(w1.finalUtilization, 0.4, 'first window finalUtilization should be 0.4');
  });

  it('window 1 has snapshotCount = 2', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour') as QuotaWindow[];
    assert.equal(fiveHourWindows[0].snapshotCount, 2, 'first window should have 2 snapshots');
  });

  it('window 2 starts fresh with snapshot 3 data', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour') as QuotaWindow[];
    const w2 = fiveHourWindows[1];
    assert.ok(w2, 'second window should exist');
    assert.equal(w2.startedAt, '2025-01-01T05:30:00.000Z', 'second window should start at snapshot 3 timestamp');
    assert.equal(w2.finalUtilization, 0.1, 'second window finalUtilization should be 0.1');
    assert.equal(w2.snapshotCount, 1, 'second window should have 1 snapshot');
  });

  it('window 1 peakUtilization is max of snapshots 1 and 2 (0.4)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour') as QuotaWindow[];
    assert.equal(fiveHourWindows[0].peakUtilization, 0.4, 'first window peak should be 0.4');
  });
});

// ---------------------------------------------------------------------------
// AC-3: extra_usage with is_enabled:true → ExtraUsageWindow with correct fields
// ---------------------------------------------------------------------------

describe('AC-3: extra_usage entry produces ExtraUsageWindow with correct fields', () => {
  let tmpFile: string;

  before(() => {
    tmpFile = writeTempJsonl([
      {
        timestamp: '2025-01-01T00:00:00.000Z',
        event: 'quota_snapshot',
        extra_usage: {
          is_enabled: true,
          used_credits: 50,
          monthly_limit: 100,
          utilization: 50,
        },
      },
    ]);
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('yields 1 extra_usage window', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const extraWindows = windows.filter(w => w.type === 'extra_usage');
    assert.equal(extraWindows.length, 1, 'should yield exactly 1 extra_usage window');
  });

  it('usedCredits is 0.5 (raw centavo value 50 divided by 100)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'extra_usage') as ExtraUsageWindow;
    assert.ok(w, 'extra_usage window should exist');
    assert.equal(w.usedCredits, 0.5, 'usedCredits should be 0.5 (50 centavos / 100)');
  });

  it('monthlyLimit is 1 (raw centavo value 100 divided by 100)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'extra_usage') as ExtraUsageWindow;
    assert.ok(w, 'extra_usage window should exist');
    assert.equal(w.monthlyLimit, 1, 'monthlyLimit should be 1 (100 centavos / 100)');
  });

  it('peakUtilization is obj.utilization directly = 50', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'extra_usage') as ExtraUsageWindow;
    assert.ok(w, 'extra_usage window should exist');
    assert.equal(w.peakUtilization, 50, 'peakUtilization should be 50 (raw utilization field, 0-100 scale)');
  });

  it('isEnabled is true', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const w = windows.find(w => w.type === 'extra_usage') as ExtraUsageWindow;
    assert.ok(w, 'extra_usage window should exist');
    assert.equal(w.isEnabled, true, 'isEnabled should be true');
  });
});

// ---------------------------------------------------------------------------
// AC-4: Malformed JSON line mid-file → warn to stderr, surrounding windows intact
// ---------------------------------------------------------------------------

describe('AC-4: malformed JSON line is skipped with stderr warning; surrounding windows intact', () => {
  let tmpFile: string;
  let stderrOutput: string;

  before(() => {
    tmpFile = writeTempJsonl([
      {
        timestamp: '2025-01-01T00:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.3, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      // This placeholder is a malformed line — write it raw
    ]);
    // Insert a malformed line between valid lines
    const lines = fs.readFileSync(tmpFile, 'utf8').trimEnd().split('\n');
    const withMalformed = [
      lines[0],
      'this is not valid json {{{',
      JSON.stringify({
        timestamp: '2025-01-01T02:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.5, resets_at: '2025-01-01T05:00:00.000Z' },
      }),
    ].join('\n') + '\n';
    fs.writeFileSync(tmpFile, withMalformed, 'utf8');
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('collects windows without throwing', async () => {
    // Capture stderr
    const originalWrite = process.stderr.write.bind(process.stderr);
    stderrOutput = '';
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput += chunk.toString();
      return true;
    };

    let windows: AnyQuotaWindow[];
    try {
      windows = await collect(parseQuotaWindows(tmpFile));
    } finally {
      process.stderr.write = originalWrite;
    }

    // Should not throw — just yield the valid windows
    assert.ok(Array.isArray(windows!), 'should return an array without throwing');
  });

  it('yields the valid windows (snapshot 1 and snapshot 3 in same window)', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour') as QuotaWindow[];
    // The two valid snapshots share the same resets_at → they form 1 window
    assert.equal(fiveHourWindows.length, 1, 'valid snapshots around malformed line should form 1 window');
    assert.equal(fiveHourWindows[0].snapshotCount, 2, 'window should contain 2 valid snapshots');
  });

  it('writes a warning to stderr for the malformed line', async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      captured += chunk.toString();
      return true;
    };

    try {
      await collect(parseQuotaWindows(tmpFile));
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.ok(
      captured.includes('Malformed JSON') || captured.includes('quota-window-parser'),
      `stderr should contain a warning about malformed JSON, got: "${captured}"`
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5: since filter → only windows with endsAt >= T returned
// (only runs if the `since` option is present in the API)
// ---------------------------------------------------------------------------

describe('AC-5: since filter returns only windows with endsAt >= since date', () => {
  // Check at describe time whether the API supports `since`.
  // parseQuotaWindows accepts ParseQuotaWindowsOptions with optional `since`.
  // Per the task spec: skip if T4 has not yet landed. Since we read the source
  // and saw ParseQuotaWindowsOptions.since is present, we include the test.

  let tmpFile: string;

  before(() => {
    tmpFile = writeTempJsonl([
      // Window 1: ends 2025-01-01T01:00:00.000Z (before filter threshold)
      {
        timestamp: '2025-01-01T00:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.2, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      {
        timestamp: '2025-01-01T01:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.3, resets_at: '2025-01-01T05:00:00.000Z' },
      },
      // resets_at changes → window 1 closes (endsAt = 2025-01-01T01:00:00.000Z)
      // Window 2: ends 2025-01-01T06:00:00.000Z (after filter threshold)
      {
        timestamp: '2025-01-01T05:30:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.6, resets_at: '2025-01-01T10:00:00.000Z' },
      },
      {
        timestamp: '2025-01-01T06:00:00.000Z',
        event: 'quota_snapshot',
        five_hour: { utilization: 0.8, resets_at: '2025-01-01T10:00:00.000Z' },
      },
    ]);
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('without since filter: returns all windows', async () => {
    const windows = await collect(parseQuotaWindows(tmpFile));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour');
    assert.equal(fiveHourWindows.length, 2, 'without filter: 2 windows expected');
  });

  it('with since=2025-01-01T02:00:00.000Z: only returns window whose endsAt >= filter date', async () => {
    // TODO: This test requires T4 to be merged. The `since` option is available
    // per reading quota-window-parser.ts — ParseQuotaWindowsOptions.since exists.
    const sinceDate = new Date('2025-01-01T02:00:00.000Z');

    // Window 1 endsAt = 2025-01-01T01:00:00.000Z (before sinceDate) → filtered out
    // Window 2 endsAt = 2025-01-01T06:00:00.000Z (after sinceDate) → included
    const windows = await collect(parseQuotaWindows(tmpFile, { since: sinceDate }));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour') as QuotaWindow[];

    assert.equal(fiveHourWindows.length, 1, 'since filter should return only windows after filter date');
    assert.equal(
      fiveHourWindows[0].endsAt,
      '2025-01-01T06:00:00.000Z',
      'returned window should be the one ending after the filter date'
    );
  });

  it('with since after all windows: returns empty array', async () => {
    const sinceDate = new Date('2025-01-02T00:00:00.000Z');
    const windows = await collect(parseQuotaWindows(tmpFile, { since: sinceDate }));
    const fiveHourWindows = windows.filter(w => w.type === 'five_hour');
    assert.equal(fiveHourWindows.length, 0, 'since after all windows should return empty');
  });
});
