import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Parses ~/.claude/cache-history.jsonl and enriches existing session rows.
 * No sessions or token_events are created — only UPDATE statements are issued.
 * Records without a matching session in the DB are silently skipped.
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

  // Build a map of session_id → enrichment data (last value per session wins)
  const enrichmentMap = new Map<string, { cache_hit_ratio: number; agent_role: string | null; model: string | null }>();

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

    const sessionId = (record.session_id ?? record.sessionId) as string | undefined;
    if (!sessionId) continue; // No session_id → nothing to enrich

    const cacheHitRatio = typeof record.cache_hit_ratio === 'number' ? record.cache_hit_ratio : null;

    const breakdown = record.agent_breakdown as Record<string, unknown> | undefined;
    const agentRole = (breakdown?.agent_role as string | undefined) ?? null;

    // Strip bracket suffixes from model (e.g. "claude-opus-4-6[1m]" → "claude-opus-4-6")
    let model = (breakdown?.model as string | undefined) ?? null;
    if (model) {
      model = model.replace(/\[.*\]$/, '');
    }

    enrichmentMap.set(sessionId, {
      cache_hit_ratio: cacheHitRatio ?? (enrichmentMap.get(sessionId)?.cache_hit_ratio ?? 0),
      agent_role: agentRole ?? enrichmentMap.get(sessionId)?.agent_role ?? null,
      model: model ?? enrichmentMap.get(sessionId)?.model ?? null,
    });
  }

  let updated = 0;
  for (const [sessionId, data] of enrichmentMap) {
    try {
      db.run(
        `UPDATE sessions SET cache_hit_ratio = ?, agent_role = COALESCE(?, agent_role), model = COALESCE(NULLIF(?, 'unknown'), model) WHERE id = ?`,
        [data.cache_hit_ratio, data.agent_role, data.model, sessionId]
      );
      updated++;
    } catch (err) {
      console.warn(`[ingest:cache-history] UPDATE failed for session ${sessionId}:`, err);
    }
  }

  db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
  if (updated > 0) console.log(`[ingest:cache-history] Enriched ${updated} sessions`);
}
