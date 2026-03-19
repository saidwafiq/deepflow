import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Parses per-session JSONL files in ~/.claude/projects/*\/sessions/ → sessions table.
 * Each file is a stream of events; we materialise a session row from the aggregate.
 * Offset per file tracks lines processed, keyed by relative path.
 */
export async function parseSessions(db: DbHelpers, claudeDir: string): Promise<void> {
  const projectsDir = resolve(claudeDir, 'projects');
  if (!existsSync(projectsDir)) {
    console.warn('[ingest:sessions] Projects dir not found, skipping:', projectsDir);
    return;
  }

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name));
  } catch (err) {
    console.warn('[ingest:sessions] Cannot read projects dir:', err);
    return;
  }

  let totalInserted = 0;
  let totalUpdated = 0;

  for (const projectDir of projectDirs) {
    const sessionsDir = join(projectDir, 'sessions');
    if (!existsSync(sessionsDir)) continue;

    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(sessionsDir, f));
    } catch {
      continue;
    }

    for (const filePath of sessionFiles) {
      const offsetKey = `ingest_offset:session:${filePath}`;
      const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
      const offset = offsetRow ? parseInt(offsetRow.value as string, 10) : 0;

      let lines: string[];
      try {
        lines = readFileSync(filePath, 'utf-8').split('\n');
      } catch (err) {
        console.warn(`[ingest:sessions] Cannot read file ${filePath}:`, err);
        continue;
      }

      // Accumulate session stats from new lines
      let sessionId: string | null = null;
      let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreation = 0;
      let messages = 0, toolCalls = 0, cost = 0;
      let model = 'unknown', user = 'unknown', project: string | null = null;
      let startedAt: string | null = null, endedAt: string | null = null;
      let hasNewData = false;

      for (let i = offset; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          console.warn(`[ingest:sessions] Malformed JSON in ${filePath} at line ${i + 1}, skipping`);
          continue;
        }

        hasNewData = true;

        // Extract session identity from first available event
        if (!sessionId) sessionId = (event.session_id ?? event.sessionId ?? event.id) as string | null;
        if (!startedAt) startedAt = (event.timestamp ?? event.ts ?? event.started_at ?? null) as string | null;
        endedAt = (event.timestamp ?? event.ts ?? null) as string | null;

        if (event.model && event.model !== 'unknown') model = event.model as string;
        if (event.user) user = event.user as string;
        if (event.project) project = event.project as string;

        // Accumulate token/cost fields from usage objects or flat fields
        const usage = event.usage as Record<string, number> | undefined;
        tokensIn += (usage?.input_tokens ?? (event.input_tokens as number) ?? 0);
        tokensOut += (usage?.output_tokens ?? (event.output_tokens as number) ?? 0);
        cacheRead += (usage?.cache_read_tokens ?? (event.cache_read_tokens as number) ?? 0);
        cacheCreation += (usage?.cache_creation_tokens ?? (event.cache_creation_tokens as number) ?? 0);
        cost += (event.cost as number) ?? 0;

        if (event.type === 'message' || event.role) messages++;
        if (event.type === 'tool_use' || event.tool_name) toolCalls++;
      }

      if (hasNewData && sessionId) {
        const existing = db.get('SELECT id, tokens_in, tokens_out FROM sessions WHERE id = ?', [sessionId]);
        if (existing) {
          // Add incremental deltas to existing row
          try {
            db.run(
              `UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
               cache_read = cache_read + ?, cache_creation = cache_creation + ?,
               messages = messages + ?, tool_calls = tool_calls + ?,
               cost = cost + ?, ended_at = COALESCE(?, ended_at), model = COALESCE(NULLIF(?, 'unknown'), model)
               WHERE id = ?`,
              [tokensIn, tokensOut, cacheRead, cacheCreation, messages, toolCalls, cost, endedAt, model, sessionId]
            );
            totalUpdated++;
          } catch (err) {
            console.warn(`[ingest:sessions] Update failed for session ${sessionId}:`, err);
          }
        } else {
          try {
            db.run(
              `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, messages, tool_calls, cost, started_at, ended_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [sessionId, user, project, model, tokensIn, tokensOut, cacheRead, cacheCreation, messages, toolCalls, cost,
               startedAt ?? new Date().toISOString(), endedAt]
            );
            totalInserted++;
          } catch (err) {
            console.warn(`[ingest:sessions] Insert failed for session ${sessionId}:`, err);
          }
        }
      }

      db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
    }
  }

  if (totalInserted > 0 || totalUpdated > 0) {
    console.log(`[ingest:sessions] Inserted ${totalInserted}, updated ${totalUpdated} session records`);
  }
}
