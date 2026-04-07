import { Hono } from 'hono';
import { all } from '../db/index.js';

export const costsRouter = new Hono();

/** Filter out junk model names injected by synthetic parsers */
const JUNK_MODELS = "AND s.model NOT IN ('<synthetic>', 'unknown')";

// GET /api/costs
// Query params: user, days (default 90)
// Returns: per-model totals, daily time series per model, per-project breakdown
costsRouter.get('/', async (c) => {
  const user = c.req.query('user');
  const days = parseInt(c.req.query('days') ?? '90', 10) || 90;

  const userFilter = user ? 'AND s.user = ?' : '';
  const userParam = user ? [user] : [];

  // Per-model totals
  const modelCosts = all(
    `SELECT s.model,
            SUM(s.tokens_in)        AS input_tokens,
            SUM(s.tokens_out)       AS output_tokens,
            SUM(s.cache_read)       AS cache_read_tokens,
            SUM(s.cache_creation)   AS cache_creation_tokens,
            SUM(s.cost)             AS cost
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${JUNK_MODELS}
     ${userFilter}
     GROUP BY s.model
     ORDER BY cost DESC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  // Daily time series
  const dailySeries = all(
    `SELECT date(s.started_at) AS day,
            s.model,
            SUM(s.cost) AS cost
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${JUNK_MODELS}
     ${userFilter}
     GROUP BY day, s.model
     ORDER BY day ASC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  // Per-project breakdown (raw — normalized and re-aggregated below)
  const projectRaw = all(
    `SELECT COALESCE(s.project, '(no project)') AS project,
            SUM(s.cost)                         AS cost,
            SUM(s.tokens_in)                    AS tokens_in,
            SUM(s.tokens_out)                   AS tokens_out,
            SUM(s.cache_read)                   AS cache_read_tokens,
            SUM(s.cache_creation)               AS cache_creation_tokens,
            COUNT(*)                            AS sessions
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${JUNK_MODELS}
     ${userFilter}
     GROUP BY project
     ORDER BY cost DESC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  /** Strip worktree suffixes " (branch)" and monorepo "-packages-*" */
  function normalizeProject(name: string): string {
    return name
      .replace(/\s+\(.*\)$/, '')   // "proj (worktree)" → "proj"
      .replace(/-packages-.+$/, '') // "proj-packages-sub" → "proj"
      .trim() || '(no project)';
  }

  type ProjectRow = { project: string; cost: number; tokens_in: number; tokens_out: number; cache_read_tokens: number; cache_creation_tokens: number; sessions: number };
  const projectMap = new Map<string, ProjectRow>();
  for (const row of projectRaw as ProjectRow[]) {
    const key = normalizeProject(row.project);
    const existing = projectMap.get(key);
    if (existing) {
      existing.cost += row.cost;
      existing.tokens_in += row.tokens_in;
      existing.tokens_out += row.tokens_out;
      existing.cache_read_tokens += row.cache_read_tokens;
      existing.cache_creation_tokens += row.cache_creation_tokens;
      existing.sessions += row.sessions;
    } else {
      projectMap.set(key, { ...row, project: key });
    }
  }
  const projectBreakdown = [...projectMap.values()].sort((a, b) => b.cost - a.cost);

  // Per-agent-role breakdown
  const byAgentRole = all(
    `SELECT s.agent_role,
            SUM(s.cost)             AS cost,
            SUM(s.tokens_in)        AS input_tokens,
            SUM(s.tokens_out)       AS output_tokens,
            SUM(s.cache_read)       AS cache_read_tokens,
            SUM(s.cache_creation)   AS cache_creation_tokens
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${JUNK_MODELS}
     ${userFilter}
     GROUP BY s.agent_role
     ORDER BY cost DESC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  // Per-agent-role-model breakdown
  const byAgentRoleModel = all(
    `SELECT s.agent_role,
            s.model,
            SUM(s.cost)             AS cost,
            SUM(s.tokens_in)        AS input_tokens,
            SUM(s.tokens_out)       AS output_tokens,
            SUM(s.cache_read)       AS cache_read_tokens,
            SUM(s.cache_creation)   AS cache_creation_tokens
     FROM sessions s
     WHERE s.started_at >= datetime('now', ? || ' days')
     ${JUNK_MODELS}
     ${userFilter}
     GROUP BY s.agent_role, s.model
     ORDER BY cost DESC`,
    [`-${days}`, ...userParam] as import('sql.js').SqlValue[]
  );

  return c.json({ models: modelCosts, daily: dailySeries, projects: projectBreakdown, by_agent_role: byAgentRole, by_agent_role_model: byAgentRoleModel });
});
