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
  const allowedFields = ['started_at', 'cost', 'duration_ms', 'messages', 'tool_calls', 'tokens_in', 'tokens_out', 'user', 'project', 'session_id', 'model'];
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

  if (user) { conditions.push('user = ?'); params.push(user); }
  if (project) { conditions.push('project = ?'); params.push(project); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = all(
    `SELECT ${selectClause} FROM sessions ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset] as import('sql.js').SqlValue[]
  );

  const totalRow = all(
    `SELECT COUNT(*) as total FROM sessions ${where}`,
    params as import('sql.js').SqlValue[]
  );
  const total = (totalRow[0]?.total as number) ?? 0;

  return c.json({ data: rows, total, limit, offset });
});
