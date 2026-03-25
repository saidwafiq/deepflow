/**
 * Tests for hooks/df-statusline.js — T2: active_command field in token-history records
 *
 * Validates that writeTokenHistory() reads .deepflow/active-command.json marker
 * and includes the active_command field in token-history.jsonl records.
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

const HOOK_PATH = path.resolve(__dirname, 'df-statusline.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-statusline-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the statusline hook as a child process with JSON piped to stdin.
 * The hook reads data from stdin and writes token-history.jsonl to .deepflow/.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { cwd, env: extraEnv } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env, ...extraEnv };
  // Unset HOME to avoid writing cache-history.jsonl to real home
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
 * Build a minimal statusline input payload that triggers writeTokenHistory().
 */
function makeStatuslineInput(workspaceDir) {
  return {
    model: { id: 'claude-test', display_name: 'Claude Test' },
    session_id: 'test-session-123',
    workspace: { current_dir: workspaceDir },
    context_window: {
      used_percentage: 25,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    },
  };
}

/**
 * Read the last record from token-history.jsonl.
 */
function readLastTokenRecord(deepflowDir) {
  const historyPath = path.join(deepflowDir, 'token-history.jsonl');
  if (!fs.existsSync(historyPath)) return null;
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// T2: active_command field in token-history records
// ---------------------------------------------------------------------------

describe('T2 — writeTokenHistory active_command field', () => {
  let tmpDir;
  let deepflowDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    // Create .claude dir for cache-history (avoids touching real HOME)
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('active_command is set when active-command.json marker exists', () => {
    // Write a valid active-command.json marker
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      JSON.stringify({ command: 'df:execute', started_at: new Date().toISOString() })
    );

    const input = makeStatuslineInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0, 'Hook should exit successfully');

    const record = readLastTokenRecord(deepflowDir);
    assert.ok(record, 'Token history record should exist');
    assert.equal(record.active_command, 'df:execute', 'active_command should match marker');
  });

  test('active_command is null when no marker file exists', () => {
    // No active-command.json created
    const input = makeStatuslineInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0, 'Hook should exit successfully');

    const record = readLastTokenRecord(deepflowDir);
    assert.ok(record, 'Token history record should exist');
    assert.equal(record.active_command, null, 'active_command should be null when no marker');
  });

  test('active_command is null when marker file contains corrupt JSON', () => {
    // Write corrupt JSON
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      'NOT VALID JSON {'
    );

    const input = makeStatuslineInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0, 'Hook should exit successfully even with corrupt marker');

    const record = readLastTokenRecord(deepflowDir);
    assert.ok(record, 'Token history record should exist');
    assert.equal(record.active_command, null, 'active_command should be null for corrupt marker');
  });

  test('active_command is null when marker exists but has no command field', () => {
    // Marker JSON without command key
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      JSON.stringify({ started_at: new Date().toISOString() })
    );

    const input = makeStatuslineInput(tmpDir);
    const { code } = runHook(input, { cwd: tmpDir });
    assert.equal(code, 0);

    const record = readLastTokenRecord(deepflowDir);
    assert.ok(record);
    assert.equal(record.active_command, null, 'active_command should be null when command field missing');
  });

  test('active_command field always present in token-history record schema', () => {
    const input = makeStatuslineInput(tmpDir);
    runHook(input, { cwd: tmpDir });

    const record = readLastTokenRecord(deepflowDir);
    assert.ok(record);
    assert.ok('active_command' in record, 'active_command key must be present in record');
    // Also verify other expected fields are present
    assert.ok('timestamp' in record);
    assert.ok('model' in record);
    assert.ok('session_id' in record);
    assert.ok('agent_role' in record);
  });

  test('active_command reads different command names correctly', () => {
    // Test with a different command name
    fs.writeFileSync(
      path.join(deepflowDir, 'active-command.json'),
      JSON.stringify({ command: 'df:verify' })
    );

    const input = makeStatuslineInput(tmpDir);
    runHook(input, { cwd: tmpDir });

    const record = readLastTokenRecord(deepflowDir);
    assert.ok(record);
    assert.equal(record.active_command, 'df:verify');
  });
});
