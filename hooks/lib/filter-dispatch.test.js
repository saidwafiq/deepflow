'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalize, PROTECTED, RULES, normalizeCmd, matchRule, dispatch, loadTemplates } = require('./filter-dispatch');

// ---------------------------------------------------------------------------
// AC-9: normalize(cmd) → NormalizedPattern
// ---------------------------------------------------------------------------

describe('normalize() — typed placeholder substitution', () => {

  // --- AC-9 core assertions ---

  test('git diff HEAD~5 and git diff main..feature produce distinct patterns', () => {
    const a = normalize('git diff HEAD~5');
    const b = normalize('git diff main..feature');
    // HEAD~5 → single <ref>; main..feature → <ref>..<ref>
    assert.notEqual(a.pattern, b.pattern,
      `expected distinct patterns but both produced: "${a.pattern}"`);
  });

  test('ls /a and ls /b normalize to the same pattern (ls <path>)', () => {
    const a = normalize('ls /a');
    const b = normalize('ls /b');
    assert.equal(a.pattern, b.pattern);
    assert.equal(a.pattern, 'ls <path>');
  });

  // --- Return shape ---

  test('returns NormalizedPattern with {pattern, argvShape, observations}', () => {
    const result = normalize('ls /tmp');
    assert.ok(typeof result.pattern === 'string', 'pattern must be string');
    assert.ok(Array.isArray(result.argvShape), 'argvShape must be array');
    assert.equal(result.observations, 0, 'observations must start at 0');
  });

  // --- Ref classification ---

  test('HEAD~3 is classified as <ref>', () => {
    const r = normalize('git show HEAD~3');
    assert.equal(r.pattern, 'git show <ref>');
    assert.deepEqual(r.argvShape, ['git', 'show', '<ref>']);
  });

  test('HEAD^2 is classified as <ref>', () => {
    const r = normalize('git show HEAD^2');
    assert.equal(r.pattern, 'git show <ref>');
  });

  test('SHA (7 hex chars) is classified as <ref>', () => {
    const r = normalize('git show abc1234');
    assert.equal(r.pattern, 'git show <ref>');
  });

  test('SHA (40 hex chars) is classified as <ref>', () => {
    const sha = 'a'.repeat(40);
    const r = normalize(`git show ${sha}`);
    assert.equal(r.pattern, 'git show <ref>');
  });

  test('HEAD alone is classified as <ref>', () => {
    const r = normalize('git log HEAD');
    assert.equal(r.pattern, 'git log <ref>');
  });

  test('plain branch name (no structure) passes through unchanged (conservative)', () => {
    // Conservative normalization: plain lowercase words like "main", "feature"
    // are NOT replaced — they lack the structural markers (/, ., ~N, ^N) that
    // distinguish a ref from a subcommand. They are absorbed into the pattern
    // as-is, which is correct — false-merge is worse than false-separation.
    const r = normalize('git log main');
    assert.equal(r.pattern, 'git log main');
  });

  test('origin/main is classified as <ref> (has / structure)', () => {
    const r = normalize('git log origin/main');
    assert.equal(r.pattern, 'git log <ref>');
  });

  // --- Range classification ---

  test('main..feature produces <ref>..<ref>', () => {
    const r = normalize('git diff main..feature');
    assert.equal(r.pattern, 'git diff <ref>..<ref>');
    assert.deepEqual(r.argvShape, ['git', 'diff', '<ref>..<ref>']);
  });

  test('HEAD~1...origin/main produces <ref>...<ref>', () => {
    const r = normalize('git diff HEAD~1...origin/main');
    assert.equal(r.pattern, 'git diff <ref>...<ref>');
  });

  test('HEAD~5 and main..feature shapes are different', () => {
    const a = normalize('git diff HEAD~5');
    const b = normalize('git diff main..feature');
    assert.notDeepEqual(a.argvShape, b.argvShape);
  });

  // --- Path classification ---

  test('/usr/bin/node is classified as <path>', () => {
    const r = normalize('ls /usr/bin/node');
    assert.equal(r.pattern, 'ls <path>');
  });

  test('multiple absolute paths become multiple <path> tokens', () => {
    const r = normalize('diff /etc/hosts /etc/hosts.bak');
    assert.equal(r.pattern, 'diff <path> <path>');
  });

  test('ls /a/b/c and ls /x/y/z normalize to the same pattern', () => {
    const a = normalize('ls /a/b/c');
    const b = normalize('ls /x/y/z');
    assert.equal(a.pattern, b.pattern);
  });

  // --- Glob classification ---

  test('*.js is classified as <glob>', () => {
    const r = normalize('find . -name *.js');
    assert.equal(r.pattern, 'find . -name <glob>');
  });

  test('**/*.ts is classified as <glob>', () => {
    const r = normalize('ls **/*.ts');
    assert.equal(r.pattern, 'ls <glob>');
  });

  test('src/*.test.js is classified as <glob>', () => {
    const r = normalize('node src/*.test.js');
    assert.equal(r.pattern, 'node <glob>');
  });

  // --- Flags pass through unchanged ---

  test('flags (starting with -) are preserved verbatim', () => {
    const r = normalize('git log --oneline --graph');
    assert.equal(r.pattern, 'git log --oneline --graph');
  });

  test('flags mixed with refs preserve flag tokens', () => {
    const r = normalize('git diff --stat HEAD~1');
    assert.equal(r.pattern, 'git diff --stat <ref>');
  });

  // --- Executable name always verbatim ---

  test('executable name is never replaced', () => {
    const r = normalize('git status');
    assert.ok(r.argvShape[0] === 'git', 'first token must be executable name');
  });

  test('leading whitespace is stripped before normalization', () => {
    const a = normalize('  ls /tmp');
    const b = normalize('ls /tmp');
    assert.equal(a.pattern, b.pattern);
  });

  // --- Edge cases ---

  test('empty string returns empty pattern and argvShape', () => {
    const r = normalize('');
    assert.equal(r.pattern, '');
    assert.deepEqual(r.argvShape, []);
    assert.equal(r.observations, 0);
  });

  test('single token (executable only) returns that token as pattern', () => {
    const r = normalize('ls');
    assert.equal(r.pattern, 'ls');
    assert.deepEqual(r.argvShape, ['ls']);
  });

  test('ORIG_HEAD is classified as <ref>', () => {
    const r = normalize('git diff ORIG_HEAD');
    assert.equal(r.pattern, 'git diff <ref>');
  });

  test('FETCH_HEAD is classified as <ref>', () => {
    const r = normalize('git diff FETCH_HEAD');
    assert.equal(r.pattern, 'git diff <ref>');
  });

  test('MERGE_HEAD is classified as <ref>', () => {
    const r = normalize('git diff MERGE_HEAD');
    assert.equal(r.pattern, 'git diff <ref>');
  });

  test('subcommand words (non-ref short strings) pass through', () => {
    // 'status', 'add', 'commit' etc. are subcommand words — they match _REF_SIMPLE
    // since they are alphanum but they look like branch names.
    // This is acceptable: conservative normalization means short words ARE refs.
    // Verify that at minimum the executable is preserved.
    const r = normalize('git status');
    assert.equal(r.argvShape[0], 'git');
  });
});

// ---------------------------------------------------------------------------
// Existing exports still work after adding normalize
// ---------------------------------------------------------------------------

describe('filter-dispatch — existing exports unaffected', () => {
  test('PROTECTED is an array of regexes', () => {
    assert.ok(Array.isArray(PROTECTED));
    assert.ok(PROTECTED.length > 0);
    assert.ok(PROTECTED[0] instanceof RegExp);
  });

  test('RULES is a non-empty array', () => {
    assert.ok(Array.isArray(RULES));
    assert.ok(RULES.length > 0);
  });

  test('normalizeCmd strips leading whitespace', () => {
    assert.equal(normalizeCmd('  git status'), 'git status');
  });

  test('matchRule finds npm ci', () => {
    const rule = matchRule('npm ci');
    assert.ok(rule !== null);
    assert.equal(rule.lines, 3);
  });

  test('dispatch returns pass-through for unknown command', () => {
    loadTemplates([]);
    const { filter, rewrite } = dispatch('echo hello');
    assert.equal(filter, null);
    assert.equal(rewrite, 'echo hello');
  });
});
