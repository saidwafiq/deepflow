import { Hono } from 'hono';
import { run, get } from '../db/index.js';
/** Validate a single ingest payload; returns array of error strings or empty array. */
function validatePayload(body) {
    const errors = [];
    if (!body || typeof body !== 'object') {
        errors.push('body must be a JSON object');
        return errors;
    }
    const b = body;
    if (!b.user || typeof b.user !== 'string')
        errors.push('user is required (string)');
    if (!b.project || typeof b.project !== 'string')
        errors.push('project is required (string)');
    if (!b.tokens || typeof b.tokens !== 'object' || Array.isArray(b.tokens)) {
        errors.push('tokens is required (object with model keys)');
    }
    else {
        // Validate no negative token values within each model entry
        const tokens = b.tokens;
        for (const [mdl, usage] of Object.entries(tokens)) {
            if (typeof usage !== 'object' || usage === null)
                continue;
            const fields = [
                ['input', 'tokens_in'],
                ['output', 'tokens_out'],
                ['cache_read', 'cache_read'],
                ['cache_creation', 'cache_creation'],
            ];
            for (const [field, label] of fields) {
                const val = usage[field];
                if (typeof val === 'number' && val < 0) {
                    errors.push(`tokens.${mdl}.${field} (${label}) must be >= 0, got ${val}`);
                }
            }
        }
    }
    // Validate top-level cost field
    if (b.cost !== undefined && typeof b.cost === 'number' && b.cost < 0) {
        errors.push(`cost must be >= 0, got ${b.cost}`);
    }
    return errors;
}
/** Upsert a session row and insert token_events from a single payload. Returns count inserted. */
function insertPayload(payload) {
    const { user, project, tokens, session_id, model, started_at, ended_at, duration_ms, messages = 0, tool_calls = 0, cost = 0, } = payload;
    // Derive aggregate token totals from the tokens map
    let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheCreation = 0;
    const ts = new Date().toISOString();
    for (const [, usage] of Object.entries(tokens)) {
        totalIn += Math.max(0, usage.input ?? 0);
        totalOut += Math.max(0, usage.output ?? 0);
        totalCacheRead += Math.max(0, usage.cache_read ?? 0);
        totalCacheCreation += Math.max(0, usage.cache_creation ?? 0);
    }
    const clampedCost = Math.max(0, cost);
    // Derive a stable session id if not provided
    const sid = session_id ?? `${user}:${project}:${started_at ?? ts}`;
    const primaryModel = model ?? Object.keys(tokens)[0] ?? 'unknown';
    // Upsert session
    const existing = get('SELECT id FROM sessions WHERE id = ?', [sid]);
    if (existing) {
        run(`UPDATE sessions SET
         tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
         cache_read = cache_read + ?, cache_creation = cache_creation + ?,
         messages = messages + ?, tool_calls = tool_calls + ?,
         cost = cost + ?,
         ended_at = COALESCE(?, ended_at),
         duration_ms = COALESCE(?, duration_ms)
       WHERE id = ?`, [totalIn, totalOut, totalCacheRead, totalCacheCreation,
            messages, tool_calls, clampedCost,
            ended_at ?? null, duration_ms ?? null, sid]);
    }
    else {
        run(`INSERT INTO sessions
         (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation,
          messages, tool_calls, cost, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [sid, user, project, primaryModel,
            totalIn, totalOut, totalCacheRead, totalCacheCreation,
            messages, tool_calls, clampedCost,
            started_at ?? ts, ended_at ?? null, duration_ms ?? null]);
    }
    // Insert one token_event per model in tokens map
    let inserted = 0;
    for (const [mdl, usage] of Object.entries(tokens)) {
        run(`INSERT INTO token_events
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [sid, mdl,
            Math.max(0, usage.input ?? 0), Math.max(0, usage.output ?? 0),
            Math.max(0, usage.cache_read ?? 0), Math.max(0, usage.cache_creation ?? 0),
            started_at ?? ts]);
        inserted++;
    }
    return inserted;
}
/** POST /api/ingest — team mode only. Accepts single payload or array of payloads. */
export function createIngestRouter() {
    const router = new Hono();
    router.post('/', async (c) => {
        let body;
        try {
            body = await c.req.json();
        }
        catch {
            return c.json({ error: 'invalid JSON' }, 400);
        }
        // Support both single object and array batch
        const payloads = Array.isArray(body) ? body : [body];
        const allErrors = [];
        for (let i = 0; i < payloads.length; i++) {
            const errs = validatePayload(payloads[i]);
            if (errs.length > 0) {
                allErrors.push(...errs.map((e) => `[${i}] ${e}`));
            }
        }
        if (allErrors.length > 0) {
            return c.json({ error: 'validation failed', details: allErrors }, 400);
        }
        let totalInserted = 0;
        for (const p of payloads) {
            try {
                totalInserted += insertPayload(p);
            }
            catch (err) {
                console.warn('[ingest] Insert error:', err);
            }
        }
        return c.json({ status: 'ok', inserted: totalInserted, count: payloads.length });
    });
    return router;
}
//# sourceMappingURL=ingest.js.map