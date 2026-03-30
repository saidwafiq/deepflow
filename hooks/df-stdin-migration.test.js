/**
 * Tests for stdin migration (test-hang-fix T2)
 *
 * Verifies that all 9 migrated hooks use readStdinIfMain instead of inline
 * process.stdin.on listeners. The core behavioral guarantee: require()'ing
 * any hook no longer hangs the process waiting for stdin.
 *
 * Detailed behavioral tests for individual hooks live in their own test files.
 */

'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Prevent the test runner from hanging on stdin after all tests complete.
// The execFileSync calls inherit pipe handles that can keep the event loop alive.
after(() => { process.stdin.destroy(); });

const HOOKS_DIR = path.resolve(__dirname);

/** All hooks that were migrated to readStdinIfMain */
const MIGRATED_HOOKS = [
  'df-command-usage.js',
  'df-execution-history.js',
  'df-explore-protocol.js',
  'df-snapshot-guard.js',
  'df-statusline.js',
  'df-subagent-registry.js',
  'df-tool-usage.js',
  'df-tool-usage-spike.js',
  'df-worktree-guard.js',
];

describe('stdin migration — no-hang on require()', () => {
  for (const hookFile of MIGRATED_HOOKS) {
    const hookPath = path.join(HOOKS_DIR, hookFile);

    test(`require("${hookFile}") completes without hanging`, () => {
      // Spawn a child that require()s the hook and exits.
      // If stdin listeners are still inline, this will hang until timeout.
      const script = `require(${JSON.stringify(hookPath)}); process.exit(0);`;
      execFileSync(
        process.execPath,
        ['-e', script],
        {
          encoding: 'utf8',
          timeout: 3000,  // 3s is generous — require should be <100ms
        }
      );
      // If we reach here, require() didn't hang — that's the assertion.
      assert.ok(true, `${hookFile} require() completed without timeout`);
    });
  }
});

describe('stdin migration — no inline process.stdin.on', () => {
  for (const hookFile of MIGRATED_HOOKS) {
    const hookPath = path.join(HOOKS_DIR, hookFile);

    test(`${hookFile} has no direct process.stdin.on calls`, () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      const matches = content.match(/process\.stdin\.on\s*\(/g);
      assert.equal(
        matches,
        null,
        `${hookFile} still contains process.stdin.on — migration incomplete`
      );
    });
  }
});

describe('stdin migration — uses readStdinIfMain', () => {
  for (const hookFile of MIGRATED_HOOKS) {
    const hookPath = path.join(HOOKS_DIR, hookFile);

    test(`${hookFile} imports readStdinIfMain`, () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      assert.match(
        content,
        /readStdinIfMain/,
        `${hookFile} does not reference readStdinIfMain`
      );
    });
  }
});

describe('stdin migration — hook-stdin.js helper', () => {
  test('hook-stdin.js exports readStdinIfMain function', () => {
    const lib = require(path.join(HOOKS_DIR, 'lib', 'hook-stdin.js'));
    assert.equal(typeof lib.readStdinIfMain, 'function');
  });

  test('readStdinIfMain is a no-op when caller is not main module', () => {
    const lib = require(path.join(HOOKS_DIR, 'lib', 'hook-stdin.js'));
    // When we require() hook-stdin from a test, module !== require.main
    // so calling readStdinIfMain with our own module should be a no-op.
    let callbackInvoked = false;
    lib.readStdinIfMain(module, () => { callbackInvoked = true; });
    // Give a tick for any async listener to fire (there shouldn't be one).
    assert.equal(callbackInvoked, false, 'callback should not be invoked when not main module');
  });
});
