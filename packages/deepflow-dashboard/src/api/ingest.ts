import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run, get, getDb } from '../db/index.js';

/**
 * Resolve the ingest shared secret. Priority:
 *  1. DEEPFLOW_INGEST_SECRET env var
 *  2. ingest_secret field in .deepflow/config.yaml
 * Returns undefined when not configured (auth disabled).
 */
function resolveIngestSecret(): string | undefined {
  if (process.env.DEEPFLOW_INGEST_SECRET) {
    return process.env.DEEPFLOW_INGEST_SECRET;
  }
  const configPath = resolve(process.cwd(), '.deepflow', 'config.yaml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const match = raw.match(/^ingest_secret:\s*["']?([^\s"'\n]+)["']?/m);
      if (match?.[1]) return match[1];
    } catch {
      // Ignore — no secret
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// In-memory rate limiter: 100 requests per 60-second window, keyed by IP
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

/** Returns remaining TTL in seconds if the IP is over the limit, or 0 if allowed. */
function checkRateLimit(ip: string): number {
  const now = Date.now();

  // Purge all expired entries on each request to avoid unbounded growth
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  }

  let entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
    return 0;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }
  return 0;
}

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
  } else {
    // Validate no negative token values within each model entry
    const tokens = b.tokens as Record<string, Record<string, unknown>>;
    for (const [mdl, usage] of Object.entries(tokens)) {
      if (typeof usage !== 'object' || usage === null) continue;
      const fields: Array<[string, string]> = [
        ['input', 'tokens_in'],
        ['output', 'tokens_out'],
        ['cache_read', 'cache_read'],
        ['cache_creation', 'cache_creation'],
      ];
      for (const [field, label] of fields) {
        const val = (usage as Record<string, unknown>)[field];
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

/** Upsert a session row and insert token_events from a single payload. Returns count inserted.
 *  Idempotent: posting the same session_id payload multiple times produces identical totals.
 *  - Sessions are upserted with absolute (SET =) values, not accumulated deltas.
 *  - token_events uses INSERT OR IGNORE on the UNIQUE(session_id, model, source) constraint.
 *  - Everything runs inside a single transaction for atomicity.
 */
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
    totalIn += Math.max(0, usage.input ?? 0);
    totalOut += Math.max(0, usage.output ?? 0);
    totalCacheRead += Math.max(0, usage.cache_read ?? 0);
    totalCacheCreation += Math.max(0, usage.cache_creation ?? 0);
  }

  const clampedCost = Math.max(0, cost);

  // Derive a stable session id if not provided
  const sid = session_id ?? `${user}:${project}:${started_at ?? ts}`;
  const primaryModel = model ?? Object.keys(tokens)[0] ?? 'unknown';

  let inserted = 0;

  // Wrap everything in a transaction for atomicity
  getDb().run('BEGIN');
  try {
    // Idempotent upsert: INSERT or UPDATE with absolute (non-accumulating) values
    const existing = get('SELECT id FROM sessions WHERE id = ?', [sid]);
    if (existing) {
      // SET absolute values — re-posting the same payload yields the same row
      run(
        `UPDATE sessions SET
           tokens_in = ?, tokens_out = ?,
           cache_read = ?, cache_creation = ?,
           messages = ?, tool_calls = ?,
           cost = ?,
           ended_at = COALESCE(?, ended_at),
           duration_ms = COALESCE(?, duration_ms)
         WHERE id = ?`,
        [totalIn, totalOut, totalCacheRead, totalCacheCreation,
         messages, tool_calls, clampedCost,
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
         messages, tool_calls, clampedCost,
         started_at ?? ts, ended_at ?? null, duration_ms ?? null]
      );
    }

    // INSERT OR IGNORE: duplicate (session_id, model, source) rows are silently skipped
    for (const [mdl, usage] of Object.entries(tokens)) {
      run(
        `INSERT OR IGNORE INTO token_events
           (session_id, model, source, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
         VALUES (?, ?, 'ingest', ?, ?, ?, ?, ?)`,
        [sid, mdl,
         Math.max(0, usage.input ?? 0), Math.max(0, usage.output ?? 0),
         Math.max(0, usage.cache_read ?? 0), Math.max(0, usage.cache_creation ?? 0),
         started_at ?? ts]
      );
      inserted++;
    }

    getDb().run('COMMIT');
  } catch (err) {
    getDb().run('ROLLBACK');
    throw err;
  }

  return inserted;
}

/** POST /api/ingest — team mode only. Accepts single payload or array of payloads. */
export function createIngestRouter(): Hono {
  const router = new Hono();

  const secret = resolveIngestSecret();

  router.post('/', async (c) => {
    // Rate limiting — 100 req/min per IP, checked before auth
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ??
      c.req.header('x-real-ip') ??
      'unknown';
    const retryAfter = checkRateLimit(ip);
    if (retryAfter > 0) {
      return c.json(
        { error: 'Too Many Requests', retryAfter },
        429,
        { 'Retry-After': String(retryAfter) }
      );
    }

    // Bearer token auth — enforced when a secret is configured
    if (secret) {
      const authHeader = c.req.header('Authorization') ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== secret) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

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
