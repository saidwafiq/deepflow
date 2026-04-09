'use strict';

/**
 * Sequential orchestrator for the repo-inspect benchmark.
 *
 * Runs approaches A, B, C one at a time (isolation requirement).
 * For each approach:
 *   - Records start/end timestamps (ISO 8601)
 *   - Spawns `claude --print` with the approach prompt, 300s timeout
 *   - Saves raw output to output-{a|b|c}.json
 *   - Collects token metrics from .deepflow/token-history.jsonl (windowed by run)
 *   - Counts tool_calls from ~/.claude/tool-usage.jsonl (windowed by run)
 *   - Records wall_time and timeout status
 *
 * After all runs: verifies timestamp ranges do not overlap (AC-8).
 * Writes summary to benchmark/repo-inspect/summary.json.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve paths relative to this script's location (benchmark/repo-inspect/)
const BENCH_DIR = __dirname;
const REPO_ROOT = path.resolve(BENCH_DIR, '..', '..');
const DEEPFLOW_DIR = path.join(REPO_ROOT, '.deepflow');

// Metric collector lives in src/eval/
const { collectMetrics, readJsonl, filterByRange } = require(
  path.join(REPO_ROOT, 'src', 'eval', 'metric-collector.js')
);

const TIMEOUT_MS = 300_000; // 300 seconds per AC-9

const APPROACHES = [
  { id: 'a', label: 'Approach A (browse-fetch)', promptFile: path.join(BENCH_DIR, 'approach-a.md') },
  { id: 'b', label: 'Approach B (WebFetch + gh api)', promptFile: path.join(BENCH_DIR, 'approach-b.md') },
  { id: 'c', label: 'Approach C (local clone)', promptFile: path.join(BENCH_DIR, 'approach-c.md') },
];

/**
 * Count tool calls from ~/.claude/tool-usage.jsonl within the timestamp window.
 * The spec calls this file "command-usage.jsonl" but the actual file on disk is
 * tool-usage.jsonl (same file referenced by metric-collector.readToolUsage).
 *
 * @param {number} startMs
 * @param {number} endMs
 * @returns {Promise<number>}
 */
async function countToolCalls(startMs, endMs) {
  const toolUsagePath = path.join(os.homedir(), '.claude', 'tool-usage.jsonl');
  let all;
  try {
    all = await readJsonl(toolUsagePath);
  } catch (_) {
    return 0;
  }
  const filtered = filterByRange(all, startMs, endMs);
  return filtered.length;
}

/**
 * Run a single approach and return its result record.
 *
 * @param {{ id: string, label: string, promptFile: string }} approach
 * @returns {Promise<object>}
 */
async function runApproach(approach) {
  const promptContent = fs.readFileSync(approach.promptFile, 'utf8');

  console.log(`\n[run.js] Starting ${approach.label} …`);

  const startIso = new Date().toISOString();
  const startMs = Date.now();

  const result = spawnSync(
    'claude',
    [
      '--print',
      '--dangerously-skip-permissions',
      '--max-budget-usd', '5',
      promptContent,
    ],
    {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      cwd: REPO_ROOT,
    }
  );

  const endMs = Date.now();
  const endIso = new Date().toISOString();

  const timedOut = result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT';

  // Save raw stdout to output-{id}.json regardless of success/timeout.
  const outputFile = path.join(BENCH_DIR, `output-${approach.id}.json`);
  let parsedOutput = null;
  const rawOutput = result.stdout || '';

  // Attempt to parse the output as JSON (the approaches produce JSON).
  // Try direct parse first, then extract from markdown code blocks.
  try {
    parsedOutput = JSON.parse(rawOutput.trim());
  } catch (_) {
    // Try extracting JSON from a ```json ... ``` code block.
    const codeBlockMatch = rawOutput.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
      try {
        parsedOutput = JSON.parse(codeBlockMatch[1].trim());
      } catch (_2) {
        // Still failed — leave as null.
      }
    }
    if (!parsedOutput) {
      // Try extracting any JSON object from the output.
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsedOutput = JSON.parse(jsonMatch[0]);
        } catch (_3) {
          // Truly non-JSON output — leave as null.
        }
      }
    }
  }

  // Write parsed JSON (if available) or raw output to the file.
  if (parsedOutput) {
    fs.writeFileSync(outputFile, JSON.stringify(parsedOutput, null, 2), 'utf8');
  } else {
    fs.writeFileSync(outputFile, rawOutput, 'utf8');
  }

  // Collect token metrics windowed by this run's timestamps.
  const tokenMetrics = await collectMetrics(DEEPFLOW_DIR, startMs, endMs);

  // Count tool calls from tool-usage.jsonl.
  const tool_calls_count = await countToolCalls(startMs, endMs);

  const record = {
    approach: approach.id,
    label: approach.label,
    status: timedOut ? 'timeout' : result.status === 0 ? 'success' : 'error',
    exit_code: result.status,
    start_iso: startIso,
    end_iso: endIso,
    start_ms: startMs,
    end_ms: endMs,
    wall_time_ms: endMs - startMs,
    output_file: outputFile,
    output_valid_json: parsedOutput !== null,
    metrics: {
      ...tokenMetrics,
      tool_calls_count,
    },
  };

  if (timedOut) {
    console.log(`[run.js] ${approach.label} TIMED OUT after ${record.wall_time_ms}ms`);
  } else {
    console.log(`[run.js] ${approach.label} finished in ${record.wall_time_ms}ms (exit ${result.status})`);
  }

  return record;
}

/**
 * Verify that no two timestamp ranges overlap (AC-8).
 * Ranges are [start_ms, end_ms] inclusive.
 *
 * @param {object[]} records
 * @returns {{ ok: boolean, violations: string[] }}
 */
function verifyNoOverlap(records) {
  const violations = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];
      // Overlap if a.start < b.end AND b.start < a.end
      if (a.start_ms < b.end_ms && b.start_ms < a.end_ms) {
        violations.push(
          `${a.approach} [${a.start_ms}–${a.end_ms}] overlaps ${b.approach} [${b.start_ms}–${b.end_ms}]`
        );
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

async function main() {
  console.log('[run.js] Starting repo-inspect benchmark (sequential)');
  console.log(`[run.js] Timeout per approach: ${TIMEOUT_MS / 1000}s`);
  console.log(`[run.js] Deepflow dir: ${DEEPFLOW_DIR}`);

  const records = [];

  // Sequential execution — never parallel (isolation requirement).
  for (const approach of APPROACHES) {
    const record = await runApproach(approach);
    records.push(record);
  }

  // AC-6: verify Approach C tmpdir cleaned up.
  const tmpdirExists = fs.existsSync('/tmp/hf-mount-inspect');
  if (tmpdirExists) {
    console.warn('[run.js] WARNING: /tmp/hf-mount-inspect still exists — cleaning up.');
    try { spawnSync('rm', ['-rf', '/tmp/hf-mount-inspect']); } catch (_) { /* best effort */ }
  } else {
    console.log('[run.js] AC-6 verified: /tmp/hf-mount-inspect cleaned up.');
  }

  // AC-8: verify non-overlapping timestamp ranges.
  const overlapCheck = verifyNoOverlap(records);
  if (!overlapCheck.ok) {
    console.error('[run.js] WARNING: Timestamp overlap detected!');
    for (const v of overlapCheck.violations) {
      console.error(`  - ${v}`);
    }
  } else {
    console.log('[run.js] AC-8 verified: timestamp ranges do not overlap.');
  }

  const summary = {
    benchmark: 'repo-inspect',
    run_at: new Date().toISOString(),
    timeout_per_approach_ms: TIMEOUT_MS,
    approaches: records,
    overlap_check: overlapCheck,
    tmpdir_cleanup: !tmpdirExists,
  };

  const summaryFile = path.join(BENCH_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[run.js] Summary written to ${summaryFile}`);

  // Print per-approach metrics table.
  console.log('\n--- Metrics Summary ---');
  for (const r of records) {
    console.log(`\n${r.label} (${r.status})`);
    console.log(`  wall_time:       ${r.wall_time_ms}ms`);
    console.log(`  total_tokens:    ${r.metrics.total_tokens}`);
    console.log(`  cache_ratio:     ${r.metrics.cache_ratio.toFixed(3)}`);
    console.log(`  context_burn:    ${r.metrics.context_burn}%`);
    console.log(`  tool_calls:      ${r.metrics.tool_calls_count}`);
    console.log(`  token_entries:   ${r.metrics.entry_count}`);
  }

  // Exit 0 as long as summary was written successfully.
  // Individual approach failures are recorded in the summary — report.js handles scoring.
  process.exit(0);
}

main().catch((err) => {
  console.error('[run.js] Fatal error:', err);
  process.exit(2);
});
