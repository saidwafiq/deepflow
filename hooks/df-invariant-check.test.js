/**
 * Tests for hooks/df-invariant-check.js
 *
 * Validates the execSync → execFileSync migration (security hardening wave-1).
 * Ensures shell-injection-prone execSync is fully replaced by execFileSync
 * in isBinaryAvailable and extractDiffFromLastCommit.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isBinaryAvailable } = require('./df-invariant-check');

const HOOK_SOURCE = fs.readFileSync(
  path.resolve(__dirname, 'df-invariant-check.js'),
  'utf8'
);

// ---------------------------------------------------------------------------
// 1. No execSync usage anywhere in the source
// ---------------------------------------------------------------------------

describe('execSync removal (grep-based)', () => {
  test('source does not import execSync from child_process', () => {
    // Match the destructured import pattern: { execSync }
    const importPattern = /\brequire\(['"]child_process['"]\).*\bexecSync\b/;
    assert.equal(
      importPattern.test(HOOK_SOURCE),
      false,
      'execSync should not appear in the child_process require statement'
    );
  });

  test('source does not call execSync anywhere', () => {
    // Look for execSync( calls — but not execFileSync(
    // We match word-boundary before execSync and ensure it's not preceded by "File"
    const lines = HOOK_SOURCE.split('\n');
    const offendingLines = lines.filter((line) => {
      // Skip comments
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
      // Match execSync but not execFileSync
      return /\bexecSync\b/.test(line) && !/\bexecFileSync\b/.test(line);
    });
    assert.equal(
      offendingLines.length,
      0,
      `Found bare execSync usage on lines: ${offendingLines.map((l) => l.trim()).join('; ')}`
    );
  });

  test('source imports execFileSync from child_process', () => {
    const importPattern = /\bexecFileSync\b.*=.*require\(['"]child_process['"]\)/;
    const altPattern = /require\(['"]child_process['"]\).*\bexecFileSync\b/;
    assert.ok(
      importPattern.test(HOOK_SOURCE) || altPattern.test(HOOK_SOURCE),
      'execFileSync should be imported from child_process'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. isBinaryAvailable behavioral tests
// ---------------------------------------------------------------------------

describe('isBinaryAvailable', () => {
  test('returns true for a binary that exists (node)', () => {
    // node is always available in the test environment
    assert.equal(isBinaryAvailable('node'), true);
  });

  test('returns true for a binary that exists (git)', () => {
    assert.equal(isBinaryAvailable('git'), true);
  });

  test('returns false for a binary that does not exist', () => {
    assert.equal(
      isBinaryAvailable('__nonexistent_binary_xyz_12345__'),
      false
    );
  });

  test('handles binary names with no shell injection risk', () => {
    // execFileSync passes the argument as an array element, not through a shell.
    // A name like "node; rm -rf /" should simply not be found, not executed.
    assert.equal(isBinaryAvailable('node; rm -rf /'), false);
  });
});

// ---------------------------------------------------------------------------
// 3. extractDiffFromLastCommit uses execFileSync (source-level check)
// ---------------------------------------------------------------------------

describe('extractDiffFromLastCommit implementation', () => {
  test('uses execFileSync with git as first argument', () => {
    // Find the function body and verify execFileSync('git', [...]) pattern
    const fnMatch = HOOK_SOURCE.match(
      /function\s+extractDiffFromLastCommit[\s\S]*?^}/m
    );
    assert.ok(fnMatch, 'extractDiffFromLastCommit function should exist in source');

    const fnBody = fnMatch[0];
    assert.ok(
      /execFileSync\(\s*['"]git['"]/.test(fnBody),
      'extractDiffFromLastCommit should call execFileSync with "git" as first argument'
    );
  });

  test('does not use execSync in extractDiffFromLastCommit', () => {
    const fnMatch = HOOK_SOURCE.match(
      /function\s+extractDiffFromLastCommit[\s\S]*?^}/m
    );
    assert.ok(fnMatch, 'extractDiffFromLastCommit function should exist in source');

    const fnBody = fnMatch[0];
    // Ensure no bare execSync call (only execFileSync allowed)
    const hasBareExecSync = /\bexecSync\b/.test(fnBody) && !/\bexecFileSync\b/.test(fnBody);
    assert.equal(
      hasBareExecSync,
      false,
      'extractDiffFromLastCommit should not use execSync'
    );
  });

  test('passes diff arguments as array elements, not a single string', () => {
    const fnMatch = HOOK_SOURCE.match(
      /function\s+extractDiffFromLastCommit[\s\S]*?^}/m
    );
    const fnBody = fnMatch[0];
    // Should have ['diff', 'HEAD~1', 'HEAD'] or similar array syntax
    assert.ok(
      /execFileSync\(\s*['"]git['"]\s*,\s*\[/.test(fnBody),
      'git arguments should be passed as an array (second argument to execFileSync)'
    );
  });
});
