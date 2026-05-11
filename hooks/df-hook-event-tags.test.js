/**
 * Tests for @hook-event tags in hook files (self-describing-hooks, T1)
 *
 * Verifies that each hook file has the correct @hook-event comment tag
 * within the first 10 lines, enabling programmatic event discovery.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOKS_DIR = path.resolve(__dirname);

/**
 * Read first N lines of a file and return them as an array.
 */
function readFirstLines(filePath, n = 10) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').slice(0, n);
}

/**
 * Extract @hook-event value from a file's first 10 lines.
 * Returns the matched event string or null.
 */
function extractHookEvent(filePath) {
  const lines = readFirstLines(filePath, 10);
  for (const line of lines) {
    const match = line.match(/\/\/\s*@hook-event:\s*(.+)/);
    if (match) return match[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Expected tags per hook file
// ---------------------------------------------------------------------------

// v2 surviving hooks: every non-test .js file in hooks/ must declare its
// PostToolUse / PreToolUse / SessionStart / statusLine via @hook-event tag.
const EXPECTED_TAGS = {
  'ac-coverage.js': 'PostToolUse',
  'df-bash-telemetry.js': 'PostToolUse',
  'df-check-update.js': 'SessionStart',
  'df-codebase-inject.js': 'PreToolUse',
  'df-codebase-staleness.js': 'PostToolUse',
  'df-spec-lint.js': 'PostToolUse',
  'df-statusline.js': 'statusLine',
  'spec-transition.js': 'PostToolUse',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@hook-event tags — self-describing hooks', () => {

  // Test each hook file individually
  for (const [filename, expectedTag] of Object.entries(EXPECTED_TAGS)) {
    test(`${filename} has @hook-event: ${expectedTag}`, () => {
      const filePath = path.join(HOOKS_DIR, filename);
      assert.ok(fs.existsSync(filePath), `${filename} should exist`);

      const tag = extractHookEvent(filePath);
      assert.ok(tag !== null, `${filename} should have a @hook-event tag within the first 10 lines`);
      assert.equal(tag, expectedTag);
    });
  }

  // Tag must appear on line 2 (index 1) — the canonical position
  test('all tags appear on line 2 (after shebang)', () => {
    for (const filename of Object.keys(EXPECTED_TAGS)) {
      const filePath = path.join(HOOKS_DIR, filename);
      const lines = readFirstLines(filePath, 3);
      assert.match(
        lines[1],
        /\/\/\s*@hook-event:/,
        `${filename}: tag should be on line 2`
      );
    }
  });

  // df-statusline uses statusLine (not a hooks.* lifecycle event)
  test('df-statusline.js uses statusLine event (not a hooks.* event)', () => {
    const tag = extractHookEvent(path.join(HOOKS_DIR, 'df-statusline.js'));
    assert.equal(tag, 'statusLine');
    assert.ok(
      !tag.startsWith('Session') && !tag.startsWith('Pre') && !tag.startsWith('Post') && !tag.startsWith('Subagent'),
      'statusLine should not be a lifecycle event type'
    );
  });

  // Every non-test hook file in hooks/ must declare a @hook-event tag.
  // Catches new hooks added without the canonical tag.
  test('every hooks/*.js declares @hook-event (auto-discovery)', () => {
    const files = fs.readdirSync(HOOKS_DIR)
      .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
    const missing = [];
    for (const f of files) {
      const tag = extractHookEvent(path.join(HOOKS_DIR, f));
      if (!tag) missing.push(f);
    }
    assert.deepEqual(missing, [], `hooks missing @hook-event: ${missing.join(', ')}`);
  });
});
