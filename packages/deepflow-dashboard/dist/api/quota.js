import { Hono } from 'hono';
import { all } from '../db/index.js';
export const quotaRouter = new Hono();
// GET /api/quota
// Query params: user
// Returns: latest quota snapshot per user+window_type, with utilization %
quotaRouter.get('/', (c) => {
    const user = c.req.query('user');
    const userFilter = user ? 'WHERE qs.user = ?' : '';
    const params = user ? [user] : [];
    // Latest snapshot per user+window_type using a subquery on max captured_at
    const rows = all(`SELECT qs.user, qs.window_type, qs.used, qs.limit_val, qs.reset_at, qs.captured_at
     FROM quota_snapshots qs
     INNER JOIN (
       SELECT user, window_type, MAX(captured_at) AS latest
       FROM quota_snapshots
       GROUP BY user, window_type
     ) latest_qs ON qs.user = latest_qs.user
                AND qs.window_type = latest_qs.window_type
                AND qs.captured_at = latest_qs.latest
     ${userFilter}
     ORDER BY qs.user, qs.window_type`, params);
    const data = rows.map((r) => ({
        ...r,
        utilization_pct: r.limit_val
            ? Math.round((r.used / r.limit_val) * 1000) / 10
            : r.used > 0 ? r.used : null,
    }));
    return c.json({ data });
});
//# sourceMappingURL=quota.js.map