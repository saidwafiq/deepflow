#!/usr/bin/env node
'use strict';

/**
 * hooks/lib/bash-scopes.test.js
 *
 * Unit tests for the three helpers added to bash-scopes.js:
 *   - READ_STYLE_VERBS  (Set<string>)
 *   - splitPipeSegments (cmd: string) => string[]
 *   - extractReadStyleFileArgs (cmd: string) => string[]
 *
 * Covers acceptance criteria from specs/doing-subagent-burn-controls.md:
 *   AC-1: cat bar.go (out-of-slice) → extractReadStyleFileArgs returns ['bar.go']
 *   AC-2: cat foo.go (in-slice)     → extractReadStyleFileArgs returns ['foo.go']
 *   AC-3: cat <<'EOF' (heredoc)     → extractReadStyleFileArgs returns []
 *   AC-4: go test ./... 2>&1 | grep FAIL → first splitPipeSegments segment verb is NOT read-style
 *   AC-5: df-spike cat any/file.go  → READ_STYLE_VERBS covers 'cat'
 *
 * Additional unit tests:
 *   - READ_STYLE_VERBS contains expected verbs and is a Set
 *   - splitPipeSegments: single command, multi-pipe, logical-OR (||), heredoc
 *   - extractReadStyleFileArgs: flags, flag-args, multiple files, redirections, quotes
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  READ_STYLE_VERBS,
  splitPipeSegments,
  extractReadStyleFileArgs,
} = require('./bash-scopes');

// ---------------------------------------------------------------------------
// READ_STYLE_VERBS
// ---------------------------------------------------------------------------

describe('READ_STYLE_VERBS', () => {
  test('is a Set', () => {
    assert.ok(READ_STYLE_VERBS instanceof Set, 'should be a Set');
  });

  test('contains expected POSIX verbs', () => {
    for (const verb of ['cat', 'head', 'tail', 'less', 'more']) {
      assert.ok(READ_STYLE_VERBS.has(verb), `should contain "${verb}"`);
    }
  });

  test('contains modern alternatives bat and batcat', () => {
    assert.ok(READ_STYLE_VERBS.has('bat'), 'should contain "bat"');
    assert.ok(READ_STYLE_VERBS.has('batcat'), 'should contain "batcat"');
  });

  test('does NOT contain search tools (those are in SEARCH_TOOL_DENY)', () => {
    for (const verb of ['grep', 'rg', 'ag', 'find']) {
      assert.ok(!READ_STYLE_VERBS.has(verb), `should NOT contain "${verb}"`);
    }
  });

  test('does NOT contain build/test tools', () => {
    for (const verb of ['go', 'npm', 'node', 'jest', 'tsc']) {
      assert.ok(!READ_STYLE_VERBS.has(verb), `should NOT contain "${verb}"`);
    }
  });

  // AC-5 support: df-spike running `cat any/file.go` — cat is in READ_STYLE_VERBS
  test('AC-5 support: cat is a read-style verb (df-spike cat check)', () => {
    assert.ok(READ_STYLE_VERBS.has('cat'), '"cat" must be a read-style verb');
  });
});

// ---------------------------------------------------------------------------
// splitPipeSegments
// ---------------------------------------------------------------------------

describe('splitPipeSegments', () => {
  test('single command with no pipe returns one segment', () => {
    const segs = splitPipeSegments('cat foo.go');
    assert.deepEqual(segs, ['cat foo.go']);
  });

  test('splits a true pipe into two segments', () => {
    const segs = splitPipeSegments('cat foo.go | wc -l');
    assert.equal(segs.length, 2);
    assert.equal(segs[0], 'cat foo.go');
    assert.equal(segs[1], 'wc -l');
  });

  // AC-4: go test ./... 2>&1 | grep FAIL — first segment verb should be non-read-style
  test('AC-4: go test pipeline first segment verb is NOT a read-style verb', () => {
    const segs = splitPipeSegments('go test ./... 2>&1 | grep FAIL');
    assert.equal(segs.length, 2, 'should split into 2 segments');
    const firstVerb = segs[0].trim().split(/\s+/)[0];
    assert.ok(!READ_STYLE_VERBS.has(firstVerb), `first verb "${firstVerb}" should NOT be read-style`);
  });

  test('logical OR (||) is NOT split as a pipe', () => {
    const segs = splitPipeSegments('cmd1 || cmd2');
    assert.equal(segs.length, 1, 'logical OR should not create a second segment');
    assert.ok(segs[0].includes('||'), 'both sides of || should be in one segment');
  });

  test('heredoc causes no additional pipe segments', () => {
    const cmd = "cat <<'EOF'\nhello world\nEOF";
    const segs = splitPipeSegments(cmd);
    assert.equal(segs.length, 1, 'heredoc should be a single segment');
    assert.ok(segs[0].includes('<<'), 'heredoc operator should be preserved');
  });

  test('multiple pipes produce multiple segments', () => {
    const segs = splitPipeSegments('cat foo.go | grep func | wc -l');
    assert.equal(segs.length, 3, 'should split into 3 segments');
  });

  test('empty string returns one empty segment', () => {
    const segs = splitPipeSegments('');
    assert.equal(segs.length, 1);
    assert.equal(segs[0], '');
  });

  test('null/undefined input returns one empty segment', () => {
    assert.deepEqual(splitPipeSegments(null), ['']);
    assert.deepEqual(splitPipeSegments(undefined), ['']);
  });
});

// ---------------------------------------------------------------------------
// extractReadStyleFileArgs
// ---------------------------------------------------------------------------

describe('extractReadStyleFileArgs', () => {
  // AC-1/AC-2: cat bar.go / cat foo.go return the filename
  test('AC-1/AC-2: cat <file> returns [file]', () => {
    assert.deepEqual(extractReadStyleFileArgs('cat bar.go'), ['bar.go']);
    assert.deepEqual(extractReadStyleFileArgs('cat foo.go'), ['foo.go']);
  });

  // AC-3: heredoc cat <<'EOF' — no file arg, content is inline
  test('AC-3: cat <<EOF (heredoc) returns []', () => {
    assert.deepEqual(extractReadStyleFileArgs("cat <<'EOF'"), []);
    assert.deepEqual(extractReadStyleFileArgs('cat <<EOF'), []);
    assert.deepEqual(extractReadStyleFileArgs("cat <<'EOF'\nhello\nEOF"), []);
  });

  test('returns [] when no file args (cat alone)', () => {
    assert.deepEqual(extractReadStyleFileArgs('cat'), []);
  });

  test('skips short flags (-n, -c, -q)', () => {
    const result = extractReadStyleFileArgs('tail -n 20 foo.go');
    assert.ok(!result.includes('-n'), 'should not include flag -n');
    assert.ok(!result.includes('20'), 'should not include numeric flag arg 20');
    assert.ok(result.includes('foo.go'), 'should include foo.go');
  });

  test('skips long flags (--lines)', () => {
    const result = extractReadStyleFileArgs('head --lines=10 foo.go');
    // --lines=10 is a single token starting with -
    assert.ok(!result.includes('--lines=10'), 'should not include --lines=10');
    assert.ok(result.includes('foo.go'), 'should include foo.go');
  });

  test('skips purely numeric tokens that follow a flag (flag-args like -n 5)', () => {
    const result = extractReadStyleFileArgs('head -n 5 foo.go');
    assert.ok(!result.includes('5'), 'should not include numeric flag arg "5"');
    assert.deepEqual(result, ['foo.go']);
  });

  test('handles multiple file args', () => {
    const result = extractReadStyleFileArgs('cat foo.go bar.go');
    assert.deepEqual(result, ['foo.go', 'bar.go']);
  });

  test('strips surrounding single quotes from file paths', () => {
    const result = extractReadStyleFileArgs("cat 'foo.go'");
    assert.deepEqual(result, ['foo.go']);
  });

  test('strips surrounding double quotes from file paths', () => {
    const result = extractReadStyleFileArgs('cat "foo.go"');
    assert.deepEqual(result, ['foo.go']);
  });

  test('skips output redirection tokens and their targets', () => {
    const result = extractReadStyleFileArgs('cat foo.go > output.txt');
    assert.ok(!result.includes('>'), 'should not include redirection operator');
    assert.ok(!result.includes('output.txt'), 'should not include redirection target');
    assert.deepEqual(result, ['foo.go']);
  });

  test('handles stderr redirection (2>)', () => {
    const result = extractReadStyleFileArgs('cat foo.go 2>/dev/null');
    assert.deepEqual(result, ['foo.go']);
  });

  test('returns [] for null/undefined input', () => {
    assert.deepEqual(extractReadStyleFileArgs(null), []);
    assert.deepEqual(extractReadStyleFileArgs(undefined), []);
    assert.deepEqual(extractReadStyleFileArgs(''), []);
  });

  test('handles path with directory prefix', () => {
    const result = extractReadStyleFileArgs('cat src/commands/df/update.md');
    assert.deepEqual(result, ['src/commands/df/update.md']);
  });

  test('works with non-cat read-style verbs', () => {
    assert.deepEqual(extractReadStyleFileArgs('bat hooks/lib/bash-scopes.js'), ['hooks/lib/bash-scopes.js']);
    assert.deepEqual(extractReadStyleFileArgs('view README.md'), ['README.md']);
  });
});

// ---------------------------------------------------------------------------
// Integration: helpers work together for AC-1 through AC-5 slice-guard logic
// ---------------------------------------------------------------------------

describe('integration: slice-guard logic simulation', () => {
  const activeSlice = ['foo.go'];

  function sliceGuardWouldBlock(cmd) {
    // Simulate what a slice guard would do:
    // 1. Split the command into pipe segments
    // 2. Check the first segment's verb
    // 3. If it's a read-style verb, extract file args
    // 4. Block if any file arg is NOT in the active slice
    const segs = splitPipeSegments(cmd);
    const firstSeg = segs[0];
    const verb = firstSeg.trim().split(/\s+/)[0];

    if (!READ_STYLE_VERBS.has(verb)) return false; // not a read-style command — pass

    const fileArgs = extractReadStyleFileArgs(firstSeg);
    if (fileArgs.length === 0) return false; // heredoc or no file args — pass

    return fileArgs.some(f => !activeSlice.includes(f));
  }

  // AC-1: cat bar.go should be blocked (bar.go not in slice)
  test('AC-1: cat bar.go is blocked when bar.go is not in active slice', () => {
    assert.equal(sliceGuardWouldBlock('cat bar.go'), true);
  });

  // AC-2: cat foo.go should pass (foo.go is in slice)
  test('AC-2: cat foo.go passes through when foo.go is in active slice', () => {
    assert.equal(sliceGuardWouldBlock('cat foo.go'), false);
  });

  // AC-3: cat <<'EOF' (heredoc) should pass
  test('AC-3: cat heredoc passes through (no file arg)', () => {
    assert.equal(sliceGuardWouldBlock("cat <<'EOF'\nhello\nEOF"), false);
  });

  // AC-4: go test ./... 2>&1 | grep FAIL should pass (not a read-style verb)
  test('AC-4: go test pipeline passes through (not a read-style command)', () => {
    assert.equal(sliceGuardWouldBlock('go test ./... 2>&1 | grep FAIL'), false);
  });

  // AC-5: df-spike cat any/file.go — cat IS a read-style verb (spike's scope is wider,
  // so the slice guard should not fire for spike agents; but the helpers correctly
  // identify it as a read-style command, enabling the guard to make that decision)
  test('AC-5: cat is correctly identified as read-style (slice guard can apply role filter)', () => {
    const verb = 'cat';
    assert.ok(READ_STYLE_VERBS.has(verb), 'cat is a read-style verb — slice guard can apply');
  });
});
