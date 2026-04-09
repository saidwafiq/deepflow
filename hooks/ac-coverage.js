#!/usr/bin/env node
/**
 * deepflow AC coverage checker
 * Standalone script called by the orchestrator after ratchet checks.
 *
 * Usage:
 *   node ac-coverage.js --spec <path> --output <text> --status <pass|fail|revert>
 *   node ac-coverage.js --spec <path> --output-file <path> --status <pass|fail|revert>
 *
 * Exit codes:
 *   0 — all ACs covered, no ACs in spec, or input status was fail/revert
 *   2 — SALVAGEABLE: missed ACs detected and input status was pass
 *   1 — script error only
 */

'use strict';

const fs = require('fs');

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec' && argv[i + 1]) { args.spec = argv[++i]; }
    else if (a === '--output' && argv[i + 1]) { args.output = argv[++i]; }
    else if (a === '--output-file' && argv[i + 1]) { args.outputFile = argv[++i]; }
    else if (a === '--status' && argv[i + 1]) { args.status = argv[++i]; }
  }
  return args;
}

// ── Section extraction ──────────────────────────────────────────────────────

/**
 * Extract content of `## Acceptance Criteria` section (up to next ## or EOF).
 * Returns null if the section is absent.
 */
function extractACSection(content) {
  const lines = content.split('\n');
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      if (capturing) break; // next section — stop
      if (/^acceptance criteria$/i.test(headerMatch[1].trim())) {
        capturing = true;
      }
      continue;
    }
    if (capturing) {
      captured.push(line);
    }
  }

  return capturing ? captured.join('\n') : null;
}

// ── AC extraction from spec ─────────────────────────────────────────────────

/**
 * Extract canonical AC-N identifiers from the spec's Acceptance Criteria section.
 * Returns null if no section found, empty array if section exists but has no AC-\d+ patterns.
 */
function extractSpecACs(specContent) {
  const section = extractACSection(specContent);
  if (section === null) return null;

  const ids = new Set();
  const pattern = /\bAC-(\d+)\b/g;
  let m;
  while ((m = pattern.exec(section)) !== null) {
    ids.add(`AC-${m[1]}`);
  }
  return [...ids].sort((a, b) => {
    const na = parseInt(a.replace('AC-', ''), 10);
    const nb = parseInt(b.replace('AC-', ''), 10);
    return na - nb;
  });
}

// ── AC parsing from agent output ────────────────────────────────────────────

/**
 * Parse AC_COVERAGE block from agent output.
 * Returns a Map of AC-N → { status: 'done'|'skip', reason: string|null }
 */
function parseACCoverage(outputText) {
  const map = new Map();

  const blockMatch = outputText.match(/AC_COVERAGE:([\s\S]*?)AC_COVERAGE_END/);
  if (!blockMatch) return map;

  const block = blockMatch[1];
  const linePattern = /^(AC-\d+):(done|skip)(?::(.+))?$/gm;
  let m;
  while ((m = linePattern.exec(block)) !== null) {
    map.set(m[1], {
      status: m[2],
      reason: m[3] ? m[3].trim() : null,
    });
  }
  return map;
}

// ── Main logic ──────────────────────────────────────────────────────────────

function run(args) {
  if (!args.spec) {
    console.error('[ac-coverage] Error: --spec is required');
    process.exit(1);
  }
  if (!args.status) {
    console.error('[ac-coverage] Error: --status is required');
    process.exit(1);
  }

  // Read spec
  let specContent;
  try {
    specContent = fs.readFileSync(args.spec, 'utf8');
  } catch (e) {
    console.error(`[ac-coverage] Error reading spec: ${e.message}`);
    process.exit(1);
  }

  // Extract canonical ACs (AC-2, AC-7, AC-8)
  const specACs = extractSpecACs(specContent);

  // AC-7: no Acceptance Criteria section → silent exit
  if (specACs === null) {
    process.exit(0);
  }

  // AC-8: section exists but no AC-\d+ patterns → silent exit
  if (specACs.length === 0) {
    process.exit(0);
  }

  // Read agent output
  let outputText = '';
  if (args.outputFile) {
    try {
      outputText = fs.readFileSync(args.outputFile, 'utf8');
    } catch (e) {
      console.error(`[ac-coverage] Error reading output file: ${e.message}`);
      process.exit(1);
    }
  } else if (args.output !== undefined) {
    outputText = args.output;
  }

  // AC-3: parse AC_COVERAGE block from agent output
  const reported = parseACCoverage(outputText);

  // AC-3: diff — identify missed ACs (not reported as done)
  const missed = [];
  const skipped = [];
  let coveredCount = 0;

  for (const id of specACs) {
    const entry = reported.get(id);
    if (entry && entry.status === 'done') {
      coveredCount++;
    } else if (entry && entry.status === 'skip') {
      skipped.push({ id, reason: entry.reason });
    } else {
      missed.push(id);
    }
  }

  const totalACs = specACs.length;
  const reportedDoneCount = coveredCount;

  // AC-6: summary line
  const summaryParts = [];
  if (missed.length > 0) {
    summaryParts.push(`missed: ${missed.join(', ')}`);
  }
  if (skipped.length > 0) {
    const skipDesc = skipped.map(s => s.reason ? `${s.id} (${s.reason})` : s.id).join(', ');
    summaryParts.push(`skipped: ${skipDesc}`);
  }

  const summaryDetail = summaryParts.length > 0 ? ` — ${summaryParts.join('; ')}` : '';
  console.log(`[ac-coverage] ${reportedDoneCount}/${totalACs} ACs covered${summaryDetail}`);

  // AC-4 / AC-5: status override
  const inputStatus = args.status;
  const hasMissed = missed.length > 0;

  if (hasMissed && inputStatus === 'pass') {
    // AC-4: override to SALVAGEABLE
    console.log('OVERRIDE:SALVAGEABLE');
    process.exit(2);
  } else {
    // AC-5: all done, or status was already fail/revert — no override
    console.log('OVERRIDE:none');
    process.exit(0);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run(args);
}

module.exports = { extractSpecACs, parseACCoverage, extractACSection };
