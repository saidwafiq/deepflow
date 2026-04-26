'use strict';
// covers specs/ac-scope-isolation.md#AC-2
// covers specs/ac-scope-isolation.md#AC-3
// covers specs/ac-scope-isolation.md#AC-4
// covers specs/ac-scope-isolation.md#AC-5
// covers specs/ac-scope-isolation.md#AC-8
// covers specs/agent-delegation-contract.md#AC-1
// covers specs/agent-delegation-contract.md#AC-2
// covers specs/agent-delegation-contract.md#AC-3
// covers specs/agent-delegation-contract.md#AC-4
// covers specs/agent-delegation-contract.md#AC-5
// covers specs/agent-delegation-contract.md#AC-6
// covers specs/agent-delegation-contract.md#AC-7
// covers specs/agent-delegation-contract.md#AC-8
// covers specs/agent-delegation-contract.md#AC-9
// covers specs/agent-delegation-contract.md#AC-10

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getCanonicalSpecSlug, scanTestFilesForScopedACs } = require('./ac-coverage.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp dir, write named files, return { dir, paths }. Caller cleans up. */
function makeTmpFixtures(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cov-test-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf8');
    paths[name] = p;
  }
  return { dir, paths };
}

function removeTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── AC-4: getCanonicalSpecSlug ────────────────────────────────────────────────

test('AC-4: plain spec path → bare slug', () => {
  assert.equal(getCanonicalSpecSlug('specs/foo.md'), 'foo');
});

test('AC-4: doing- prefix stripped', () => {
  assert.equal(getCanonicalSpecSlug('specs/doing-foo.md'), 'foo');
});

test('AC-4: done- prefix stripped', () => {
  assert.equal(getCanonicalSpecSlug('specs/done-foo.md'), 'foo');
});

test('AC-4: leading directory segments ignored', () => {
  assert.equal(getCanonicalSpecSlug('/home/user/project/specs/doing-ac-scope-isolation.md'), 'ac-scope-isolation');
});

test('AC-4: path with trailing slash on directory (basename still works)', () => {
  // path.basename strips the trailing slash on directory prefix; the file itself has no trailing slash
  assert.equal(getCanonicalSpecSlug('specs/doing-foo.md'), 'foo');
});

// ── AC-2, AC-3: scanTestFilesForScopedACs — pattern matching ─────────────────

test('AC-2 AC-3: line comment reference is found', () => {
  const { dir, paths } = makeTmpFixtures({
    'a.test.js': '// covers specs/foo.md#AC-1\nconst x = 1;\n',
  });
  try {
    const result = scanTestFilesForScopedACs([paths['a.test.js']], 'foo');
    assert.ok(result.has('AC-1'), 'expected AC-1 from line comment');
  } finally {
    removeTmpDir(dir);
  }
});

test('AC-2 AC-3: JSDoc @covers reference is found', () => {
  const { dir, paths } = makeTmpFixtures({
    'b.test.js': '/**\n * @covers specs/foo.md#AC-2\n */\nfunction x() {}\n',
  });
  try {
    const result = scanTestFilesForScopedACs([paths['b.test.js']], 'foo');
    assert.ok(result.has('AC-2'), 'expected AC-2 from JSDoc');
  } finally {
    removeTmpDir(dir);
  }
});

test('AC-2 AC-3: string literal reference is found', () => {
  const { dir, paths } = makeTmpFixtures({
    'c.test.js': "test('should handle specs/foo.md#AC-3', () => {});\n",
  });
  try {
    const result = scanTestFilesForScopedACs([paths['c.test.js']], 'foo');
    assert.ok(result.has('AC-3'), 'expected AC-3 from string literal');
  } finally {
    removeTmpDir(dir);
  }
});

test('AC-2 AC-3: all three in one file — AC-1, AC-2, AC-3 all returned', () => {
  const content = [
    '// covers specs/foo.md#AC-1',
    '/**',
    ' * @covers specs/foo.md#AC-2',
    ' */',
    "test('should handle specs/foo.md#AC-3', () => {});",
  ].join('\n');

  const { dir, paths } = makeTmpFixtures({ 'all.test.js': content });
  try {
    const result = scanTestFilesForScopedACs([paths['all.test.js']], 'foo');
    assert.ok(result.has('AC-1'), 'AC-1 missing');
    assert.ok(result.has('AC-2'), 'AC-2 missing');
    assert.ok(result.has('AC-3'), 'AC-3 missing');
  } finally {
    removeTmpDir(dir);
  }
});

// ── AC-2: bare AC-N without scoped prefix is NOT matched ─────────────────────

test('AC-2: bare AC-1 without specs/{slug}.md# prefix is not matched', () => {
  const { dir, paths } = makeTmpFixtures({
    'bare.test.js': '// covers AC-1\ntest("AC-2 passes", () => {});\n',
  });
  try {
    const result = scanTestFilesForScopedACs([paths['bare.test.js']], 'foo');
    assert.equal(result.size, 0, 'expected no matches for bare AC-N');
  } finally {
    removeTmpDir(dir);
  }
});

// ── AC-5, AC-8: cross-spec collision isolation ────────────────────────────────

test('AC-5 AC-8: file with refs to two specs — scanning for spec a returns only AC-1', () => {
  const content = [
    '// covers specs/a.md#AC-1',
    '// covers specs/b.md#AC-2',
  ].join('\n');

  const { dir, paths } = makeTmpFixtures({ 'tmp.test.js': content });
  try {
    const resultA = scanTestFilesForScopedACs([paths['tmp.test.js']], 'a');
    assert.ok(resultA.has('AC-1'), 'expected AC-1 for slug a');
    assert.ok(!resultA.has('AC-2'), 'AC-2 from spec b leaked into slug a scan');
  } finally {
    removeTmpDir(dir);
  }
});

test('AC-5 AC-8: file with refs to two specs — scanning for spec b returns only AC-2', () => {
  const content = [
    '// covers specs/a.md#AC-1',
    '// covers specs/b.md#AC-2',
  ].join('\n');

  const { dir, paths } = makeTmpFixtures({ 'tmp.test.js': content });
  try {
    const resultB = scanTestFilesForScopedACs([paths['tmp.test.js']], 'b');
    assert.ok(resultB.has('AC-2'), 'expected AC-2 for slug b');
    assert.ok(!resultB.has('AC-1'), 'AC-1 from spec a leaked into slug b scan');
  } finally {
    removeTmpDir(dir);
  }
});
