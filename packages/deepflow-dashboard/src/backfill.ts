/**
 * Backfill: reads local ~/.claude/ data and POSTs it to a team server.
 * Uses the same parsers as local ingestion, but transforms rows to
 * the /api/ingest payload format instead of writing to a local DB.
 *
 * Offset tracking: persists last-sent offset per source to
 * .deepflow/backfill-state.json so re-runs skip already-sent records.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import https from 'node:https';
import http from 'node:http';
import type { IngestPayload } from './api/ingest.js';

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Offset state
// ---------------------------------------------------------------------------

export interface BackfillState {
  sessions_offset: number;
  token_history_offset: number;
}

function loadState(stateFile: string): BackfillState {
  if (existsSync(stateFile)) {
    try {
      const raw = readFileSync(stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BackfillState>;
      return {
        sessions_offset: parsed.sessions_offset ?? 0,
        token_history_offset: parsed.token_history_offset ?? 0,
      };
    } catch {
      // Corrupted state — start from zero; will re-send but won't lose data
    }
  }
  return { sessions_offset: 0, token_history_offset: 0 };
}

function saveState(stateFile: string, state: BackfillState): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** POST a batch of payloads to the remote server. Returns true on success. */
async function postBatch(url: string, payloads: IngestPayload[], secret?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payloads);
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    }

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers,
      timeout: 30000,
    };

    const req = lib.request(options, (res) => {
      // Consume response body to free socket
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });

    req.on('error', (err) => {
      console.warn('[backfill] Request error:', err.message);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Send payloads in BATCH_SIZE chunks starting from `startOffset`.
 * Persists the offset after each successful batch.
 * Stops on first failure to preserve the last-good offset.
 * Returns the number of newly sent records.
 */
async function sendInBatchesWithOffset(
  url: string,
  payloads: IngestPayload[],
  startOffset: number,
  stateFile: string,
  state: BackfillState,
  offsetKey: keyof BackfillState,
  secret?: string,
): Promise<number> {
  const pending = payloads.slice(startOffset);
  if (pending.length === 0) return 0;

  let sent = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const ok = await postBatch(url, batch, secret);
    if (ok) {
      sent += batch.length;
      // Persist the new offset immediately after each successful batch
      (state[offsetKey] as number) = startOffset + sent;
      saveState(stateFile, state);
      process.stdout.write(`\r[backfill] Sent ${sent}/${pending.length} (${offsetKey})`);
    } else {
      // Stop on failure; last-good offset is already persisted
      console.warn(`\n[backfill] Batch failed at offset ${startOffset + sent}, stopping. Last-good offset preserved.`);
      break;
    }
  }
  if (pending.length > 0) process.stdout.write('\n');
  return sent;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/** Build IngestPayload objects from session JSONL files in ~/.claude/projects/ */
function collectSessionPayloads(claudeDir: string): IngestPayload[] {
  const payloads: IngestPayload[] = [];
  const projectsDir = resolve(claudeDir, 'projects');
  if (!existsSync(projectsDir)) return payloads;

  const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(projectsDir, d.name));

  for (const projectDir of projectDirs) {
    const sessionsDir = join(projectDir, 'sessions');
    if (!existsSync(sessionsDir)) continue;

    const sessionFiles = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(sessionsDir, f));

    for (const filePath of sessionFiles) {
      let lines: string[];
      try {
        lines = readFileSync(filePath, 'utf-8').split('\n');
      } catch {
        continue;
      }

      let sessionId: string | null = null;
      let user = 'unknown', project: string | null = null;
      let model = 'unknown';
      let startedAt: string | null = null, endedAt: string | null = null;
      let messages = 0, toolCalls = 0, cost = 0, durationMs: number | null = null;
      const tokensByModel: Record<string, { input: number; output: number; cache_read: number; cache_creation: number }> = {};

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (!sessionId) sessionId = (event.session_id ?? event.sessionId ?? event.id) as string | null;
        if (!startedAt) startedAt = (event.timestamp ?? event.ts ?? event.started_at ?? null) as string | null;
        endedAt = (event.timestamp ?? event.ts ?? null) as string | null;

        if (event.model && event.model !== 'unknown') model = event.model as string;
        if (event.user) user = event.user as string;
        if (event.project) project = event.project as string;
        if (event.duration_ms) durationMs = event.duration_ms as number;

        const usage = event.usage as Record<string, number> | undefined;
        const evModel = (event.model as string) ?? model;
        if (!tokensByModel[evModel]) tokensByModel[evModel] = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
        tokensByModel[evModel].input += usage?.input_tokens ?? (event.input_tokens as number) ?? 0;
        tokensByModel[evModel].output += usage?.output_tokens ?? (event.output_tokens as number) ?? 0;
        tokensByModel[evModel].cache_read += usage?.cache_read_tokens ?? (event.cache_read_tokens as number) ?? 0;
        tokensByModel[evModel].cache_creation += usage?.cache_creation_tokens ?? (event.cache_creation_tokens as number) ?? 0;
        cost += (event.cost as number) ?? 0;

        if (event.type === 'message' || event.role) messages++;
        if (event.type === 'tool_use' || event.tool_name) toolCalls++;
      }

      if (!sessionId || Object.keys(tokensByModel).length === 0) continue;

      payloads.push({
        user,
        project: project ?? 'unknown',
        tokens: tokensByModel,
        session_id: sessionId,
        model,
        started_at: startedAt ?? new Date().toISOString(),
        ended_at: endedAt ?? undefined,
        duration_ms: durationMs ?? undefined,
        messages,
        tool_calls: toolCalls,
        cost,
      });
    }
  }

  return payloads;
}

/** Build IngestPayload objects from .deepflow/token-history.jsonl */
function collectTokenHistoryPayloads(deepflowDir: string, defaultUser: string): IngestPayload[] {
  const payloads: IngestPayload[] = [];
  const filePath = resolve(deepflowDir, 'token-history.jsonl');
  if (!existsSync(filePath)) return payloads;

  let lines: string[];
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n');
  } catch {
    return payloads;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const sessionId = (record.session_id ?? record.sessionId) as string | undefined;
    if (!sessionId) continue;

    const mdl = (record.model as string) ?? 'unknown';
    payloads.push({
      user: defaultUser,
      project: 'unknown',
      tokens: {
        [mdl]: {
          input: (record.input_tokens as number) ?? 0,
          output: 0,
          cache_read: (record.cache_read_tokens as number) ?? 0,
          cache_creation: (record.cache_creation_tokens as number) ?? 0,
        },
      },
      session_id: sessionId,
      model: mdl,
      started_at: (record.timestamp as string) ?? new Date().toISOString(),
    });
  }

  return payloads;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  url: string;
  claudeDir?: string;
  deepflowDir?: string;
  user?: string;
  /** Shared secret for bearer token auth. Falls back to DEEPFLOW_INGEST_SECRET env var. */
  secret?: string;
}

/** Main backfill entry point. */
export async function runBackfill(opts: BackfillOptions): Promise<void> {
  const claudeDir = opts.claudeDir ?? resolve(homedir(), '.claude');
  const deepflowDir = opts.deepflowDir ?? resolve(process.cwd(), '.deepflow');
  const user = opts.user ?? process.env.USER ?? 'unknown';
  const secret = opts.secret ?? process.env.DEEPFLOW_INGEST_SECRET;
  const ingestUrl = opts.url.replace(/\/$/, '') + '/api/ingest';
  const stateFile = resolve(deepflowDir, 'backfill-state.json');

  console.log(`[backfill] Source: ${claudeDir}`);
  console.log(`[backfill] Target: ${ingestUrl}`);
  console.log(`[backfill] State:  ${stateFile}`);

  // Load persisted offsets
  const state = loadState(stateFile);
  console.log(`[backfill] Offsets: sessions=${state.sessions_offset}, token_history=${state.token_history_offset}`);

  // Collect from both sources
  const sessionPayloads = collectSessionPayloads(claudeDir);
  const tokenPayloads = collectTokenHistoryPayloads(deepflowDir, user);

  // Deduplicate: session payloads take precedence
  const seenSessions = new Set(sessionPayloads.map((p) => p.session_id).filter(Boolean));
  const deduped = tokenPayloads.filter((p) => !seenSessions.has(p.session_id));

  const newSessions = sessionPayloads.length - state.sessions_offset;
  const newTokenHistory = deduped.length - state.token_history_offset;
  console.log(
    `[backfill] Collected ${sessionPayloads.length} sessions (${newSessions > 0 ? newSessions : 0} new), ` +
    `${deduped.length} token-history (${newTokenHistory > 0 ? newTokenHistory : 0} new)`,
  );

  // Send sessions source
  const sentSessions = await sendInBatchesWithOffset(
    ingestUrl,
    sessionPayloads,
    state.sessions_offset,
    stateFile,
    state,
    'sessions_offset',
    secret,
  );

  // Send token-history source
  const sentTokenHistory = await sendInBatchesWithOffset(
    ingestUrl,
    deduped,
    state.token_history_offset,
    stateFile,
    state,
    'token_history_offset',
    secret,
  );

  const totalSent = sentSessions + sentTokenHistory;
  if (totalSent === 0) {
    console.log('[backfill] Nothing new to send.');
  } else {
    console.log(`[backfill] Done. Sent ${totalSent} new records (${sentSessions} sessions + ${sentTokenHistory} token-history).`);
  }
}
