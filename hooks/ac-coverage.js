#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow AC coverage checker
 * Standalone script called by the orchestrator after ratchet checks.
 *
 * Usage:
 *   node ac-coverage.js --spec <path> --test-files <file1,file2,...> --status <pass|fail|revert>
 *   node ac-coverage.js --spec <path> --snapshot <path> --status <pass|fail|revert>
 *
 * Exit codes:
 *   0 — all ACs covered, no ACs in spec, or input status was fail/revert
 *   2 — SALVAGEABLE: missed ACs detected and input status was pass
 *   1 — script error only
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec' && argv[i + 1]) { args.spec = argv[++i]; }
    else if (a === '--test-files' && argv[i + 1]) { args.testFiles = argv[++i]; }
    else if (a === '--snapshot' && argv[i + 1]) { args.snapshot = argv[++i]; }
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

// ── AC scanning from test files ─────────────────────────────────────────────

/**
 * Scan test files for AC references in test names.
 * Matches patterns like: it('AC-1: ...'), test('AC-2 ...'), describe('AC-3 ...')
 * Returns a Set of AC-N identifiers found across all test files.
 */
function scanTestFilesForACs(testFilePaths) {
  const found = new Set();
  const pattern = /\b(it|test|describe)\s*\(\s*['"`][^'"`]*\bAC-(\d+)\b/g;

  for (const filePath of testFilePaths) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      // Skip unreadable files — not a fatal error
      continue;
    }

    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      found.add(`AC-${m[2]}`);
    }
  }

  return found;
}

/**
 * Resolve test file paths from --test-files (comma-separated list) or
 * --snapshot (newline-separated list of paths from snapshot file).
 */
function resolveTestFiles(args) {
  if (args.testFiles) {
    return args.testFiles.split(',').map(f => f.trim()).filter(Boolean);
  }
  if (args.snapshot) {
    let content;
    try {
      content = fs.readFileSync(args.snapshot, 'utf8');
    } catch (e) {
      console.error(`[ac-coverage] Error reading snapshot file: ${e.message}`);
      process.exit(1);
    }
    return content.split('\n').map(f => f.trim()).filter(Boolean);
  }
  return [];
}

// ── Main logic ──────────────────────────────────────────────────────────────

function run(args) {
  if (!args.spec) {
    // Called as a PostToolUse hook without explicit args — no-op
    process.exit(0);
  }
  if (!args.status) {
    // Called as a PostToolUse hook without explicit args — no-op
    process.exit(0);
  }

  // Read spec
  let specContent;
  try {
    specContent = fs.readFileSync(args.spec, 'utf8');
  } catch (e) {
    console.error(`[ac-coverage] Error reading spec: ${e.message}`);
    process.exit(1);
  }

  // Extract canonical ACs from spec
  const specACs = extractSpecACs(specContent);

  // No Acceptance Criteria section → silent exit
  if (specACs === null) {
    process.exit(0);
  }

  // Section exists but no AC-\d+ patterns → silent exit
  if (specACs.length === 0) {
    process.exit(0);
  }

  // Resolve test files to scan
  const testFilePaths = resolveTestFiles(args);

  // Scan test files for AC references
  const coveredACs = scanTestFilesForACs(testFilePaths);

  // Diff — identify missed ACs (not referenced in any test name)
  const missed = [];
  let coveredCount = 0;

  for (const id of specACs) {
    if (coveredACs.has(id)) {
      coveredCount++;
    } else {
      missed.push(id);
    }
  }

  const totalACs = specACs.length;

  // Summary line
  const summaryDetail = missed.length > 0 ? ` — missed: ${missed.join(', ')}` : '';
  console.log(`[ac-coverage] ${coveredCount}/${totalACs} ACs covered${summaryDetail}`);

  // Status override
  const inputStatus = args.status;
  const hasMissed = missed.length > 0;

  if (hasMissed && inputStatus === 'pass') {
    // Override to SALVAGEABLE
    console.log('OVERRIDE:SALVAGEABLE');
    process.exit(2);
  } else {
    // All done, or status was already fail/revert — no override
    console.log('OVERRIDE:none');
    process.exit(0);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run(args);
}

module.exports = { extractSpecACs, extractACSection, scanTestFilesForACs, resolveTestFiles };
