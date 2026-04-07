import { Hono } from 'hono';
import { all } from '../db/index.js';

export const sessionsRouter = new Hono();

// GET /api/sessions
// Query params: user, project, limit (default 50), offset (default 0), sort (started_at|cost|duration_ms|messages, default started_at), order (asc|desc, default desc), fields (comma-separated column names to SELECT; omit for full rows)
sessionsRouter.get('/', (c) => {
  const user = c.req.query('user');
  const project = c.req.query('project');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const allowedSort = ['started_at', 'cost', 'duration_ms', 'messages', 'tool_calls', 'tokens_in', 'tokens_out'];
  const sortRaw = c.req.query('sort') ?? 'started_at';
  const sort = allowedSort.includes(sortRaw) ? sortRaw : 'started_at';
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  // Allowed column names for the ?fields= whitelist
  const allowedFields = ['started_at', 'cost', 'duration_ms', 'messages', 'tool_calls', 'tokens_in', 'tokens_out', 'user', 'project', 'session_id', 'model', 'agent_role', 'cache_hit_ratio'];
  const fieldsRaw = c.req.query('fields');
  const selectClause = fieldsRaw
    ? fieldsRaw
        .split(',')
        .map((f) => f.trim())
        .filter((f) => allowedFields.includes(f))
        .join(', ') || '*'
    : '*';

  const conditions: string[] = [];
  const params: unknown[] = [];

  const agentRole = c.req.query('agent_role');

  const includeSubagents = c.req.query('include_subagents') === 'true';
  if (!includeSubagents) conditions.push('parent_session_id IS NULL');

  if (user) { conditions.push('user = ?'); params.push(user); }
  if (project) { conditions.push('project = ?'); params.push(project); }
  if (agentRole) { conditions.push('agent_role = ?'); params.push(agentRole); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const subagentCountExpr = `(SELECT COUNT(*) FROM sessions sub WHERE sub.parent_session_id = s.id) AS subagent_count`;
  const totalCostExpr = `s.cost + COALESCE((SELECT SUM(sub.cost) FROM sessions sub WHERE sub.parent_session_id = s.id), 0) AS total_cost`;
  const finalSelect = selectClause === '*' ? `s.*, ${subagentCountExpr}, ${totalCostExpr}` : selectClause;

  const rows = all(
    `SELECT ${finalSelect} FROM sessions s ${where} ORDER BY s.${sort} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset] as import('sql.js').SqlValue[]
  );

  const totalRow = all(
    `SELECT COUNT(*) as total FROM sessions s ${where}`,
    params as import('sql.js').SqlValue[]
  );
  const total = (totalRow[0]?.total as number) ?? 0;

  return c.json({ data: rows, total, limit, offset });
});

// GET /api/sessions/:id/subagents — returns all subagent sessions for a parent
sessionsRouter.get('/:id/subagents', (c) => {
  const id = c.req.param('id');
  const rows = all(
    `SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC`,
    [id] as import('sql.js').SqlValue[]
  );
  return c.json({ data: rows });
});
