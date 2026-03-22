/**
 * Tests for hooks/df-subagent-registry.js
 *
 * Tests the SubagentStop hook that reads event JSON from stdin,
 * extracts session_id/agent_type/agent_id, generates a timestamp,
 * and appends a JSON line to ~/.claude/subagent-sessions.jsonl.
 * Fire-and-forget, fail-open (exit 0 on error).
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

const HOOK_PATH = path.resolve(__dirname, 'df-subagent-registry.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-subagent-registry-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the subagent registry hook as a child process with JSON piped to stdin.
 * Overrides HOME so the registry file lands in our tmp dir.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { home } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env };
  if (home) {
    env.HOME = home;
  }
  try {
    const stdout = execFileSync(
      process.execPath,
      [HOOK_PATH],
      {
        input: json,
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
 * Read the registry file and return parsed JSON lines.
 */
function readRegistry(home) {
  const registryPath = path.join(home, '.claude', 'subagent-sessions.jsonl');
  if (!fs.existsSync(registryPath)) return [];
  const content = fs.readFileSync(registryPath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// 1. Valid SubagentStop event — appends correct JSON line
// ---------------------------------------------------------------------------

describe('df-subagent-registry — valid SubagentStop event', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    // Create ~/.claude directory so appendFileSync works
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpHome);
  });

  test('appends JSON line with session_id, agent_type, agent_id, timestamp', () => {
    const event = {
      session_id: 'sess-abc-123',
      agent_type: 'reasoner',
      agent_id: 'agent-xyz-789',
    };

    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].session_id, 'sess-abc-123');
    assert.equal(entries[0].agent_type, 'reasoner');
    assert.equal(entries[0].agent_id, 'agent-xyz-789');
    assert.ok(entries[0].timestamp, 'timestamp field should be present');
  });

  test('timestamp is ISO-8601 format', () => {
    const event = {
      session_id: 'sess-ts-check',
      agent_type: 'worker',
      agent_id: 'agent-ts-001',
    };

    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);

    // ISO-8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert.match(entries[0].timestamp, isoRegex, 'timestamp should be ISO-8601');
  });

  test('multiple invocations append multiple lines', () => {
    const event1 = { session_id: 'sess-1', agent_type: 'reasoner', agent_id: 'a1' };
    const event2 = { session_id: 'sess-2', agent_type: 'worker', agent_id: 'a2' };

    runHook(event1, { home: tmpHome });
    runHook(event2, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].session_id, 'sess-1');
    assert.equal(entries[1].session_id, 'sess-2');
  });

  test('entry only contains session_id, agent_type, agent_id, and timestamp', () => {
    const event = {
      session_id: 'sess-fields',
      agent_type: 'qa',
      agent_id: 'agent-f',
      extra_field: 'should-not-appear',
      nested: { foo: 'bar' },
    };

    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);
    const keys = Object.keys(entries[0]).sort();
    assert.deepEqual(keys, ['agent_id', 'agent_type', 'session_id', 'timestamp']);
  });
});

// ---------------------------------------------------------------------------
// 2. Registry file creation
// ---------------------------------------------------------------------------

describe('df-subagent-registry — file creation', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpHome);
  });

  test('creates registry file if ~/.claude directory exists but file does not', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const event = { session_id: 's1', agent_type: 'r', agent_id: 'a1' };

    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);

    const registryPath = path.join(tmpHome, '.claude', 'subagent-sessions.jsonl');
    assert.ok(fs.existsSync(registryPath), 'registry file should be created');
  });

  test('exits 0 when ~/.claude directory does not exist (fail-open)', () => {
    // No .claude directory — appendFileSync will throw ENOENT
    const event = { session_id: 's1', agent_type: 'r', agent_id: 'a1' };

    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0, 'should exit 0 even when directory is missing');
  });
});

// ---------------------------------------------------------------------------
// 3. Missing fields — fail-open (exit 0)
// ---------------------------------------------------------------------------

describe('df-subagent-registry — missing fields (fail-open)', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpHome);
  });

  test('exits 0 when session_id is missing', () => {
    const event = { agent_type: 'reasoner', agent_id: 'a1' };
    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);
  });

  test('exits 0 when agent_type is missing', () => {
    const event = { session_id: 's1', agent_id: 'a1' };
    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);
  });

  test('exits 0 when agent_id is missing', () => {
    const event = { session_id: 's1', agent_type: 'reasoner' };
    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);
  });

  test('exits 0 with empty object', () => {
    const result = runHook({}, { home: tmpHome });
    assert.equal(result.code, 0);
  });

  test('still writes entry with undefined fields when fields are missing', () => {
    const event = { session_id: 's1' };
    runHook(event, { home: tmpHome });

    const entries = readRegistry(tmpHome);
    // The hook destructures and writes whatever it gets — undefined becomes null/omitted in JSON
    assert.equal(entries.length, 1);
    assert.equal(entries[0].session_id, 's1');
    assert.ok(entries[0].timestamp, 'timestamp should still be present');
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid JSON stdin — fail-open (exit 0)
// ---------------------------------------------------------------------------

describe('df-subagent-registry — invalid JSON stdin', () => {
  test('exits 0 on completely invalid JSON', () => {
    const result = runHook('not valid json{{{');
    assert.equal(result.code, 0);
  });

  test('exits 0 on empty stdin', () => {
    const result = runHook('');
    assert.equal(result.code, 0);
  });

  test('exits 0 on truncated JSON', () => {
    const result = runHook('{"session_id": "s1", "agent_type":');
    assert.equal(result.code, 0);
  });

  test('exits 0 on non-object JSON (array)', () => {
    // JSON.parse succeeds but destructuring an array yields undefined fields
    // appendFileSync may still work — either way, exit 0
    let tmpHome = makeTmpDir();
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const result = runHook('[1, 2, 3]', { home: tmpHome });
    assert.equal(result.code, 0);
    rmrf(tmpHome);
  });

  test('exits 0 on JSON null', () => {
    const result = runHook('null');
    assert.equal(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------

describe('df-subagent-registry — edge cases', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmrf(tmpHome);
  });

  test('appended line is valid JSONL (ends with newline)', () => {
    const event = { session_id: 's1', agent_type: 'r', agent_id: 'a1' };
    runHook(event, { home: tmpHome });

    const registryPath = path.join(tmpHome, '.claude', 'subagent-sessions.jsonl');
    const raw = fs.readFileSync(registryPath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'registry entry should end with newline');
  });

  test('handles special characters in field values', () => {
    const event = {
      session_id: 'sess-with-"quotes"-and-\\backslash',
      agent_type: 'type/with/slashes',
      agent_id: 'id with spaces & symbols!@#',
    };

    const result = runHook(event, { home: tmpHome });
    assert.equal(result.code, 0);

    const entries = readRegistry(tmpHome);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].session_id, 'sess-with-"quotes"-and-\\backslash');
    assert.equal(entries[0].agent_type, 'type/with/slashes');
    assert.equal(entries[0].agent_id, 'id with spaces & symbols!@#');
  });

  test('writes to correct path: ~/.claude/subagent-sessions.jsonl', () => {
    const event = { session_id: 's1', agent_type: 'r', agent_id: 'a1' };
    runHook(event, { home: tmpHome });

    const expectedPath = path.join(tmpHome, '.claude', 'subagent-sessions.jsonl');
    assert.ok(fs.existsSync(expectedPath), 'file should exist at expected path');

    // Verify no other jsonl files were created
    const claudeDir = path.join(tmpHome, '.claude');
    const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    assert.equal(files[0], 'subagent-sessions.jsonl');
  });

  test('each appended line is independently parseable JSON', () => {
    for (let i = 0; i < 3; i++) {
      runHook({ session_id: `s${i}`, agent_type: 'r', agent_id: `a${i}` }, { home: tmpHome });
    }

    const registryPath = path.join(tmpHome, '.claude', 'subagent-sessions.jsonl');
    const lines = fs.readFileSync(registryPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);

    lines.forEach((line, i) => {
      const parsed = JSON.parse(line);
      assert.equal(parsed.session_id, `s${i}`);
    });
  });
});
