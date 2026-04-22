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
const DEFAULT_CANARY        = path.join('.deepflow', 'auto-filter-canary.jsonl');
const DEFAULT_MIN_OBS       = 5;
const FOLLOW_UP_WINDOW_MS   = 10_000;
const PROMOTE_THRESHOLD     = 20;

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
    '  --canary <file>            Path to auto-filter-canary.jsonl (for --promote)',
    `                             (default: ${DEFAULT_CANARY})`,
    `  --min-observations <N>     Minimum occurrences per pattern (default: ${DEFAULT_MIN_OBS})`,
    '  --propose                  Write ranked candidates to --out as YAML',
    `  --promote                  Promote proposals with >=${PROMOTE_THRESHOLD} canary rows and zero signal_lost`,
    '                             to hooks/filters/generated/{name}.js',
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
// YAML parsing (minimal — covers the format written by toYaml above)
// ---------------------------------------------------------------------------

/**
 * Parse the filters-proposed.yaml format produced by toYaml().
 * Returns an array of proposal objects.
 * Keys parsed: pattern, template, score, mode, createdAt, name, archetype.
 *
 * The format is a hand-rolled YAML where each proposal is a sequence item
 * under a 'proposals:' key. We parse line-by-line to avoid an external dep.
 */
function parseProposalsYaml(text) {
  const proposals = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();

    // Start of a new list item
    if (/^\s{2}-\s+\w+:/.test(line)) {
      if (current) proposals.push(current);
      current = {};
      // Also parse the key-value on the same line as the dash
      const m = line.match(/^\s{2}-\s+(\w+):\s*(.*)/);
      if (m) current[m[1]] = unquoteYamlScalar(m[2]);
      continue;
    }

    // Continuation key-value inside a list item
    if (current && /^\s{4}\w+:/.test(line)) {
      const m = line.match(/^\s{4}(\w+):\s*(.*)/);
      if (m) current[m[1]] = unquoteYamlScalar(m[2]);
      continue;
    }
  }

  if (current) proposals.push(current);
  return proposals;
}

/**
 * Reverse the escaping applied by yamlEscape(): strip surrounding double-quotes
 * if present (JSON-quoted scalar) and unescape JSON escape sequences.
 */
function unquoteYamlScalar(s) {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch (_) { return t; }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Canary grouping
// ---------------------------------------------------------------------------

/**
 * Read auto-filter-canary.jsonl and group rows by filter name.
 * Returns a Map<filterName, {count: number, signalLostCount: number}>.
 */
function groupCanaryRows(file) {
  const records = readTelemetry(file); // reuse the JSONL reader
  const groups = new Map();

  for (const rec of records) {
    if (!rec || typeof rec.filter !== 'string') continue;
    const key = rec.filter;
    if (!groups.has(key)) groups.set(key, { count: 0, signalLostCount: 0 });
    const g = groups.get(key);
    g.count += 1;
    if (rec.signal_lost === true) g.signalLostCount += 1;
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Promote logic
// ---------------------------------------------------------------------------

/**
 * Promote proposals that have accumulated >= PROMOTE_THRESHOLD canary rows
 * with zero signal_lost=true rows.
 *
 * @param {string} proposalsFile — path to filters-proposed.yaml
 * @param {string} canaryFile    — path to auto-filter-canary.jsonl
 * @param {string} templatesDir  — path to hooks/filters/templates/
 * @param {string} generatedDir  — path to hooks/filters/generated/
 * @returns {{ promoted: number, remaining: number }}
 */
function promoteFilters(proposalsFile, canaryFile, templatesDir, generatedDir) {
  if (!fs.existsSync(proposalsFile)) {
    process.stdout.write('df-filter-suggest --promote: no proposals file found.\n');
    return { promoted: 0, remaining: 0 };
  }

  const proposalsText = fs.readFileSync(proposalsFile, 'utf8');
  const proposals = parseProposalsYaml(proposalsText);
  const canaryGroups = groupCanaryRows(canaryFile);

  const remaining = [];
  let promotedCount = 0;

  for (const proposal of proposals) {
    // Derive the filter name used in canary rows: prefer 'name', fall back to 'template'
    const filterName = proposal.name || proposal.template;
    const archetype  = proposal.archetype || proposal.template;

    if (!filterName || !archetype) {
      // Incomplete proposal — keep as-is
      remaining.push(proposal);
      continue;
    }

    const canary = canaryGroups.get(filterName);
    const count  = canary ? canary.count : 0;
    const signalLostCount = canary ? canary.signalLostCount : 0;

    if (count >= PROMOTE_THRESHOLD && signalLostCount === 0) {
      // Create generated/ dir if needed
      fs.mkdirSync(generatedDir, { recursive: true });

      const src  = path.join(templatesDir, `${archetype}.js`);
      const dest = path.join(generatedDir, `${filterName}.js`);

      if (!fs.existsSync(src)) {
        // Template file missing — leave proposal in place, warn
        process.stderr.write(
          `df-filter-suggest --promote: template not found: ${src} (skipping ${filterName})\n`
        );
        remaining.push(proposal);
        continue;
      }

      fs.copyFileSync(src, dest);
      promotedCount += 1;
    } else {
      remaining.push(proposal);
    }
  }

  // Rewrite proposals file with only the remaining (non-promoted) entries
  const newYaml = toYaml(remaining.map(p => ({
    pattern:   p.pattern   || '',
    template:  p.template  || p.archetype || '',
    score:     parseFloat(p.score) || 0,
    mode:      p.mode      || 'auto',
    createdAt: p.createdAt || new Date().toISOString(),
  })));
  atomicWriteFileSync(proposalsFile, newYaml);

  process.stdout.write(
    `df-filter-suggest: ${promotedCount} promoted, ${remaining.length} remaining\n`
  );
  return { promoted: promotedCount, remaining: remaining.length };
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
  const canaryFile     = getArg(args, '--canary')    || DEFAULT_CANARY;
  const minObsRaw      = getArg(args, '--min-observations');
  const minObservations = minObsRaw ? parseInt(minObsRaw, 10) : DEFAULT_MIN_OBS;
  const propose        = hasFlag(args, '--propose');
  const promote        = hasFlag(args, '--promote');
  const llmEnabled     = process.env.DF_FILTER_LLM === '1';

  if (!Number.isFinite(minObservations) || minObservations < 1) {
    process.stderr.write(`df-filter-suggest: invalid --min-observations: ${minObsRaw}\n`);
    return 2;
  }

  const records  = readTelemetry(telemetryFile);
  const groups   = groupByPattern(records);
  const ranked   = rankPatterns(groups, minObservations);

  printRankedTable(ranked);

  if (promote) {
    const templatesDir = path.join('hooks', 'filters', 'templates');
    const generatedDir = path.join('hooks', 'filters', 'generated');
    promoteFilters(outFile, canaryFile, templatesDir, generatedDir);
    return 0;
  }

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
  parseProposalsYaml,
  groupCanaryRows,
  promoteFilters,
  FOLLOW_UP_WINDOW_MS,
  DEFAULT_MIN_OBS,
  PROMOTE_THRESHOLD,
  BUILTIN_TEMPLATE_NAMES,
};

if (require.main === module) {
  process.exit(main());
}
