/**
 * Unit tests for GET /api/quota/windows route (AC-2, AC-4, AC-10).
 *
 * AC-2: GET /api/quota/windows returns { data: WindowRow[] } with startedAt,
 *       endsAt, and pct fields for all 4 types.
 * AC-4: Rows sorted newest-first by startedAt.
 * AC-10: GET /api/quota and GET /api/quota/history responses unchanged.
 *
 * Strategy:
 * - Source-inspection tests verify route structure, field names, and existing
 *   route preservation (no runtime deps on DB or file system).
 * - Logic tests exercise the correlation and isActive logic extracted inline
 *   (same algorithm as quota.ts) for precise behavioral assertions.
 *
 * Run with:
 *   node --experimental-strip-types --loader ../../lib/__tests__/ts-loader.mjs \
 *     --test src/api/__tests__/quota-windows.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..', '..');
const quotaSrc = readFileSync(resolve(SRC_ROOT, 'api', 'quota.ts'), 'utf8');

// ---------------------------------------------------------------------------
// Types mirrored from quota.ts for logic tests
// ---------------------------------------------------------------------------

interface WindowRow {
  startedAt: string;
  endsAt: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  seven_day_sonnet_pct: number | null;
  extra_usage_pct: number | null;
  isActive: boolean;
}

interface MockWindow {
  type: string;
  startedAt: string;
  endsAt: string;
  finalUtilization: number;
}

// ---------------------------------------------------------------------------
// Helpers: replicate route logic for unit testing
// (identical algorithm as quota.ts — changes here signal implementation drift)
// ---------------------------------------------------------------------------

function findOverlap(pool: MockWindow[], ts: string): MockWindow | undefined {
  const tsMs = new Date(ts).getTime();
  return pool.find((w) => {
    const start = new Date(w.startedAt).getTime();
    const end = new Date(w.endsAt).getTime();
    return start <= tsMs && tsMs <= end;
  });
}

function correlateWindows(allWindows: MockWindow[], now: number): WindowRow[] {
  const fiveHour = allWindows.filter((w) => w.type === 'five_hour');
  const sevenDay = allWindows.filter((w) => w.type === 'seven_day');
  const sevenDaySonnet = allWindows.filter((w) => w.type === 'seven_day_sonnet');
  const extraUsage = allWindows.filter((w) => w.type === 'extra_usage');

  const rows: WindowRow[] = fiveHour.map((fh) => {
    const sdMatch = findOverlap(sevenDay, fh.startedAt);
    const sdsMatch = findOverlap(sevenDaySonnet, fh.startedAt);
    const euMatch = findOverlap(extraUsage, fh.startedAt);

    const fhEndsMs = new Date(fh.endsAt).getTime();
    const fhStartMs = new Date(fh.startedAt).getTime();
    const isActive = fhEndsMs > now && fhStartMs <= now;

    return {
      startedAt: fh.startedAt,
      endsAt: fh.endsAt,
      five_hour_pct: fh.finalUtilization,
      seven_day_pct: sdMatch ? sdMatch.finalUtilization : null,
      seven_day_sonnet_pct: sdsMatch ? sdsMatch.finalUtilization : null,
      extra_usage_pct: euMatch ? euMatch.finalUtilization : null,
      isActive,
    };
  });

  rows.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return rows;
}

// ---------------------------------------------------------------------------
// AC-2 (source): /windows route exists with correct structure
// ---------------------------------------------------------------------------

describe("AC-2 (source): GET /api/quota/windows route structure", () => {
  it("defines quotaRouter.get('/windows') route", () => {
    assert.ok(
      quotaSrc.includes("quotaRouter.get('/windows'") ||
        quotaSrc.includes('quotaRouter.get("/windows"'),
      "quota.ts should define a GET /windows route on quotaRouter"
    );
  });

  it("WindowRow interface includes startedAt field", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    assert.ok(ifaceStart !== -1, 'WindowRow interface should be defined');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(ifaceBody.includes('startedAt'), 'WindowRow should have startedAt');
  });

  it("WindowRow interface includes endsAt field", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(ifaceBody.includes('endsAt'), 'WindowRow should have endsAt');
  });

  it("WindowRow interface includes five_hour_pct as number | null", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(
      ifaceBody.includes('five_hour_pct: number | null'),
      'WindowRow should have five_hour_pct: number | null'
    );
  });

  it("WindowRow interface includes seven_day_pct as number | null", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(
      ifaceBody.includes('seven_day_pct: number | null'),
      'WindowRow should have seven_day_pct: number | null'
    );
  });

  it("WindowRow interface includes seven_day_sonnet_pct as number | null", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(
      ifaceBody.includes('seven_day_sonnet_pct: number | null'),
      'WindowRow should have seven_day_sonnet_pct: number | null'
    );
  });

  it("WindowRow interface includes extra_usage_pct as number | null", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(
      ifaceBody.includes('extra_usage_pct: number | null'),
      'WindowRow should have extra_usage_pct: number | null'
    );
  });

  it("WindowRow interface includes isActive boolean", () => {
    const ifaceStart = quotaSrc.indexOf('interface WindowRow');
    const ifaceEnd = quotaSrc.indexOf('}', ifaceStart);
    const ifaceBody = quotaSrc.slice(ifaceStart, ifaceEnd);
    assert.ok(ifaceBody.includes('isActive: boolean'), 'WindowRow should have isActive: boolean');
  });

  it("response wraps rows in { data } envelope", () => {
    const windowsRouteStart = quotaSrc.indexOf("quotaRouter.get('/windows'");
    const windowsRouteEnd = quotaSrc.indexOf('\n});', windowsRouteStart);
    const routeBody = quotaSrc.slice(windowsRouteStart, windowsRouteEnd);
    assert.ok(
      routeBody.includes('c.json({ data }') || routeBody.includes('c.json({ data:'),
      'Route should return { data } envelope'
    );
  });

  it("file-not-found path returns { data: [] }", () => {
    const windowsRouteStart = quotaSrc.indexOf("quotaRouter.get('/windows'");
    const windowsRouteEnd = quotaSrc.indexOf('\n});', windowsRouteStart);
    const routeBody = quotaSrc.slice(windowsRouteStart, windowsRouteEnd);
    assert.ok(
      routeBody.includes('{ data: [] }'),
      'Route should return empty data array when file is missing'
    );
  });

  it("groups windows by type (five_hour, seven_day, seven_day_sonnet, extra_usage)", () => {
    const windowsRouteStart = quotaSrc.indexOf("quotaRouter.get('/windows'");
    const windowsRouteEnd = quotaSrc.indexOf('\n});', windowsRouteStart);
    const routeBody = quotaSrc.slice(windowsRouteStart, windowsRouteEnd);
    assert.ok(routeBody.includes("'five_hour'"), 'Route should filter five_hour windows');
    assert.ok(routeBody.includes("'seven_day'"), 'Route should filter seven_day windows');
    assert.ok(routeBody.includes("'seven_day_sonnet'"), 'Route should filter seven_day_sonnet windows');
    assert.ok(routeBody.includes("'extra_usage'"), 'Route should filter extra_usage windows');
  });

  it("uses findOverlap to correlate windows by startedAt", () => {
    const windowsRouteStart = quotaSrc.indexOf("quotaRouter.get('/windows'");
    const windowsRouteEnd = quotaSrc.indexOf('\n});', windowsRouteStart);
    const routeBody = quotaSrc.slice(windowsRouteStart, windowsRouteEnd);
    assert.ok(
      routeBody.includes('findOverlap'),
      'Route should use findOverlap to match windows by timestamp'
    );
    assert.ok(
      routeBody.includes('fh.startedAt'),
      'Route should look up seven_day/extra_usage windows using five_hour startedAt'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2 (logic): happy path — all 4 window types correlated correctly
// ---------------------------------------------------------------------------

describe("AC-2 (logic): happy path — all 4 types correlated, pct values correct", () => {
  // five_hour window from T=0 to T+5h
  // seven_day window spanning T-1d to T+7d (overlaps five_hour)
  // seven_day_sonnet window spanning T-1d to T+7d (overlaps five_hour)
  // extra_usage window spanning T-1d to T+7d (overlaps five_hour)

  const base = '2025-06-01T00:00:00.000Z';
  const plus5h = '2025-06-01T05:00:00.000Z';
  const minus1d = '2025-05-31T00:00:00.000Z';
  const plus7d = '2025-06-08T00:00:00.000Z';

  const allWindows: MockWindow[] = [
    { type: 'five_hour', startedAt: base, endsAt: plus5h, finalUtilization: 0.4 },
    { type: 'seven_day', startedAt: minus1d, endsAt: plus7d, finalUtilization: 0.6 },
    { type: 'seven_day_sonnet', startedAt: minus1d, endsAt: plus7d, finalUtilization: 0.3 },
    { type: 'extra_usage', startedAt: minus1d, endsAt: plus7d, finalUtilization: 0.8 },
  ];

  // now is far in the future so isActive = false for all
  const now = new Date('2030-01-01T00:00:00.000Z').getTime();

  it("returns exactly 1 row (one five_hour window)", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows.length, 1, 'should return 1 row for 1 five_hour window');
  });

  it("row has correct startedAt and endsAt", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].startedAt, base, 'startedAt should match five_hour window');
    assert.equal(rows[0].endsAt, plus5h, 'endsAt should match five_hour window');
  });

  it("five_hour_pct is the finalUtilization of the five_hour window", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].five_hour_pct, 0.4, 'five_hour_pct should be 0.4');
  });

  it("seven_day_pct is the finalUtilization of the overlapping seven_day window", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].seven_day_pct, 0.6, 'seven_day_pct should be 0.6');
  });

  it("seven_day_sonnet_pct is the finalUtilization of the overlapping seven_day_sonnet window", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].seven_day_sonnet_pct, 0.3, 'seven_day_sonnet_pct should be 0.3');
  });

  it("extra_usage_pct is the finalUtilization of the overlapping extra_usage window", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].extra_usage_pct, 0.8, 'extra_usage_pct should be 0.8');
  });
});

// ---------------------------------------------------------------------------
// AC-2 (logic): missing match — no overlapping seven_day → null pct
// ---------------------------------------------------------------------------

describe("AC-2 (logic): missing match — no overlapping seven_day window → seven_day_pct null", () => {
  // five_hour window: 2025-06-01T00:00 → 2025-06-01T05:00
  // seven_day window: starts AFTER the five_hour's startedAt → no overlap
  const fiveHourStart = '2025-06-01T00:00:00.000Z';
  const fiveHourEnd = '2025-06-01T05:00:00.000Z';
  const sevenDayStart = '2025-06-05T00:00:00.000Z'; // starts after five_hour
  const sevenDayEnd = '2025-06-12T00:00:00.000Z';

  const allWindows: MockWindow[] = [
    { type: 'five_hour', startedAt: fiveHourStart, endsAt: fiveHourEnd, finalUtilization: 0.5 },
    { type: 'seven_day', startedAt: sevenDayStart, endsAt: sevenDayEnd, finalUtilization: 0.7 },
  ];

  const now = new Date('2030-01-01T00:00:00.000Z').getTime();

  it("seven_day_pct is null when no seven_day window overlaps the five_hour startedAt", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows.length, 1, 'should return 1 row');
    assert.equal(rows[0].seven_day_pct, null, 'seven_day_pct should be null when no overlap');
  });

  it("seven_day_sonnet_pct is null when no seven_day_sonnet windows exist", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].seven_day_sonnet_pct, null, 'seven_day_sonnet_pct should be null');
  });

  it("extra_usage_pct is null when no extra_usage windows exist", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].extra_usage_pct, null, 'extra_usage_pct should be null');
  });

  it("five_hour_pct is still correct even with missing overlaps", () => {
    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].five_hour_pct, 0.5, 'five_hour_pct should be 0.5');
  });
});

// ---------------------------------------------------------------------------
// AC-2 (logic): isActive flag
// ---------------------------------------------------------------------------

describe("AC-2 (logic): isActive flag — true when endsAt > now && startedAt <= now", () => {
  it("isActive is true when now is inside the five_hour window", () => {
    const windowStart = '2025-06-01T00:00:00.000Z';
    const windowEnd = '2025-06-01T05:00:00.000Z';
    // now is between start and end
    const now = new Date('2025-06-01T02:30:00.000Z').getTime();

    const allWindows: MockWindow[] = [
      { type: 'five_hour', startedAt: windowStart, endsAt: windowEnd, finalUtilization: 0.4 },
    ];

    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].isActive, true, 'isActive should be true when now is inside the window');
  });

  it("isActive is false when now is after endsAt", () => {
    const windowStart = '2025-06-01T00:00:00.000Z';
    const windowEnd = '2025-06-01T05:00:00.000Z';
    const now = new Date('2025-06-01T06:00:00.000Z').getTime(); // after end

    const allWindows: MockWindow[] = [
      { type: 'five_hour', startedAt: windowStart, endsAt: windowEnd, finalUtilization: 0.4 },
    ];

    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].isActive, false, 'isActive should be false when now is after endsAt');
  });

  it("isActive is false when now is before startedAt", () => {
    const windowStart = '2025-06-01T10:00:00.000Z';
    const windowEnd = '2025-06-01T15:00:00.000Z';
    const now = new Date('2025-06-01T09:00:00.000Z').getTime(); // before start

    const allWindows: MockWindow[] = [
      { type: 'five_hour', startedAt: windowStart, endsAt: windowEnd, finalUtilization: 0.2 },
    ];

    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].isActive, false, 'isActive should be false when now is before startedAt');
  });

  it("isActive source: computed as fhEndsMs > now && fhStartMs <= now", () => {
    const windowsRouteStart = quotaSrc.indexOf("quotaRouter.get('/windows'");
    const windowsRouteEnd = quotaSrc.indexOf('\n});', windowsRouteStart);
    const routeBody = quotaSrc.slice(windowsRouteStart, windowsRouteEnd);
    assert.ok(
      routeBody.includes('fhEndsMs > now && fhStartMs <= now') ||
        routeBody.includes('fhEndsMs > now') && routeBody.includes('fhStartMs <= now'),
      'isActive should be computed as fhEndsMs > now && fhStartMs <= now'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: Sort order — newest-first by startedAt
// ---------------------------------------------------------------------------

describe("AC-4: rows sorted newest-first by startedAt", () => {
  it("multiple five_hour windows are returned newest-first", () => {
    const older = '2025-06-01T00:00:00.000Z';
    const newer = '2025-06-01T06:00:00.000Z';
    const now = new Date('2030-01-01T00:00:00.000Z').getTime();

    const allWindows: MockWindow[] = [
      { type: 'five_hour', startedAt: older, endsAt: '2025-06-01T05:00:00.000Z', finalUtilization: 0.3 },
      { type: 'five_hour', startedAt: newer, endsAt: '2025-06-01T11:00:00.000Z', finalUtilization: 0.7 },
    ];

    const rows = correlateWindows(allWindows, now);
    assert.equal(rows.length, 2, 'should return 2 rows');
    assert.equal(rows[0].startedAt, newer, 'newest window should be first (index 0)');
    assert.equal(rows[1].startedAt, older, 'older window should be second (index 1)');
  });

  it("sort is stable — 3 windows in ascending input order become newest-first", () => {
    const t1 = '2025-01-01T00:00:00.000Z';
    const t2 = '2025-01-02T00:00:00.000Z';
    const t3 = '2025-01-03T00:00:00.000Z';
    const now = new Date('2030-01-01T00:00:00.000Z').getTime();

    const allWindows: MockWindow[] = [
      { type: 'five_hour', startedAt: t1, endsAt: '2025-01-01T05:00:00.000Z', finalUtilization: 0.1 },
      { type: 'five_hour', startedAt: t2, endsAt: '2025-01-02T05:00:00.000Z', finalUtilization: 0.2 },
      { type: 'five_hour', startedAt: t3, endsAt: '2025-01-03T05:00:00.000Z', finalUtilization: 0.3 },
    ];

    const rows = correlateWindows(allWindows, now);
    assert.equal(rows[0].startedAt, t3, 'first row should be newest (t3)');
    assert.equal(rows[1].startedAt, t2, 'second row should be middle (t2)');
    assert.equal(rows[2].startedAt, t1, 'third row should be oldest (t1)');
  });

  it("sort source: uses new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()", () => {
    assert.ok(
      quotaSrc.includes('new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()'),
      'Sort comparator should be newest-first (b - a)'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-10: Existing routes GET /api/quota and GET /api/quota/history unchanged
// ---------------------------------------------------------------------------

describe("AC-10: existing routes GET /api/quota and GET /api/quota/history unchanged", () => {
  it("quotaRouter still defines GET / route for /api/quota", () => {
    assert.ok(
      quotaSrc.includes("quotaRouter.get('/', ") || quotaSrc.includes('quotaRouter.get("/", '),
      'quotaRouter should still define a GET / route'
    );
  });

  it("GET /api/quota still queries quota_snapshots table", () => {
    const rootRouteStart = quotaSrc.indexOf("quotaRouter.get('/', ");
    assert.ok(rootRouteStart !== -1, 'GET / route not found');
    const rootRouteEnd = quotaSrc.indexOf('\n});', rootRouteStart);
    const routeBody = quotaSrc.slice(rootRouteStart, rootRouteEnd);
    assert.ok(
      routeBody.includes('FROM quota_snapshots'),
      'GET / should still query quota_snapshots'
    );
  });

  it("GET /api/quota still returns { data } envelope", () => {
    const rootRouteStart = quotaSrc.indexOf("quotaRouter.get('/', ");
    const rootRouteEnd = quotaSrc.indexOf('\n});', rootRouteStart);
    const routeBody = quotaSrc.slice(rootRouteStart, rootRouteEnd);
    assert.ok(
      routeBody.includes('c.json({ data }') || routeBody.includes('c.json({ data:'),
      'GET / should return { data } envelope'
    );
  });

  it("quotaRouter still defines GET /history route for /api/quota/history", () => {
    assert.ok(
      quotaSrc.includes("quotaRouter.get('/history'") ||
        quotaSrc.includes('quotaRouter.get("/history"'),
      'quotaRouter should still define a GET /history route'
    );
  });

  it("GET /api/quota/history still queries quota_snapshots with captured_at filter", () => {
    const historyRouteStart = quotaSrc.indexOf("quotaRouter.get('/history'");
    assert.ok(historyRouteStart !== -1, 'GET /history route not found');
    const historyRouteEnd = quotaSrc.indexOf('\n});', historyRouteStart);
    const routeBody = quotaSrc.slice(historyRouteStart, historyRouteEnd);
    assert.ok(
      routeBody.includes('FROM quota_snapshots'),
      'GET /history should still query quota_snapshots'
    );
    assert.ok(
      routeBody.includes('captured_at > ?'),
      'GET /history should still filter by captured_at'
    );
  });

  it("GET /api/quota/history still returns utilization_pct", () => {
    const historyRouteStart = quotaSrc.indexOf("quotaRouter.get('/history'");
    const historyRouteEnd = quotaSrc.indexOf('\n});', historyRouteStart);
    const routeBody = quotaSrc.slice(historyRouteStart, historyRouteEnd);
    assert.ok(
      routeBody.includes('utilization_pct'),
      'GET /history should still include utilization_pct in response'
    );
  });

  it("GET /api/quota/history still supports window_type and days query params", () => {
    const historyRouteStart = quotaSrc.indexOf("quotaRouter.get('/history'");
    const historyRouteEnd = quotaSrc.indexOf('\n});', historyRouteStart);
    const routeBody = quotaSrc.slice(historyRouteStart, historyRouteEnd);
    assert.ok(
      routeBody.includes("c.req.query('window_type')") ||
        routeBody.includes('c.req.query("window_type")'),
      'GET /history should still accept window_type query param'
    );
    assert.ok(
      routeBody.includes("c.req.query('days')") || routeBody.includes('c.req.query("days")'),
      'GET /history should still accept days query param'
    );
  });
});
