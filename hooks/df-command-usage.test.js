/**
 * Tests for hooks/df-command-usage.js
 *
 * Tests the command usage tracker hook that tracks df:* command invocations
 * with token deltas and tool call counts across PreToolUse, PostToolUse,
 * and SessionEnd events.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_PATH = path.resolve(__dirname, 'df-command-usage.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-command-usage-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the command usage hook as a child process with JSON piped to stdin.
 * Sets CLAUDE_HOOK_EVENT to control which handler runs.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { event, cwd, env: extraEnv } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env, ...extraEnv };
  if (event) env.CLAUDE_HOOK_EVENT = event;
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
 * Read the active-command.json marker file.
 */
function readMarker(tmpDir) {
  const markerPath = path.join(tmpDir, '.deepflow', 'active-command.json');
  if (!fs.existsSync(markerPath)) return null;
  return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
}

/**
 * Read command-usage.jsonl and return parsed records.
 */
function readUsage(tmpDir) {
  const usagePath = path.join(tmpDir, '.deepflow', 'command-usage.jsonl');
  if (!fs.existsSync(usagePath)) return [];
  const content = fs.readFileSync(usagePath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

/**
 * Write a token-history.jsonl file in .deepflow/ with the given records.
 */
function writeTokenHistory(tmpDir, records) {
  const deepflowDir = path.join(tmpDir, '.deepflow');
  fs.mkdirSync(deepflowDir, { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(deepflowDir, 'token-history.jsonl'), content);
}

/**
 * Write a fake transcript file with usage entries.
 */
function writeTranscript(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
}

/**
 * Write an active-command.json marker directly.
 */
function writeMarker(tmpDir, marker) {
  const deepflowDir = path.join(tmpDir, '.deepflow');
  fs.mkdirSync(deepflowDir, { recursive: true });
  fs.writeFileSync(path.join(deepflowDir, 'active-command.json'), JSON.stringify(marker, null, 2));
}

// ---------------------------------------------------------------------------
// 1. PreToolUse — opening a new command marker
// ---------------------------------------------------------------------------

describe('df-command-usage — PreToolUse opens marker', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('creates marker for df:plan Skill call', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-123',
      cwd: tmpDir,
    };
    const result = runHook(payload, { event: 'PreToolUse' });
    assert.equal(result.code, 0);

    const marker = readMarker(tmpDir);
    assert.ok(marker, 'marker should exist');
    assert.equal(marker.command, 'df:plan');
    assert.equal(marker.session_id, 'sess-123');
    assert.equal(marker.tool_calls_count, 0);
    assert.ok(marker.started_at, 'started_at should be set');
  });

  test('creates marker for df:execute Skill call', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:execute' },
      session_id: 'sess-456',
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.command, 'df:execute');
    assert.equal(marker.session_id, 'sess-456');
  });

  test('ignores non-Skill tool calls', () => {
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.js' },
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker, null, 'no marker should be created for non-Skill tools');
  });

  test('ignores Skill calls without df: prefix', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'browse-fetch' },
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker, null, 'no marker for non-df: skills');
  });

  test('marker started_at is ISO-8601 format', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:verify' },
      session_id: 'sess-ts',
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert.match(marker.started_at, isoRegex, 'started_at should be ISO-8601');
  });

  test('marker has token_snapshot with expected fields', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-tok',
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.ok(marker.token_snapshot, 'token_snapshot should exist');
    assert.equal(typeof marker.token_snapshot.input_tokens, 'number');
    assert.equal(typeof marker.token_snapshot.cache_read_input_tokens, 'number');
    assert.equal(typeof marker.token_snapshot.cache_creation_input_tokens, 'number');
  });

  test('reads token snapshot from token-history.jsonl', () => {
    writeTokenHistory(tmpDir, [
      { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 },
      { input_tokens: 2000, cache_read_input_tokens: 800, cache_creation_input_tokens: 300 },
    ]);

    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:discover' },
      session_id: 'sess-tok2',
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.token_snapshot.input_tokens, 2000);
    assert.equal(marker.token_snapshot.cache_read_input_tokens, 800);
    assert.equal(marker.token_snapshot.cache_creation_input_tokens, 300);
  });

  test('defaults token snapshot to zeros when no token-history exists', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-notok',
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.token_snapshot.input_tokens, 0);
    assert.equal(marker.token_snapshot.cache_read_input_tokens, 0);
    assert.equal(marker.token_snapshot.cache_creation_input_tokens, 0);
  });

  test('uses transcript_path from payload', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-tp',
      cwd: tmpDir,
      transcript_path: '/tmp/some-transcript.jsonl',
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.transcript_path, '/tmp/some-transcript.jsonl');
  });

  test('builds transcript_path from session_storage_path', () => {
    const storagePath = path.join(tmpDir, 'session-storage');
    fs.mkdirSync(storagePath, { recursive: true });

    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-ssp',
      cwd: tmpDir,
      session_storage_path: storagePath,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.transcript_path, path.join(storagePath, 'transcript.jsonl'));
  });

  test('uses CLAUDE_SESSION_ID when session_id not in payload', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse', env: { CLAUDE_SESSION_ID: 'env-sess-42' } });

    const marker = readMarker(tmpDir);
    assert.equal(marker.session_id, 'env-sess-42');
  });

  test('defaults session_id to "unknown" when not available', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      cwd: tmpDir,
    };
    // Clear CLAUDE_SESSION_ID from env
    runHook(payload, { event: 'PreToolUse', env: { CLAUDE_SESSION_ID: '' } });

    const marker = readMarker(tmpDir);
    // Either 'unknown' or empty string depending on fallback
    assert.ok(marker.session_id !== undefined, 'session_id should exist');
  });
});

// ---------------------------------------------------------------------------
// 2. PreToolUse — close-on-next (switching commands)
// ---------------------------------------------------------------------------

describe('df-command-usage — PreToolUse close-on-next', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('closes previous command and opens new one when marker exists', () => {
    // First command
    const payload1 = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-1',
      cwd: tmpDir,
    };
    runHook(payload1, { event: 'PreToolUse' });

    // Second command — should close first and open second
    const payload2 = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:execute' },
      session_id: 'sess-1',
      cwd: tmpDir,
    };
    runHook(payload2, { event: 'PreToolUse' });

    // Verify first command was recorded
    const records = readUsage(tmpDir);
    assert.equal(records.length, 1, 'first command should be closed and recorded');
    assert.equal(records[0].command, 'df:plan');

    // Verify new marker is for the second command
    const marker = readMarker(tmpDir);
    assert.equal(marker.command, 'df:execute');
  });

  test('closed command record has ended_at', () => {
    const payload1 = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-1',
      cwd: tmpDir,
    };
    runHook(payload1, { event: 'PreToolUse' });

    const payload2 = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:verify' },
      session_id: 'sess-1',
      cwd: tmpDir,
    };
    runHook(payload2, { event: 'PreToolUse' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert.match(records[0].ended_at, isoRegex);
  });

  test('computes token deltas when closing a command', () => {
    // Write initial token history
    writeTokenHistory(tmpDir, [
      { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    ]);

    const payload1 = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-1',
      cwd: tmpDir,
    };
    runHook(payload1, { event: 'PreToolUse' });

    // Update token history to simulate token usage
    writeTokenHistory(tmpDir, [
      { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
      { input_tokens: 3000, cache_read_input_tokens: 1200, cache_creation_input_tokens: 400 },
    ]);

    const payload2 = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:execute' },
      session_id: 'sess-1',
      cwd: tmpDir,
    };
    runHook(payload2, { event: 'PreToolUse' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].input_tokens_delta, 2000);
    assert.equal(records[0].cache_read_delta, 700);
    assert.equal(records[0].cache_creation_delta, 300);
  });
});

// ---------------------------------------------------------------------------
// 3. PostToolUse — incrementing tool_calls_count
// ---------------------------------------------------------------------------

describe('df-command-usage — PostToolUse increments tool count', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('increments tool_calls_count on active marker', () => {
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-1',
      started_at: new Date().toISOString(),
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
    });

    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.js' },
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PostToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.tool_calls_count, 1);
  });

  test('increments multiple times', () => {
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-1',
      started_at: new Date().toISOString(),
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
    });

    for (let i = 0; i < 3; i++) {
      runHook({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmpDir }, { event: 'PostToolUse' });
    }

    const marker = readMarker(tmpDir);
    assert.equal(marker.tool_calls_count, 3);
  });

  test('does not count df:* Skill calls (avoids double-counting)', () => {
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-1',
      started_at: new Date().toISOString(),
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
    });

    const dfSkillPayload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:execute' },
      cwd: tmpDir,
    };
    runHook(dfSkillPayload, { event: 'PostToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.tool_calls_count, 0, 'df:* Skill calls should not increment count');
  });

  test('counts non-df: Skill calls', () => {
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-1',
      started_at: new Date().toISOString(),
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
    });

    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'browse-fetch' },
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PostToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.tool_calls_count, 1, 'non-df: Skill calls should increment count');
  });

  test('does nothing when no marker exists', () => {
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.js' },
      cwd: tmpDir,
    };
    const result = runHook(payload, { event: 'PostToolUse' });
    assert.equal(result.code, 0);

    const marker = readMarker(tmpDir);
    assert.equal(marker, null, 'no marker should be created by PostToolUse');
  });
});

// ---------------------------------------------------------------------------
// 4. SessionEnd — closing the last command
// ---------------------------------------------------------------------------

describe('df-command-usage — SessionEnd closes active command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('closes active marker and writes usage record', () => {
    writeMarker(tmpDir, {
      command: 'df:execute',
      session_id: 'sess-end',
      started_at: '2025-01-01T00:00:00.000Z',
      token_snapshot: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      tool_calls_count: 7,
    });

    // Write updated token history
    writeTokenHistory(tmpDir, [
      { input_tokens: 1500, cache_read_input_tokens: 600, cache_creation_input_tokens: 150 },
    ]);

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    // Marker should be deleted
    const marker = readMarker(tmpDir);
    assert.equal(marker, null, 'marker should be deleted after SessionEnd');

    // Usage record should be written
    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].command, 'df:execute');
    assert.equal(records[0].session_id, 'sess-end');
    assert.equal(records[0].started_at, '2025-01-01T00:00:00.000Z');
    assert.equal(records[0].tool_calls_count, 7);
    assert.equal(records[0].input_tokens_delta, 1000);
    assert.equal(records[0].cache_read_delta, 400);
    assert.equal(records[0].cache_creation_delta, 100);
  });

  test('does nothing when no marker exists', () => {
    const result = runHook({ cwd: tmpDir }, { event: 'SessionEnd' });
    assert.equal(result.code, 0);

    const records = readUsage(tmpDir);
    assert.equal(records.length, 0, 'no usage record should be written without a marker');
  });

  test('deletes marker even if it contains invalid JSON', () => {
    const markerPath = path.join(tmpDir, '.deepflow', 'active-command.json');
    fs.writeFileSync(markerPath, 'not valid json{{{');

    const result = runHook({ cwd: tmpDir }, { event: 'SessionEnd' });
    assert.equal(result.code, 0);
    assert.ok(!fs.existsSync(markerPath), 'invalid marker should be deleted');
  });
});

// ---------------------------------------------------------------------------
// 5. Full lifecycle — open, increment, close
// ---------------------------------------------------------------------------

describe('df-command-usage — full lifecycle', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('open → increment → session end produces correct record', () => {
    // Open command
    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, session_id: 'sess-life', cwd: tmpDir },
      { event: 'PreToolUse' }
    );

    // Several tool calls
    runHook({ tool_name: 'Read', tool_input: {}, cwd: tmpDir }, { event: 'PostToolUse' });
    runHook({ tool_name: 'Bash', tool_input: {}, cwd: tmpDir }, { event: 'PostToolUse' });
    runHook({ tool_name: 'Grep', tool_input: {}, cwd: tmpDir }, { event: 'PostToolUse' });

    // End session
    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].command, 'df:plan');
    assert.equal(records[0].session_id, 'sess-life');
    assert.equal(records[0].tool_calls_count, 3);
    assert.ok(records[0].started_at);
    assert.ok(records[0].ended_at);
  });

  test('open → open (different command) → session end produces two records', () => {
    // Open first command
    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, session_id: 'sess-multi', cwd: tmpDir },
      { event: 'PreToolUse' }
    );

    // Some tool calls
    runHook({ tool_name: 'Read', tool_input: {}, cwd: tmpDir }, { event: 'PostToolUse' });

    // Open second command (closes first)
    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:execute' }, session_id: 'sess-multi', cwd: tmpDir },
      { event: 'PreToolUse' }
    );

    // More tool calls
    runHook({ tool_name: 'Bash', tool_input: {}, cwd: tmpDir }, { event: 'PostToolUse' });
    runHook({ tool_name: 'Edit', tool_input: {}, cwd: tmpDir }, { event: 'PostToolUse' });

    // End session
    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 2);
    assert.equal(records[0].command, 'df:plan');
    assert.equal(records[0].tool_calls_count, 1);
    assert.equal(records[1].command, 'df:execute');
    assert.equal(records[1].tool_calls_count, 2);
  });
});

// ---------------------------------------------------------------------------
// 6. Token delta edge cases
// ---------------------------------------------------------------------------

describe('df-command-usage — token delta edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('token deltas are clamped to zero (never negative)', () => {
    // Start with high token count
    writeTokenHistory(tmpDir, [
      { input_tokens: 5000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 1000 },
    ]);

    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, session_id: 's1', cwd: tmpDir },
      { event: 'PreToolUse' }
    );

    // Replace with lower token count (simulating reset or file rotation)
    writeTokenHistory(tmpDir, [
      { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    ]);

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].input_tokens_delta, 0, 'negative delta should be clamped to 0');
    assert.equal(records[0].cache_read_delta, 0);
    assert.equal(records[0].cache_creation_delta, 0);
  });

  test('token deltas default to zero when token-history is empty', () => {
    // Write empty token history
    fs.writeFileSync(path.join(tmpDir, '.deepflow', 'token-history.jsonl'), '');

    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, session_id: 's1', cwd: tmpDir },
      { event: 'PreToolUse' }
    );

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].input_tokens_delta, 0);
    assert.equal(records[0].cache_read_delta, 0);
    assert.equal(records[0].cache_creation_delta, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Transcript output token parsing
// ---------------------------------------------------------------------------

describe('df-command-usage — transcript output token parsing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('accumulates output_tokens from transcript entries after offset', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');

    // Write transcript with some entries before and after offset
    const preEntries = [
      { message: { usage: { output_tokens: 100 } } },
      { message: { usage: { output_tokens: 200 } } },
    ];
    const postEntries = [
      { message: { usage: { output_tokens: 300 } } },
      { message: { usage: { output_tokens: 400 } } },
    ];

    // Write pre-entries first to get offset
    writeTranscript(transcriptPath, preEntries);
    const offset = fs.statSync(transcriptPath).size;

    // Append post-entries
    const postContent = postEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(transcriptPath, postContent);

    // Set up marker with transcript info
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-txn',
      started_at: '2025-01-01T00:00:00.000Z',
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
      transcript_path: transcriptPath,
      transcript_offset: offset,
    });

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].output_tokens, 700, 'should sum output_tokens from entries after offset');
  });

  test('handles transcript with usage at top level', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    writeTranscript(transcriptPath, [
      { usage: { output_tokens: 150 } },
      { usage: { output_tokens: 250 } },
    ]);

    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-top',
      started_at: '2025-01-01T00:00:00.000Z',
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
      transcript_path: transcriptPath,
      transcript_offset: 0,
    });

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].output_tokens, 400);
  });

  test('returns 0 when transcript does not exist', () => {
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-nofile',
      started_at: '2025-01-01T00:00:00.000Z',
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
      transcript_path: '/nonexistent/transcript.jsonl',
      transcript_offset: 0,
    });

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].output_tokens, 0);
  });

  test('returns 0 when transcript_path is empty', () => {
    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-empty-tp',
      started_at: '2025-01-01T00:00:00.000Z',
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
      transcript_path: '',
      transcript_offset: 0,
    });

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].output_tokens, 0);
  });

  test('skips malformed lines in transcript', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const content = [
      JSON.stringify({ message: { usage: { output_tokens: 100 } } }),
      'not valid json',
      JSON.stringify({ message: { usage: { output_tokens: 200 } } }),
    ].join('\n') + '\n';
    fs.writeFileSync(transcriptPath, content);

    writeMarker(tmpDir, {
      command: 'df:plan',
      session_id: 'sess-malformed',
      started_at: '2025-01-01T00:00:00.000Z',
      token_snapshot: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      tool_calls_count: 0,
      transcript_path: transcriptPath,
      transcript_offset: 0,
    });

    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].output_tokens, 300, 'should skip malformed lines and sum the rest');
  });
});

// ---------------------------------------------------------------------------
// 8. findProjectDir — project directory resolution
// ---------------------------------------------------------------------------

describe('df-command-usage — findProjectDir resolution', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('uses cwd from payload', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-cwd',
      cwd: tmpDir,
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.ok(marker, 'marker should exist in cwd-specified directory');
  });

  test('uses workspace.current_dir from payload', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-ws',
      workspace: { current_dir: tmpDir },
    };
    runHook(payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.ok(marker, 'marker should exist in workspace.current_dir directory');
  });

  test('falls back to CLAUDE_PROJECT_DIR env var', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'df:plan' },
      session_id: 'sess-env',
    };
    runHook(payload, { event: 'PreToolUse', env: { CLAUDE_PROJECT_DIR: tmpDir } });

    const marker = readMarker(tmpDir);
    assert.ok(marker, 'marker should exist when using CLAUDE_PROJECT_DIR');
  });
});

// ---------------------------------------------------------------------------
// 9. Fail-open (REQ-8) — never break Claude Code
// ---------------------------------------------------------------------------

describe('df-command-usage — fail-open (REQ-8)', () => {
  test('exits 0 on invalid JSON stdin', () => {
    const result = runHook('not valid json{{{', { event: 'PreToolUse' });
    assert.equal(result.code, 0);
  });

  test('exits 0 on empty stdin', () => {
    const result = runHook('', { event: 'PreToolUse' });
    assert.equal(result.code, 0);
  });

  test('exits 0 on unknown event type', () => {
    const result = runHook({ cwd: '/tmp' }, { event: 'UnknownEvent' });
    assert.equal(result.code, 0);
  });

  test('exits 0 when no CLAUDE_HOOK_EVENT is set', () => {
    const result = runHook({ cwd: '/tmp' }, {});
    assert.equal(result.code, 0);
  });

  test('exits 0 when .deepflow directory cannot be created (no cwd)', () => {
    const result = runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, cwd: '/nonexistent/path/12345' },
      { event: 'PreToolUse' }
    );
    assert.equal(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. JSONL output format
// ---------------------------------------------------------------------------

describe('df-command-usage — JSONL output format', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('usage record has all expected fields', () => {
    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, session_id: 'sess-fields', cwd: tmpDir },
      { event: 'PreToolUse' }
    );
    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    const r = records[0];
    const expectedKeys = [
      'command', 'session_id', 'started_at', 'ended_at',
      'tool_calls_count', 'input_tokens_delta', 'output_tokens',
      'cache_read_delta', 'cache_creation_delta',
    ];
    for (const key of expectedKeys) {
      assert.ok(key in r, `record should have field "${key}"`);
    }
  });

  test('multiple records are each on their own line (valid JSONL)', () => {
    // Three command cycles
    for (const cmd of ['df:plan', 'df:execute', 'df:verify']) {
      runHook(
        { tool_name: 'Skill', tool_input: { skill: cmd }, session_id: 'sess-jsonl', cwd: tmpDir },
        { event: 'PreToolUse' }
      );
    }
    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const usagePath = path.join(tmpDir, '.deepflow', 'command-usage.jsonl');
    const raw = fs.readFileSync(usagePath, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 3);

    // Each line must be independently parseable
    lines.forEach((line, i) => {
      const parsed = JSON.parse(line);
      assert.ok(parsed.command, `line ${i} should have command field`);
    });
  });

  test('usage file ends with newline', () => {
    runHook(
      { tool_name: 'Skill', tool_input: { skill: 'df:plan' }, session_id: 's', cwd: tmpDir },
      { event: 'PreToolUse' }
    );
    runHook({ cwd: tmpDir }, { event: 'SessionEnd' });

    const usagePath = path.join(tmpDir, '.deepflow', 'command-usage.jsonl');
    const raw = fs.readFileSync(usagePath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'JSONL file should end with newline');
  });
});
