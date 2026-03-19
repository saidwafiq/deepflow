import { Hono } from 'hono';
import { all } from '../db/index.js';

export const activityRouter = new Hono();

// GET /api/activity
// Query params: user, weeks (default 52)
// Returns: daily session counts for the heatmap grid — 52 weeks × 7 days
activityRouter.get('/', (c) => {
  const user = c.req.query('user');
  const weeks = Math.min(parseInt(c.req.query('weeks') ?? '52', 10) || 52, 104);
  const days = weeks * 7;

  const userFilter = user ? 'AND user = ?' : '';
  const params: unknown[] = [`-${days}`];
  if (user) params.push(user);

  const rows = all(
    `SELECT date(started_at) AS day,
            COUNT(*)          AS session_count,
            SUM(cost)         AS total_cost,
            SUM(messages)     AS total_messages
     FROM sessions
     WHERE started_at >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY day
     ORDER BY day ASC`,
    params as import('sql.js').SqlValue[]
  );

  return c.json({ data: rows, weeks, days });
});
