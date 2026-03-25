'use strict';

/**
 * Metric collector for df:eval.
 *
 * Reads `.deepflow/token-history.jsonl` and `~/.claude/tool-usage.jsonl`
 * from existing hook outputs — no new instrumentation hooks installed (AC-17).
 *
 * Metric source mapping (from spec doing-skill-eval.md):
 *   cache_ratio   = cache_read_input_tokens / input_tokens
 *   total_tokens  = sum of (input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens) per entry
 *   wall_time     = endTimestamp - startTimestamp (ms)
 *   context_burn  = max used_percentage across entries
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

/**
 * Parse a JSONL file, yielding one parsed object per line.
 * Lines that are empty or fail to parse are silently skipped.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function readJsonl(filePath) {
  const entries = [];
  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch (_) {
    return entries;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      // skip malformed lines
    }
  }

  return entries;
}

/**
 * Filter entries whose `timestamp` field falls within [startTimestamp, endTimestamp].
 * If startTimestamp or endTimestamp is null/undefined, that bound is open.
 *
 * @param {object[]} entries
 * @param {number|null} startTimestamp  — ms since epoch (inclusive)
 * @param {number|null} endTimestamp    — ms since epoch (inclusive)
 * @returns {object[]}
 */
function filterByRange(entries, startTimestamp, endTimestamp) {
  return entries.filter((e) => {
    const ts = new Date(e.timestamp).getTime();
    if (isNaN(ts)) return false;
    if (startTimestamp != null && ts < startTimestamp) return false;
    if (endTimestamp != null && ts > endTimestamp) return false;
    return true;
  });
}

/**
 * Collect evaluation metrics from existing hook output files.
 *
 * AC-16: reads `.deepflow/token-history.jsonl` from the fixture's execution
 *        to compute cache_ratio (cache_read / input_tokens) and total_tokens.
 * AC-17: metrics sourced from existing hook outputs; no new hooks installed.
 *
 * @param {string} deepflowDir   — path to the fixture's `.deepflow/` directory
 * @param {number|null} startTimestamp — ms since epoch; open bound if null
 * @param {number|null} endTimestamp   — ms since epoch; open bound if null
 * @returns {Promise<{
 *   cache_ratio: number,
 *   total_tokens: number,
 *   wall_time: number,
 *   context_burn: number,
 *   entry_count: number
 * }>}
 */
async function collectMetrics(deepflowDir, startTimestamp = null, endTimestamp = null) {
  const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

  const allEntries = await readJsonl(tokenHistoryPath);
  const entries = filterByRange(allEntries, startTimestamp, endTimestamp);

  let sumInputTokens = 0;
  let sumCacheRead = 0;
  let sumCacheCreation = 0;
  let sumOutputTokens = 0;
  let maxUsedPercentage = 0;

  for (const e of entries) {
    const inputTokens = Number(e.input_tokens) || 0;
    const cacheRead = Number(e.cache_read_input_tokens) || 0;
    const cacheCreation = Number(e.cache_creation_input_tokens) || 0;
    const outputTokens = Number(e.output_tokens) || 0;
    const usedPct = Number(e.used_percentage) || 0;

    sumInputTokens += inputTokens;
    sumCacheRead += cacheRead;
    sumCacheCreation += cacheCreation;
    sumOutputTokens += outputTokens;

    if (usedPct > maxUsedPercentage) {
      maxUsedPercentage = usedPct;
    }
  }

  // cache_ratio: fraction of input tokens served from cache.
  // Use sumInputTokens as denominator; guard against division-by-zero.
  const cache_ratio = sumInputTokens > 0 ? sumCacheRead / sumInputTokens : 0;

  // total_tokens: all tokens consumed — input (fresh + cache-creation + cache-read) + output.
  const total_tokens = sumInputTokens + sumCacheCreation + sumCacheRead + sumOutputTokens;

  // wall_time: caller-supplied timestamp delta in ms.
  const wall_time =
    startTimestamp != null && endTimestamp != null
      ? endTimestamp - startTimestamp
      : 0;

  // context_burn: peak context window utilisation across entries.
  const context_burn = maxUsedPercentage;

  return {
    cache_ratio,
    total_tokens,
    wall_time,
    context_burn,
    entry_count: entries.length,
  };
}

/**
 * Read tool-usage entries from `~/.claude/tool-usage.jsonl` filtered by range.
 * Provided for orchestrator use; secondary metric source (REQ-10).
 *
 * @param {number|null} startTimestamp
 * @param {number|null} endTimestamp
 * @returns {Promise<object[]>}
 */
async function readToolUsage(startTimestamp = null, endTimestamp = null) {
  const toolUsagePath = path.join(os.homedir(), '.claude', 'tool-usage.jsonl');
  const allEntries = await readJsonl(toolUsagePath);
  return filterByRange(allEntries, startTimestamp, endTimestamp);
}

module.exports = {
  collectMetrics,
  readToolUsage,
  // exported for testing / orchestrator composition
  readJsonl,
  filterByRange,
};
