import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { DbHelpers } from '../../db/index.js';

/**
 * Minimal YAML parser for the flat key:value format used in task result files.
 * Handles: string, number, boolean, and quoted strings.
 * Does NOT handle nested objects or arrays (criteria list is ignored).
 */
function parseSimpleYaml(content: string): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1 || line.startsWith('#') || line.startsWith(' ') || line.startsWith('-')) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (val === 'true') result[key] = true;
    else if (val === 'false') result[key] = false;
    else if (val === 'null' || val === '~' || val === '') result[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(val)) result[key] = parseFloat(val);
    else result[key] = val;
  }
  return result;
}

/**
 * Parses .deepflow/results/T*.yaml → task_results table.
 * Upserts based on task_id — YAML files are stable records, not streams.
 * Tracks processed files in _meta to skip unchanged ones on re-run.
 */
export async function parseTaskResults(db: DbHelpers, deepflowDir: string): Promise<void> {
  const resultsDir = resolve(deepflowDir, 'results');
  if (!existsSync(resultsDir)) {
    console.warn('[ingest:task-results] Results dir not found, skipping:', resultsDir);
    return;
  }

  let yamlFiles: string[];
  try {
    yamlFiles = readdirSync(resultsDir)
      .filter((f) => /^T.+\.yaml$/.test(f))
      .map((f) => join(resultsDir, f));
  } catch (err) {
    console.warn('[ingest:task-results] Cannot read results dir:', err);
    return;
  }

  let upserted = 0;

  for (const filePath of yamlFiles) {
    const fileKey = `ingest_seen:task-result:${basename(filePath)}`;
    // Check mtime-based cache: store file size as a cheap change detector
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[ingest:task-results] Cannot read ${filePath}:`, err);
      continue;
    }

    const contentHash = String(content.length); // lightweight: size as proxy for change
    const seenRow = db.get('SELECT value FROM _meta WHERE key = ?', [fileKey]);
    if (seenRow && seenRow.value === contentHash) continue; // unchanged

    let record: Record<string, string | number | boolean | null>;
    try {
      record = parseSimpleYaml(content);
    } catch (err) {
      console.warn(`[ingest:task-results] YAML parse failed for ${filePath}:`, err);
      continue;
    }

    const taskId = (record.task as string) ?? basename(filePath, '.yaml');
    const status = (record.status as string) ?? 'unknown';
    const ts = (record.timestamp as string) ?? new Date().toISOString();

    try {
      db.run(
        `INSERT INTO task_results (task_id, spec, status, cost, input_tokens, output_tokens, execution_count, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          taskId,
          (record.spec as string) ?? null,
          status,
          (record.cost as number) ?? 0,
          (record.input_tokens as number) ?? 0,
          (record.output_tokens as number) ?? 0,
          (record.execution_count as number) ?? 1,
          ts,
        ]
      );
      upserted++;
    } catch (err) {
      console.warn(`[ingest:task-results] Upsert failed for ${filePath}:`, err);
      continue;
    }

    db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [fileKey, contentHash]);
  }

  if (upserted > 0) console.log(`[ingest:task-results] Processed ${upserted} task result files`);
}
