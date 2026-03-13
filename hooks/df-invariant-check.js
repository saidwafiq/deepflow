#!/usr/bin/env node
/**
 * deepflow invariant checker
 * Checks implementation diffs against spec invariants.
 *
 * Usage (CLI):   node df-invariant-check.js --invariants <spec-file.md> <diff-file>
 * Usage (module): const { checkInvariants } = require('./df-invariant-check');
 *
 * REQ-6: CLI mode — parse args, read files, exit non-zero on hard failures
 * REQ-7: Output format — `${file}:${line}: [${TAG}] ${description}`, capped at 15 lines
 * REQ-9: Auto-mode escalation — advisory items promoted to hard when mode === 'auto'
 */

'use strict';

const fs = require('fs');
const { extractSection } = require('./df-spec-lint');

// ── Valid violation tags (REQ-7) ──────────────────────────────────────────────
const TAGS = {
  MOCK: 'MOCK',               // Production code contains mock/stub placeholders
  MISSING_TEST: 'MISSING_TEST', // Changed code has no corresponding test coverage
  HARDCODED: 'HARDCODED',     // Hardcoded values that should be configurable
  STUB: 'STUB',               // Incomplete stub left in production code
  PHANTOM: 'PHANTOM',         // Reference to non-existent symbol/file/function
  SCOPE_GAP: 'SCOPE_GAP',     // Implementation goes beyond or falls short of spec scope
};

// ── Diff parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a unified diff string into a structured list of file changes.
 *
 * @param {string} diff - Raw unified diff text
 * @returns {Array<{ file: string, hunks: Array<{ startLine: number, lines: Array<{ lineNo: number, content: string }> }> }>}
 */
function parseDiff(diff) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let newLineNo = 0;

  for (const line of diff.split('\n')) {
    // New file header: "+++ b/path/to/file" or "+++ path/to/file"
    if (line.startsWith('+++ ')) {
      const filePath = line.slice(4).replace(/^[ab]\//, '');
      currentFile = { file: filePath, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    // Skip "---" lines (old file header)
    if (line.startsWith('--- ')) {
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch && currentFile) {
      newLineNo = parseInt(hunkMatch[1], 10);
      currentHunk = { startLine: newLineNo, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      // Added line
      currentHunk.lines.push({ lineNo: newLineNo, content: line.slice(1) });
      newLineNo++;
    } else if (line.startsWith('-')) {
      // Removed line — does not advance new-file line numbers
    } else if (line.startsWith(' ')) {
      // Context line
      newLineNo++;
    }
  }

  return files;
}

// ── Task-type helpers (REQ-8) ─────────────────────────────────────────────────

/**
 * Classify a file path as a test file or a production file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return (
    /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
    /^tests?\//.test(filePath) ||
    /\/__tests__\//.test(filePath)
  );
}

// ── Placeholder check functions (T4-T8 will implement these) ─────────────────
//
// Each check function receives:
//   - files: parsed diff (output of parseDiff())
//   - specContent: raw spec markdown string
//   - taskType: 'bootstrap' | 'spike' | 'implementation'
//
// Each function returns an array of violation objects:
//   { file: string, line: number, tag: string, description: string }

/**
 * T4 placeholder: Check for mock/stub markers left in production code.
 * Looks for patterns like TODO, FIXME, console.log, mock(), stub() in added lines.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkMocks(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  // REQ-8: taskType filtering
  //   bootstrap: skip mock detection entirely for test files
  //   spike: only check production files (skip test files)
  //   implementation: check all files
  let filesToCheck = files;
  if (taskType === 'bootstrap') {
    filesToCheck = files.filter((f) => !isTestFile(f.file));
  } else if (taskType === 'spike') {
    filesToCheck = files.filter((f) => !isTestFile(f.file));
  }

  // REQ-1: Detect mock usage patterns in production (non-test) files
  const MOCK_PATTERNS = [
    /\bjest\.fn\s*\(/,
    /\bvi\.fn\s*\(/,
    /\bsinon\.stub\s*\(/,
    /=\s*mock\s*\(/,
    /\bjest\.mock\s*\(/,
    /\bvi\.mock\s*\(/,
    /\bsinon\.mock\s*\(/,
    /\bjest\.spyOn\s*\(/,
    /\bcreateMock\s*\(/,
    /\bmockImplementation\s*\(/,
  ];

  const violations = [];

  for (const fileObj of filesToCheck) {
    for (const hunk of fileObj.hunks) {
      for (const addedLine of hunk.lines) {
        for (const pattern of MOCK_PATTERNS) {
          if (pattern.test(addedLine.content)) {
            violations.push({
              file: fileObj.file,
              line: addedLine.lineNo,
              tag: TAGS.MOCK,
              description: `Mock pattern found: ${pattern}`,
            });
            break; // Only report one violation per line
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Check that every REQ-N identifier in the spec has at least one mention
 * in the added lines of a test file in the diff (REQ-2).
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkMissingTests(files, specContent, taskType) {
  // REQ-8: taskType filtering
  //   spike: skip entirely (spikes don't require test coverage)
  //   bootstrap: skip (bootstrapping doesn't need tests yet)
  //   implementation: enforce
  if (taskType === 'spike' || taskType === 'bootstrap') {
    return [];
  }

  const violations = [];

  // Extract the Requirements section and collect all REQ-N identifiers
  const reqSection = extractSection(specContent, 'Requirements');
  if (!reqSection) return violations;

  const reqPattern = /REQ-\d+[a-z]?/g;
  const allReqIds = new Set(reqSection.match(reqPattern) || []);
  if (allReqIds.size === 0) return violations;

  // Identify test files in the diff
  const isTestFile = (filePath) =>
    /\.test\.js$/.test(filePath) ||
    /\.spec\.js$/.test(filePath) ||
    /(^|\/)test(s)?\//.test(filePath);

  // Collect all added-line content from test files in the diff
  const testFileContent = files
    .filter((f) => isTestFile(f.file))
    .flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.content)))
    .join('\n');

  // Emit a violation for each REQ-N that has no mention in any test file's added lines
  for (const reqId of allReqIds) {
    if (!testFileContent.includes(reqId)) {
      violations.push({
        file: 'spec',
        line: 1,
        tag: TAGS.MISSING_TEST,
        description: `${reqId} has no test reference in diff`,
      });
    }
  }

  return violations;
}

/**
 * Check for stub returns and TODO/FIXME/HACK markers left in production code.
 * Detects patterns like `return null`, `return []`, `throw new Error('not implemented')`,
 * and comment markers that indicate incomplete work.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkStubsAndTodos(files, specContent, taskType) {
  // REQ-8: taskType filtering
  //   spike: skip TODO/FIXME/HACK detection (spikes are exploratory)
  //   implementation: all checks enforced
  const violations = [];

  const stubReturnPattern = /\breturn\s+(null|undefined|\[\]|\{\})\s*;?\s*$/;
  const notImplementedPattern = /throw\s+new\s+Error\s*\(\s*['"]not implemented['"]\s*\)/i;
  const todoCommentPattern = /\/\/\s*(TODO|FIXME|HACK)\b/i;

  for (const fileEntry of files) {
    for (const hunk of fileEntry.hunks) {
      for (const { lineNo, content } of hunk.lines) {
        if (taskType !== 'spike' && todoCommentPattern.test(content)) {
          violations.push({
            file: fileEntry.file,
            line: lineNo,
            tag: TAGS.STUB,
            description: `TODO/FIXME/HACK comment found: ${content.trim()}`,
          });
        } else if (notImplementedPattern.test(content)) {
          violations.push({
            file: fileEntry.file,
            line: lineNo,
            tag: TAGS.STUB,
            description: `Stub return found: ${content.trim()}`,
          });
        } else if (stubReturnPattern.test(content)) {
          violations.push({
            file: fileEntry.file,
            line: lineNo,
            tag: TAGS.STUB,
            description: `Stub return found: ${content.trim()}`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * T6 placeholder: Check for hardcoded values that should be configurable.
 * Detects magic numbers, hardcoded URLs, hardcoded credentials patterns, etc.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkHardcoded(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  // TODO (T6): Implement hardcoded-value detection
  // Suggested approach:
  //   - Scan added lines for hardcoded IPs, URLs, API keys, magic numbers
  //   - Allow common safe literals (0, 1, -1, true, false, empty string)
  //   - Cross-reference spec Constraints section for explicitly allowed constants
  //   - Return { file, line, tag: TAGS.HARDCODED, description } for each hit
  return [];
}

/**
 * T7 placeholder: Check for phantom references (undefined symbols, missing imports).
 * Detects references to identifiers that don't appear to be defined in the diff.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkPhantoms(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  // TODO (T7): Implement phantom-reference detection
  // Suggested approach:
  //   - Build a set of symbols defined in the diff (function declarations, const/let/var)
  //   - Identify references to symbols that are neither defined in diff nor imported
  //   - Flag require() / import paths that don't exist on disk relative to the file
  //   - Return { file, line, tag: TAGS.PHANTOM, description } for each hit
  return [];
}

/**
 * T8 placeholder: Check for scope gaps between spec and implementation.
 * Verifies the implementation addresses all REQ-N requirements and doesn't
 * add features outside the spec scope.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkScopeGaps(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  // TODO (T8): Implement scope-gap detection
  // Suggested approach:
  //   - Extract REQ-N identifiers from the spec Requirements section
  //   - Look for each REQ-N mentioned in diff comments/code as evidence of implementation
  //   - Extract "Out of Scope" section items from spec
  //   - Flag diff additions that look like out-of-scope features
  //   - Return { file, line, tag: TAGS.SCOPE_GAP, description } for each gap
  return [];
}

// ── Output formatting (REQ-7) ─────────────────────────────────────────────────

/**
 * Format a single violation into the canonical output string.
 *
 * @param {{ file: string, line: number, tag: string, description: string }} violation
 * @returns {string} Formatted as `${file}:${line}: [${TAG}] ${description}`
 */
function formatViolation(violation) {
  return `${violation.file}:${violation.line}: [${violation.tag}] ${violation.description}`;
}

/**
 * Format checkInvariants results into printable output lines.
 * Caps output at 15 violation lines; appends a summary if truncated.
 *
 * @param {{ hard: Array, advisory: Array }} results
 * @returns {string[]} Lines ready for printing
 */
function formatOutput(results) {
  const MAX_LINES = 15;
  const lines = [];

  const allViolations = [
    ...results.hard.map((v) => ({ ...v, severity: 'HARD' })),
    ...results.advisory.map((v) => ({ ...v, severity: 'ADVISORY' })),
  ];

  const total = allViolations.length;
  const shown = allViolations.slice(0, MAX_LINES);

  for (const v of shown) {
    lines.push(formatViolation(v));
  }

  if (total > MAX_LINES) {
    const remaining = total - MAX_LINES;
    lines.push(`... and ${remaining} more invariant violation${remaining === 1 ? '' : 's'}`);
  }

  return lines;
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Check implementation diffs against spec invariants.
 *
 * @param {string} diff - Raw unified diff text
 * @param {string} specContent - Raw spec markdown content
 * @param {object} opts
 * @param {'interactive'|'auto'} opts.mode - 'auto' promotes advisory to hard (REQ-9)
 * @param {'bootstrap'|'spike'|'implementation'} opts.taskType - Affects which checks apply
 * @returns {{ hard: Array<{ file: string, line: number, tag: string, description: string }>,
 *             advisory: Array<{ file: string, line: number, tag: string, description: string }> }}
 */
function checkInvariants(diff, specContent, opts = {}) {
  const { mode = 'interactive', taskType = 'implementation' } = opts;

  const hard = [];
  const advisory = [];

  // Parse the diff into structured file/hunk/line data
  const files = parseDiff(diff);

  // ── Run placeholder checks (T4-T8 will fill these in) ───────────────────
  // Hard invariant checks: failures block the commit/task
  const mockViolations = checkMocks(files, specContent, taskType);
  hard.push(...mockViolations);

  const stubViolations = checkStubsAndTodos(files, specContent, taskType);
  hard.push(...stubViolations);

  const phantomViolations = checkPhantoms(files, specContent, taskType);
  hard.push(...phantomViolations);

  const scopeGapViolations = checkScopeGaps(files, specContent, taskType);
  hard.push(...scopeGapViolations);

  // Hard invariant: REQ-2 requires hard fail when any REQ-N has zero test references
  const missingTestViolations = checkMissingTests(files, specContent, taskType);
  hard.push(...missingTestViolations);

  const hardcodedViolations = checkHardcoded(files, specContent, taskType);
  advisory.push(...hardcodedViolations);

  // ── Auto-mode escalation (REQ-9) ─────────────────────────────────────────
  // In auto mode (non-interactive CI/hook runs), all advisory items are promoted
  // to hard failures so the pipeline blocks on any violation.
  if (mode === 'auto') {
    hard.push(...advisory.splice(0, advisory.length));
  }

  return { hard, advisory };
}

// ── CLI entry point (REQ-6) ───────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse --invariants <spec-path> <diff-file>
  const invariantsIdx = args.indexOf('--invariants');
  if (invariantsIdx === -1 || args.length < invariantsIdx + 3) {
    console.error('Usage: df-invariant-check.js --invariants <spec-file.md> <diff-file>');
    console.error('');
    console.error('Options:');
    console.error('  --invariants <spec-file.md> <diff-file>   Run invariant checks');
    console.error('  --auto                                     Auto mode (advisory => hard)');
    console.error('  --task-type <bootstrap|spike|implementation>  Task type (default: implementation)');
    process.exit(1);
  }

  const specPath = args[invariantsIdx + 1];
  const diffPath = args[invariantsIdx + 2];
  const mode = args.includes('--auto') ? 'auto' : 'interactive';

  const taskTypeIdx = args.indexOf('--task-type');
  const taskType = taskTypeIdx !== -1 ? args[taskTypeIdx + 1] : 'implementation';

  let specContent, diff;
  try {
    specContent = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    console.error(`Error reading spec file "${specPath}": ${err.message}`);
    process.exit(1);
  }

  try {
    diff = fs.readFileSync(diffPath, 'utf8');
  } catch (err) {
    console.error(`Error reading diff file "${diffPath}": ${err.message}`);
    process.exit(1);
  }

  const results = checkInvariants(diff, specContent, { mode, taskType });
  const outputLines = formatOutput(results);

  if (results.hard.length > 0) {
    console.error('HARD invariant failures:');
    for (const line of outputLines.filter((_, i) => i < results.hard.length)) {
      console.error(`  ${line}`);
    }
  }

  if (results.advisory.length > 0) {
    console.warn('Advisory warnings:');
    for (const v of results.advisory) {
      console.warn(`  ${formatViolation(v)}`);
    }
  }

  if (results.hard.length === 0 && results.advisory.length === 0) {
    console.log('All invariant checks passed.');
  } else if (outputLines.length > 0) {
    // Print formatted output (respects 15-line cap)
    for (const line of outputLines) {
      if (results.hard.some((v) => formatViolation(v) === line)) {
        console.error(line);
      } else {
        console.warn(line);
      }
    }
  }

  process.exit(results.hard.length > 0 ? 1 : 0);
}

module.exports = { checkInvariants, formatOutput, formatViolation, parseDiff, TAGS };
