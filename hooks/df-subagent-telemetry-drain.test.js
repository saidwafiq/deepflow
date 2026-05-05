'use strict';

/**
 * Tests for hooks/df-subagent-telemetry-drain.js (REQ-B1, REQ-B3, REQ-B4)
 *
 * Verifies:
 *   1. Hook carries @hook-event: SubagentStop and @hook-owner: deepflow tags.
 *   2. After a subagent completes, token-history.jsonl contains one new row
 *      with agent_role, task_id, and cache_read_input_tokens (AC-6).
 *   3. Re-running against the same agent_id does NOT add a duplicate row (AC-7).
 *   4. When the subagent JSONL is malformed/missing, the hook exits 0 and
 *      appends an error entry to events.jsonl (AC-8).
 *   5. sumTokenUsage correctly aggregates across multiple assistant turns.
 *   6. extractTaskIdFromTranscript handles all task_id patterns.
 *   7. isDuplicate returns false for empty/missing file and true on match.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-subagent-telemetry-drain.js');

const {
  drain,
  parseJsonl,
  sumTokenUsage,
  resolveAgentJsonlPath,
  extractTaskIdFromTranscript,
  isDuplicate,
  appendErrorEvent,
} = require('./df-subagent-telemetry-drain');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-telemetry-drain-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run the drain hook as a child process with JSON piped to stdin.
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
 * Build a minimal SubagentStop payload.
 */
function subagentStopPayload({
  agent_id = 'agent-abc123',
  agent_type = 'df-implement',
  session_id = 'session-xyz',
  transcript_path = null,
  agent_transcript_path = null,
  cwd = os.tmpdir(),
} = {}) {
  return {
    hook_event_name: 'SubagentStop',
    agent_id,
    agent_type,
    session_id,
    transcript_path,
    agent_transcript_path,
    cwd,
  };
}

/**
 * Build a minimal subagent JSONL content with one assistant turn.
 */
function buildSubagentJsonl({
  agentId = 'aac30cf1df9c46a2b',
  taskId = 'T4',
  input_tokens = 100,
  cache_creation_input_tokens = 500,
  cache_read_input_tokens = 1200,
  output_tokens = 80,
  model = 'claude-sonnet-4-6',
} = {}) {
  const userEntry = {
    parentUuid: null,
    isSidechain: true,
    agentId,
    type: 'user',
    message: {
      role: 'user',
      content: `${taskId}: implement the feature`,
    },
    uuid: 'user-uuid-1',
    timestamp: new Date().toISOString(),
    sessionId: 'session-xyz',
  };

  const assistantEntry = {
    agentId,
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        output_tokens,
      },
    },
    uuid: 'asst-uuid-1',
    timestamp: new Date().toISOString(),
  };

  return [JSON.stringify(userEntry), JSON.stringify(assistantEntry)].join('\n') + '\n';
}

/**
 * Read all JSONL records from token-history.jsonl in the given deepflow dir.
 */
function readTokenHistory(deepflowDir) {
  const p = path.join(deepflowDir, 'token-history.jsonl');
  if (!fs.existsSync(p)) return [];
  return parseJsonl(fs.readFileSync(p, 'utf8'));
}

/**
 * Read all JSONL records from events.jsonl in the given deepflow dir.
 */
function readEvents(deepflowDir) {
  const p = path.join(deepflowDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return parseJsonl(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tag verification
// ---------------------------------------------------------------------------

describe('df-subagent-telemetry-drain.js — hook event tags', () => {
  function readFirstLines(n = 5) {
    return fs.readFileSync(HOOK_PATH, 'utf8').split('\n').slice(0, n);
  }

  test('carries @hook-event: SubagentStop on line 2', () => {
    const lines = readFirstLines();
    assert.match(lines[1], /\/\/\s*@hook-event:\s*SubagentStop/);
  });

  test('carries @hook-owner: deepflow within first 5 lines', () => {
    const lines = readFirstLines();
    const hasOwner = lines.some(l => /\/\/\s*@hook-owner:\s*deepflow/.test(l));
    assert.ok(hasOwner, 'should have @hook-owner: deepflow tag');
  });
});

// ---------------------------------------------------------------------------
// parseJsonl
// ---------------------------------------------------------------------------

describe('parseJsonl', () => {
  test('parses valid JSONL', () => {
    const content = '{"a":1}\n{"b":2}\n';
    const result = parseJsonl(content);
    assert.equal(result.length, 2);
    assert.equal(result[0].a, 1);
    assert.equal(result[1].b, 2);
  });

  test('skips empty lines', () => {
    const content = '{"a":1}\n\n{"b":2}\n';
    const result = parseJsonl(content);
    assert.equal(result.length, 2);
  });

  test('skips malformed lines', () => {
    const content = '{"a":1}\nnot-json\n{"b":2}\n';
    const result = parseJsonl(content);
    assert.equal(result.length, 2);
  });

  test('returns empty array for empty content', () => {
    assert.deepEqual(parseJsonl(''), []);
    assert.deepEqual(parseJsonl('\n\n'), []);
  });
});

// ---------------------------------------------------------------------------
// sumTokenUsage
// ---------------------------------------------------------------------------

describe('sumTokenUsage', () => {
  test('sums tokens across multiple assistant turns', () => {
    const entries = [
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 50,
          },
        },
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 50,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 150,
            output_tokens: 25,
          },
        },
      },
    ];
    const result = sumTokenUsage(entries);
    assert.equal(result.input_tokens, 150);
    assert.equal(result.cache_creation_input_tokens, 300);
    assert.equal(result.cache_read_input_tokens, 450);
    assert.equal(result.output_tokens, 75);
    assert.equal(result.model, 'claude-sonnet-4-6');
  });

  test('ignores non-assistant entries', () => {
    const entries = [
      { type: 'user', message: { usage: { input_tokens: 9999 } } },
      {
        type: 'assistant',
        message: {
          model: 'model-x',
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 50, output_tokens: 5 },
        },
      },
    ];
    const result = sumTokenUsage(entries);
    assert.equal(result.input_tokens, 10);
  });

  test('handles entries with no usage field', () => {
    const entries = [
      { type: 'assistant', message: {} },
      {
        type: 'assistant',
        message: {
          model: 'model-y',
          usage: { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 10, output_tokens: 3 },
        },
      },
    ];
    const result = sumTokenUsage(entries);
    assert.equal(result.input_tokens, 5);
    assert.equal(result.model, 'model-y');
  });

  test('returns zeros for empty entries', () => {
    const result = sumTokenUsage([]);
    assert.equal(result.input_tokens, 0);
    assert.equal(result.cache_creation_input_tokens, 0);
    assert.equal(result.cache_read_input_tokens, 0);
    assert.equal(result.output_tokens, 0);
    assert.equal(result.model, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// extractTaskIdFromTranscript
// ---------------------------------------------------------------------------

describe('extractTaskIdFromTranscript', () => {
  function userEntry(content) {
    return { type: 'user', message: { content } };
  }

  test('extracts "T4:" style task id', () => {
    const entries = [userEntry('T4: implement the feature')];
    assert.equal(extractTaskIdFromTranscript(entries), 'T4');
  });

  test('extracts "T123:" style task id', () => {
    const entries = [userEntry('T123: do something')];
    assert.equal(extractTaskIdFromTranscript(entries), 'T123');
  });

  test('extracts task id from "Task: T4" style', () => {
    const entries = [userEntry('Task: T4\nsome more text')];
    assert.equal(extractTaskIdFromTranscript(entries), 'T4');
  });

  test('extracts task id from "## T4" header style', () => {
    const entries = [userEntry('## T4 Implementation\nsome details')];
    assert.equal(extractTaskIdFromTranscript(entries), 'T4');
  });

  test('returns null when no task id found', () => {
    const entries = [userEntry('implement the feature without any task id')];
    assert.equal(extractTaskIdFromTranscript(entries), null);
  });

  test('returns null for empty entries', () => {
    assert.equal(extractTaskIdFromTranscript([]), null);
  });

  test('handles array content blocks', () => {
    const entries = [{
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'T7: some task' },
        ],
      },
    }];
    assert.equal(extractTaskIdFromTranscript(entries), 'T7');
  });

  test('skips non-user entries', () => {
    const entries = [
      { type: 'assistant', message: { content: 'T4: not user' } },
      { type: 'user', message: { content: 'T9: user task' } },
    ];
    assert.equal(extractTaskIdFromTranscript(entries), 'T9');
  });
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('returns false when file does not exist', () => {
    const p = path.join(tmp, 'token-history.jsonl');
    assert.equal(isDuplicate(p, 'agent-123'), false);
  });

  test('returns false when agent_id not in file', () => {
    const p = path.join(tmp, 'token-history.jsonl');
    fs.writeFileSync(p, JSON.stringify({ agent_id: 'agent-other' }) + '\n');
    assert.equal(isDuplicate(p, 'agent-123'), false);
  });

  test('returns true when agent_id found in file', () => {
    const p = path.join(tmp, 'token-history.jsonl');
    fs.writeFileSync(p, JSON.stringify({ agent_id: 'agent-123', ts: 'x' }) + '\n');
    assert.equal(isDuplicate(p, 'agent-123'), true);
  });

  test('returns false for empty file', () => {
    const p = path.join(tmp, 'token-history.jsonl');
    fs.writeFileSync(p, '');
    assert.equal(isDuplicate(p, 'agent-123'), false);
  });
});

// ---------------------------------------------------------------------------
// appendErrorEvent
// ---------------------------------------------------------------------------

describe('appendErrorEvent', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('creates events.jsonl with error entry', () => {
    appendErrorEvent(tmp, 'agent-xyz', 'test error message');
    const events = readEvents(tmp);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'telemetry-drain-error');
    assert.equal(events[0].agent_id, 'agent-xyz');
    assert.equal(events[0].error, 'test error message');
  });

  test('appends multiple entries without overwriting', () => {
    appendErrorEvent(tmp, 'agent-1', 'error 1');
    appendErrorEvent(tmp, 'agent-2', 'error 2');
    const events = readEvents(tmp);
    assert.equal(events.length, 2);
    assert.equal(events[0].agent_id, 'agent-1');
    assert.equal(events[1].agent_id, 'agent-2');
  });

  test('ts field is ISO-8601 string', () => {
    appendErrorEvent(tmp, 'agent-ts-test', 'err');
    const events = readEvents(tmp);
    assert.equal(typeof events[0].ts, 'string');
    assert.ok(!isNaN(Date.parse(events[0].ts)));
  });
});

// ---------------------------------------------------------------------------
// drain function — AC-6: one row with agent_role, task_id, cache_read_input_tokens
// ---------------------------------------------------------------------------

describe('drain — AC-6: appends token history row', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('appends one row per agent with required fields', () => {
    // Setup fake subagent JSONL
    const agentId = 'test-agent-001';
    const sessionBase = 'session-abc';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const agentJsonlPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(agentJsonlPath, buildSubagentJsonl({
      agentId,
      taskId: 'T4',
      cache_read_input_tokens: 1300,
    }));

    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const deepflowDir = path.join(tmp, '.deepflow');
    const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

    const payload = subagentStopPayload({
      agent_id: agentId,
      agent_type: 'df-implement',
      session_id: 'session-abc',
      transcript_path: transcriptPath,
      cwd: tmp,
    });

    const result = drain({ payload, deepflowDir, tokenHistoryPath });

    assert.ok(result.record, 'should return a record');
    assert.equal(result.skipped, false);
    assert.equal(result.error, null);

    const rows = readTokenHistory(deepflowDir);
    assert.equal(rows.length, 1);

    const row = rows[0];
    assert.equal(row.agent_role, 'df-implement', 'agent_role should be df-implement');
    assert.equal(row.task_id, 'T4', 'task_id should be T4');
    assert.equal(row.cache_read_input_tokens, 1300, 'cache_read_input_tokens should be non-zero');
    assert.equal(row.agent_id, agentId);
    assert.equal(row.session_id, 'session-abc');
    assert.ok(row.timestamp, 'should have timestamp');
    assert.ok(!isNaN(Date.parse(row.timestamp)), 'timestamp should be ISO-8601');
  });

  test('record contains all expected fields', () => {
    const agentId = 'test-agent-fields';
    const sessionBase = 'session-fields';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${agentId}.jsonl`),
      buildSubagentJsonl({ agentId, taskId: 'T7' })
    );

    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const deepflowDir = path.join(tmp, '.deepflow');
    const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

    drain({
      payload: subagentStopPayload({
        agent_id: agentId,
        agent_type: 'df-implement',
        transcript_path: transcriptPath,
        cwd: tmp,
      }),
      deepflowDir,
      tokenHistoryPath,
    });

    const row = readTokenHistory(deepflowDir)[0];
    const requiredFields = [
      'timestamp', 'agent_id', 'agent_role', 'task_id',
      'input_tokens', 'cache_creation_input_tokens',
      'cache_read_input_tokens', 'output_tokens', 'model', 'session_id',
    ];
    for (const field of requiredFields) {
      assert.ok(field in row, `missing field: ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// drain function — AC-7: idempotency
// ---------------------------------------------------------------------------

describe('drain — AC-7: idempotency', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('re-running against the same agent_id does not add duplicate row', () => {
    const agentId = 'test-agent-idem';
    const sessionBase = 'session-idem';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const agentJsonlPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(agentJsonlPath, buildSubagentJsonl({ agentId }));

    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const deepflowDir = path.join(tmp, '.deepflow');
    const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

    const payload = subagentStopPayload({
      agent_id: agentId,
      transcript_path: transcriptPath,
      cwd: tmp,
    });

    // First drain
    const result1 = drain({ payload, deepflowDir, tokenHistoryPath });
    assert.equal(result1.skipped, false);

    // Second drain — same agent_id
    const result2 = drain({ payload, deepflowDir, tokenHistoryPath });
    assert.equal(result2.skipped, true, 'second drain should be skipped');
    assert.equal(result2.record, null);

    // Only one row in the file
    const rows = readTokenHistory(deepflowDir);
    assert.equal(rows.length, 1, 'should only have one row');
  });
});

// ---------------------------------------------------------------------------
// drain function — AC-8: malformed/missing JSONL
// ---------------------------------------------------------------------------

describe('drain — AC-8: malformed/missing JSONL handling', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('exits 0 and writes error to events.jsonl when agent JSONL not found', () => {
    const agentId = 'test-agent-missing';
    const deepflowDir = path.join(tmp, '.deepflow');
    const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

    // No agent JSONL created — transcript_path points to non-existent session
    const transcriptPath = path.join(tmp, 'session-missing.jsonl');
    // Don't create it

    const payload = subagentStopPayload({
      agent_id: agentId,
      transcript_path: transcriptPath,
      cwd: tmp,
    });

    const result = drain({ payload, deepflowDir, tokenHistoryPath });
    assert.ok(result.error, 'should return an error string');
    assert.equal(result.record, null);

    // events.jsonl should have an error entry
    const events = readEvents(deepflowDir);
    assert.ok(events.length > 0, 'events.jsonl should have entries');
    assert.equal(events[0].event, 'telemetry-drain-error');
    assert.equal(events[0].agent_id, agentId);
  });

  test('exits 0 and writes error when agent JSONL is empty', () => {
    const agentId = 'test-agent-empty';
    const sessionBase = 'session-empty';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    // Create empty JSONL
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), '');

    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const deepflowDir = path.join(tmp, '.deepflow');
    const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

    const payload = subagentStopPayload({
      agent_id: agentId,
      transcript_path: transcriptPath,
      cwd: tmp,
    });

    const result = drain({ payload, deepflowDir, tokenHistoryPath });
    assert.ok(result.error, 'should return an error string');

    const events = readEvents(deepflowDir);
    assert.ok(events.length > 0);
    assert.equal(events[0].event, 'telemetry-drain-error');
  });

  test('hook process exits 0 even when agent JSONL is missing', () => {
    const tmp2 = makeTmpDir();
    try {
      const payload = subagentStopPayload({
        agent_id: 'agent-missing-proc',
        transcript_path: path.join(tmp2, 'no-such-session.jsonl'),
        cwd: tmp2,
      });
      const result = runHook(payload, { cwd: tmp2 });
      assert.equal(result.code, 0, 'hook process must exit 0');
    } finally {
      rmrf(tmp2);
    }
  });
});

// ---------------------------------------------------------------------------
// Hook process exit code — always 0
// ---------------------------------------------------------------------------

describe('df-subagent-telemetry-drain.js — exit code', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('exits 0 for valid SubagentStop event', () => {
    const agentId = 'agent-exit0';
    const sessionBase = 'session-exit0';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${agentId}.jsonl`),
      buildSubagentJsonl({ agentId })
    );
    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const payload = subagentStopPayload({
      agent_id: agentId,
      transcript_path: transcriptPath,
      cwd: tmp,
    });
    const result = runHook(payload, { cwd: tmp });
    assert.equal(result.code, 0);
  });

  test('exits 0 for non-SubagentStop event', () => {
    const result = runHook({ hook_event_name: 'PreToolUse', cwd: tmp }, { cwd: tmp });
    assert.equal(result.code, 0);
  });

  test('exits 0 for malformed event (no fields)', () => {
    const result = runHook({ cwd: tmp }, { cwd: tmp });
    assert.equal(result.code, 0);
  });

  test('exits 0 even with completely invalid JSON structure', () => {
    // This one uses the raw process invocation with broken JSON
    try {
      execFileSync(process.execPath, [HOOK_PATH], {
        input: 'not valid json at all',
        cwd: tmp,
        encoding: 'utf8',
        timeout: 5000,
      });
      // Exits 0 with no error
    } catch (err) {
      // readStdinIfMain exits 0 on invalid JSON parse
      assert.equal(err.status, 0, 'should exit 0 even for invalid JSON');
    }
  });
});

// ---------------------------------------------------------------------------
// resolveAgentJsonlPath
// ---------------------------------------------------------------------------

describe('resolveAgentJsonlPath', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('returns agent_transcript_path when it exists', () => {
    const p = path.join(tmp, 'agent-direct.jsonl');
    fs.writeFileSync(p, '');
    const payload = { agent_transcript_path: p };
    assert.equal(resolveAgentJsonlPath(payload), p);
  });

  test('derives path from transcript_path + agent_id', () => {
    const sessionBase = 'session-abc';
    const agentId = 'agent-derive';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const agentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(agentPath, '');

    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const payload = { transcript_path: transcriptPath, agent_id: agentId };
    assert.equal(resolveAgentJsonlPath(payload), agentPath);
  });

  test('returns null when no path can be resolved', () => {
    const payload = {
      agent_id: 'agent-no-file',
      transcript_path: path.join(tmp, 'no-session.jsonl'),
    };
    assert.equal(resolveAgentJsonlPath(payload), null);
  });
});

// ---------------------------------------------------------------------------
// Process-level integration: runHook produces token-history.jsonl row
// ---------------------------------------------------------------------------

describe('process-level integration', () => {
  let tmp;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => rmrf(tmp));

  test('running hook process creates token-history.jsonl with correct fields', () => {
    const agentId = 'agent-proc-test';
    const sessionBase = 'session-proc-test';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${agentId}.jsonl`),
      buildSubagentJsonl({
        agentId,
        taskId: 'T4',
        cache_read_input_tokens: 5000,
      })
    );
    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const payload = subagentStopPayload({
      agent_id: agentId,
      agent_type: 'df-implement',
      transcript_path: transcriptPath,
      cwd: tmp,
    });

    const result = runHook(payload, { cwd: tmp });
    assert.equal(result.code, 0);

    const deepflowDir = path.join(tmp, '.deepflow');
    const rows = readTokenHistory(deepflowDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_role, 'df-implement');
    assert.equal(rows[0].task_id, 'T4');
    assert.ok(rows[0].cache_read_input_tokens > 0);
  });

  test('running hook process twice does not duplicate row', () => {
    const agentId = 'agent-dup-test';
    const sessionBase = 'session-dup-test';
    const subagentsDir = path.join(tmp, sessionBase, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${agentId}.jsonl`),
      buildSubagentJsonl({ agentId })
    );
    const transcriptPath = path.join(tmp, `${sessionBase}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const payload = subagentStopPayload({
      agent_id: agentId,
      transcript_path: transcriptPath,
      cwd: tmp,
    });

    runHook(payload, { cwd: tmp });
    runHook(payload, { cwd: tmp });

    const deepflowDir = path.join(tmp, '.deepflow');
    const rows = readTokenHistory(deepflowDir);
    assert.equal(rows.length, 1, 'must not have duplicate rows');
  });
});
