#!/usr/bin/env node
/**
 * df-filter-suggest — read .deepflow/bash-telemetry.jsonl, rank verbose
 * command patterns, and (optionally) propose filter candidates.
 *
 * Verbosity score per normalized pattern:
 *   verbosity_score = frequency × avg_lines × follow_up_rate
 *
 *     frequency       = N (number of occurrences of the pattern)
 *     avg_lines       = mean raw_lines across occurrences
 *     follow_up_rate  = fraction of occurrences where follow_up_within_ms
 *                       is non-null AND below FOLLOW_UP_WINDOW_MS (default 10_000)
 *
 * Only patterns with N >= MIN_OBSERVATIONS (default 5) are eligible for
 * suggestion (REQ-6, REQ-9). This keeps the signal conservative — rare
 * patterns never get auto-promoted.
 *
 * Modes:
 *   (default)  — print a ranked ASCII table to stdout; exit 0
 *   --propose  — additionally write .deepflow/filters-proposed.yaml with
 *                {pattern, template, score, mode: 'auto'|'llm', createdAt}
 *                via atomicWriteFileSync.
 *
 *   DF_FILTER_LLM=1  — enables the LLM-synthesis branch (mode: 'llm');
 *                      when unset the LLM branch is skipped entirely (REQ-7).
 *
 * Usage:
 *   node bin/df-filter-suggest.js [--telemetry <file>] [--out <file>]
 *                                 [--min-observations <N>] [--propose] [--help]
 *
 * Shape follows bin/lineage-ingest.js (reads state → writes .deepflow/*).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { atomicWriteFileSync } = require('../hooks/lib/installer-utils');
const { BUILTIN_TEMPLATE_NAMES } = require('../hooks/lib/filter-dispatch');

const DEFAULT_TELEMETRY     = path.join('.deepflow', 'bash-telemetry.jsonl');
const DEFAULT_OUT           = path.join('.deepflow', 'filters-proposed.yaml');
const DEFAULT_MIN_OBS       = 5;
const FOLLOW_UP_WINDOW_MS   = 10_000;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(args, flag) {
  return args.indexOf(flag) >= 0;
}

function printHelp() {
  process.stdout.write([
    'df-filter-suggest — rank verbose Bash patterns from telemetry',
    '',
    'Usage:',
    '  node bin/df-filter-suggest.js [options]',
    '',
    'Options:',
    '  --telemetry <file>         Path to bash-telemetry.jsonl',
    `                             (default: ${DEFAULT_TELEMETRY})`,
    '  --out <file>               Output path for --propose mode',
    `                             (default: ${DEFAULT_OUT})`,
    `  --min-observations <N>     Minimum occurrences per pattern (default: ${DEFAULT_MIN_OBS})`,
    '  --propose                  Write ranked candidates to --out as YAML',
    '  --help                     Show this help',
    '',
    'Env:',
    '  DF_FILTER_LLM=1            Enable LLM-assisted synthesis (mode: llm)',
    '',
    'Scoring:',
    '  verbosity_score = frequency × avg_lines × follow_up_rate',
    '  Patterns with fewer than min-observations occurrences are excluded.',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Telemetry reading / grouping
// ---------------------------------------------------------------------------

/**
 * Read a JSONL file and return an array of parsed records.
 * Malformed lines are skipped silently.
 */
function readTelemetry(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (_) {
      // Skip malformed row
    }
  }
  return records;
}

/**
 * Group records by normalized pattern and compute per-group aggregates.
 *
 * @param {Array<Object>} records
 * @returns {Map<string, {frequency, avgLines, followUpRate}>}
 */
function groupByPattern(records) {
  const groups = new Map();

  for (const rec of records) {
    if (!rec || typeof rec.pattern !== 'string') continue;
    const key = rec.pattern;
    if (!groups.has(key)) {
      groups.set(key, { lines: [], followUps: [] });
    }
    const g = groups.get(key);
    if (typeof rec.raw_lines === 'number') g.lines.push(rec.raw_lines);
    // follow_up_within_ms is null on first observation — treat null as "no follow-up"
    const fu = rec.follow_up_within_ms;
    g.followUps.push(typeof fu === 'number' && fu < FOLLOW_UP_WINDOW_MS ? 1 : 0);
  }

  const out = new Map();
  for (const [pattern, g] of groups) {
    const frequency = g.lines.length || g.followUps.length;
    const avgLines  = g.lines.length
      ? g.lines.reduce((s, v) => s + v, 0) / g.lines.length
      : 0;
    const followUpRate = g.followUps.length
      ? g.followUps.reduce((s, v) => s + v, 0) / g.followUps.length
      : 0;
    out.set(pattern, { frequency, avgLines, followUpRate });
  }
  return out;
}

/**
 * Compute verbosity scores and filter out patterns below the N-gate.
 * Returns an array sorted descending by score.
 */
function rankPatterns(groups, minObservations) {
  const ranked = [];
  for (const [pattern, agg] of groups) {
    if (agg.frequency < minObservations) continue;
    const score = agg.frequency * agg.avgLines * agg.followUpRate;
    ranked.push({
      pattern,
      frequency: agg.frequency,
      avgLines: agg.avgLines,
      followUpRate: agg.followUpRate,
      score,
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

// ---------------------------------------------------------------------------
// Template matching (deterministic auto-proposal)
// ---------------------------------------------------------------------------

/**
 * Heuristically suggest which built-in archetype template fits a pattern.
 * This is the deterministic branch of REQ-7 (mode: 'auto').
 *
 * Matchers are conservative keyword rules. If none fit, returns 'truncate-stable'
 * as the safe default (it never loses signal — just caps length).
 *
 * @param {string} pattern — normalized argv pattern
 * @returns {string} template name from BUILTIN_TEMPLATE_NAMES
 */
function suggestTemplate(pattern) {
  const p = pattern.toLowerCase();

  if (/\bgit\s+diff\b/.test(p) && /--stat\b/.test(p))                return 'diff-stat-only';
  if (/\bgit\s+diff\b/.test(p))                                       return 'diff-stat-only';
  if (/\bjq\b|\bjson\b/.test(p))                                      return 'json-project';
  if (/\brealpath\b|\breadlink\b/.test(p))                            return 'resolve-and-report';
  if (/\bgrep\b|\brg\b|\btest\b|\bjest\b|\bpytest\b/.test(p))         return 'failures-only';
  if (/\btree\b|\bdu\b/.test(p))                                      return 'summarize-tree';
  if (/\bls\s|\bls$/.test(p))                                         return 'group-by-prefix';
  if (/\btail\b|\bhead\b|\bcat\b/.test(p))                            return 'head-tail-window';

  return 'truncate-stable';
}

// ---------------------------------------------------------------------------
// YAML serialization (minimal — no dependency)
// ---------------------------------------------------------------------------

function yamlEscape(s) {
  // Quote the string if it contains YAML-significant chars
  if (/[:#\-{}\[\],&*!|>%@`\n"']/.test(s) || /^\s|\s$/.test(s) || s === '') {
    return JSON.stringify(s); // JSON string ≈ double-quoted YAML scalar
  }
  return s;
}

function toYaml(proposals) {
  const lines = ['# Auto-generated by bin/df-filter-suggest.js', 'proposals:'];
  if (proposals.length === 0) {
    lines.push('  []');
    return lines.join('\n') + '\n';
  }
  for (const p of proposals) {
    lines.push(`  - pattern: ${yamlEscape(p.pattern)}`);
    lines.push(`    template: ${yamlEscape(p.template)}`);
    lines.push(`    score: ${p.score.toFixed(4)}`);
    lines.push(`    mode: ${p.mode}`);
    lines.push(`    createdAt: ${yamlEscape(p.createdAt)}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printRankedTable(ranked) {
  if (ranked.length === 0) {
    process.stdout.write('df-filter-suggest: no patterns meet the observation threshold.\n');
    return;
  }
  const header = ['score', 'freq', 'avg_lines', 'fu_rate', 'pattern'];
  const rows = ranked.map(r => [
    r.score.toFixed(2),
    String(r.frequency),
    r.avgLines.toFixed(1),
    r.followUpRate.toFixed(2),
    r.pattern,
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const fmt = (cells) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  process.stdout.write(fmt(header) + '\n');
  process.stdout.write(widths.map(w => '-'.repeat(w)).join('  ') + '\n');
  for (const row of rows) process.stdout.write(fmt(row) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv || process.argv.slice(2);

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    return 0;
  }

  const telemetryFile  = getArg(args, '--telemetry') || DEFAULT_TELEMETRY;
  const outFile        = getArg(args, '--out')       || DEFAULT_OUT;
  const minObsRaw      = getArg(args, '--min-observations');
  const minObservations = minObsRaw ? parseInt(minObsRaw, 10) : DEFAULT_MIN_OBS;
  const propose        = hasFlag(args, '--propose');
  const llmEnabled     = process.env.DF_FILTER_LLM === '1';

  if (!Number.isFinite(minObservations) || minObservations < 1) {
    process.stderr.write(`df-filter-suggest: invalid --min-observations: ${minObsRaw}\n`);
    return 2;
  }

  const records  = readTelemetry(telemetryFile);
  const groups   = groupByPattern(records);
  const ranked   = rankPatterns(groups, minObservations);

  printRankedTable(ranked);

  if (!propose) return 0;

  // Build proposals. Deterministic (mode: 'auto') always runs.
  // LLM (mode: 'llm') only when DF_FILTER_LLM=1 — currently a stub that emits
  // a sentinel template name; real LLM synthesis will be wired via subagent.
  const now = new Date().toISOString();
  const proposals = ranked.map(r => ({
    pattern:   r.pattern,
    template:  suggestTemplate(r.pattern),
    score:     r.score,
    mode:      'auto',
    createdAt: now,
  }));

  if (llmEnabled) {
    // LLM-synthesis stub: annotate each auto proposal with an llm twin so
    // reviewers can diff the deterministic vs model-suggested template.
    // Actual model invocation is deferred to a subagent (out of T21 scope).
    for (const r of ranked) {
      proposals.push({
        pattern:   r.pattern,
        template:  `llm:${suggestTemplate(r.pattern)}`,
        score:     r.score,
        mode:      'llm',
        createdAt: now,
      });
    }
  }

  // Ensure output dir exists before atomic write
  const outDir = path.dirname(outFile);
  if (outDir && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const yaml = toYaml(proposals);
  atomicWriteFileSync(outFile, yaml);

  process.stdout.write(
    `df-filter-suggest: ${proposals.length} proposals written to ${outFile}` +
    (llmEnabled ? ' (LLM mode on)' : '') + '\n'
  );
  return 0;
}

module.exports = {
  main,
  readTelemetry,
  groupByPattern,
  rankPatterns,
  suggestTemplate,
  toYaml,
  FOLLOW_UP_WINDOW_MS,
  DEFAULT_MIN_OBS,
  BUILTIN_TEMPLATE_NAMES,
};

if (require.main === module) {
  process.exit(main());
}
