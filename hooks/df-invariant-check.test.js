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

const { isBinaryAvailable, checkConfigYamlGuard } = require('./df-invariant-check');

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

// ---------------------------------------------------------------------------
// 4. checkConfigYamlGuard — config.yaml/yml modification detection
// ---------------------------------------------------------------------------

describe('checkConfigYamlGuard', () => {
  // Helper: build a minimal parsed-file object matching the shape used by check functions
  function makeFiles(...paths) {
    return paths.map((p) => ({ file: p, chunks: [] }));
  }

  test('detects .deepflow/config.yaml modification as HARD violation', () => {
    const files = makeFiles('.deepflow/config.yaml');
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 1);
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
    assert.equal(violations[0].file, '.deepflow/config.yaml');
    assert.equal(violations[0].line, 1);
    assert.ok(violations[0].description.includes('[CONFIG_GUARD]'));
  });

  test('detects .deepflow/config.yml variant as HARD violation', () => {
    const files = makeFiles('.deepflow/config.yml');
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 1);
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
    assert.equal(violations[0].file, '.deepflow/config.yml');
  });

  test('detects config.yaml inside a worktree sub-path', () => {
    const worktreePath = '.claude/worktrees/agent-abc123/.deepflow/config.yaml';
    const files = makeFiles(worktreePath);
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 1);
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
    assert.equal(violations[0].file, worktreePath);
  });

  test('detects config.yml inside a deeply nested worktree path', () => {
    const deepPath = 'some/deep/path/.deepflow/config.yml';
    const files = makeFiles(deepPath);
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 1);
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
  });

  test('returns no violations for non-config files', () => {
    const files = makeFiles(
      'src/index.js',
      'hooks/df-invariant-check.js',
      'package.json',
      '.deepflow/decisions.md'
    );
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 0);
  });

  test('ignores files that partially match but are not config.yaml/yml', () => {
    const files = makeFiles(
      '.deepflow/config.yaml.bak',
      '.deepflow/config.yamls',
      '.deepflow/my-config.yaml',
      'config.yaml'  // not under .deepflow/
    );
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 0);
  });

  test('returns one violation per matching file when multiple configs present', () => {
    const files = makeFiles(
      '.deepflow/config.yaml',
      '.claude/worktrees/agent-xyz/.deepflow/config.yml'
    );
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.equal(violations.length, 2);
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
    assert.equal(violations[1].tag, 'CONFIG_GUARD');
  });

  test('returns empty array when files list is empty', () => {
    const violations = checkConfigYamlGuard([], '', 'implementation');
    assert.equal(violations.length, 0);
  });

  test('works regardless of specContent and taskType arguments', () => {
    const files = makeFiles('.deepflow/config.yaml');

    // Different specContent and taskType should not affect the result
    const v1 = checkConfigYamlGuard(files, 'some spec content', 'spike');
    const v2 = checkConfigYamlGuard(files, '', 'bootstrap');

    assert.equal(v1.length, 1);
    assert.equal(v2.length, 1);
  });

  test('violation description mentions the offending file path', () => {
    const targetPath = '.claude/worktrees/agent-foo/.deepflow/config.yaml';
    const files = makeFiles(targetPath);
    const violations = checkConfigYamlGuard(files, '', 'implementation');

    assert.ok(
      violations[0].description.includes(targetPath),
      'description should include the exact file path'
    );
  });
});

// ---------------------------------------------------------------------------
// 5. T3 — stdin hang fix: readStdinIfMain guard and no raw stdin listeners
// ---------------------------------------------------------------------------

describe('stdin hang fix (T3)', () => {
  test('source does not contain process.stdin.on calls', () => {
    // The old code used process.stdin.on('data') directly, which caused hangs
    // when the file was required by tests. readStdinIfMain replaces this.
    const lines = HOOK_SOURCE.split('\n');
    const offendingLines = lines.filter((line) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
      return /process\.stdin\.on\b/.test(line);
    });
    assert.equal(
      offendingLines.length,
      0,
      `Found process.stdin.on in source: ${offendingLines.map((l) => l.trim()).join('; ')}`
    );
  });

  test('source calls readStdinIfMain', () => {
    // readStdinIfMain(module, callback) should be the entry point for stdin reading
    assert.ok(
      /readStdinIfMain\s*\(\s*module\b/.test(HOOK_SOURCE),
      'source should call readStdinIfMain(module, ...) to guard stdin reading'
    );
  });

  test('source imports readStdinIfMain from hook-stdin', () => {
    assert.ok(
      /require\(['"]\.\/lib\/hook-stdin['"]\)/.test(HOOK_SOURCE),
      'source should require ./lib/hook-stdin'
    );
    assert.ok(
      /readStdinIfMain/.test(HOOK_SOURCE),
      'readStdinIfMain should be destructured from the import'
    );
  });

  test('--invariants CLI entry point is preserved', () => {
    // The CLI path must still exist: require.main === module && --invariants
    assert.ok(
      /require\.main\s*===\s*module/.test(HOOK_SOURCE),
      'source should have require.main === module guard for CLI mode'
    );
    assert.ok(
      /--invariants/.test(HOOK_SOURCE),
      'source should reference --invariants flag'
    );
  });

  test('requiring the module does not hang (exits immediately)', () => {
    // AC-5: node -e "require('./hooks/df-invariant-check.js')" should exit fast.
    // We already required it at the top of this file without hanging,
    // so reaching this test at all proves require() does not block.
    // Additionally, verify the exported API is still accessible.
    assert.equal(typeof isBinaryAvailable, 'function');
    assert.equal(typeof checkConfigYamlGuard, 'function');
  });
});
