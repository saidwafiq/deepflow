import { Hono } from 'hono';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { all } from '../db/index.js';
import { parseQuotaWindows, type AnyQuotaWindow } from '../lib/quota-window-parser.js';

export const quotaRouter = new Hono();

// ---------------------------------------------------------------------------
// Types for GET /api/quota/windows
// ---------------------------------------------------------------------------

interface WindowRow {
  startedAt: string;
  endsAt: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  seven_day_sonnet_pct: number | null;
  extra_usage_pct: number | null;
  isActive: boolean;
  sevenDayEndsAt: string | null;
  cost: number;
}

// ---------------------------------------------------------------------------
// GET /api/quota/windows
// ---------------------------------------------------------------------------
// Returns correlated quota windows: each five_hour window paired with the
// seven_day / seven_day_sonnet / extra_usage window that overlaps it.
// Sorted newest-first. No monetary values — utilization % only.
// ---------------------------------------------------------------------------
quotaRouter.get('/windows', async (c) => {
  const claudeDir = resolve(homedir(), '.claude');
  const filePath = resolve(claudeDir, 'quota-history.jsonl');

  // Collect all windows from the JSONL file
  const allWindows: AnyQuotaWindow[] = [];
  try {
    for await (const w of parseQuotaWindows(filePath)) {
      allWindows.push(w);
    }
  } catch {
    // File missing or unreadable — return empty
    return c.json({ data: [] });
  }

  // Group by window type
  const fiveHour = allWindows.filter((w) => w.type === 'five_hour');
  const sevenDay = allWindows.filter((w) => w.type === 'seven_day');
  const sevenDaySonnet = allWindows.filter((w) => w.type === 'seven_day_sonnet');
  const extraUsage = allWindows.filter((w) => w.type === 'extra_usage');

  /** Find the first window in `pool` where startedAt <= ts <= endsAt */
  function findOverlap(pool: AnyQuotaWindow[], ts: string): AnyQuotaWindow | undefined {
    const tsMs = new Date(ts).getTime();
    return pool.find((w) => {
      const start = new Date(w.startedAt).getTime();
      const end = new Date(w.endsAt).getTime();
      return start <= tsMs && tsMs <= end;
    });
  }

  const now = Date.now();

  // Bulk query: session costs indexed by started_at for cost-per-window assignment
  const sessionRows = fiveHour.length > 0
    ? all(
        `SELECT started_at, COALESCE(cost, 0) AS cost
         FROM sessions
         WHERE started_at >= ? AND started_at <= ?
           AND model NOT IN ('<synthetic>', 'unknown')`,
        [fiveHour[0].startedAt, fiveHour[fiveHour.length - 1].endsAt] as import('sql.js').SqlValue[]
      )
    : [];

  const rows: WindowRow[] = fiveHour.map((fh) => {
    const sdMatch = findOverlap(sevenDay, fh.startedAt);
    const sdsMatch = findOverlap(sevenDaySonnet, fh.startedAt);
    const euMatch = findOverlap(extraUsage, fh.startedAt);

    const fhEndsMs = new Date(fh.endsAt).getTime();
    const fhStartMs = new Date(fh.startedAt).getTime();
    const isActive = fhEndsMs > now && fhStartMs <= now;

    const cost = sessionRows
      .filter((s) => {
        const ts = new Date(s.started_at as string).getTime();
        return ts >= fhStartMs && ts <= fhEndsMs;
      })
      .reduce((sum, s) => sum + (s.cost as number), 0);

    return {
      startedAt: fh.startedAt,
      endsAt: fh.endsAt,
      five_hour_pct: fh.finalUtilization,
      seven_day_pct: sdMatch ? sdMatch.finalUtilization : null,
      seven_day_sonnet_pct: sdsMatch ? sdsMatch.finalUtilization : null,
      extra_usage_pct: euMatch ? euMatch.finalUtilization : null,
      isActive,
      sevenDayEndsAt: sdMatch ? sdMatch.endsAt : null,
      cost,
    };
  });

  // Sort newest-first by startedAt
  rows.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return c.json({ data: rows });
});

// GET /api/quota/history
// Query params: window_type (optional), days (optional, default 7)
// Returns: time-series of quota snapshots ordered by captured_at
quotaRouter.get('/history', (c) => {
  const windowType = c.req.query('window_type');
  const days = parseInt(c.req.query('days') ?? '7', 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const conditions: string[] = ['captured_at > ?'];
  const params: import('sql.js').SqlValue[] = [cutoff];

  if (windowType) {
    conditions.push('window_type = ?');
    params.push(windowType);
  }

  const where = conditions.join(' AND ');

  const rows = all(
    `SELECT captured_at, window_type, used, limit_val
     FROM quota_snapshots
     WHERE ${where}
     ORDER BY captured_at`,
    params
  );

  const data = rows.map((r) => ({
    ...r,
    utilization_pct: r.limit_val
      ? Math.round(((r.used as number) / (r.limit_val as number)) * 1000) / 10
      : (r.used as number) > 0 ? (r.used as number) : null,
  }));

  return c.json({ data });
});

// GET /api/quota
// Query params: user
// Returns: latest quota snapshot per user+window_type, with utilization %
quotaRouter.get('/', (c) => {
  const user = c.req.query('user');

  const userFilter = user ? 'WHERE qs.user = ?' : '';
  const params = user ? [user] : [];

  // Latest snapshot per user+window_type using a subquery on max captured_at
  const rows = all(
    `SELECT qs.user, qs.window_type, qs.used, qs.limit_val, qs.reset_at, qs.captured_at
     FROM quota_snapshots qs
     INNER JOIN (
       SELECT user, window_type, MAX(captured_at) AS latest
       FROM quota_snapshots
       GROUP BY user, window_type
     ) latest_qs ON qs.user = latest_qs.user
                AND qs.window_type = latest_qs.window_type
                AND qs.captured_at = latest_qs.latest
     ${userFilter}
     ORDER BY qs.user, qs.window_type`,
    params as import('sql.js').SqlValue[]
  );

  const data = rows.map((r) => ({
    ...r,
    utilization_pct: r.limit_val
      ? Math.round(((r.used as number) / (r.limit_val as number)) * 1000) / 10
      : (r.used as number) > 0 ? (r.used as number) : null,
  }));

  return c.json({ data });
});
