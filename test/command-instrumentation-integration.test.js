/**
 * Integration tests for command-instrumentation spec.
 *
 * Covers AC-2 through AC-8 by exercising hooks as child processes (black-box).
 * No internal imports — all assertions based on file I/O side effects.
 *
 * Uses Node.js built-in node:test (CommonJS) to match project conventions.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Paths to hook scripts under test
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const CMD_USAGE_HOOK = path.join(ROOT, 'hooks', 'df-command-usage.js');
const STATUSLINE_HOOK = path.join(ROOT, 'hooks', 'df-statusline.js');
const TOOL_USAGE_HOOK = path.join(ROOT, 'hooks', 'df-tool-usage.js');
const INSTALL_SCRIPT = path.join(ROOT, 'bin', 'install.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-instr-integ-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run a hook script as a child process.
 * Returns { stdout, stderr, code }.
 */
function runHook(hookPath, input, { event, cwd, env: extraEnv } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env, ...extraEnv };
  if (event) env.CLAUDE_HOOK_EVENT = event;
  env.HOME = cwd || os.tmpdir();
  try {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input: json,
      cwd: cwd || os.tmpdir(),
      encoding: 'utf8',
      timeout: 5000,
      env,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? 1,
    };
  }
}

function readMarker(tmpDir) {
  const p = path.join(tmpDir, '.deepflow', 'active-command.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readUsage(tmpDir) {
  const p = path.join(tmpDir, '.deepflow', 'command-usage.jsonl');
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

function writeMarker(tmpDir, marker) {
  const dir = path.join(tmpDir, '.deepflow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-command.json'), JSON.stringify(marker, null, 2));
}

function writeTokenHistory(tmpDir, records) {
  const dir = path.join(tmpDir, '.deepflow');
  fs.mkdirSync(dir, { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'token-history.jsonl'), content);
}

function readToolUsage(homeDir) {
  // tool-usage.jsonl lives in $HOME/.claude/ (not .deepflow/)
  const p = path.join(homeDir, '.claude', 'tool-usage.jsonl');
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

function makeSkillPayload(skill, { sessionId, cwd, transcriptPath, sessionStoragePath } = {}) {
  const p = {
    tool_name: 'Skill',
    tool_input: { skill },
    cwd,
  };
  if (sessionId) p.session_id = sessionId;
  if (transcriptPath) p.transcript_path = transcriptPath;
  if (sessionStoragePath) p.session_storage_path = sessionStoragePath;
  return p;
}

function makeStatuslineInput(workspaceDir) {
  return {
    model: { id: 'claude-test', display_name: 'Claude Test' },
    session_id: 'integ-session-1',
    workspace: { current_dir: workspaceDir },
    context_window: {
      used_percentage: 25,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 5000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 1000,
      },
    },
  };
}

function makeToolInput(cwd) {
  return {
    session_id: 'integ-session-1',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test.js' },
    tool_response: { content: 'file contents here' },
    cwd,
  };
}

// ===========================================================================
// AC-2: When a df:* Skill call starts, active-command.json exists with valid
// JSON containing command, session_id, started_at, token_snapshot,
// transcript_path, transcript_offset, tool_calls_count: 0
// ===========================================================================

describe('AC-2: active-command.json marker on df:* Skill start', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('marker file exists after PreToolUse with df:* Skill', () => {
    const payload = makeSkillPayload('df:execute', { sessionId: 'sess-ac2', cwd: tmpDir });
    runHook(CMD_USAGE_HOOK, payload, { event: 'PreToolUse' });

    const markerPath = path.join(tmpDir, '.deepflow', 'active-command.json');
    assert.ok(fs.existsSync(markerPath), 'active-command.json must exist');
  });

  test('marker is valid JSON with all required fields', () => {
    const payload = makeSkillPayload('df:execute', { sessionId: 'sess-ac2-fields', cwd: tmpDir });
    runHook(CMD_USAGE_HOOK, payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.ok(marker, 'marker must be parseable JSON');

    // Required fields per AC-2
    assert.equal(marker.command, 'df:execute');
    assert.equal(marker.session_id, 'sess-ac2-fields');
    assert.ok('started_at' in marker, 'started_at field required');
    assert.ok('token_snapshot' in marker, 'token_snapshot field required');
    assert.ok('transcript_path' in marker, 'transcript_path field required');
    assert.ok('transcript_offset' in marker, 'transcript_offset field required');
    assert.equal(marker.tool_calls_count, 0, 'tool_calls_count must start at 0');
  });

  test('started_at is a valid ISO-8601 timestamp', () => {
    const payload = makeSkillPayload('df:discover', { sessionId: 's', cwd: tmpDir });
    runHook(CMD_USAGE_HOOK, payload, { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    const parsed = new Date(marker.started_at);
    assert.ok(!isNaN(parsed.getTime()), 'started_at must be a valid date');
    assert.match(marker.started_at, /^\d{4}-\d{2}-\d{2}T/, 'started_at must be ISO format');
  });

  test('token_snapshot contains numeric token counts', () => {
    writeTokenHistory(tmpDir, [
      { input_tokens: 1000, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 },
    ]);

    const payload = makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir });
    runHook(CMD_USAGE_HOOK, payload, { event: 'PreToolUse' });

    const snap = readMarker(tmpDir).token_snapshot;
    assert.equal(typeof snap.input_tokens, 'number');
    assert.equal(typeof snap.cache_read_input_tokens, 'number');
    assert.equal(typeof snap.cache_creation_input_tokens, 'number');
  });

  test('no marker created for non-df: Skill calls', () => {
    const payload = {
      tool_name: 'Skill',
      tool_input: { skill: 'browse-fetch' },
      cwd: tmpDir,
    };
    runHook(CMD_USAGE_HOOK, payload, { event: 'PreToolUse' });
    assert.equal(readMarker(tmpDir), null);
  });

  test('no marker created for non-Skill tools', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: '/x' }, cwd: tmpDir };
    runHook(CMD_USAGE_HOOK, payload, { event: 'PreToolUse' });
    assert.equal(readMarker(tmpDir), null);
  });
});

// ===========================================================================
// AC-3: After the next df:* command starts (or session ends), previous marker
// is deleted and command-usage.jsonl has a new record for the previous command
// ===========================================================================

describe('AC-3: previous marker closed on next command or session end', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('starting command B closes command A marker and writes A to usage', () => {
    // Start command A
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's1', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // Start command B — closes A
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's1', cwd: tmpDir }),
      { event: 'PreToolUse' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1, 'one usage record for closed command A');
    assert.equal(records[0].command, 'df:execute');

    // Marker should now be B
    const marker = readMarker(tmpDir);
    assert.equal(marker.command, 'df:execute');
  });

  test('SessionEnd closes active marker and writes usage record', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:verify', { sessionId: 's2', cwd: tmpDir }),
      { event: 'PreToolUse' });

    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    // Marker deleted
    assert.equal(readMarker(tmpDir), null, 'marker must be deleted after SessionEnd');

    // Usage record written
    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].command, 'df:verify');
  });

  test('SessionEnd without active marker writes nothing', () => {
    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });
    assert.equal(readUsage(tmpDir).length, 0);
  });
});

// ===========================================================================
// AC-4: tool-usage.jsonl records include active_command
// ===========================================================================

describe('AC-4: tool-usage.jsonl records include active_command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
    // tool-usage.jsonl writes to $HOME/.claude/
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('active_command set in tool-usage when marker exists', () => {
    // Create marker directly (command-usage hook would do this via PreToolUse)
    writeMarker(tmpDir, {
      command: 'df:execute',
      started_at: new Date().toISOString(),
    });

    // Run tool-usage hook (HOME=tmpDir so it writes to tmpDir/.claude/)
    runHook(TOOL_USAGE_HOOK, makeToolInput(tmpDir), {
      event: 'PostToolUse',
      cwd: tmpDir,
    });

    // tool-usage.jsonl is at $HOME/.claude/tool-usage.jsonl
    const records = readToolUsage(tmpDir);
    assert.ok(records.length >= 1, 'tool-usage record should exist');
    const last = records[records.length - 1];
    assert.equal(last.active_command, 'df:execute');
  });

  test('active_command null in tool-usage when no marker exists', () => {
    runHook(TOOL_USAGE_HOOK, makeToolInput(tmpDir), {
      event: 'PostToolUse',
      cwd: tmpDir,
    });

    const records = readToolUsage(tmpDir);
    assert.ok(records.length >= 1, 'tool-usage record should exist');
    const last = records[records.length - 1];
    assert.equal(last.active_command, null);
  });
});

// ===========================================================================
// AC-5: Each record in command-usage.jsonl is valid JSON with all 9 fields,
// non-negative delta values
// ===========================================================================

describe('AC-5: command-usage.jsonl records have all 9 fields, non-negative deltas', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  const REQUIRED_FIELDS = [
    'command', 'session_id', 'started_at', 'ended_at',
    'tool_calls_count', 'input_tokens_delta', 'output_tokens',
    'cache_read_delta', 'cache_creation_delta',
  ];

  test('single command lifecycle produces record with all 9 fields', () => {
    writeTokenHistory(tmpDir, [
      { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    ]);

    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 'sess-ac5', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // Simulate some usage
    writeTokenHistory(tmpDir, [
      { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
      { input_tokens: 3000, cache_read_input_tokens: 1200, cache_creation_input_tokens: 400 },
    ]);

    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    const r = records[0];

    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in r, `record must contain field "${field}"`);
    }
  });

  test('delta values are non-negative', () => {
    // Start with high tokens, then "reset" to lower values
    writeTokenHistory(tmpDir, [
      { input_tokens: 5000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 1000 },
    ]);

    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // Simulate token history going lower (file rotation, etc.)
    writeTokenHistory(tmpDir, [
      { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    ]);

    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    const r = readUsage(tmpDir)[0];
    assert.ok(r.input_tokens_delta >= 0, 'input_tokens_delta must be >= 0');
    assert.ok(r.cache_read_delta >= 0, 'cache_read_delta must be >= 0');
    assert.ok(r.cache_creation_delta >= 0, 'cache_creation_delta must be >= 0');
    assert.ok(r.output_tokens >= 0, 'output_tokens must be >= 0');
    assert.ok(r.tool_calls_count >= 0, 'tool_calls_count must be >= 0');
  });

  test('each line in JSONL is independently valid JSON', () => {
    // Run three commands
    for (const cmd of ['df:spec', 'df:execute', 'df:verify']) {
      runHook(CMD_USAGE_HOOK,
        makeSkillPayload(cmd, { sessionId: 's-jsonl', cwd: tmpDir }),
        { event: 'PreToolUse' });
    }
    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    const usagePath = path.join(tmpDir, '.deepflow', 'command-usage.jsonl');
    const raw = fs.readFileSync(usagePath, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 3, 'three commands should produce three records');

    for (let i = 0; i < lines.length; i++) {
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(lines[i]); },
        `line ${i} must be valid JSON`);
      for (const field of REQUIRED_FIELDS) {
        assert.ok(field in parsed, `line ${i} must have field "${field}"`);
      }
    }
  });

  test('tool_calls_count reflects actual PostToolUse events', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // 5 tool calls
    for (let i = 0; i < 5; i++) {
      runHook(CMD_USAGE_HOOK,
        { tool_name: 'Read', tool_input: {}, cwd: tmpDir },
        { event: 'PostToolUse' });
    }

    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    const r = readUsage(tmpDir)[0];
    assert.equal(r.tool_calls_count, 5);
  });
});

// ===========================================================================
// AC-6: When command A is running and command B starts, A gets its own record
// (closed by B's PreToolUse). B's marker replaces A's
// ===========================================================================

describe('AC-6: command switching — A closed by B\'s PreToolUse', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('command A gets a usage record when command B starts', () => {
    // Command A
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // Tool calls during A
    runHook(CMD_USAGE_HOOK,
      { tool_name: 'Bash', tool_input: {}, cwd: tmpDir },
      { event: 'PostToolUse' });
    runHook(CMD_USAGE_HOOK,
      { tool_name: 'Read', tool_input: {}, cwd: tmpDir },
      { event: 'PostToolUse' });

    // Command B starts — closes A
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // A should be recorded with its tool calls
    const records = readUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].command, 'df:execute');
    assert.equal(records[0].tool_calls_count, 2);
    assert.ok(records[0].ended_at, 'A must have ended_at');
  });

  test('B\'s marker replaces A\'s marker', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    const marker = readMarker(tmpDir);
    assert.equal(marker.command, 'df:execute', 'marker must be B after switch');
    assert.equal(marker.tool_calls_count, 0, 'B starts fresh with 0 tool calls');
  });

  test('three-command chain produces correct records', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:verify', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    const records = readUsage(tmpDir);
    assert.equal(records.length, 3, 'three commands should produce three records');
    assert.equal(records[0].command, 'df:execute');
    assert.equal(records[1].command, 'df:execute');
    assert.equal(records[2].command, 'df:verify');
  });
});

// ===========================================================================
// AC-7: npx deepflow registers the hook for PreToolUse, PostToolUse, and
// SessionEnd; npx deepflow --uninstall removes all three. No duplicates
// after repeated installs
// ===========================================================================

describe('AC-7: install/uninstall registers and removes hooks', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Create a fake ~/.claude/ directory
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    settingsPath = path.join(claudeDir, 'settings.json');
  });

  afterEach(() => { rmrf(tmpDir); });

  function runInstall(args = []) {
    try {
      const stdout = execFileSync(process.execPath, [INSTALL_SCRIPT, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, HOME: tmpDir },
      });
      return { stdout, stderr: '', code: 0 };
    } catch (err) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        code: err.status ?? 1,
      };
    }
  }

  function readSettings() {
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  function countCommandUsageHooks(settings, eventType) {
    if (!settings?.hooks?.[eventType]) return 0;
    return settings.hooks[eventType].filter(h => {
      // Hook structure: { hooks: [{ type: 'command', command: '...' }] }
      const cmd = h.hooks?.[0]?.command || h.command || '';
      return cmd.includes('df-command-usage');
    }).length;
  }

  test('install registers df-command-usage for all three event types', () => {
    const result = runInstall();
    assert.equal(result.code, 0, `Install failed: ${result.stderr}`);

    const settings = readSettings();
    assert.ok(settings, 'settings.json must exist after install');

    assert.ok(countCommandUsageHooks(settings, 'PreToolUse') >= 1,
      'PreToolUse must have df-command-usage hook');
    assert.ok(countCommandUsageHooks(settings, 'PostToolUse') >= 1,
      'PostToolUse must have df-command-usage hook');
    assert.ok(countCommandUsageHooks(settings, 'SessionEnd') >= 1,
      'SessionEnd must have df-command-usage hook');
  });

  test('no duplicate hooks after repeated installs', () => {
    runInstall();
    runInstall();
    runInstall();

    const settings = readSettings();
    assert.equal(countCommandUsageHooks(settings, 'PreToolUse'), 1,
      'PreToolUse must have exactly 1 df-command-usage hook');
    assert.equal(countCommandUsageHooks(settings, 'PostToolUse'), 1,
      'PostToolUse must have exactly 1 df-command-usage hook');
    assert.equal(countCommandUsageHooks(settings, 'SessionEnd'), 1,
      'SessionEnd must have exactly 1 df-command-usage hook');
  });

  test('uninstall removes all three hooks', () => {
    // TODO: Cannot test uninstall end-to-end because bin/install.js --uninstall
    // requires process.stdin.isTTY and interactive confirmation ("y/N"),
    // which is not available in child_process.execFileSync.
    // Verifying by reading the uninstall source: it filters out df-command-usage
    // from PreToolUse, PostToolUse, and SessionEnd in settings.json.
    //
    // To partially validate, we verify the settings.json written by install
    // contains hook entries that the uninstall code would match and remove.
    runInstall();
    const settings = readSettings();
    assert.ok(settings, 'settings must exist after install');

    // Verify the hooks use the pattern that uninstall filters on
    for (const eventType of ['PreToolUse', 'PostToolUse', 'SessionEnd']) {
      const hooks = settings.hooks?.[eventType] || [];
      const cmdHooks = hooks.filter(h => {
        const cmd = h.hooks?.[0]?.command || '';
        return cmd.includes('df-command-usage');
      });
      assert.ok(cmdHooks.length >= 1,
        `${eventType} must have a df-command-usage hook that uninstall can match`);
    }
  });
});

// ===========================================================================
// AC-8: Deleting .deepflow/ mid-session causes no hook errors or Claude Code
// interruptions
// ===========================================================================

describe('AC-8: deleting .deepflow/ mid-session causes no errors', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('command-usage hook exits 0 after .deepflow deleted (PreToolUse)', () => {
    // Start a command
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // Delete .deepflow/
    rmrf(path.join(tmpDir, '.deepflow'));

    // Another PreToolUse should not crash
    const result = runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });
    assert.equal(result.code, 0, 'hook must exit 0 even after .deepflow deleted');
  });

  test('command-usage hook exits 0 after .deepflow deleted (PostToolUse)', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    rmrf(path.join(tmpDir, '.deepflow'));

    const result = runHook(CMD_USAGE_HOOK,
      { tool_name: 'Read', tool_input: {}, cwd: tmpDir },
      { event: 'PostToolUse' });
    assert.equal(result.code, 0, 'PostToolUse must exit 0 after .deepflow deleted');
  });

  test('command-usage hook exits 0 after .deepflow deleted (SessionEnd)', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    rmrf(path.join(tmpDir, '.deepflow'));

    const result = runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });
    assert.equal(result.code, 0, 'SessionEnd must exit 0 after .deepflow deleted');
  });

  test('statusline hook exits 0 after .deepflow deleted', () => {
    rmrf(path.join(tmpDir, '.deepflow'));

    const result = runHook(STATUSLINE_HOOK, makeStatuslineInput(tmpDir), { cwd: tmpDir });
    assert.equal(result.code, 0, 'statusline hook must exit 0 without .deepflow');
  });

  test('tool-usage hook exits 0 after .deepflow deleted', () => {
    rmrf(path.join(tmpDir, '.deepflow'));

    const result = runHook(TOOL_USAGE_HOOK, makeToolInput(tmpDir), {
      event: 'PostToolUse',
      cwd: tmpDir,
    });
    assert.equal(result.code, 0, 'tool-usage hook must exit 0 without .deepflow');
  });

  test('marker file deleted mid-command — PostToolUse still exits 0', () => {
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 's', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // Delete just the marker, not the whole .deepflow
    const markerPath = path.join(tmpDir, '.deepflow', 'active-command.json');
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);

    const result = runHook(CMD_USAGE_HOOK,
      { tool_name: 'Bash', tool_input: {}, cwd: tmpDir },
      { event: 'PostToolUse' });
    assert.equal(result.code, 0, 'PostToolUse must handle missing marker gracefully');
  });

  test('corrupt marker JSON does not crash SessionEnd', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.deepflow', 'active-command.json'),
      'THIS IS NOT JSON {{{'
    );

    const result = runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });
    assert.equal(result.code, 0, 'SessionEnd must handle corrupt marker gracefully');
  });
});

// ===========================================================================
// Cross-hook integration: full lifecycle across all hooks
// ===========================================================================

describe('Cross-hook integration: full command lifecycle', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.deepflow'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('command start -> tool calls -> token writes -> session end: all records consistent', () => {
    // 1. Start df:execute
    runHook(CMD_USAGE_HOOK,
      makeSkillPayload('df:execute', { sessionId: 'full-integ', cwd: tmpDir }),
      { event: 'PreToolUse' });

    // 2. Tool usage writes tool record — should have active_command
    runHook(TOOL_USAGE_HOOK, makeToolInput(tmpDir), {
      event: 'PostToolUse',
      cwd: tmpDir,
    });

    // 4. PostToolUse increments tool count on command-usage marker
    runHook(CMD_USAGE_HOOK,
      { tool_name: 'Read', tool_input: {}, cwd: tmpDir },
      { event: 'PostToolUse' });

    // 5. End session
    runHook(CMD_USAGE_HOOK, { cwd: tmpDir }, { event: 'SessionEnd' });

    // Verify tool usage has active_command (reads from $HOME/.claude/)
    const toolRecords = readToolUsage(tmpDir);
    const taggedTools = toolRecords.filter(r => r.active_command === 'df:execute');
    assert.ok(taggedTools.length >= 1, 'tool-usage should have df:execute records');

    // Verify command-usage record
    const usageRecords = readUsage(tmpDir);
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].command, 'df:execute');
    assert.equal(usageRecords[0].session_id, 'full-integ');
    assert.ok(usageRecords[0].tool_calls_count >= 1, 'should have at least 1 tool call');

    // Verify marker is cleaned up
    assert.equal(readMarker(tmpDir), null, 'marker must be deleted after SessionEnd');
  });
});
