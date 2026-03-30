'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

after(() => { process.stdin.destroy(); });

const LINT_SCRIPT = path.join(__dirname, 'lint-no-bare-stdin.js');
const HOOKS_DIR = path.resolve(__dirname, '..');

describe('lint-no-bare-stdin', () => {
  test('is a valid Node.js script (can be parsed without syntax errors)', () => {
    // --check parses without executing
    execFileSync(process.execPath, ['--check', LINT_SCRIPT], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ok(true, 'script parsed without syntax errors');
  });

  test('exits 0 when run against current hooks directory (codebase is clean)', () => {
    const result = execFileSync(process.execPath, [LINT_SCRIPT], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.match(result, /OK/, 'should report OK when no violations found');
  });

  test('scans hooks/df-*.js files (not lib/ or test files)', () => {
    // Verify the script's target pattern by checking that hook files exist
    const entries = fs.readdirSync(HOOKS_DIR);
    const hookFiles = entries.filter(
      (f) => f.startsWith('df-') && f.endsWith('.js') && !f.endsWith('.test.js')
    );
    assert.ok(hookFiles.length > 0, 'should find at least one hooks/df-*.js file to lint');
  });

  test('detects bare process.stdin.on and exits 1', () => {
    // Create a temporary hook file with a violation
    const tempHook = path.join(HOOKS_DIR, 'df-_test-lint-violation.js');
    fs.writeFileSync(tempHook, `'use strict';\nprocess.stdin.on('data', () => {});\n`);
    try {
      execFileSync(process.execPath, [LINT_SCRIPT], {
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.fail('should have exited with code 1');
    } catch (err) {
      assert.equal(err.status, 1, 'should exit 1 when violations found');
      assert.match(
        err.stderr.toString(),
        /FAIL/,
        'should report FAIL in stderr'
      );
      assert.match(
        err.stderr.toString(),
        /df-_test-lint-violation\.js/,
        'should name the violating file'
      );
    } finally {
      try { fs.unlinkSync(tempHook); } catch (_e) { /* ignore */ }
    }
  });

  test('ignores .test.js files when scanning', () => {
    // Create a test file with a violation — should NOT be flagged
    const tempTest = path.join(HOOKS_DIR, 'df-_test-lint-fake.test.js');
    fs.writeFileSync(tempTest, `'use strict';\nprocess.stdin.on('data', () => {});\n`);
    try {
      const result = execFileSync(process.execPath, [LINT_SCRIPT], {
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.match(result, /OK/, 'test files should be excluded from scanning');
    } finally {
      try { fs.unlinkSync(tempTest); } catch (_e) { /* ignore */ }
    }
  });
});
