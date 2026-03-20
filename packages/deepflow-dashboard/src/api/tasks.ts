import { Hono } from 'hono';
import { all } from '../db/index.js';

export const tasksRouter = new Hono();

// GET /api/tasks
// Returns spec-grouped aggregates: per-spec summary with nested tasks.
// Each spec has: spec, total_cost, task_count, latest_status.
// Each task has: task_id, attempt_count, latest_status, total_cost, total_tokens, last_run_at.
tasksRouter.get('/', (c) => {
  const specFilter = c.req.query('spec');
  const statusFilter = c.req.query('status');

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (specFilter) { conditions.push('spec = ?'); params.push(specFilter); }
  if (statusFilter) {
    // Filter tasks where latest status matches
    conditions.push(`task_id IN (
      SELECT task_id FROM task_attempts ta2
      WHERE (ta2.spec = task_attempts.spec OR (ta2.spec IS NULL AND task_attempts.spec IS NULL))
        AND ta2.task_id = task_attempts.task_id
      ORDER BY ta2.ended_at DESC LIMIT 1
    )`);
    // Use a simpler approach: filter by latest_status in outer query
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Aggregate per task_id within each spec
  const taskRows = all(
    `SELECT
       spec,
       task_id,
       COUNT(*)                   AS attempt_count,
       SUM(cost)                  AS total_cost,
       SUM(tokens_in) + SUM(tokens_out) + SUM(cache_read) AS total_tokens,
       MAX(ended_at)              AS last_run_at,
       (SELECT status FROM task_attempts ta2
        WHERE ta2.task_id = task_attempts.task_id
          AND (ta2.spec = task_attempts.spec OR (ta2.spec IS NULL AND task_attempts.spec IS NULL))
        ORDER BY ta2.ended_at DESC LIMIT 1) AS latest_status
     FROM task_attempts
     ${where}
     GROUP BY spec, task_id
     ORDER BY spec ASC, last_run_at DESC`,
    params as import('sql.js').SqlValue[]
  );

  // Apply optional status filter on latest_status
  const filteredTasks = statusFilter
    ? taskRows.filter((r) => r.latest_status === statusFilter)
    : taskRows;

  // Group tasks by spec
  const specMap = new Map<string, {
    spec: string | null;
    total_cost: number;
    task_count: number;
    latest_status: string | null;
    last_run_at: string | null;
    tasks: typeof filteredTasks;
  }>();

  for (const row of filteredTasks) {
    const key = (row.spec as string | null) ?? '__null__';
    if (!specMap.has(key)) {
      specMap.set(key, {
        spec: row.spec as string | null,
        total_cost: 0,
        task_count: 0,
        latest_status: null,
        last_run_at: null,
        tasks: [],
      });
    }
    const entry = specMap.get(key)!;
    entry.total_cost += (row.total_cost as number) ?? 0;
    entry.task_count += 1;
    entry.tasks.push(row);
    // Track latest_status as the status of the most recently run task in the spec
    if (!entry.last_run_at || (row.last_run_at as string) > entry.last_run_at) {
      entry.last_run_at = row.last_run_at as string;
      entry.latest_status = row.latest_status as string | null;
    }
  }

  const data = Array.from(specMap.values());

  return c.json({ data, total: data.length });
});

// GET /api/tasks/:task_id/attempts
// Returns attempt-level rows ordered by ended_at DESC.
tasksRouter.get('/:task_id/attempts', (c) => {
  const taskId = c.req.param('task_id');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;

  const rows = all(
    `SELECT id, task_id, spec, session_id, status,
            tokens_in, tokens_out, cache_read, cost,
            started_at, ended_at
     FROM task_attempts
     WHERE task_id = ?
     ORDER BY ended_at DESC
     LIMIT ? OFFSET ?`,
    [taskId, limit, offset] as import('sql.js').SqlValue[]
  );

  const totalRow = all(
    `SELECT COUNT(*) AS total FROM task_attempts WHERE task_id = ?`,
    [taskId] as import('sql.js').SqlValue[]
  );
  const total = (totalRow[0]?.total as number) ?? 0;

  return c.json({ data: rows, total, limit, offset });
});
