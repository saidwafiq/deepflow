import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { DbHelpers } from '../../db/index.js';
import { fetchPricing, computeCost } from '../../pricing.js';

interface TaskStartRecord {
  type: 'task_start';
  task_id: string;
  spec?: string;
  session_id?: string;
  timestamp: string;
}

interface TaskEndRecord {
  type: 'task_end';
  task_id: string;
  session_id?: string;
  status?: string;
  timestamp: string;
}

type ExecRecord = TaskStartRecord | TaskEndRecord | { type: string };

/**
 * Discover all .deepflow/execution-history.jsonl files across projects.
 * Mirrors the discovery pattern from token-history.ts.
 */
function discoverExecutionHistoryFiles(claudeDir: string): Array<{ path: string; project: string }> {
  const results: Array<{ path: string; project: string }> = [];
  const projectsDir = resolve(claudeDir, 'projects');

  if (!existsSync(projectsDir)) return results;

  try {
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dirName of projectDirs) {
      // Decode dir name to real path: "-Users-saidsalles-apps-foo" → "/Users/saidsalles/apps/foo"
      const realPath = '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
      const execFile = resolve(realPath, '.deepflow', 'execution-history.jsonl');

      if (existsSync(execFile)) {
        const segments = realPath.split('/');
        const appsIdx = segments.lastIndexOf('apps');
        const project = appsIdx >= 0 && appsIdx < segments.length - 1
          ? segments.slice(appsIdx + 1).join('-')
          : basename(realPath);

        results.push({ path: execFile, project });
      }
    }
  } catch {
    // Non-fatal
  }

  return results;
}

/**
 * Parses execution-history.jsonl files → task_attempts table.
 * Correlates task_start/task_end pairs by task_id + session_id.
 * Joins token_events within the task's timestamp window to compute token totals.
 */
export async function parseExecutionHistory(db: DbHelpers, claudeDir: string): Promise<void> {
  const files = discoverExecutionHistoryFiles(claudeDir);

  if (files.length === 0) {
    console.warn('[ingest:execution-history] No execution-history.jsonl files found');
    return;
  }

  const pricing = await fetchPricing();
  let totalInserted = 0;

  for (const { path: filePath } of files) {
    const offsetKey = `ingest_offset:execution-history:${filePath}`;
    const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
    const offset = offsetRow ? parseInt(offsetRow.value as string, 10) : 0;

    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf-8').split('\n');
    } catch (err) {
      console.warn(`[ingest:execution-history] Cannot read ${filePath}:`, err);
      continue;
    }

    if (lines.length <= offset) continue;

    // Parse all new lines into records
    const newRecords: ExecRecord[] = [];
    for (let i = offset; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        newRecords.push(JSON.parse(line) as ExecRecord);
      } catch {
        continue;
      }
    }

    // Build a map of task_start records keyed by task_id+session_id
    const starts = new Map<string, TaskStartRecord>();
    for (const rec of newRecords) {
      if (rec.type === 'task_start') {
        const r = rec as TaskStartRecord;
        const key = `${r.task_id}::${r.session_id ?? ''}`;
        starts.set(key, r);
      }
    }

    let inserted = 0;
    for (const rec of newRecords) {
      if (rec.type !== 'task_end') continue;
      const end = rec as TaskEndRecord;
      const key = `${end.task_id}::${end.session_id ?? ''}`;
      const start = starts.get(key);
      if (!start) {
        console.warn(`[ingest:execution-history] Orphaned task_end: task_id=${end.task_id}, session_id=${end.session_id}`);
        continue;
      }

      const sessionId = start.session_id ?? null;
      const startedAt = start.timestamp;
      const endedAt = end.timestamp;

      // Sum token_events within the timestamp window for this session
      let tokensIn = 0;
      let tokensOut = 0;
      let cacheRead = 0;
      let cacheCreation = 0;
      let model = 'unknown';

      if (sessionId) {
        const tokenRows = db.all(
          `SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
           FROM token_events
           WHERE session_id = ? AND timestamp >= ? AND timestamp <= ?`,
          [sessionId, startedAt, endedAt]
        ) as Array<{
          model: string;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_creation_tokens: number;
        }>;

        for (const te of tokenRows) {
          tokensIn += te.input_tokens ?? 0;
          tokensOut += te.output_tokens ?? 0;
          cacheRead += te.cache_read_tokens ?? 0;
          cacheCreation += te.cache_creation_tokens ?? 0;
          if (te.model && te.model !== 'unknown') model = te.model;
        }
      }

      // token_events don't have 5m/1h breakdown — treat all as 5m (conservative)
      const cost = computeCost(pricing, model, tokensIn, tokensOut, cacheRead, cacheCreation);

      try {
        db.run(
          `INSERT INTO task_attempts (task_id, spec, session_id, status, tokens_in, tokens_out, cache_read, cost, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            end.task_id,
            start.spec ?? null,
            sessionId,
            end.status ?? 'unknown',
            tokensIn,
            tokensOut,
            cacheRead,
            cost,
            startedAt,
            endedAt,
          ]
        );
        inserted++;
      } catch (err) {
        console.warn(`[ingest:execution-history] Insert failed for ${end.task_id}:`, err);
      }
    }

    db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
    if (inserted > 0) {
      console.log(`[ingest:execution-history] Inserted ${inserted} task_attempts from ${filePath}`);
      totalInserted += inserted;
    }
  }

  if (totalInserted > 0) {
    console.log(`[ingest:execution-history] Total: ${totalInserted} new task_attempts`);
  }
}
