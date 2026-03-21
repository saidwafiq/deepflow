import { Hono } from 'hono';
import { all } from '../db/index.js';
export const costsRouter = new Hono();
// GET /api/costs
// Query params: user, days (default 90)
// Returns: per-model totals, daily time series per model, per-project breakdown
costsRouter.get('/', async (c) => {
    const user = c.req.query('user');
    const days = parseInt(c.req.query('days') ?? '90', 10) || 90;
    const userFilter = user ? 'AND s.user = ?' : '';
    const userParam = user ? [user] : [];
    // Per-model totals — aggregate directly from sessions table which has pre-computed cost
    const modelCosts = all(`SELECT model,
            SUM(tokens_in)        AS input_tokens,
            SUM(tokens_out)       AS output_tokens,
            SUM(cache_read)       AS cache_read_tokens,
            SUM(cache_creation)   AS cache_creation_tokens,
            SUM(cost)             AS cost
     FROM sessions
     WHERE started_at >= datetime('now', ? || ' days')
     ${user ? 'AND user = ?' : ''}
     GROUP BY model
     ORDER BY cost DESC`, [`-${days}`, ...userParam]);
    // Daily time series — cost already stored on sessions
    const dailySeries = all(`SELECT date(s.started_at) AS day,
            s.model,
            SUM(s.cost) AS cost
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY day, s.model
     ORDER BY day ASC`, [`-${days}`, ...userParam]);
    // Per-project breakdown
    const projectBreakdown = all(`SELECT COALESCE(s.project, '(no project)') AS project,
            SUM(s.cost)        AS cost,
            SUM(s.tokens_in)   AS tokens_in,
            SUM(s.tokens_out)  AS tokens_out,
            COUNT(*)           AS sessions
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY project
     ORDER BY cost DESC`, [`-${days}`, ...userParam]);
    return c.json({ models: modelCosts, daily: dailySeries, projects: projectBreakdown });
});
//# sourceMappingURL=costs.js.map