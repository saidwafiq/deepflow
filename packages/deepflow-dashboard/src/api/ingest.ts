import { Hono } from 'hono';
import { run, get } from '../db/index.js';

export interface IngestPayload {
  user: string;
  project: string;
  tokens: Record<string, { input?: number; output?: number; cache_read?: number; cache_creation?: number }>;
  // Optional per-session fields
  session_id?: string;
  model?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  messages?: number;
  tool_calls?: number;
  cost?: number;
}

/** Validate a single ingest payload; returns array of error strings or empty array. */
function validatePayload(body: unknown): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    errors.push('body must be a JSON object');
    return errors;
  }
  const b = body as Record<string, unknown>;

  if (!b.user || typeof b.user !== 'string') errors.push('user is required (string)');
  if (!b.project || typeof b.project !== 'string') errors.push('project is required (string)');
  if (!b.tokens || typeof b.tokens !== 'object' || Array.isArray(b.tokens)) {
    errors.push('tokens is required (object with model keys)');
  }

  return errors;
}

/** Upsert a session row and insert token_events from a single payload. Returns count inserted. */
function insertPayload(payload: IngestPayload): number {
  const {
    user,
    project,
    tokens,
    session_id,
    model,
    started_at,
    ended_at,
    duration_ms,
    messages = 0,
    tool_calls = 0,
    cost = 0,
  } = payload;

  // Derive aggregate token totals from the tokens map
  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheCreation = 0;
  const ts = new Date().toISOString();

  for (const [, usage] of Object.entries(tokens)) {
    totalIn += usage.input ?? 0;
    totalOut += usage.output ?? 0;
    totalCacheRead += usage.cache_read ?? 0;
    totalCacheCreation += usage.cache_creation ?? 0;
  }

  // Derive a stable session id if not provided
  const sid = session_id ?? `${user}:${project}:${started_at ?? ts}`;
  const primaryModel = model ?? Object.keys(tokens)[0] ?? 'unknown';

  // Upsert session
  const existing = get('SELECT id FROM sessions WHERE id = ?', [sid]);
  if (existing) {
    run(
      `UPDATE sessions SET
         tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
         cache_read = cache_read + ?, cache_creation = cache_creation + ?,
         messages = messages + ?, tool_calls = tool_calls + ?,
         cost = cost + ?,
         ended_at = COALESCE(?, ended_at),
         duration_ms = COALESCE(?, duration_ms)
       WHERE id = ?`,
      [totalIn, totalOut, totalCacheRead, totalCacheCreation,
       messages, tool_calls, cost,
       ended_at ?? null, duration_ms ?? null, sid]
    );
  } else {
    run(
      `INSERT INTO sessions
         (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation,
          messages, tool_calls, cost, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sid, user, project, primaryModel,
       totalIn, totalOut, totalCacheRead, totalCacheCreation,
       messages, tool_calls, cost,
       started_at ?? ts, ended_at ?? null, duration_ms ?? null]
    );
  }

  // Insert one token_event per model in tokens map
  let inserted = 0;
  for (const [mdl, usage] of Object.entries(tokens)) {
    run(
      `INSERT INTO token_events
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sid, mdl,
       usage.input ?? 0, usage.output ?? 0,
       usage.cache_read ?? 0, usage.cache_creation ?? 0,
       started_at ?? ts]
    );
    inserted++;
  }

  return inserted;
}

/** POST /api/ingest — team mode only. Accepts single payload or array of payloads. */
export function createIngestRouter(): Hono {
  const router = new Hono();

  router.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    // Support both single object and array batch
    const payloads: unknown[] = Array.isArray(body) ? body : [body];
    const allErrors: string[] = [];

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
        totalInserted += insertPayload(p as IngestPayload);
      } catch (err) {
        console.warn('[ingest] Insert error:', err);
      }
    }

    return c.json({ status: 'ok', inserted: totalInserted, count: payloads.length });
  });

  return router;
}
