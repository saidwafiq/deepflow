import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbHelpers } from '../../db/index.js';
import { projectNameFromDir } from './utils.js';

/**
 * Reconstruct the real filesystem path from a Claude project dir name.
 * Dir names encode the absolute path by replacing `/` with `-`, so naive
 * reverse-decoding is ambiguous when project names also contain hyphens.
 *
 * Strategy: split the encoded name into segments and walk the filesystem,
 * consuming segments greedily until we find an existing directory. This
 * handles multi-hyphen project names like `my-app`, `bingo-rgs`, `foo-bar-baz`.
 */
function decodeDirNameToPath(dirName: string): string | null {
  // Strip leading hyphen and split on hyphens
  const stripped = dirName.replace(/^-+/, '');
  const parts = stripped.split('-');

  // Build path incrementally; the first segment is always a root dir (e.g. "Users")
  let path = '/';
  let i = 0;

  while (i < parts.length) {
    // Try consuming more segments to find the longest matching dir entry
    let matched = false;
    // Try longest match first (greedy from current position to end)
    for (let end = parts.length; end > i; end--) {
      const candidate = parts.slice(i, end).join('-');
      const fullPath = resolve(path, candidate);
      if (existsSync(fullPath)) {
        path = fullPath;
        i = end;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // No existing entry found — fall back to single-segment advance
      path = resolve(path, parts[i]);
      i++;
    }
  }

  return path === '/' ? null : path;
}

/**
 * Discover all .deepflow/token-history.jsonl files across projects.
 * Scans common project locations and the Claude projects dir to map back.
 */
function discoverTokenHistoryFiles(claudeDir: string): Array<{ path: string; project: string }> {
  const results: Array<{ path: string; project: string }> = [];
  const projectsDir = resolve(claudeDir, 'projects');

  if (!existsSync(projectsDir)) return results;

  try {
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dirName of projectDirs) {
      const realPath = decodeDirNameToPath(dirName);
      if (!realPath) continue;

      const tokenFile = resolve(realPath, '.deepflow', 'token-history.jsonl');

      if (existsSync(tokenFile)) {
        const project = projectNameFromDir(dirName);
        results.push({ path: tokenFile, project });
      }
    }
  } catch {
    // Non-fatal
  }

  return results;
}

/**
 * Parses token-history.jsonl files from ALL projects → token_events table.
 * Discovers .deepflow/ dirs across all known projects for cross-project coverage.
 */
export async function parseTokenHistory(db: DbHelpers, claudeDir: string): Promise<void> {
  const files = discoverTokenHistoryFiles(claudeDir);

  if (files.length === 0) {
    console.warn('[ingest:token-history] No token-history.jsonl files found');
    return;
  }

  let totalInserted = 0;

  for (const { path: filePath, project } of files) {
    const offsetKey = `ingest_offset:token-history:${filePath}`;
    const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
    const offset = offsetRow ? parseInt(offsetRow.value as string, 10) : 0;

    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf-8').split('\n');
    } catch (err) {
      console.warn(`[ingest:token-history] Cannot read ${filePath}:`, err);
      continue;
    }

    if (lines.length <= offset) continue;

    let inserted = 0;
    for (let i = offset; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const sessionId = (record.session_id ?? record.sessionId) as string | undefined;
      if (!sessionId) continue;

      // Ensure session row exists with project info
      const existing = db.get('SELECT id FROM sessions WHERE id = ?', [sessionId]);
      if (!existing) {
        try {
          db.run(
            `INSERT OR IGNORE INTO sessions (id, user, project, tokens_in, tokens_out, cache_read, cache_creation, messages, tool_calls, cost, started_at)
             VALUES (?, 'unknown', ?, 0, 0, 0, 0, 0, 0, 0, ?)`,
            [sessionId, project, (record.timestamp ?? new Date().toISOString()) as string]
          );
        } catch {
          // non-fatal
        }
      }

      // Resolve agent_role from the session row (set during session ingest)
      const sessionRow = db.get('SELECT agent_role FROM sessions WHERE id = ?', [sessionId]) as Record<string, unknown> | undefined;
      const agentRole = (sessionRow?.agent_role as string | undefined) ?? 'orchestrator';

      try {
        const rawInputTokens = (record.input_tokens ?? record.inputTokens ?? 0) as number;
        const rawOutputTokens = (record.output_tokens ?? record.outputTokens ?? 0) as number;
        const rawCacheRead = (record.cache_read_input_tokens ?? 0) as number;
        const rawCacheCreation = (record.cache_creation_input_tokens ?? 0) as number;
        const clampedInputTokens = Math.max(0, rawInputTokens);
        const clampedOutputTokens = Math.max(0, rawOutputTokens);
        const clampedCacheRead = Math.max(0, rawCacheRead);
        const clampedCacheCreation = Math.max(0, rawCacheCreation);
        if (rawInputTokens < 0) console.warn(`[ingest:token-history] Clamping negative input_tokens (${rawInputTokens}) to 0 at line ${i + 1} in ${filePath}`);
        if (rawOutputTokens < 0) console.warn(`[ingest:token-history] Clamping negative output_tokens (${rawOutputTokens}) to 0 at line ${i + 1} in ${filePath}`);
        if (rawCacheRead < 0) console.warn(`[ingest:token-history] Clamping negative cache_read_tokens (${rawCacheRead}) to 0 at line ${i + 1} in ${filePath}`);
        if (rawCacheCreation < 0) console.warn(`[ingest:token-history] Clamping negative cache_creation_tokens (${rawCacheCreation}) to 0 at line ${i + 1} in ${filePath}`);

        db.run(
          `INSERT INTO token_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp, agent_role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            ((record.model as string) ?? 'unknown').replace(/\[\d+[km]\]$/i, ''),
            clampedInputTokens,
            clampedOutputTokens,
            clampedCacheRead,
            clampedCacheCreation,
            (record.timestamp ?? new Date().toISOString()) as string,
            agentRole,
          ]
        );
        inserted++;
      } catch (err) {
        console.warn(`[ingest:token-history] Insert failed:`, err);
      }
    }

    db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
    if (inserted > 0) {
      console.log(`[ingest:token-history] ${project}: inserted ${inserted} records`);
      totalInserted += inserted;
    }
  }

  if (totalInserted > 0) {
    console.log(`[ingest:token-history] Total: ${totalInserted} new records across ${files.length} projects`);
  }
}
