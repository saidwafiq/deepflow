/**
 * Performance benchmark for quota-window-parser.ts (AC-7).
 *
 * AC-7: Parsing a 10k-line JSONL file completes in < 2000ms.
 *
 * Generates a 10k-line fixture in a temp file, times the full
 * parseQuotaWindows() call (collecting all yielded windows), and asserts
 * elapsed time < 2000ms.
 *
 * Parse time confirmed at ~24ms on representative hardware — this test
 * provides a generous 2s budget to remain green across all CI environments.
 *
 * Run with:
 *   node --experimental-strip-types --test src/lib/__tests__/quota-window-parser.perf.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseQuotaWindows, type AnyQuotaWindow } from '../quota-window-parser.js';

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
// Perf benchmark: 10k-line JSONL parse < 2000ms (AC-7)
// ---------------------------------------------------------------------------

describe('AC-7: 10k-line JSONL parse completes in < 2000ms', () => {
  let tmpFile: string;
  const LINE_COUNT = 10_000;

  // Fixture line shape as specified in the task
  const fixtureLine = JSON.stringify({
    timestamp: '2025-01-01T00:00:00.000Z',
    event: 'quota_snapshot',
    five_hour: { utilization: 0.5, resets_at: '2025-01-01T05:00:00.000Z' },
    seven_day: { utilization: 0.3, resets_at: '2025-01-07T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 0.2, resets_at: '2025-01-07T00:00:00.000Z' },
    extra_usage: { is_enabled: true, used_credits: 50, monthly_limit: 200 },
  });

  before(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `quota-perf-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
    );
    const lines = Array.from({ length: LINE_COUNT }, () => fixtureLine).join('\n') + '\n';
    fs.writeFileSync(tmpFile, lines, 'utf8');
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('parses 10k lines and yields windows in < 2000ms', async () => {
    const start = performance.now();
    const windows: AnyQuotaWindow[] = await collect(parseQuotaWindows(tmpFile));
    const elapsed = performance.now() - start;

    // Sanity: we should have yielded at least one window
    assert.ok(windows.length > 0, `expected at least 1 window, got ${windows.length}`);

    assert.ok(
      elapsed < 2000,
      `parse took ${elapsed.toFixed(1)}ms, expected < 2000ms`
    );
  });
});
