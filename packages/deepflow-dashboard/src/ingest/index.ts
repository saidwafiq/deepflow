import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { run, get, all, type DbHelpers } from '../db/index.js';
import { fetchPricing, resolveModelPricing } from '../pricing.js';
import { parseQuotaHistory } from './parsers/quota-history.js';
import { parseHistory } from './parsers/history.js';
import { parseTokenHistory } from './parsers/token-history.js';
import { parseSessions } from './parsers/sessions.js';
import { parseCacheHistory } from './parsers/cache-history.js';
import { parseToolUsage } from './parsers/tool-usage.js';
import { parseExecutionHistory } from './parsers/execution-history.js';
import { parseStatsCache } from './parsers/stats-cache.js';

/** Shared db helper bundle passed to every parser */
const dbHelpers: DbHelpers = { run, get, all };

/**
 * Post-ingestion: compute costs for sessions where cost = 0 or cost IS NULL.
 * Only updates sessions.cost — never overwrites tokens_in, tokens_out,
 * cache_read, or cache_creation (those are set by their respective parsers).
 */
async function computeSessionCosts(): Promise<void> {
  const pricing = await fetchPricing();
  const sessions = all(`
    SELECT id, model, tokens_in, tokens_out, cache_read, cache_creation FROM sessions
    WHERE (cost = 0 OR cost IS NULL) AND (tokens_in > 0 OR tokens_out > 0)
  `);

  let costUpdated = 0;
  for (const s of sessions) {
    const modelPricing = resolveModelPricing(pricing, s.model as string);
    if (!modelPricing) continue;

    const inputCost = ((s.tokens_in as number) ?? 0) * (modelPricing.input ?? 0) / 1_000_000;
    const outputCost = ((s.tokens_out as number) ?? 0) * (modelPricing.output ?? 0) / 1_000_000;
    const cacheReadCost = ((s.cache_read as number) ?? 0) * (modelPricing.cache_read ?? modelPricing.input * 0.1) / 1_000_000;
    const cacheCreationCost = ((s.cache_creation as number) ?? 0) * (modelPricing.cache_creation ?? modelPricing.input * 1.25) / 1_000_000;
    const totalCost = inputCost + outputCost + cacheReadCost + cacheCreationCost;

    if (totalCost > 0) {
      run('UPDATE sessions SET cost = ? WHERE id = ?', [totalCost, s.id as string]);
      costUpdated++;
    }
  }

  console.log(`[ingest:costs] Cost computed for ${costUpdated} sessions`);
}

/**
 * Run all ingestion parsers in sequence.
 * Missing files and parse errors are logged as warnings; ingestion never throws.
 *
 * @param deepflowDir  Absolute path to the .deepflow directory (defaults to cwd/.deepflow)
 */
/**
 * One-time migration: wipe sessions + session ingest offsets so the fixed
 * parser re-processes all JSONL files from scratch.
 * Idempotent — tracked via _meta key 'migration:session_reparse_v1'.
 */
function runMigrationSessionReparseV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:session_reparse_v1'");
  if (already) return;

  console.log('[ingest:migration] Running session_reparse_v1 — wiping stale sessions + offsets…');

  // Delete all session rows
  run('DELETE FROM sessions');

  // Delete session ingest offsets so parsers re-read from byte 0
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:session:%'");

  // Mark migration as done
  run("INSERT INTO _meta (key, value) VALUES ('migration:session_reparse_v1', '1')");

  console.log('[ingest:migration] session_reparse_v1 complete');
}

/**
 * One-time migration: wipe tool_usage + quota_snapshots + their offsets
 * so the fixed parsers re-process all JSONL files from scratch.
 */
function runMigrationToolQuotaReparseV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:tool_quota_reparse_v1'");
  if (already) return;

  console.log('[ingest:migration] Running tool_quota_reparse_v1 — wiping stale tool_usage + quota data…');

  run('DELETE FROM tool_usage');
  run("DELETE FROM _meta WHERE key = 'ingest_offset:tool-usage'");

  run('DELETE FROM quota_snapshots');
  run("DELETE FROM _meta WHERE key = 'ingest_offset:quota-history'");

  run("INSERT INTO _meta (key, value) VALUES ('migration:tool_quota_reparse_v1', '1')");
  console.log('[ingest:migration] tool_quota_reparse_v1 complete');
}

/**
 * One-time migration: reset cost/token fields on sessions (preserving user, project, model,
 * messages, tool_calls, duration_ms, started_at, ended_at) + delete task_attempts + token_events
 * so cost fields are recomputed with fixed pricing logic.
 * Idempotent — tracked via _meta key 'migration:cost_reparse_v1'.
 */
function runMigrationCostReparseV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:cost_reparse_v1'");
  if (already) return;

  console.log('[ingest:migration] Running cost_reparse_v1 — resetting cost/token fields + task_attempts for re-ingestion…');

  // Zero out cost and token fields only — preserve user, project, model, messages,
  // tool_calls, duration_ms, started_at, ended_at and all other session metadata
  run('UPDATE sessions SET cost = 0, tokens_in = 0, tokens_out = 0, cache_read = 0, cache_creation = 0');

  // Delete token_events to force re-ingestion of token data
  run('DELETE FROM token_events');

  // Delete task_attempts rows to force recalculation
  run('DELETE FROM task_attempts');

  // Delete ingest offsets so parsers re-read from byte 0
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:session:%'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:task-attempts'");
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:token-%'");

  // Mark migration as done
  run("INSERT INTO _meta (key, value) VALUES ('migration:cost_reparse_v1', '1')");

  console.log('[ingest:migration] cost_reparse_v1 complete');
}

export async function runIngestion(deepflowDir?: string): Promise<void> {
  const claudeDir = resolve(homedir(), '.claude');
  const dfDir = deepflowDir ?? resolve(process.cwd(), '.deepflow');

  console.log('[ingest] Starting ingestion…');

  // Run one-time migrations before parsers
  runMigrationSessionReparseV1();
  runMigrationToolQuotaReparseV1();
  runMigrationCostReparseV1();
  console.log(`[ingest]   claudeDir : ${claudeDir}`);
  console.log(`[ingest]   deepflowDir : ${dfDir}`);

  const parsers: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'quota-history',  fn: () => parseQuotaHistory(dbHelpers, claudeDir) },
    { name: 'history',        fn: () => parseHistory(dbHelpers, claudeDir) },
    { name: 'token-history',  fn: () => parseTokenHistory(dbHelpers, claudeDir) },
    { name: 'sessions',       fn: () => parseSessions(dbHelpers, claudeDir) },
    { name: 'cache-history',  fn: () => parseCacheHistory(dbHelpers, claudeDir) },
    { name: 'tool-usage',     fn: () => parseToolUsage(dbHelpers, claudeDir) },
    { name: 'execution-history', fn: () => parseExecutionHistory(dbHelpers, claudeDir) },
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

  // Post-ingestion: compute costs for sessions missing cost data
  try {
    await computeSessionCosts();
  } catch (err) {
    console.warn('[ingest] Cost computation failed:', err);
  }

  console.log('[ingest] Ingestion complete');
}
