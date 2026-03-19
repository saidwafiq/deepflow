import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Parses .deepflow/token-history.jsonl → token_events table.
 * Requires a valid session_id in each record; skips records without one.
 */
export async function parseTokenHistory(db: DbHelpers, deepflowDir: string): Promise<void> {
  const filePath = resolve(deepflowDir, 'token-history.jsonl');
  if (!existsSync(filePath)) {
    console.warn('[ingest:token-history] File not found, skipping:', filePath);
    return;
  }

  const offsetKey = 'ingest_offset:token-history';
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
      console.warn(`[ingest:token-history] Malformed JSON at line ${i + 1}, skipping`);
      continue;
    }

    const sessionId = (record.session_id ?? record.sessionId) as string | undefined;
    if (!sessionId) {
      console.warn(`[ingest:token-history] Missing session_id at line ${i + 1}, skipping`);
      continue;
    }

    // Ensure session row exists (placeholder if not)
    const existing = db.get('SELECT id FROM sessions WHERE id = ?', [sessionId]);
    if (!existing) {
      try {
        db.run(
          `INSERT OR IGNORE INTO sessions (id, user, tokens_in, tokens_out, cache_read, cache_creation, messages, tool_calls, cost, started_at)
           VALUES (?, 'unknown', 0, 0, 0, 0, 0, 0, 0, ?)`,
          [sessionId, (record.timestamp ?? new Date().toISOString()) as string]
        );
      } catch {
        // session insert failure is non-fatal; FK may fail on token_events insert below
      }
    }

    try {
      db.run(
        `INSERT INTO token_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          (record.model as string) ?? 'unknown',
          (record.input_tokens ?? record.inputTokens ?? 0) as number,
          (record.output_tokens ?? record.outputTokens ?? 0) as number,
          (record.cache_read_tokens ?? record.cacheReadTokens ?? 0) as number,
          (record.cache_creation_tokens ?? record.cacheCreationTokens ?? 0) as number,
          (record.timestamp ?? new Date().toISOString()) as string,
        ]
      );
      inserted++;
    } catch (err) {
      console.warn(`[ingest:token-history] Insert failed at line ${i + 1}:`, err);
    }
  }

  db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
  if (inserted > 0) console.log(`[ingest:token-history] Inserted ${inserted} new records`);
}
