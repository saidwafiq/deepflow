import { Hono } from 'hono';
import { all, get } from '../db/index.js';

export const cacheRouter = new Hono();

// GET /api/cache
// Query params: user, days (default 30)
// Returns: overall hit ratio, token breakdown, daily trend
cacheRouter.get('/', (c) => {
  const user = c.req.query('user');
  const days = parseInt(c.req.query('days') ?? '30', 10) || 30;

  const userFilter = user ? 'AND user = ?' : '';
  const params: unknown[] = [`-${days}`];
  if (user) params.push(user);

  // Overall totals for the period
  const totals = get(
    `SELECT SUM(tokens_in)      AS total_input,
            SUM(tokens_out)     AS total_output,
            SUM(cache_read)     AS total_cache_read,
            SUM(cache_creation) AS total_cache_creation
     FROM sessions
     WHERE started_at >= datetime('now', ? || ' days')
     ${userFilter}`,
    params as import('sql.js').SqlValue[]
  ) ?? {};

  const totalInput = (totals.total_input as number) ?? 0;
  const totalCacheRead = (totals.total_cache_read as number) ?? 0;
  const totalCacheCreation = (totals.total_cache_creation as number) ?? 0;

  // Hit ratio: cache_read / (total_input + cache_read) — fraction of tokens served from cache
  const denominator = totalInput + totalCacheRead;
  const hitRatio = denominator > 0 ? totalCacheRead / denominator : 0;

  // Daily trend
  const daily = all(
    `SELECT date(started_at)  AS day,
            SUM(tokens_in)    AS input_tokens,
            SUM(cache_read)   AS cache_read_tokens,
            SUM(cache_creation) AS cache_creation_tokens
     FROM sessions
     WHERE started_at >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY day
     ORDER BY day ASC`,
    params as import('sql.js').SqlValue[]
  );

  return c.json({
    summary: {
      total_input: totalInput,
      total_output: (totals.total_output as number) ?? 0,
      total_cache_read: totalCacheRead,
      total_cache_creation: totalCacheCreation,
      hit_ratio: Math.round(hitRatio * 10000) / 100, // percentage, 2 decimal places
    },
    daily,
  });
});
