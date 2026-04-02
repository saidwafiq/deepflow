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
    SELECT id, model, tokens_in, tokens_out, cache_read, cache_creation, cache_creation_5m, cache_creation_1h FROM sessions
    WHERE (cost = 0 OR cost IS NULL) AND (tokens_in > 0 OR tokens_out > 0)
  `);

  let costUpdated = 0;
  for (const s of sessions) {
    const modelPricing = resolveModelPricing(pricing, s.model as string);
    if (!modelPricing) continue;

    const cc5m = (s.cache_creation_5m as number) ?? 0;
    const cc1h = (s.cache_creation_1h as number) ?? 0;
    // If breakdown is missing (old data), treat total cache_creation as 5m (conservative)
    const cacheCreation5m = (cc5m > 0 || cc1h > 0) ? cc5m : ((s.cache_creation as number) ?? 0);
    const cacheCreation1h = cc1h;

    const inputCost = ((s.tokens_in as number) ?? 0) * (modelPricing.input ?? 0) / 1_000_000;
    const outputCost = ((s.tokens_out as number) ?? 0) * (modelPricing.output ?? 0) / 1_000_000;
    const cacheReadCost = ((s.cache_read as number) ?? 0) * (modelPricing.cache_read ?? modelPricing.input * 0.1) / 1_000_000;
    const cacheCreation5mCost = cacheCreation5m * (modelPricing.cache_creation ?? modelPricing.input * 1.25) / 1_000_000;
    const cacheCreation1hCost = cacheCreation1h * (modelPricing.cache_creation_1h ?? modelPricing.input * 2) / 1_000_000;
    const totalCost = inputCost + outputCost + cacheReadCost + cacheCreation5mCost + cacheCreation1hCost;

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

/**
 * One-time migration: reset cost/token fields + session ingest offsets so sessions
 * are re-parsed with cache_creation_5m/1h breakdown and correct pricing.
 */
function runMigrationCacheBreakdownV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:cache_breakdown_v1'");
  if (already) return;

  console.log('[ingest:migration] Running cache_breakdown_v1 — resetting sessions for cache TTL breakdown re-ingestion…');

  run('UPDATE sessions SET cost = 0, tokens_in = 0, tokens_out = 0, cache_read = 0, cache_creation = 0, cache_creation_5m = 0, cache_creation_1h = 0');
  run('DELETE FROM token_events');
  run('DELETE FROM task_attempts');
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:session:%'");
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:token-%'");
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:execution-%'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:cache-history'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:stats-cache'");

  run("INSERT INTO _meta (key, value) VALUES ('migration:cache_breakdown_v1', '1')");
  console.log('[ingest:migration] cache_breakdown_v1 complete');
}

/**
 * One-time migration: wipe token_events, task_attempts, reset session fields,
 * and delete all session/token/execution/cache-history ingest offsets so sessions
 * are re-parsed from scratch with the dedup fix.
 * Idempotent — tracked via _meta key 'migration:pipeline_critical_v1'.
 */
function runMigrationPipelineCriticalV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:pipeline_critical_v1'");
  if (already) return;

  console.log('[ingest:migration] Running pipeline_critical_v1 — wiping token_events, task_attempts, resetting sessions + offsets…');

  run('DELETE FROM token_events');
  run('DELETE FROM task_attempts');
  run(`UPDATE sessions SET cost=0, tokens_in=0, tokens_out=0, cache_read=0, cache_creation=0,
       cache_creation_5m=0, cache_creation_1h=0, messages=0, tool_calls=0,
       duration_ms=NULL, model='unknown'`);
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:session:%'");
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:token-%'");
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:execution-%'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:cache-history'");

  run("INSERT INTO _meta (key, value) VALUES ('migration:pipeline_critical_v1', '1')");
  console.log('[ingest:migration] pipeline_critical_v1 complete');
}

/**
 * One-time migration: purge sessions where model = '<synthetic>' and their
 * associated token_events. Synthetic sessions are placeholders created during
 * pipeline dedup and should not appear in any view.
 * Idempotent — tracked via _meta key 'migration:purge_synthetic_v2'.
 */
function runMigrationPurgeSyntheticV2(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:purge_synthetic_v2'");
  if (already) return;

  console.log("[ingest:migration] Running purge_synthetic_v2 — removing '<synthetic>' sessions…");

  run("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
  run("DELETE FROM sessions WHERE model = '<synthetic>'");

  run("INSERT INTO _meta (key, value) VALUES ('migration:purge_synthetic_v2', '1')");
  console.log('[ingest:migration] purge_synthetic_v2 complete');
}

/**
 * One-time migration: reset cost and model on virtual (subagent) sessions
 * so the fixed upsert (which now includes model = excluded.model) can
 * re-apply the correct model and recompute cost on the next ingest.
 * Idempotent — tracked via _meta key 'migration:subagent_model_fix_v1'.
 */
function runMigrationSubagentModelFixV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:subagent_model_fix_v1'");
  if (already) return;

  console.log("[ingest:migration] Running subagent_model_fix_v1 — resetting model/cost on virtual sessions…");

  // Reset model and cost on all virtual (subagent) sessions so the corrected
  // upsert will re-apply the right model string and recompute cost on ingest.
  run("UPDATE sessions SET cost = 0, model = 'unknown' WHERE id LIKE '%::%'");

  // Delete token_events for virtual sessions so cost is recomputed cleanly
  run("DELETE FROM token_events WHERE session_id LIKE '%::%'");

  // Reset ingest offsets for session parsers so virtual sessions are re-processed
  run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:session:%'");

  run("INSERT INTO _meta (key, value) VALUES ('migration:subagent_model_fix_v1', '1')");
  console.log('[ingest:migration] subagent_model_fix_v1 complete');
}

/**
 * One-time migration: delete quota_snapshots with window_type='unknown'
 * (created from error responses) and re-parse from scratch.
 */
function runMigrationQuotaErrorFilterV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:quota_error_filter_v1'");
  if (already) return;

  console.log('[ingest:migration] Running quota_error_filter_v1 — removing error-originated quota rows…');

  run("DELETE FROM quota_snapshots WHERE window_type = 'unknown'");
  run("DELETE FROM _meta WHERE key = 'ingest_offset:quota-history'");

  run("INSERT INTO _meta (key, value) VALUES ('migration:quota_error_filter_v1', '1')");
  console.log('[ingest:migration] quota_error_filter_v1 complete');
}

/**
 * One-time migration: deduplicate quota_snapshots and add a unique index to
 * prevent future duplicates on (captured_at, window_type, user).
 * Idempotent — tracked via _meta key 'migration:quota_unique_index_v1'.
 */
function runMigrationQuotaUniqueIndexV1(): void {
  const already = get("SELECT value FROM _meta WHERE key = 'migration:quota_unique_index_v1'");
  if (already) return;

  console.log('[ingest:migration] Running quota_unique_index_v1 — deduplicating quota_snapshots + adding unique index…');

  run(`DELETE FROM quota_snapshots WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM quota_snapshots GROUP BY captured_at, window_type, user
  )`);
  run('CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_unique ON quota_snapshots(captured_at, window_type, user)');

  run("INSERT INTO _meta (key, value) VALUES ('migration:quota_unique_index_v1', '1')");
  console.log('[ingest:migration] quota_unique_index_v1 complete');
}

export async function runIngestion(deepflowDir?: string): Promise<void> {
  const claudeDir = resolve(homedir(), '.claude');
  const dfDir = deepflowDir ?? resolve(process.cwd(), '.deepflow');

  console.log('[ingest] Starting ingestion…');

  // Run one-time migrations before parsers
  runMigrationSessionReparseV1();
  runMigrationToolQuotaReparseV1();
  runMigrationCostReparseV1();
  runMigrationCacheBreakdownV1();
  runMigrationPipelineCriticalV1();
  runMigrationPurgeSyntheticV2();
  runMigrationSubagentModelFixV1();
  runMigrationQuotaErrorFilterV1();
  runMigrationQuotaUniqueIndexV1();
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
