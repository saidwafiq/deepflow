'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-implement-test-invocation-cap.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-cap-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Create a minimal .deepflow project with config.yaml in dir */
function makeDeepflowProject(dir, { buildCommand = '', testCommand = '' } = {}) {
  fs.mkdirSync(path.join(dir, '.deepflow'), { recursive: true });
  const config = [
    'quality:',
    `  build_command: "${buildCommand}"`,
    `  test_command: "${testCommand}"`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.deepflow', 'config.yaml'), config, 'utf8');
}

function runHook(input, { cwd, env } = {}) {
  const json = JSON.stringify(input);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      cwd: cwd || os.tmpdir(),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
    return { stdout, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', code: err.status ?? 1 };
  }
}

function parsed(stdout) {
  if (!stdout.trim()) return null;
  return JSON.parse(stdout.trim());
}

function isDenied(stdout) {
  const p = parsed(stdout);
  return p?.hookSpecificOutput?.permissionDecision === 'deny';
}

function counterPath(dir, taskId) {
  return path.join(dir, '.deepflow', 'runtime', 'task-counters', `${taskId}.json`);
}

// ---------------------------------------------------------------------------
// AC-2: Test invocation cap
// ---------------------------------------------------------------------------

// specs/cut-implement-task-waste.md#AC-2

describe('df-implement-test-invocation-cap — first invocation allowed', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmpDir();
    makeDeepflowProject(tmp, { testCommand: 'node --test' });
  });
  afterEach(() => rmrf(tmp));

  test('first invocation of test_command passes through (no output)', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'node --test' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T1', DEEPFLOW_AGENT_ROLE: 'implement' } },
    );
    assert.equal(r.stdout, '', 'first call must produce no output (pass through)');
  });

  test('counter file exists after first invocation', () => {
    runHook(
      { tool_name: 'Bash', tool_input: { command: 'node --test' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T1' } },
    );
    const file = counterPath(tmp, 'T1');
    assert.ok(fs.existsSync(file), 'counter file must be created after first call');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.task_id, 'T1');
    assert.equal(data.test_invocations, 1);
    assert.ok(data.first_invocation_at, 'must record first_invocation_at');
  });

  test('non-matching command passes through even with task ID set', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'echo hello' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T1' } },
    );
    assert.equal(r.stdout, '');
  });
});

describe('df-implement-test-invocation-cap — second invocation denied', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmpDir();
    makeDeepflowProject(tmp, { testCommand: 'node --test' });
  });
  afterEach(() => rmrf(tmp));

  test('second invocation of test_command is denied', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'node --test' }, cwd: tmp };
    const opts = { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T2' } };
    // First — must pass
    const r1 = runHook(payload, opts);
    assert.equal(r1.stdout, '');
    // Second — must deny
    const r2 = runHook(payload, opts);
    assert.ok(isDenied(r2.stdout), 'second call must be denied');
  });

  test('deny message references the task ID and fix hint', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'node --test' }, cwd: tmp };
    const opts = { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T3' } };
    runHook(payload, opts); // first
    const r2 = runHook(payload, opts); // second
    const p = parsed(r2.stdout);
    const reason = p?.hookSpecificOutput?.permissionDecisionReason || '';
    assert.ok(reason.includes('T3'), 'reason must include task ID');
    assert.ok(reason.toLowerCase().includes('fix root cause'), 'reason must include fix hint');
  });
});

describe('df-implement-test-invocation-cap — different task ID resets count', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmpDir();
    makeDeepflowProject(tmp, { testCommand: 'node --test' });
  });
  afterEach(() => rmrf(tmp));

  test('different task ID allows a fresh first invocation', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'node --test' }, cwd: tmp };
    // Task T10 — first call
    runHook(payload, { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T10' } });
    // Task T11 — also a first call (different ID, no counter file)
    const r = runHook(payload, { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T11' } });
    assert.equal(r.stdout, '', 'first call for a new task ID must pass through');
  });

  test('second call for T10 is denied even after T11 first call', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'node --test' }, cwd: tmp };
    runHook(payload, { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T10' } }); // T10 #1
    runHook(payload, { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T11' } }); // T11 #1
    const r = runHook(payload, { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T10' } }); // T10 #2
    assert.ok(isDenied(r.stdout), 'T10 second call must be denied');
  });
});

describe('df-implement-test-invocation-cap — build_command also capped', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmpDir();
    makeDeepflowProject(tmp, { buildCommand: 'npm run build', testCommand: 'npm test' });
  });
  afterEach(() => rmrf(tmp));

  test('first invocation of build_command passes through', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm run build' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T5' } },
    );
    assert.equal(r.stdout, '');
  });

  test('second invocation of build_command is denied', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'npm run build' }, cwd: tmp };
    const opts = { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T5' } };
    runHook(payload, opts);
    const r2 = runHook(payload, opts);
    assert.ok(isDenied(r2.stdout));
  });
});

describe('df-implement-test-invocation-cap — fail open cases', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('no .deepflow dir — passes through (fail open)', () => {
    // No .deepflow config created
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T99' } },
    );
    assert.equal(r.stdout, '', 'must fail open when no config found');
  });

  test('no DEEPFLOW_TASK_ID and no runtime file — passes through (fail open)', () => {
    makeDeepflowProject(tmp, { testCommand: 'npm test' });
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: tmp },
      {
        cwd: tmp,
        env: {
          DEEPFLOW_TASK_ID: '', // explicitly unset
        },
      },
    );
    assert.equal(r.stdout, '', 'must fail open when task ID unavailable');
  });

  test('non-Bash tool — passes through', () => {
    makeDeepflowProject(tmp, { testCommand: 'npm test' });
    const r = runHook(
      { tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T1' } },
    );
    assert.equal(r.stdout, '');
  });

  test('exits 0 always', () => {
    makeDeepflowProject(tmp, { testCommand: 'npm test' });
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: tmp },
      { cwd: tmp, env: { DEEPFLOW_TASK_ID: 'T1' } },
    );
    assert.equal(r.code, 0);
  });
});
