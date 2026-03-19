import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Parses ~/.claude/tool-usage.jsonl → tool_usage table.
 */
export async function parseToolUsage(db: DbHelpers, claudeDir: string): Promise<void> {
  const filePath = resolve(claudeDir, 'tool-usage.jsonl');
  if (!existsSync(filePath)) {
    console.warn('[ingest:tool-usage] File not found, skipping:', filePath);
    return;
  }

  const offsetKey = 'ingest_offset:tool-usage';
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
      console.warn(`[ingest:tool-usage] Malformed JSON at line ${i + 1}, skipping`);
      continue;
    }

    const ts = (record.timestamp ?? record.ts ?? new Date().toISOString()) as string;
    let sessionId = (record.session_id ?? record.sessionId) as string | undefined;
    if (!sessionId) {
      sessionId = `tool-synthetic-${ts}-${i}`;
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
      db.run(
        `INSERT INTO tool_usage (session_id, tool_name, call_count, total_tokens, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [
          sessionId,
          (record.tool_name ?? record.toolName ?? record.tool ?? 'unknown') as string,
          (record.call_count ?? record.callCount ?? record.count ?? 1) as number,
          (record.total_tokens ?? record.totalTokens ?? record.tokens ?? record.output_size_est_tokens ?? 0) as number,
          ts,
        ]
      );
      inserted++;
    } catch (err) {
      console.warn(`[ingest:tool-usage] Insert failed at line ${i + 1}:`, err);
    }
  }

  db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
  if (inserted > 0) console.log(`[ingest:tool-usage] Inserted ${inserted} new records`);
}
