/**
 * Tests for hooks/df-tool-usage.js — T3: active_command field in tool-usage records
 *
 * Validates that the tool usage hook reads .deepflow/active-command.json marker
 * and includes the active_command field in tool-usage.jsonl records.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_PATH = path.resolve(__dirname, 'df-tool-usage.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-tool-usage-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the tool usage hook as a child process with JSON piped to stdin.
 * Overrides HOME so tool-usage.jsonl goes to a temp location.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { cwd, env: extraEnv } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env, ...extraEnv };
  // Override HOME so the log file goes to our temp dir
  env.HOME = cwd || os.tmpdir();
  try {
    const stdout = execFileSync(
      process.execPath,
      [HOOK_PATH],
      {
        input: json,
        cwd: cwd || os.tmpdir(),
        encoding: 'utf8',
        timeout: 5000,
        env,
      }
    );
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? 1,
    };
  }
}

/**
 * Build a minimal PostToolUse event payload.
 */
function makeToolInput(cwd) {
  return {
    session_id: 'tool-test-session',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test.js' },
    tool_response: { content: 'file contents here' },
    cwd: cwd,
  };
}

/**
 * Read the last record from tool-usage.jsonl.
 */
function readLastToolRecord(homeDir) {
  const logPath = path.join(homeDir, '.claude', 'tool-usage.jsonl');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// T3: active_command field in tool-usage records
// ---------------------------------------------------------------------------

describe('T3 — tool-usage active_command field', () => {
  let tmpDir;
  let deepflowDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    // Create .claude dir for tool-usage.jsonl output
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('active_command is set when active-command.json marker exists', () => {
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      JSON.stringify({ command: 'df:plan', started_at: new Date().toISOString() })
    );

    const input = makeToolInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0, 'Hook should exit successfully');

    const record = readLastToolRecord(tmpDir);
    assert.ok(record, 'Tool usage record should exist');
    assert.equal(record.active_command, 'df:plan', 'active_command should match marker');
  });

  test('active_command is null when no marker file exists', () => {
    const input = makeToolInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0);

    const record = readLastToolRecord(tmpDir);
    assert.ok(record, 'Tool usage record should exist');
    assert.equal(record.active_command, null, 'active_command should be null without marker');
  });

  test('active_command is null when marker file contains corrupt JSON', () => {
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      '{{corrupt json'
    );

    const input = makeToolInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0, 'Hook should not crash on corrupt marker');

    const record = readLastToolRecord(tmpDir);
    assert.ok(record);
    assert.equal(record.active_command, null, 'active_command should be null for corrupt marker');
  });

  test('active_command is null when marker has no command field', () => {
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      JSON.stringify({ other_field: 'value' })
    );

    const input = makeToolInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0);

    const record = readLastToolRecord(tmpDir);
    assert.ok(record);
    assert.equal(record.active_command, null, 'active_command should be null when command field missing');
  });

  test('active_command field always present in tool-usage record schema', () => {
    const input = makeToolInput(tmpDir);
    runHook(input, { cwd: tmpDir });

    const record = readLastToolRecord(tmpDir);
    assert.ok(record);
    assert.ok('active_command' in record, 'active_command key must always be present');
    // Verify other expected fields
    assert.ok('timestamp' in record);
    assert.ok('session_id' in record);
    assert.ok('tool_name' in record);
    assert.ok('phase' in record);
  });

  test('active_command reads df:execute correctly', () => {
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      JSON.stringify({ command: 'df:execute' })
    );

    const input = makeToolInput(tmpDir);
    runHook(input, { cwd: tmpDir });

    const record = readLastToolRecord(tmpDir);
    assert.ok(record);
    assert.equal(record.active_command, 'df:execute');
  });

  test('hook exits 0 even when marker is unreadable (permissions)', () => {
    // Write marker then make the deepflow dir inaccessible won't work on all OS.
    // Instead, set cwd to a non-existent path to trigger the fallback.
    const input = makeToolInput('/nonexistent/path/that/does/not/exist');
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0, 'Hook should always exit 0');
  });
});
