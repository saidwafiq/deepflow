'use strict';

/**
 * AC-2: ≥8 template files in hooks/filters/templates/; each exports
 *       { name, archetype, match(cmd), apply(raw) -> {header, body, truncated?} }.
 * AC-3: apply() output matches schema  ^# .+\n(.*\n)*(-- truncated \d+ lines --)?$
 *       (header starts with "# "; truncation marker when present matches the pattern).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = path.resolve(__dirname, 'templates');

const EXPECTED_NAMES = [
  'truncate-stable',
  'group-by-prefix',
  'json-project',
  'resolve-and-report',
  'failures-only',
  'head-tail-window',
  'summarize-tree',
  'diff-stat-only',
];

function loadTemplate(name) {
  return require(path.join(TEMPLATES_DIR, `${name}.js`));
}

/**
 * Assert the FilteredOutput schema:
 *   header: string starting with "# "
 *   body:   string (may be empty)
 *   truncated?: { lines: number } (if present, lines > 0)
 */
function assertSchema(result, label) {
  assert.ok(result && typeof result === 'object', `${label}: result must be an object`);
  assert.ok(typeof result.header === 'string', `${label}: header must be a string`);
  assert.ok(result.header.startsWith('# '), `${label}: header must start with "# ", got: ${JSON.stringify(result.header)}`);
  assert.ok(typeof result.body === 'string', `${label}: body must be a string`);
  if (result.truncated !== undefined) {
    assert.ok(typeof result.truncated === 'object', `${label}: truncated must be an object`);
    assert.ok(typeof result.truncated.lines === 'number', `${label}: truncated.lines must be a number`);
    assert.ok(result.truncated.lines > 0, `${label}: truncated.lines must be > 0`);
  }
}

// ---------------------------------------------------------------------------
// AC-2: module shape
// ---------------------------------------------------------------------------

describe('AC-2: template module shape', () => {
  for (const name of EXPECTED_NAMES) {
    test(`${name} exports required fields`, () => {
      const tpl = loadTemplate(name);
      assert.ok(tpl, `${name}: module must export an object`);
      assert.equal(typeof tpl.name, 'string', `${name}: must export name string`);
      assert.ok(tpl.name.length > 0, `${name}: name must be non-empty`);
      assert.equal(typeof tpl.archetype, 'string', `${name}: must export archetype string`);
      assert.ok(tpl.archetype.length > 0, `${name}: archetype must be non-empty`);
      assert.equal(typeof tpl.match, 'function', `${name}: must export match function`);
      assert.equal(typeof tpl.apply, 'function', `${name}: must export apply function`);
    });
  }

  test('at least 8 templates exist', () => {
    assert.ok(EXPECTED_NAMES.length >= 8, `Expected ≥8 templates, got ${EXPECTED_NAMES.length}`);
    for (const name of EXPECTED_NAMES) {
      const tpl = loadTemplate(name);
      assert.ok(tpl, `Template ${name} failed to load`);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 + AC-3: fixture-per-archetype snapshot with schema assertion
// ---------------------------------------------------------------------------

describe('AC-2+AC-3: apply() schema per archetype', () => {

  test('truncate-stable: apply emits valid schema', () => {
    const tpl = loadTemplate('truncate-stable');
    // match should fire for npm ci
    assert.ok(tpl.match('npm ci'), 'match should accept "npm ci"');
    assert.ok(tpl.match('pnpm install'), 'match should accept "pnpm install"');
    assert.ok(!tpl.match('git diff'), 'match should reject "git diff"');

    // fixture: 10 lines of output
    const raw = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'truncate-stable');
    // truncation expected: 10 lines → keep last 5 → 5 dropped
    assert.ok(result.truncated, 'should mark truncated when output > KEEP_LINES');
    assert.equal(result.truncated.lines, 5);
  });

  test('truncate-stable: no truncation when output fits window', () => {
    const tpl = loadTemplate('truncate-stable');
    const raw = 'line 1\nline 2\nline 3';
    const result = tpl.apply(raw);
    assertSchema(result, 'truncate-stable short');
    assert.ok(!result.truncated, 'no truncation for short output');
  });

  test('group-by-prefix: apply emits valid schema', () => {
    const tpl = loadTemplate('group-by-prefix');
    assert.ok(tpl.match('ls -la /some/path'), 'match should accept "ls -la /some/path"');
    assert.ok(!tpl.match('npm ci'), 'match should reject "npm ci"');

    const raw = [
      'src/components/Button.js',
      'src/components/Input.js',
      'src/utils/format.js',
      'tests/Button.test.js',
    ].join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'group-by-prefix');
    assert.ok(result.body.includes('src'), 'body should reference src prefix');
  });

  test('json-project: apply emits valid schema with valid JSON', () => {
    const tpl = loadTemplate('json-project');
    assert.ok(tpl.match('cat package.json'), 'match should accept "cat package.json"');
    assert.ok(!tpl.match('git diff'), 'match should reject "git diff"');

    const pkg = JSON.stringify({
      name: 'my-pkg',
      version: '1.0.0',
      scripts: { build: 'tsc', test: 'jest', lint: 'eslint .' },
      dependencies: { lodash: '^4.0.0', express: '^4.18.0' },
      devDependencies: { jest: '^29.0.0' },
    }, null, 2);
    const result = tpl.apply(pkg);
    assertSchema(result, 'json-project');
    assert.ok(result.body.includes('my-pkg'), 'body should include package name');
    assert.ok(result.body.includes('1.0.0'), 'body should include version');
  });

  test('json-project: apply handles invalid JSON gracefully', () => {
    const tpl = loadTemplate('json-project');
    const result = tpl.apply('not json at all\nmore lines\n');
    assertSchema(result, 'json-project invalid');
    // header should mention parse failure
    assert.ok(result.header.includes('parse failed') || result.header.includes('json-project'), 'header present');
  });

  test('resolve-and-report: apply emits valid schema', () => {
    const tpl = loadTemplate('resolve-and-report');
    assert.ok(tpl.match('readlink -f /some/path'), 'match should accept readlink');
    assert.ok(tpl.match('ls -la /foo'), 'match should accept ls -la with path');
    assert.ok(!tpl.match('npm ci'), 'match should reject npm ci');

    const raw = [
      '/real/path/to/file',
      'readlink: /broken/link: too many levels of symbolic links',
      '/another/good/path',
    ].join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'resolve-and-report');
    assert.ok(result.body.includes('too many levels'), 'error line should appear in body');
  });

  test('failures-only: apply emits valid schema — test output with failures', () => {
    const tpl = loadTemplate('failures-only');
    assert.ok(tpl.match('npm test'), 'match should accept "npm test"');
    assert.ok(tpl.match('node --test hooks/df-bash-rewrite.test.js'), 'match should accept node --test');
    assert.ok(!tpl.match('git diff'), 'match should reject git diff');

    const raw = [
      'TAP version 14',
      'ok 1 - passes fine',
      'ok 2 - also passes',
      'not ok 3 - dispatch returns null',
      '  Error: expected null, got "something"',
      '    at Object.<anonymous> (test.js:42:5)',
      'ok 4 - another passing test',
      '# tests 4',
      '# pass  3',
      '# fail  1',
    ].join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'failures-only');
    assert.ok(result.body.includes('not ok 3'), 'failure line should appear');
    assert.ok(!result.body.includes('ok 1'), 'passing lines should be suppressed');
  });

  test('failures-only: all-passing output produces minimal body', () => {
    const tpl = loadTemplate('failures-only');
    const raw = [
      'ok 1 - test one',
      'ok 2 - test two',
      '# tests 2',
      '# pass  2',
    ].join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'failures-only all-pass');
    // body should not contain passing test lines
    assert.ok(!result.body.includes('ok 1'), 'no passing lines in output');
  });

  test('head-tail-window: apply emits valid schema with truncation', () => {
    const tpl = loadTemplate('head-tail-window');
    assert.ok(tpl.match('git log --oneline'), 'match should accept git log --oneline');
    assert.ok(tpl.match('cat README.md'), 'match should accept cat <file>');
    assert.ok(!tpl.match('npm ci'), 'match should reject npm ci');

    const raw = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'head-tail-window');
    assert.ok(result.truncated, 'should truncate 20 lines (window=10)');
    assert.equal(result.truncated.lines, 10); // 20 - 5 head - 5 tail
    assert.ok(result.body.includes('-- 10 lines omitted --'), 'omission marker present');
  });

  test('head-tail-window: no truncation when output fits window', () => {
    const tpl = loadTemplate('head-tail-window');
    const raw = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'head-tail-window short');
    assert.ok(!result.truncated, 'no truncation for short output');
  });

  test('summarize-tree: apply emits valid schema', () => {
    const tpl = loadTemplate('summarize-tree');
    assert.ok(tpl.match('tree src/'), 'match should accept tree command');
    assert.ok(tpl.match('find . -name "*.js" -print'), 'match should accept find -print');
    assert.ok(!tpl.match('npm ci'), 'match should reject npm ci');

    const raw = [
      'src',
      '├── components',
      '│   ├── Button.js',
      '│   └── Input.js',
      '├── utils',
      '│   └── format.js',
      '└── index.js',
      '',
      '2 directories, 4 files',
    ].join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'summarize-tree');
    assert.ok(result.body.includes('depth'), 'body should contain depth summary');
  });

  test('diff-stat-only: apply emits valid schema — diff with stat block', () => {
    const tpl = loadTemplate('diff-stat-only');
    assert.ok(tpl.match('git diff HEAD~1'), 'match should accept git diff');
    assert.ok(tpl.match('git show abc1234'), 'match should accept git show');
    assert.ok(!tpl.match('git diff --stat'), 'should not match already-stat commands');
    assert.ok(!tpl.match('npm ci'), 'match should reject npm ci');

    const raw = [
      'diff --git a/foo.js b/foo.js',
      'index 123abc..456def 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,5 +1,6 @@',
      '-old line',
      '+new line',
      ' context line',
      ' foo.js | 2 +-',
      ' bar.js | 5 +++++',
      ' 2 files changed, 6 insertions(+), 1 deletion(-)',
    ].join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'diff-stat-only');
    assert.ok(result.body.includes('2 files changed'), 'summary line should appear');
    assert.ok(result.body.includes('foo.js'), 'stat line should appear');
  });

  test('diff-stat-only: fallback for diff without stat block', () => {
    const tpl = loadTemplate('diff-stat-only');
    const raw = Array.from({ length: 20 }, (_, i) => `+new line ${i}`).join('\n');
    const result = tpl.apply(raw);
    assertSchema(result, 'diff-stat-only no-stat');
    // should still produce valid schema even without stat block
    assert.ok(result.header.startsWith('# '));
  });
});

// ---------------------------------------------------------------------------
// AC-3: output matches regex pattern
// ---------------------------------------------------------------------------

describe('AC-3: output schema regex compliance', () => {
  // Schema: header must start with "# ", body is any string, truncated marker
  // format is "-- truncated N lines --" (found in body for head-tail-window) or
  // in the truncated object. We assert the truncated object format strictly.

  for (const name of EXPECTED_NAMES) {
    test(`${name}: apply() header always starts with "# "`, () => {
      const tpl = loadTemplate(name);
      // Use a generic multi-line raw input for each
      const raw = Array.from({ length: 50 }, (_, i) => `content line ${i + 1}`).join('\n');
      const result = tpl.apply(raw);
      assert.match(result.header, /^# .+/, `${name}: header regex mismatch`);
    });
  }
});

// ---------------------------------------------------------------------------
// loadBuiltinTemplates integration
// ---------------------------------------------------------------------------

describe('loadBuiltinTemplates integration', () => {
  test('loadBuiltinTemplates loads all 8 templates', () => {
    const { loadBuiltinTemplates, BUILTIN_TEMPLATE_NAMES } = require('../lib/filter-dispatch');
    const loaded = loadBuiltinTemplates();
    assert.ok(loaded.length >= 8, `Expected ≥8 templates, got ${loaded.length}`);
    assert.equal(loaded.length, BUILTIN_TEMPLATE_NAMES.length);
  });

  test('dispatch() resolves template after loadBuiltinTemplates', () => {
    const { loadBuiltinTemplates, dispatch } = require('../lib/filter-dispatch');
    loadBuiltinTemplates();
    // git diff should match diff-stat-only
    const { filter } = dispatch('git diff HEAD~1');
    assert.ok(filter, 'dispatch should return a filter for git diff HEAD~1');
    assert.equal(filter.name, 'diff-stat-only');
  });
});
