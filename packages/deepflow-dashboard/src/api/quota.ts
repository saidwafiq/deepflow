import { Hono } from 'hono';
import { all } from '../db/index.js';

export const quotaRouter = new Hono();

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
