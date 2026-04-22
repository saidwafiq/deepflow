'use strict';

/**
 * Tests for hooks/df-bash-telemetry.js (REQ-5, AC-5)
 *
 * Verifies:
 *   1. Hook carries @hook-event: PostToolUse and @hook-owner: deepflow tags.
 *   2. runHook fixture appends one JSONL row per invocation with all required fields.
 *   3. All required fields (ts, pattern, raw_lines, raw_bytes, filter_applied,
 *      exit_code, follow_up_within_ms) are present and typed correctly.
 *   4. follow_up_within_ms is null on first call, non-negative number on repeat.
 *   5. filter_applied reflects dispatch() result (false when no template matched).
 *   6. Non-Bash tools produce no output and no JSONL row.
 *   7. Hook exits 0 always.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-bash-telemetry.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-bash-telemetry-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run the telemetry hook as a child process with JSON piped to stdin.
 * Returns { stdout, code }.
 */
function runHook(input, { cwd } = {}) {
  const json = JSON.stringify(input);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      cwd: cwd || os.tmpdir(),
      encoding: 'utf8',
      timeout: 5000,
    });
    return { stdout, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', code: err.status ?? 1 };
  }
}

/**
 * Read all JSONL records from bash-telemetry.jsonl in the given dir.
 * @param {string} dir
 * @returns {Array<Object>}
 */
function readTelemetry(dir) {
  const p = path.join(dir, '.deepflow', 'bash-telemetry.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

/**
 * Build a minimal PostToolUse Bash payload.
 */
function bashPayload(cmd, { output = '', isError = false, cwd } = {}) {
  return {
    tool_name: 'Bash',
    tool_input: { command: cmd },
    tool_result: {
      content: [{ type: 'text', text: output }],
      is_error: isError,
    },
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Tag verification (AC-5 prerequisite)
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — hook event tags', () => {
  function readFirstLines(n = 5) {
    return fs.readFileSync(HOOK_PATH, 'utf8').split('\n').slice(0, n);
  }

  test('carries @hook-event: PostToolUse on line 2', () => {
    const lines = readFirstLines();
    assert.match(lines[1], /\/\/\s*@hook-event:\s*PostToolUse/);
  });

  test('carries @hook-owner: deepflow within first 5 lines', () => {
    const lines = readFirstLines();
    const hasOwner = lines.some(l => /\/\/\s*@hook-owner:\s*deepflow/.test(l));
    assert.ok(hasOwner, 'should have @hook-owner: deepflow tag');
  });
});

// ---------------------------------------------------------------------------
// JSONL row structure (AC-5: one row per invocation, all required fields)
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — JSONL row structure', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('appends one JSONL row per Bash invocation', () => {
    runHook(bashPayload('echo hello', { output: 'hello\n', cwd: tmp }), { cwd: tmp });
    const rows = readTelemetry(tmp);
    assert.equal(rows.length, 1);
  });

  test('appended row contains all required fields', () => {
    runHook(bashPayload('echo hello', { output: 'hello\n', cwd: tmp }), { cwd: tmp });
    const row = readTelemetry(tmp)[0];
    assert.ok('ts' in row, 'missing ts');
    assert.ok('pattern' in row, 'missing pattern');
    assert.ok('raw_lines' in row, 'missing raw_lines');
    assert.ok('raw_bytes' in row, 'missing raw_bytes');
    assert.ok('filter_applied' in row, 'missing filter_applied');
    assert.ok('exit_code' in row, 'missing exit_code');
    assert.ok('follow_up_within_ms' in row, 'missing follow_up_within_ms');
  });

  test('ts is ISO-8601 string', () => {
    runHook(bashPayload('ls /tmp', { output: '', cwd: tmp }), { cwd: tmp });
    const { ts } = readTelemetry(tmp)[0];
    assert.equal(typeof ts, 'string');
    assert.ok(!isNaN(Date.parse(ts)), `ts should be a valid ISO-8601 date, got: ${ts}`);
  });

  test('pattern is a non-empty string', () => {
    runHook(bashPayload('git status', { output: '', cwd: tmp }), { cwd: tmp });
    const { pattern } = readTelemetry(tmp)[0];
    assert.equal(typeof pattern, 'string');
    assert.ok(pattern.length > 0);
  });

  test('raw_lines is a non-negative integer', () => {
    runHook(bashPayload('echo hi', { output: 'hi\n', cwd: tmp }), { cwd: tmp });
    const { raw_lines } = readTelemetry(tmp)[0];
    assert.equal(typeof raw_lines, 'number');
    assert.ok(Number.isInteger(raw_lines));
    assert.ok(raw_lines >= 0);
  });

  test('raw_bytes is a non-negative integer', () => {
    runHook(bashPayload('echo hi', { output: 'hi\n', cwd: tmp }), { cwd: tmp });
    const { raw_bytes } = readTelemetry(tmp)[0];
    assert.equal(typeof raw_bytes, 'number');
    assert.ok(Number.isInteger(raw_bytes));
    assert.ok(raw_bytes >= 0);
  });

  test('filter_applied is a boolean', () => {
    runHook(bashPayload('echo hi', { output: '', cwd: tmp }), { cwd: tmp });
    const { filter_applied } = readTelemetry(tmp)[0];
    assert.equal(typeof filter_applied, 'boolean');
  });

  test('exit_code is null or integer', () => {
    runHook(bashPayload('echo hi', { output: '', isError: false, cwd: tmp }), { cwd: tmp });
    const { exit_code } = readTelemetry(tmp)[0];
    const valid = exit_code === null || (typeof exit_code === 'number' && Number.isInteger(exit_code));
    assert.ok(valid, `exit_code should be null or integer, got: ${exit_code}`);
  });

  test('follow_up_within_ms is null on first call', () => {
    runHook(bashPayload('git log', { output: '', cwd: tmp }), { cwd: tmp });
    const { follow_up_within_ms } = readTelemetry(tmp)[0];
    assert.equal(follow_up_within_ms, null);
  });
});

// ---------------------------------------------------------------------------
// follow_up_within_ms — second call for same pattern
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — follow_up_within_ms tracking', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('follow_up_within_ms is non-negative integer on second call with same pattern', () => {
    const payload = bashPayload('git status', { output: '', cwd: tmp });
    runHook(payload, { cwd: tmp });
    runHook(payload, { cwd: tmp });
    const rows = readTelemetry(tmp);
    assert.equal(rows.length, 2);
    const second = rows[1];
    assert.notEqual(second.follow_up_within_ms, null);
    assert.equal(typeof second.follow_up_within_ms, 'number');
    assert.ok(second.follow_up_within_ms >= 0, `expected >= 0, got ${second.follow_up_within_ms}`);
  });

  test('different patterns track independently (first call each is null)', () => {
    runHook(bashPayload('npm ci', { output: '', cwd: tmp }), { cwd: tmp });
    runHook(bashPayload('git diff HEAD~1', { output: '', cwd: tmp }), { cwd: tmp });
    const rows = readTelemetry(tmp);
    assert.equal(rows.length, 2);
    // Both are first calls for their respective patterns
    assert.equal(rows[0].follow_up_within_ms, null);
    assert.equal(rows[1].follow_up_within_ms, null);
  });

  test('appends multiple rows across multiple calls', () => {
    for (let i = 0; i < 3; i++) {
      runHook(bashPayload(`ls /tmp/${i}`, { output: '', cwd: tmp }), { cwd: tmp });
    }
    const rows = readTelemetry(tmp);
    assert.equal(rows.length, 3);
  });
});

// ---------------------------------------------------------------------------
// filter_applied reflects dispatch() result
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — filter_applied field', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('filter_applied is false when no template matches (echo has no filter)', () => {
    runHook(bashPayload('echo hello', { output: '', cwd: tmp }), { cwd: tmp });
    const { filter_applied } = readTelemetry(tmp)[0];
    assert.equal(filter_applied, false);
  });
});

// ---------------------------------------------------------------------------
// raw_lines and raw_bytes match actual output
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — raw_lines and raw_bytes', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('raw_bytes matches byte length of output', () => {
    const output = 'line one\nline two\n';
    runHook(bashPayload('echo test', { output, cwd: tmp }), { cwd: tmp });
    const { raw_bytes } = readTelemetry(tmp)[0];
    assert.equal(raw_bytes, Buffer.byteLength(output, 'utf8'));
  });

  test('raw_lines matches line count of output', () => {
    const output = 'line one\nline two\nline three\n';
    runHook(bashPayload('echo test', { output, cwd: tmp }), { cwd: tmp });
    const { raw_lines } = readTelemetry(tmp)[0];
    // 'line one\nline two\nline three\n'.split('\n') = 4 items (trailing empty)
    assert.equal(raw_lines, output.split('\n').length);
  });

  test('raw_bytes is 0 for empty output', () => {
    runHook(bashPayload('true', { output: '', cwd: tmp }), { cwd: tmp });
    const { raw_bytes, raw_lines } = readTelemetry(tmp)[0];
    assert.equal(raw_bytes, 0);
    assert.equal(raw_lines, 0);
  });
});

// ---------------------------------------------------------------------------
// exit_code field
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — exit_code field', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('exit_code is 0 when is_error=false', () => {
    runHook(bashPayload('echo ok', { output: 'ok', isError: false, cwd: tmp }), { cwd: tmp });
    const { exit_code } = readTelemetry(tmp)[0];
    assert.equal(exit_code, 0);
  });

  test('exit_code is 1 when is_error=true', () => {
    runHook(bashPayload('false', { output: '', isError: true, cwd: tmp }), { cwd: tmp });
    const { exit_code } = readTelemetry(tmp)[0];
    assert.equal(exit_code, 1);
  });
});

// ---------------------------------------------------------------------------
// Non-Bash tools: no output, no JSONL row
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — non-Bash tools skipped', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('does not append a row for Read tool', () => {
    runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_result: { content: 'file content' },
      cwd: tmp,
    }, { cwd: tmp });
    const rows = readTelemetry(tmp);
    assert.equal(rows.length, 0);
  });

  test('produces no stdout for non-Bash tools', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
      tool_result: {},
      cwd: tmp,
    }, { cwd: tmp });
    assert.equal(r.stdout, '');
  });
});

// ---------------------------------------------------------------------------
// Hook always exits 0
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — exit code', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('exits 0 for valid Bash event', () => {
    const r = runHook(bashPayload('echo hi', { output: 'hi', cwd: tmp }), { cwd: tmp });
    assert.equal(r.code, 0);
  });

  test('exits 0 for non-Bash event', () => {
    const r = runHook({ tool_name: 'Read', tool_input: {}, tool_result: {}, cwd: tmp }, { cwd: tmp });
    assert.equal(r.code, 0);
  });

  test('exits 0 for malformed event (no tool_name)', () => {
    const r = runHook({ cwd: tmp }, { cwd: tmp });
    assert.equal(r.code, 0);
  });
});

// ---------------------------------------------------------------------------
// pattern field matches normalize() output
// ---------------------------------------------------------------------------

describe('df-bash-telemetry.js — pattern normalization', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
    fs.mkdirSync(path.join(tmp, '.deepflow'), { recursive: true });
  });
  afterEach(() => rmrf(tmp));

  test('pattern for "git diff HEAD~5" normalizes HEAD~5 to <ref>', () => {
    runHook(bashPayload('git diff HEAD~5', { output: '', cwd: tmp }), { cwd: tmp });
    const { pattern } = readTelemetry(tmp)[0];
    assert.equal(pattern, 'git diff <ref>');
  });

  test('pattern for "ls /a" and "ls /b" both normalize to "ls <path>"', () => {
    runHook(bashPayload('ls /a', { output: '', cwd: tmp }), { cwd: tmp });
    runHook(bashPayload('ls /b', { output: '', cwd: tmp }), { cwd: tmp });
    const rows = readTelemetry(tmp);
    assert.equal(rows[0].pattern, 'ls <path>');
    assert.equal(rows[1].pattern, 'ls <path>');
  });
});
