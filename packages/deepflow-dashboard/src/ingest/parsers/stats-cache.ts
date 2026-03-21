import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

interface StatsCacheSession {
  id?: string;
  sessionId?: string;
  user?: string;
  project?: string;
  model?: string;
  tokens_in?: number; inputTokens?: number;
  tokens_out?: number; outputTokens?: number;
  cache_read?: number; cacheReadTokens?: number;
  cache_creation?: number; cacheCreationTokens?: number;
  duration_ms?: number; durationMs?: number;
  messages?: number;
  tool_calls?: number; toolCalls?: number;
  cost?: number;
  started_at?: string; startedAt?: string;
  ended_at?: string; endedAt?: string;
}

/**
 * Parses ~/.claude/stats-cache.json → sessions table (summary data).
 * stats-cache.json is a JSON object or array of session summaries.
 * Tracked by file size in _meta; re-processed only when the file changes.
 */
export async function parseStatsCache(db: DbHelpers, claudeDir: string): Promise<void> {
  const filePath = resolve(claudeDir, 'stats-cache.json');
  if (!existsSync(filePath)) {
    console.warn('[ingest:stats-cache] File not found, skipping:', filePath);
    return;
  }

  const offsetKey = 'ingest_offset:stats-cache';
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn('[ingest:stats-cache] Cannot read file:', err);
    return;
  }

  const contentSize = String(content.length);
  const seenRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
  if (seenRow && seenRow.value === contentSize) return; // no change

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn('[ingest:stats-cache] Malformed JSON, skipping');
    return;
  }

  // Normalise to array of sessions
  const sessions: StatsCacheSession[] = Array.isArray(parsed)
    ? (parsed as StatsCacheSession[])
    : typeof parsed === 'object' && parsed !== null && 'sessions' in parsed
      ? ((parsed as { sessions: StatsCacheSession[] }).sessions ?? [])
      : [];

  let upserted = 0;

  for (const s of sessions) {
    const id = s.id ?? s.sessionId;
    if (!id) continue;

    const startedAt = s.started_at ?? s.startedAt ?? new Date().toISOString();

    const rawTokensIn = s.tokens_in ?? s.inputTokens ?? 0;
    const rawTokensOut = s.tokens_out ?? s.outputTokens ?? 0;
    const rawCacheRead = s.cache_read ?? s.cacheReadTokens ?? 0;
    const rawCacheCreation = s.cache_creation ?? s.cacheCreationTokens ?? 0;
    const rawCost = s.cost ?? 0;
    const clampedTokensIn = Math.max(0, rawTokensIn);
    const clampedTokensOut = Math.max(0, rawTokensOut);
    const clampedCacheRead = Math.max(0, rawCacheRead);
    const clampedCacheCreation = Math.max(0, rawCacheCreation);
    const clampedCost = Math.max(0, rawCost);
    if (rawTokensIn < 0) console.warn(`[ingest:stats-cache] Clamping negative tokens_in (${rawTokensIn}) to 0 for session ${id}`);
    if (rawTokensOut < 0) console.warn(`[ingest:stats-cache] Clamping negative tokens_out (${rawTokensOut}) to 0 for session ${id}`);
    if (rawCacheRead < 0) console.warn(`[ingest:stats-cache] Clamping negative cache_read (${rawCacheRead}) to 0 for session ${id}`);
    if (rawCacheCreation < 0) console.warn(`[ingest:stats-cache] Clamping negative cache_creation (${rawCacheCreation}) to 0 for session ${id}`);
    if (rawCost < 0) console.warn(`[ingest:stats-cache] Clamping negative cost (${rawCost}) to 0 for session ${id}`);

    try {
      db.run(
        `INSERT OR IGNORE INTO sessions
           (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation,
            duration_ms, messages, tool_calls, cost, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          s.user ?? 'unknown',
          s.project ?? null,
          s.model ?? 'unknown',
          clampedTokensIn,
          clampedTokensOut,
          clampedCacheRead,
          clampedCacheCreation,
          s.duration_ms ?? s.durationMs ?? null,
          s.messages ?? 0,
          s.tool_calls ?? s.toolCalls ?? 0,
          clampedCost,
          startedAt,
          s.ended_at ?? s.endedAt ?? null,
        ]
      );
      upserted++;
    } catch (err) {
      console.warn(`[ingest:stats-cache] Insert failed for session ${id}:`, err);
    }
  }

  db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, contentSize]);
  if (upserted > 0) console.log(`[ingest:stats-cache] Inserted ${upserted} session records from stats-cache`);
}
