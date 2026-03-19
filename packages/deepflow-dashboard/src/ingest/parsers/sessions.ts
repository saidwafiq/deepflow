import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Decode Claude Code project dir name to a human-readable project name.
 * e.g. "-Users-saidsalles-apps-bingo-go" → "bingo-go"
 * Worktree dirs like "...--deepflow-worktrees-spike" → "deepflow (spike)"
 */
function projectNameFromDir(dirName: string): string {
  // Split on worktree separator
  const [mainPath, worktreePart] = dirName.split('--', 2);
  // Take last meaningful segment from the path
  const segments = mainPath.replace(/^-+/, '').split('-').filter(Boolean);
  // Walk from end to find the project name (skip user/apps prefix)
  // Pattern: Users-user-apps-projectName or Users-user-apps-org-projectName
  const appsIdx = segments.lastIndexOf('apps');
  const name = appsIdx >= 0 && appsIdx < segments.length - 1
    ? segments.slice(appsIdx + 1).join('-')
    : segments.slice(-1)[0] ?? dirName;

  if (worktreePart) {
    const wtSegments = worktreePart.split('-').filter(Boolean);
    // Remove "deepflow-worktrees" or "claude-worktrees" prefix
    const wtIdx = wtSegments.findIndex(s => s === 'worktrees');
    const suffix = wtIdx >= 0 ? wtSegments.slice(wtIdx + 1).join('-') : wtSegments.join('-');
    return suffix ? `${name} (${suffix})` : name;
  }

  return name;
}

/**
 * Parses per-session JSONL files in ~/.claude/projects/{project}/ → sessions table.
 * Session files are UUID-named .jsonl files directly in each project directory.
 * Each file is a stream of events; we materialise a session row from the aggregate.
 */
export async function parseSessions(db: DbHelpers, claudeDir: string): Promise<void> {
  const projectsDir = resolve(claudeDir, 'projects');
  if (!existsSync(projectsDir)) {
    console.warn('[ingest:sessions] Projects dir not found, skipping:', projectsDir);
    return;
  }

  let projectDirs: Array<{ path: string; name: string }>;
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        path: join(projectsDir, d.name),
        name: projectNameFromDir(d.name),
      }));
  } catch (err) {
    console.warn('[ingest:sessions] Cannot read projects dir:', err);
    return;
  }

  let totalInserted = 0;
  let totalUpdated = 0;

  for (const projectEntry of projectDirs) {
    // Session JSONL files are directly in the project dir (UUID.jsonl)
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectEntry.path)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(projectEntry.path, f));
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

      // Skip if no new lines
      if (lines.length <= offset) continue;

      // Derive session ID from filename (UUID.jsonl)
      const fileSessionId = basename(filePath, '.jsonl');

      let sessionId: string = fileSessionId;
      let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreation = 0;
      let messages = 0, toolCalls = 0, cost = 0;
      let model = 'unknown', user = 'unknown';
      const project = projectEntry.name;
      let startedAt: string | null = null, endedAt: string | null = null;
      let durationMs = 0;
      let hasNewData = false;

      for (let i = offset; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // skip malformed lines silently
        }

        hasNewData = true;

        // Extract session identity
        if (event.sessionId) sessionId = event.sessionId as string;
        if (!startedAt && event.timestamp) startedAt = event.timestamp as string;
        if (event.timestamp) endedAt = event.timestamp as string;

        if (event.model && event.model !== 'unknown') model = event.model as string;
        if (event.user) user = event.user as string;

        // Count messages and tool calls by event type
        const eventType = event.type as string | undefined;
        const dataType = (event.data as Record<string, unknown>)?.type as string | undefined;

        if (eventType === 'assistant' || event.role === 'assistant') messages++;
        if (eventType === 'human' || event.role === 'human' || event.role === 'user') messages++;
        if (dataType === 'tool_use' || eventType === 'tool_use' || event.tool_name) toolCalls++;

        // Accumulate tokens from usage objects or flat fields
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          tokensIn += usage.input_tokens ?? 0;
          tokensOut += usage.output_tokens ?? 0;
          cacheRead += usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0;
          cacheCreation += usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0;
        }
        if (typeof event.cost === 'number') cost += event.cost;
      }

      // Calculate duration from timestamps
      if (startedAt && endedAt) {
        const start = new Date(startedAt).getTime();
        const end = new Date(endedAt).getTime();
        if (!isNaN(start) && !isNaN(end)) durationMs = end - start;
      }

      if (hasNewData && sessionId) {
        const existing = db.get('SELECT id FROM sessions WHERE id = ?', [sessionId]);
        if (existing) {
          try {
            db.run(
              `UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
               cache_read = cache_read + ?, cache_creation = cache_creation + ?,
               messages = messages + ?, tool_calls = tool_calls + ?,
               cost = cost + ?, duration_ms = ?, ended_at = COALESCE(?, ended_at),
               model = COALESCE(NULLIF(?, 'unknown'), model),
               project = COALESCE(?, project)
               WHERE id = ?`,
              [tokensIn, tokensOut, cacheRead, cacheCreation, messages, toolCalls, cost,
               durationMs, endedAt, model, project, sessionId]
            );
            totalUpdated++;
          } catch (err) {
            console.warn(`[ingest:sessions] Update failed for ${sessionId}:`, err);
          }
        } else {
          try {
            db.run(
              `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, duration_ms, messages, tool_calls, cost, started_at, ended_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [sessionId, user, project, model, tokensIn, tokensOut, cacheRead, cacheCreation,
               durationMs, messages, toolCalls, cost,
               startedAt ?? new Date().toISOString(), endedAt]
            );
            totalInserted++;
          } catch (err) {
            console.warn(`[ingest:sessions] Insert failed for ${sessionId}:`, err);
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
