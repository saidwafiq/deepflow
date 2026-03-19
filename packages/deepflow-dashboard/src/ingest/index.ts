import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { run, get, all, type DbHelpers } from '../db/index.js';
import { parseQuotaHistory } from './parsers/quota-history.js';
import { parseHistory } from './parsers/history.js';
import { parseTokenHistory } from './parsers/token-history.js';
import { parseSessions } from './parsers/sessions.js';
import { parseCacheHistory } from './parsers/cache-history.js';
import { parseToolUsage } from './parsers/tool-usage.js';
import { parseTaskResults } from './parsers/task-results.js';
import { parseStatsCache } from './parsers/stats-cache.js';

/** Shared db helper bundle passed to every parser */
const dbHelpers: DbHelpers = { run, get, all };

/**
 * Run all ingestion parsers in sequence.
 * Missing files and parse errors are logged as warnings; ingestion never throws.
 *
 * @param deepflowDir  Absolute path to the .deepflow directory (defaults to cwd/.deepflow)
 */
export async function runIngestion(deepflowDir?: string): Promise<void> {
  const claudeDir = resolve(homedir(), '.claude');
  const dfDir = deepflowDir ?? resolve(process.cwd(), '.deepflow');

  console.log('[ingest] Starting ingestion…');
  console.log(`[ingest]   claudeDir : ${claudeDir}`);
  console.log(`[ingest]   deepflowDir : ${dfDir}`);

  const parsers: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'quota-history',  fn: () => parseQuotaHistory(dbHelpers, claudeDir) },
    { name: 'history',        fn: () => parseHistory(dbHelpers, claudeDir) },
    { name: 'token-history',  fn: () => parseTokenHistory(dbHelpers, dfDir) },
    { name: 'sessions',       fn: () => parseSessions(dbHelpers, claudeDir) },
    { name: 'cache-history',  fn: () => parseCacheHistory(dbHelpers, claudeDir) },
    { name: 'tool-usage',     fn: () => parseToolUsage(dbHelpers, claudeDir) },
    { name: 'task-results',   fn: () => parseTaskResults(dbHelpers, dfDir) },
    { name: 'stats-cache',    fn: () => parseStatsCache(dbHelpers, claudeDir) },
  ];

  for (const { name, fn } of parsers) {
    try {
      await fn();
    } catch (err) {
      // Isolate parser failures — one bad parser never stops the rest
      console.warn(`[ingest] Parser '${name}' threw unexpectedly:`, err);
    }
  }

  console.log('[ingest] Ingestion complete');
}
