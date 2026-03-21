import { Hono } from 'hono';
import { all, get } from '../db/index.js';
export const toolsRouter = new Hono();
// GET /api/tools
// Query params: user, sort (tool_name|call_count|total_tokens|avg_tokens|pct, default total_tokens), order (asc|desc, default desc)
// Returns: per-tool stats with % of total tokens (REQ-22)
toolsRouter.get('/', (c) => {
    const user = c.req.query('user');
    const allowedSort = ['tool_name', 'call_count', 'total_tokens', 'avg_tokens', 'pct_of_total'];
    const sortRaw = c.req.query('sort') ?? 'total_tokens';
    const sort = allowedSort.includes(sortRaw) ? sortRaw : 'total_tokens';
    const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';
    const userFilter = user ? 'AND s.user = ?' : '';
    const params = user ? [user] : [];
    // Grand total tokens across all tools for % calculation
    const grandRow = get(`SELECT SUM(tu.total_tokens) AS grand_total
     FROM tool_usage tu
     JOIN sessions s ON tu.session_id = s.id
     WHERE 1=1 ${userFilter}`, params);
    const grandTotal = grandRow?.grand_total ?? 0;
    const rows = all(`SELECT tu.tool_name,
            SUM(tu.call_count)    AS call_count,
            SUM(tu.total_tokens)  AS total_tokens,
            CASE WHEN SUM(tu.call_count) > 0
                 THEN ROUND(CAST(SUM(tu.total_tokens) AS REAL) / SUM(tu.call_count), 2)
                 ELSE 0 END        AS avg_tokens
     FROM tool_usage tu
     JOIN sessions s ON tu.session_id = s.id
     WHERE 1=1 ${userFilter}
     GROUP BY tu.tool_name`, params);
    // Attach pct_of_total, then sort in JS (simpler than embedding division in SQLite ORDER BY)
    const data = rows.map((r) => ({
        ...r,
        pct_of_total: grandTotal > 0
            ? Math.round((r.total_tokens / grandTotal) * 10000) / 100
            : 0,
    }));
    // Sort
    data.sort((a, b) => {
        const av = a[sort];
        const bv = b[sort];
        if (typeof av === 'string')
            return order === 'ASC' ? av.localeCompare(bv) : bv.localeCompare(av);
        return order === 'ASC' ? av - bv : bv - av;
    });
    return c.json({ data, grand_total_tokens: grandTotal });
});
//# sourceMappingURL=tools.js.map