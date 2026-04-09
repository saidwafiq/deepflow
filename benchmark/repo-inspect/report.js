'use strict';

/**
 * Reads per-approach metric outputs, invokes score.js, renders comparison
 * table to stdout and overwrites benchmark/repo-inspect/results.md.
 *
 * Usage: node report.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BENCH_DIR = __dirname;
const SUMMARY_FILE = path.join(BENCH_DIR, 'summary.json');
const RESULTS_FILE = path.join(BENCH_DIR, 'results.md');
const SCORE_SCRIPT = path.join(BENCH_DIR, 'score.js');

/**
 * Invoke score.js on a given output file and return { score, checks }.
 * Returns { score: 0, checks: [] } on failure.
 *
 * @param {string} outputFile
 * @returns {{ score: number, checks: object[] }}
 */
function runScore(outputFile) {
  if (!fs.existsSync(outputFile)) {
    return { score: 0, checks: [{ name: 'output file exists', passed: false, reason: `${outputFile} not found` }] };
  }
  const result = spawnSync(process.execPath, [SCORE_SCRIPT, outputFile], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0 || !result.stdout) {
    return { score: 0, checks: [{ name: 'score.js execution', passed: false, reason: result.stderr || 'no output' }] };
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    return { score: 0, checks: [{ name: 'score.js JSON parse', passed: false, reason: e.message }] };
  }
}

/**
 * Format a number for table display. Returns 'N/A' for null/undefined.
 *
 * @param {number|null|undefined} val
 * @param {number} [decimals]
 * @returns {string}
 */
function fmt(val, decimals) {
  if (val === null || val === undefined) return 'N/A';
  return decimals !== undefined ? val.toFixed(decimals) : String(val);
}

/**
 * Mark the winning cell index in an array of numbers.
 * lowerIsBetter=true  → winner is the minimum.
 * lowerIsBetter=false → winner is the maximum.
 *
 * @param {number[]} values
 * @param {boolean} lowerIsBetter
 * @returns {number} index of winner, or -1 if all N/A
 */
function winnerIndex(values, lowerIsBetter) {
  const valid = values.map((v, i) => ({ v, i })).filter(x => x.v !== null && x.v !== undefined);
  if (!valid.length) return -1;
  const best = valid.reduce((acc, cur) =>
    lowerIsBetter ? (cur.v < acc.v ? cur : acc) : (cur.v > acc.v ? cur : acc)
  );
  return best.i;
}

/**
 * Build a markdown table string from headers and rows.
 * Rows is array of string arrays (same length as headers).
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function markdownTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length))
  );
  const pad = (s, w) => s + ' '.repeat(w - s.length);
  const headerRow = '| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |';
  const sepRow   = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const dataRows = rows.map(r =>
    '| ' + r.map((cell, i) => pad(cell || '', widths[i])).join(' | ') + ' |'
  );
  return [headerRow, sepRow, ...dataRows].join('\n');
}

async function main() {
  // Load summary.json
  if (!fs.existsSync(SUMMARY_FILE)) {
    console.error(`[report.js] summary.json not found at ${SUMMARY_FILE}`);
    console.error('[report.js] Run `node run.js` first to generate benchmark data.');
    process.exit(1);
  }

  const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
  const records = summary.approaches; // array of per-approach records

  // Build per-approach data rows, scoring each
  const rows = records.map(r => {
    const m = r.metrics || {};
    const outputFile = path.join(BENCH_DIR, `output-${r.approach}.json`);
    const scoreResult = runScore(outputFile);
    return {
      id: r.approach.toUpperCase(),
      label: r.label,
      status: r.status,
      total_tokens: m.total_tokens ?? null,
      tool_calls_count: m.tool_calls_count ?? null,
      wall_time_ms: r.wall_time_ms ?? null,
      quality_score: scoreResult.score,
      cache_ratio: m.cache_ratio ?? null,
      context_burn: m.context_burn ?? null,
    };
  });

  // Determine winners per metric
  const winners = {
    total_tokens:    winnerIndex(rows.map(r => r.total_tokens), true),
    tool_calls_count: winnerIndex(rows.map(r => r.tool_calls_count), true),
    wall_time_ms:    winnerIndex(rows.map(r => r.wall_time_ms), true),
    quality_score:   winnerIndex(rows.map(r => r.quality_score), false),
    cache_ratio:     winnerIndex(rows.map(r => r.cache_ratio), false),
    context_burn:    winnerIndex(rows.map(r => r.context_burn), true),
  };

  // Annotate winner cells with *
  function cell(rows, idx, field, decimals) {
    const val = rows[idx][field];
    const str = fmt(val, decimals);
    return winners[field] === idx ? `**${str}**` : str;
  }

  const tableHeaders = [
    'Approach', 'Status', 'Total Tokens', 'Tool Calls', 'Wall Time (ms)',
    'Quality (0-8)', 'Cache Ratio', 'Context Burn %',
  ];

  const tableRows = rows.map((r, i) => [
    `${r.id} (${r.id === 'A' ? 'browse-fetch' : r.id === 'B' ? 'WebFetch+gh' : 'local-clone'})`,
    r.status,
    cell(rows, i, 'total_tokens'),
    cell(rows, i, 'tool_calls_count'),
    cell(rows, i, 'wall_time_ms'),
    cell(rows, i, 'quality_score'),
    cell(rows, i, 'cache_ratio', 3),
    cell(rows, i, 'context_burn'),
  ]);

  const table = markdownTable(tableHeaders, tableRows);

  // Compute winner summary line
  const metricLabels = {
    total_tokens: 'Total Tokens',
    tool_calls_count: 'Tool Calls',
    wall_time_ms: 'Wall Time',
    quality_score: 'Quality Score',
    cache_ratio: 'Cache Ratio',
    context_burn: 'Context Burn',
  };
  const winnerLines = Object.entries(winners)
    .filter(([, idx]) => idx >= 0)
    .map(([metric, idx]) => `- **${metricLabels[metric]}**: ${rows[idx].id}`);

  // Build markdown document
  const md = [
    '# Repo-Inspect Benchmark Results',
    '',
    `Run at: ${summary.run_at}`,
    `Timeout per approach: ${summary.timeout_per_approach_ms / 1000}s`,
    '',
    '## Comparison Table',
    '',
    '> **Bold** values indicate the winner for that metric.',
    '',
    table,
    '',
    '## Winners by Metric',
    '',
    ...winnerLines,
    '',
    '## Notes',
    '',
    '- Quality score: 0–8 checks (see `score.js`). Higher is better.',
    '- Cache ratio: cache_read_tokens / total_tokens. Higher is better.',
    '- Context burn: estimated % of context window consumed. Lower is better.',
    '- Tool calls: total tool invocations. Lower is better.',
    '',
  ].join('\n');

  // Write results.md
  fs.writeFileSync(RESULTS_FILE, md, 'utf8');

  // Print to stdout
  console.log(md);
  console.log(`[report.js] Results written to ${RESULTS_FILE}`);
}

main().catch(err => {
  console.error('[report.js] Fatal error:', err);
  process.exit(2);
});
