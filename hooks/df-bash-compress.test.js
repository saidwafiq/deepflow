/**
 * Tests for hooks/df-bash-compress.js
 *
 * PostToolUse hook that compresses verbose bash output into a one-line summary.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-bash-compress.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-bash-compress-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function makeDeepflowProject(dir) {
  fs.mkdirSync(path.join(dir, '.deepflow'), { recursive: true });
}

function makeLines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

function runHook(input, { cwd } = {}) {
  const json = JSON.stringify(input);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      cwd: cwd || os.tmpdir(),
      encoding: 'utf8',
      timeout: 5000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// 1. Pass-through: no output injected
// ---------------------------------------------------------------------------

describe('df-bash-compress — pass-through (no stdout, exit 0)', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); makeDeepflowProject(tmp); });
  afterEach(() => rmrf(tmp));

  test('skips non-Bash tools', () => {
    const r = runHook({
      tool_name: 'Read',
      tool_response: { output: makeLines(50), returncode: 0 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test('skips short output (≤ threshold)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: makeLines(15), returncode: 0 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test('skips JSON output', () => {
    const json = JSON.stringify({ waves: [{ wave: 1, tasks: Array(20).fill({ id: 'T1' }) }] });
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: json, returncode: 0 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test('skips JSON array output', () => {
    const arr = JSON.stringify(Array.from({ length: 20 }, (_, i) => `item-${i}`));
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: arr, returncode: 0 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test('skips non-zero exit code', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: makeLines(50), returncode: 1 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test('skips when .deepflow dir is absent', () => {
    const plain = makeTmpDir(); // no .deepflow subdir
    try {
      const r = runHook({
        tool_name: 'Bash',
        tool_response: { output: makeLines(50), returncode: 0 },
        cwd: plain,
      });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    } finally {
      rmrf(plain);
    }
  });

  test('exits 0 on invalid JSON input (fail open)', () => {
    const r = runHook({ tool_name: 'Bash' }); // no tool_response
    assert.equal(r.code, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Compression triggered
// ---------------------------------------------------------------------------

describe('df-bash-compress — compresses verbose output', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); makeDeepflowProject(tmp); });
  afterEach(() => rmrf(tmp));

  test('injects summary line when output > threshold', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: makeLines(30), returncode: 0 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('[df-bash-compress]'), 'should contain tag');
    assert.ok(r.stdout.includes('30 lines'), 'should include line count');
  });

  test('summary is exactly one line', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: makeLines(50), returncode: 0 },
      cwd: tmp,
    });
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'summary must be exactly one line');
  });

  test('summary includes first and last line content', () => {
    const output = 'first-unique-line\n' + makeLines(20, 'mid') + '\nlast-unique-line';
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output, returncode: 0 },
      cwd: tmp,
    });
    assert.ok(r.stdout.includes('first-unique-line'));
    assert.ok(r.stdout.includes('last-unique-line'));
  });

  test('works with string tool_response (legacy format)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: makeLines(25),
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('[df-bash-compress]'));
  });

  test('works with content field instead of output', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { content: makeLines(25), returncode: 0 },
      cwd: tmp,
    });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('[df-bash-compress]'));
  });

  test('summary includes instruction to ignore raw output', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: makeLines(30), returncode: 0 },
      cwd: tmp,
    });
    assert.ok(r.stdout.includes('ignore raw output above'));
  });

  test('threshold boundary: exactly 16 lines triggers compression', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output: makeLines(16), returncode: 0 },
      cwd: tmp,
    });
    assert.ok(r.stdout.includes('[df-bash-compress]'));
  });

  test('counts only non-empty lines toward threshold', () => {
    // 20 content lines + 10 blank lines = 20 non-empty, should compress
    const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n\n');
    const r = runHook({
      tool_name: 'Bash',
      tool_response: { output, returncode: 0 },
      cwd: tmp,
    });
    assert.ok(r.stdout.includes('[df-bash-compress]'));
  });
});
