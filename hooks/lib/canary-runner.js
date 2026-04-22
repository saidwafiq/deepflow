'use strict';

/**
 * canary-runner — fire-and-forget signal-loss measurement for proposed filters.
 *
 * Exports:
 *   runCanary(cmd, rawOutput, proposedFilterFn, canaryPath)
 *     Forks a detached child process (SPIKE-A pattern) that:
 *       1. Applies the proposedFilterFn to rawOutput.
 *       2. Applies the raw (identity) pass-through.
 *       3. Computes signal_lost via detectSignalLoss.
 *       4. Appends one JSONL row to canaryPath.
 *
 *     The caller MUST NOT await this — it is fire-and-forget.
 *     The hook PreToolUse path is never blocked by canary work.
 *
 * Child process communication:
 *   - Parent JSON-encodes {filterName,rawOutput,filteredOutput,cmd} and base64s it.
 *   - Parent spawns: node <this-file> <base64Payload> <canaryPath>
 *     (no temp file written — avoids synchronous disk I/O in the hot path)
 *   - Child decodes the argv payload, processes, appends JSONL.
 *
 * JSONL row shape:
 *   { filter: string, raw_signal_tokens: number, filtered_signal_tokens: number,
 *     signal_lost: boolean }
 *
 * Error handling:
 *   - No try/catch around spawn() — if it fails, fail-open (canary is observational).
 *   - Child wraps all I/O in try/catch; never throws to parent.
 */

'use strict'; // (duplicate pragma harmless — belt-and-suspenders for strict mode in child branch)

const path  = require('node:path');
const fs    = require('node:fs');
const { spawn } = require('node:child_process');

const { countIndicators } = require('./signal-loss-detector');
const { detectSignalLoss } = require('./signal-loss-detector');

// ---------------------------------------------------------------------------
// Child branch — runs when this module is invoked directly by the spawned child
// ---------------------------------------------------------------------------

if (require.main === module) {
  // argv: node canary-runner.js <base64Payload> <canaryPath>
  // base64Payload is a base64-encoded JSON string with fields:
  //   { filterName, rawOutput, filteredOutput, cmd }
  // This avoids writing a temp file in the parent process (hot-path optimisation).
  const base64Payload = process.argv[2];
  const canaryPath    = process.argv[3];

  if (!base64Payload || !canaryPath) {
    process.exit(0); // Missing args — bail silently.
  }

  try {
    const raw  = Buffer.from(base64Payload, 'base64').toString('utf8');
    const data = JSON.parse(raw);

    const { filterName, rawOutput, filteredOutput } = data;

    const rawIndicators      = countIndicators(rawOutput  || '');
    const filteredIndicators = countIndicators(filteredOutput || '');
    const signal_lost        = detectSignalLoss(rawOutput || '', filteredOutput || '');

    const record = {
      filter:                filterName,
      raw_signal_tokens:     rawIndicators,
      filtered_signal_tokens: filteredIndicators,
      signal_lost,
    };

    // Ensure parent directory exists.
    fs.mkdirSync(path.dirname(canaryPath), { recursive: true });
    fs.appendFileSync(canaryPath, JSON.stringify(record) + '\n');

  } catch (_) {
    // Never throw from child — child is observational only.
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent API — exported for use in df-bash-rewrite.js
// ---------------------------------------------------------------------------

/**
 * Apply a proposed filter function to rawOutput and return the filtered string.
 * The filter's apply() method returns an object; we extract displayText or
 * fall back to JSON.stringify so we always get a string for indicator counting.
 *
 * @param {Function} proposedFilterFn — FilterTemplate.apply(rawOutput) → object
 * @param {string}   rawOutput
 * @returns {string}
 */
function applyFilter(proposedFilterFn, rawOutput) {
  try {
    const result = proposedFilterFn(rawOutput);
    if (typeof result === 'string') return result;
    if (result && typeof result.displayText === 'string') return result.displayText;
    if (result && typeof result.summary === 'string') return result.summary;
    // Fall back to stable JSON representation for indicator counting.
    return JSON.stringify(result);
  } catch (_) {
    return rawOutput; // Filter crashed — treat as identity (no loss).
  }
}

/**
 * Fire-and-forget canary measurement.
 *
 * Spawns a detached child process (SPIKE-A: spawn+unref) that applies the
 * proposed filter to rawOutput, measures signal loss, and appends a JSONL row.
 *
 * @param {string}   cmd              — the raw Bash command string (used for logging)
 * @param {string}   rawOutput        — captured command output (may be empty)
 * @param {object}   proposedFilter   — FilterTemplate: { name, apply(raw) → object }
 * @param {string}   [canaryPath]     — absolute path to the JSONL file; defaults to
 *                                      path.join(process.cwd(), '.deepflow/auto-filter-canary.jsonl')
 */
function runCanary(cmd, rawOutput, proposedFilter, canaryPath) {
  const resolvedCanaryPath = canaryPath ||
    path.join(process.cwd(), '.deepflow', 'auto-filter-canary.jsonl');

  // Apply the proposed filter in the parent process so we can pass the result
  // as serialisable data to the child (functions cannot be serialised).
  const filteredOutput = applyFilter(proposedFilter.apply.bind(proposedFilter), rawOutput);

  // Encode payload as base64 JSON and pass via argv — avoids synchronous
  // writeFileSync in the hot path (eliminates ~5ms disk I/O per invocation).
  const payload = JSON.stringify({
    filterName:     proposedFilter.name || 'unknown',
    rawOutput:      rawOutput      || '',
    filteredOutput: filteredOutput || '',
    cmd,
  });
  const base64Payload = Buffer.from(payload, 'utf8').toString('base64');

  // Spawn the detached child — SPIKE-A pattern.
  const child = spawn(
    process.execPath,
    [__filename, base64Payload, resolvedCanaryPath],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  // No return value — fire-and-forget.
}

module.exports = { runCanary, applyFilter };
