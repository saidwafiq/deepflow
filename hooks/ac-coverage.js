#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow AC coverage checker
 *
 * Hook mode (PostToolUse — auto-triggered on git commit):
 *   Reads PostToolUse event from stdin. Fires only when tool_name is "Bash"
 *   and the command contains "git commit". Auto-detects the current spec from
 *   specs/doing-*.md in cwd and scans snapshot test files for AC references.
 *   Emits SALVAGEABLE (exit 2) when ACs in the spec have no corresponding
 *   test references.
 *
 * CLI mode (called explicitly by orchestrator):
 *   node ac-coverage.js --spec <path> --test-files <file1,file2,...> --status <pass|fail|revert>
 *   node ac-coverage.js --spec <path> --snapshot <path> --status <pass|fail|revert>
 *
 * Exit codes:
 *   0 — all ACs covered, no ACs in spec, or non-commit event, or status != pass
 *   2 — SALVAGEABLE: missed ACs detected (hook mode or CLI pass status)
 *   1 — script error only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

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

// ── Canonical slug derivation ───────────────────────────────────────────────

/**
 * Derive the canonical spec slug from a spec file path.
 * Strips `doing-`/`done-` prefix and `.md` suffix from the basename.
 * e.g. "specs/doing-ac-scope-isolation.md" → "ac-scope-isolation"
 */
function getCanonicalSpecSlug(specPath) {
  const base = path.basename(specPath, '.md');
  return base.replace(/^(?:doing-|done-)/, '');
}

// ── AC scanning from test files ─────────────────────────────────────────────

/**
 * Scan test files for scoped AC references tied to a specific spec.
 * Matches the pattern `specs/{canonicalSlug}.md#AC-N` anywhere in the file
 * (comments, JSDoc, string literals — not restricted to it/test/describe calls).
 * Returns a Set of AC-N identifiers found across all test files.
 */
function scanTestFilesForScopedACs(testFilePaths, canonicalSlug) {
  const found = new Set();
  // Escape slug for use in regex (handles hyphens, dots, etc.)
  const escapedSlug = canonicalSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`specs/${escapedSlug}\\.md#AC-(\\d+)`, 'g');

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
      found.add(`AC-${m[1]}`);
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

  // Derive canonical slug for scoped scan
  const slug = getCanonicalSpecSlug(args.spec);

  // Resolve test files to scan
  const testFilePaths = resolveTestFiles(args);

  // Scan test files for scoped AC references (specs/{slug}.md#AC-N)
  const coveredACs = scanTestFilesForScopedACs(testFilePaths, slug);

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

// ── Hook entry point (PostToolUse stdin) ────────────────────────────────────

function runAsHook(data) {
  const toolName = data.tool_name || '';
  const command = (data.tool_input && data.tool_input.command) || '';

  // Only fire on git commit bash events
  if (toolName !== 'Bash' || !/git\s+commit\b/.test(command)) return;

  const cwd = data.cwd || process.cwd();

  // Auto-detect spec: first doing-*.md in specs/
  let specPath;
  try {
    const specsDir = path.join(cwd, 'specs');
    const doing = fs.readdirSync(specsDir).filter(f => f.startsWith('doing-') && f.endsWith('.md'));
    if (doing.length === 0) return;
    specPath = path.join(specsDir, doing[0]);
  } catch (_) {
    return; // no specs dir — not a deepflow project
  }

  const specContent = fs.readFileSync(specPath, 'utf8');
  const specACs = extractSpecACs(specContent);
  if (specACs.length === 0) return;

  // Auto-detect test files: prefer snapshot, fall back to git ls-files
  let testFiles = [];
  try {
    const { execFileSync } = require('child_process');
    const snapshotCandidates = [
      path.join(cwd, '.deepflow', 'auto-snapshot.txt'),
      ...fs.readdirSync(path.join(cwd, '.deepflow')).filter(f => f.startsWith('auto-snapshot')).map(f => path.join(cwd, '.deepflow', f)),
    ];
    let snapshotPath = snapshotCandidates.find(p => fs.existsSync(p));
    if (snapshotPath) {
      testFiles = fs.readFileSync(snapshotPath, 'utf8').split('\n').filter(Boolean).map(f => path.resolve(cwd, f));
    } else {
      const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      testFiles = out.split('\n').filter(f => /\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests\/|__tests__\//.test(f)).map(f => path.join(cwd, f));
    }
  } catch (_) {
    return;
  }

  testFiles = testFiles.filter(f => { try { fs.accessSync(f); return true; } catch (_) { return false; } });
  if (testFiles.length === 0) return;

  const slug = getCanonicalSpecSlug(specPath);
  const coveredACs = scanTestFilesForScopedACs(testFiles, slug);
  const missed = specACs.filter(ac => !coveredACs.has(ac));

  if (missed.length > 0) {
    process.stderr.write(`[ac-coverage] SALVAGEABLE: ${specACs.length - missed.length}/${specACs.length} ACs covered in tests — missing: ${missed.join(', ')}\nOVERRIDE:SALVAGEABLE\n`);
    process.exit(2);
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  if (process.argv.length > 2) {
    // CLI mode: explicit --spec / --status args from orchestrator
    const args = parseArgs(process.argv.slice(2));
    run(args);
  } else {
    // Hook mode: read PostToolUse event from stdin
    readStdinIfMain(module, runAsHook);
  }
}

module.exports = { extractSpecACs, extractACSection, getCanonicalSpecSlug, scanTestFilesForScopedACs, resolveTestFiles };
