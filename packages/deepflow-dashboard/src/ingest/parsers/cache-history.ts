import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Parses ~/.claude/cache-history.jsonl → token_events (cache-specific rows).
 * Records without a session_id get a synthetic one derived from the timestamp.
 */
export async function parseCacheHistory(db: DbHelpers, claudeDir: string): Promise<void> {
  const filePath = resolve(claudeDir, 'cache-history.jsonl');
  if (!existsSync(filePath)) {
    console.warn('[ingest:cache-history] File not found, skipping:', filePath);
    return;
  }

  const offsetKey = 'ingest_offset:cache-history';
  const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
  const offset = offsetRow ? parseInt(offsetRow.value as string, 10) : 0;

  const lines = readFileSync(filePath, 'utf-8').split('\n');
  let inserted = 0;

  for (let i = offset; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      console.warn(`[ingest:cache-history] Malformed JSON at line ${i + 1}, skipping`);
      continue;
    }

    const ts = (record.timestamp ?? record.ts ?? new Date().toISOString()) as string;
    // Use existing session_id or synthesise one so FK is satisfied
    let sessionId = (record.session_id ?? record.sessionId) as string | undefined;
    if (!sessionId) {
      sessionId = `cache-synthetic-${ts}`;
    }

    // Ensure session placeholder exists
    try {
      db.run(
        `INSERT OR IGNORE INTO sessions (id, user, tokens_in, tokens_out, cache_read, cache_creation, messages, tool_calls, cost, started_at)
         VALUES (?, 'unknown', 0, 0, 0, 0, 0, 0, 0, ?)`,
        [sessionId, ts]
      );
    } catch {
      // non-fatal
    }

    try {
      const rawCacheRead = (record.cache_read_tokens ?? record.cacheReadTokens ?? record.tokens ?? 0) as number;
      const rawCacheCreation = (record.cache_creation_tokens ?? record.cacheCreationTokens ?? 0) as number;
      const clampedCacheRead = Math.max(0, rawCacheRead);
      const clampedCacheCreation = Math.max(0, rawCacheCreation);
      if (rawCacheRead < 0) console.warn(`[ingest:cache-history] Clamping negative cache_read_tokens (${rawCacheRead}) to 0 at line ${i + 1}`);
      if (rawCacheCreation < 0) console.warn(`[ingest:cache-history] Clamping negative cache_creation_tokens (${rawCacheCreation}) to 0 at line ${i + 1}`);

      db.run(
        `INSERT INTO token_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          (record.model as string) ?? 'unknown',
          0, // cache events carry no regular input/output tokens
          0,
          clampedCacheRead,
          clampedCacheCreation,
          ts,
        ]
      );
      inserted++;
    } catch (err) {
      console.warn(`[ingest:cache-history] Insert failed at line ${i + 1}:`, err);
    }
  }

  db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
  if (inserted > 0) console.log(`[ingest:cache-history] Inserted ${inserted} new records`);
}
