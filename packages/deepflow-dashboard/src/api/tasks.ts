import { Hono } from 'hono';
import { all } from '../db/index.js';

export const tasksRouter = new Hono();

// GET /api/tasks
// Query params: spec, status, limit (default 100), offset (default 0)
// Aggregates execution_count per task_id; shows latest status
tasksRouter.get('/', (c) => {
  const spec = c.req.query('spec');
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (spec) { conditions.push('spec = ?'); params.push(spec); }
  if (status) { conditions.push('status = ?'); params.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Aggregate per task_id: sum cost/tokens, count executions, take latest status
  const rows = all(
    `SELECT task_id,
            spec,
            SUM(cost)           AS total_cost,
            SUM(input_tokens)   AS total_input_tokens,
            SUM(output_tokens)  AS total_output_tokens,
            SUM(execution_count) AS execution_count,
            MAX(timestamp)      AS last_run_at,
            -- latest status: from the row with max timestamp
            (SELECT status FROM task_results t2
             WHERE t2.task_id = task_results.task_id
             ORDER BY t2.timestamp DESC LIMIT 1) AS status
     FROM task_results
     ${where}
     GROUP BY task_id
     ORDER BY last_run_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset] as import('sql.js').SqlValue[]
  );

  const totalRow = all(
    `SELECT COUNT(DISTINCT task_id) AS total FROM task_results ${where}`,
    params as import('sql.js').SqlValue[]
  );
  const total = (totalRow[0]?.total as number) ?? 0;

  return c.json({ data: rows, total, limit, offset });
});
