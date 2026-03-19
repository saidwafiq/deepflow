import { Hono } from 'hono';
import { all } from '../db/index.js';
import { fetchPricing, resolveModelPricing } from '../pricing.js';

export const costsRouter = new Hono();

// GET /api/costs
// Query params: user, days (default 90)
// Returns: per-model totals, daily time series per model, per-project breakdown
costsRouter.get('/', async (c) => {
  const user = c.req.query('user');
  const days = parseInt(c.req.query('days') ?? '90', 10) || 90;

  const userFilter = user ? 'AND s.user = ?' : '';
  const userParam = user ? [user] : [];

  // Per-model totals — sum cost from sessions joined with token_events for model breakdown
  // token_events holds per-model data; sessions.model is the primary model used
  const modelTotals = all(
    `SELECT te.model,
            SUM(te.input_tokens)          AS input_tokens,
            SUM(te.output_tokens)         AS output_tokens,
            SUM(te.cache_read_tokens)     AS cache_read_tokens,
            SUM(te.cache_creation_tokens) AS cache_creation_tokens
     FROM token_events te
     JOIN sessions s ON te.session_id = s.id
     WHERE te.timestamp >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY te.model
     ORDER BY input_tokens DESC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  // Compute costs per model using pricing data
  const pricing = await fetchPricing();
  const M = 1_000_000;
  const modelCosts = modelTotals.map((r) => {
    const model = r.model as string;
    const p = resolveModelPricing(pricing, model);
    const inp = (r.input_tokens as number) ?? 0;
    const out = (r.output_tokens as number) ?? 0;
    const cacheRead = (r.cache_read_tokens as number) ?? 0;
    const cacheCreate = (r.cache_creation_tokens as number) ?? 0;
    const cost = p
      ? (inp * p.input + out * p.output + cacheRead * p.cache_read + cacheCreate * p.cache_creation) / M
      : 0;
    return { model, input_tokens: inp, output_tokens: out, cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreate, cost };
  });

  // Daily time series — cost already stored on sessions
  const dailySeries = all(
    `SELECT date(s.started_at) AS day,
            s.model,
            SUM(s.cost) AS cost
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY day, s.model
     ORDER BY day ASC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  // Per-project breakdown
  const projectBreakdown = all(
    `SELECT COALESCE(s.project, '(no project)') AS project,
            SUM(s.cost)        AS cost,
            SUM(s.tokens_in)   AS tokens_in,
            SUM(s.tokens_out)  AS tokens_out,
            COUNT(*)           AS sessions
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${userFilter}
     GROUP BY project
     ORDER BY cost DESC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  return c.json({ models: modelCosts, daily: dailySeries, projects: projectBreakdown });
});
