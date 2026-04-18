'use strict';

/**
 * Unit + fixture tests for hooks/spec-transition.js
 *
 * Coverage:
 *   AC-1 — columnOf basename prefix mapping
 *   AC-2 — subStateOf HTML-comment extraction
 *   AC-3 — buildEvent JSON shape / ISO-8601 ts
 *   AC-7 — hook resilience (malformed stdin, missing dir, non-spec paths)
 *
 * AC-4 (installer)  → T15
 * AC-5 (statusline) → T12
 * AC-6 (guard_done) → T13
 *
 * Runner: Node.js built-in node:test  (no extra deps)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  columnOf,
  subStateOf,
  isSpecPath,
  buildEvent,
  readLastColumn,
} = require('./spec-transition');

const HOOK_PATH = path.resolve(__dirname, 'spec-transition.js');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh tmp directory, return its path. Caller owns cleanup. */
function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-transition-test-'));
}

/** Invoke the hook script synchronously via child_process.spawnSync. */
function runHook(stdinPayload, cwd) {
  const input = typeof stdinPayload === 'string'
    ? stdinPayload
    : JSON.stringify(stdinPayload);

  return spawnSync(process.execPath, [HOOK_PATH], {
    input,
    encoding: 'utf8',
    cwd: cwd || os.tmpdir(),
    timeout: 8000,
  });
}

// ── AC-1: columnOf ────────────────────────────────────────────────────────────

describe('AC-1 — columnOf: basename prefix → kanban column', () => {
  test('bare spec name → backlog', () => {
    assert.equal(columnOf('specs/foo.md'), 'backlog');
  });

  test('done- prefix → done', () => {
    assert.equal(columnOf('specs/done-foo.md'), 'done');
  });

  test('doing- prefix → doing', () => {
    assert.equal(columnOf('specs/doing-foo.md'), 'doing');
  });

  test('directory named done- does not affect result (basename wins)', () => {
    // e.g. done-archive/foo.md → basename is foo.md → backlog
    assert.equal(columnOf('done-archive/foo.md'), 'backlog');
  });

  test('directory named doing- does not affect result (basename wins)', () => {
    assert.equal(columnOf('doing-archive/foo.md'), 'backlog');
  });

  test('done- in .deepflow/specs-done → done', () => {
    assert.equal(columnOf('.deepflow/specs-done/done-my-spec.md'), 'done');
  });

  test('doing- prefix is case-sensitive (capital D is backlog)', () => {
    // The regex is /^doing-/ — uppercase D should fall through to backlog
    assert.equal(columnOf('specs/Doing-foo.md'), 'backlog');
  });

  test('path with no slash separators uses the whole string as basename', () => {
    // columnOf splits on '/' only; a path with no slash is its own basename
    assert.equal(columnOf('doing-foo.md'), 'doing');
    assert.equal(columnOf('done-foo.md'), 'done');
    assert.equal(columnOf('foo.md'), 'backlog');
  });
});

// ── AC-2: subStateOf ──────────────────────────────────────────────────────────

describe('AC-2 — subStateOf: HTML-comment sub_state extraction', () => {
  test('returns "doing" for <!-- sub_state: doing -->', () => {
    assert.equal(subStateOf('# spec\n<!-- sub_state: doing -->'), 'doing');
  });

  test('returns "waiting" for <!-- sub_state: waiting -->', () => {
    assert.equal(subStateOf('# spec\n<!-- sub_state: waiting -->'), 'waiting');
  });

  test('returns null when no sub_state marker present', () => {
    assert.equal(subStateOf('# spec\nSome content without any marker.'), null);
  });

  test('is case-insensitive (DOING is coerced to doing)', () => {
    // AC-2: case-insensitive
    const result = subStateOf('<!-- sub_state: DOING -->');
    assert.equal(result, 'doing');
  });

  test('is case-insensitive (WAITING is coerced to waiting)', () => {
    const result = subStateOf('<!-- sub_state: WAITING -->');
    assert.equal(result, 'waiting');
  });

  test('tolerates extra whitespace inside comment', () => {
    assert.equal(subStateOf('<!--  sub_state:  waiting  -->'), 'waiting');
  });

  test('first match wins when multiple markers are present', () => {
    const content = '<!-- sub_state: waiting -->\n<!-- sub_state: doing -->';
    assert.equal(subStateOf(content), 'waiting');
  });

  test('unknown marker value yields null', () => {
    // "blocked" is not one of doing|waiting — should return null
    assert.equal(subStateOf('<!-- sub_state: blocked -->'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(subStateOf(''), null);
  });
});

// ── AC-3: buildEvent ──────────────────────────────────────────────────────────

describe('AC-3 — buildEvent: JSON shape and ISO-8601 ts', () => {
  const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

  test('returns object with exactly the required keys', () => {
    const evt = buildEvent({
      specName: 'doing-foo.md',
      fromColumn: 'backlog',
      toColumn: 'doing',
      subState: null,
      tool: 'Write',
    });

    const keys = Object.keys(evt).sort();
    assert.deepEqual(keys, ['from_column', 'spec', 'sub_state', 'to_column', 'tool', 'ts']);
  });

  test('ts is a valid ISO-8601 string', () => {
    const evt = buildEvent({
      specName: 'foo.md',
      fromColumn: null,
      toColumn: 'backlog',
      subState: null,
      tool: 'Edit',
    });
    assert.match(evt.ts, ISO8601_RE);
  });

  test('fields are mapped to correct keys', () => {
    const evt = buildEvent({
      specName: 'done-bar.md',
      fromColumn: 'doing',
      toColumn: 'done',
      subState: 'waiting',
      tool: 'str_replace_based_edit_tool',
    });

    assert.equal(evt.spec, 'done-bar.md');
    assert.equal(evt.from_column, 'doing');
    assert.equal(evt.to_column, 'done');
    assert.equal(evt.sub_state, 'waiting');
    assert.equal(evt.tool, 'str_replace_based_edit_tool');
  });

  test('null fromColumn is preserved as null', () => {
    const evt = buildEvent({
      specName: 'foo.md',
      fromColumn: null,
      toColumn: 'backlog',
      subState: null,
      tool: 'Write',
    });
    assert.equal(evt.from_column, null);
  });

  test('null subState is preserved as null', () => {
    const evt = buildEvent({
      specName: 'foo.md',
      fromColumn: null,
      toColumn: 'backlog',
      subState: null,
      tool: 'Write',
    });
    assert.equal(evt.sub_state, null);
  });

  test('event serializes to valid JSON (round-trips)', () => {
    const evt = buildEvent({
      specName: 'doing-feature.md',
      fromColumn: 'backlog',
      toColumn: 'doing',
      subState: 'doing',
      tool: 'Edit',
    });
    const json = JSON.stringify(evt);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, evt);
  });
});

// ── isSpecPath ─────────────────────────────────────────────────────────────────
// Not a numbered AC but exercised by AC-7; covers the guard that prevents
// non-spec paths from emitting events.

describe('isSpecPath: spec path detection', () => {
  test('specs/foo.md is a spec path', () => {
    assert.equal(isSpecPath('specs/foo.md'), true);
  });

  test('specs/doing-foo.md is a spec path', () => {
    assert.equal(isSpecPath('specs/doing-foo.md'), true);
  });

  test('specs/done-foo.md is a spec path', () => {
    assert.equal(isSpecPath('specs/done-foo.md'), true);
  });

  test('.deepflow/specs-done/done-x.md is a spec path', () => {
    assert.equal(isSpecPath('.deepflow/specs-done/done-x.md'), true);
  });

  test('hooks/df-statusline.js is NOT a spec path', () => {
    assert.equal(isSpecPath('hooks/df-statusline.js'), false);
  });

  test('null/empty returns false', () => {
    assert.equal(isSpecPath(null), false);
    assert.equal(isSpecPath(''), false);
  });

  test('package.json is not a spec path', () => {
    assert.equal(isSpecPath('package.json'), false);
  });
});

// ── readLastColumn ─────────────────────────────────────────────────────────────

describe('readLastColumn: last-event lookup', () => {
  test('returns null when events file does not exist', () => {
    const tmp = makeTmp();
    const eventsPath = path.join(tmp, '.deepflow', 'events.jsonl');
    assert.equal(readLastColumn(eventsPath, 'foo.md'), null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns to_column of last matching event', () => {
    const tmp = makeTmp();
    const deepflowDir = path.join(tmp, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    const eventsPath = path.join(deepflowDir, 'events.jsonl');

    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), spec: 'foo.md', from_column: null, to_column: 'backlog', sub_state: null, tool: 'Write' }),
      JSON.stringify({ ts: new Date().toISOString(), spec: 'foo.md', from_column: 'backlog', to_column: 'doing', sub_state: null, tool: 'Edit' }),
    ];
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

    assert.equal(readLastColumn(eventsPath, 'foo.md'), 'doing');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns null when no events for specName exist', () => {
    const tmp = makeTmp();
    const deepflowDir = path.join(tmp, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    const eventsPath = path.join(deepflowDir, 'events.jsonl');

    fs.writeFileSync(eventsPath,
      JSON.stringify({ ts: new Date().toISOString(), spec: 'other.md', from_column: null, to_column: 'backlog', sub_state: null, tool: 'Write' }) + '\n'
    );

    assert.equal(readLastColumn(eventsPath, 'foo.md'), null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('skips malformed JSONL lines gracefully', () => {
    const tmp = makeTmp();
    const deepflowDir = path.join(tmp, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    const eventsPath = path.join(deepflowDir, 'events.jsonl');

    const lines = [
      'NOT VALID JSON',
      JSON.stringify({ spec: 'foo.md', to_column: 'done' }),
    ];
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

    assert.equal(readLastColumn(eventsPath, 'foo.md'), 'done');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── AC-7: hook resilience (end-to-end via child_process spawn) ─────────────────

describe('AC-7 — hook resilience: exit 0 on bad/missing inputs', () => {
  test('exits 0 with malformed (non-JSON) stdin', () => {
    const tmp = makeTmp();
    const result = runHook('THIS IS NOT JSON', tmp);
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('exits 0 when tool_input is missing', () => {
    const tmp = makeTmp();
    const payload = {
      tool_name: 'Write',
      // no tool_input field
    };
    const result = runHook(payload, tmp);
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('exits 0 for non-spec file_path (no event emitted)', () => {
    const tmp = makeTmp();
    const payload = {
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/index.js',
        content: 'console.log("hello")',
      },
      cwd: tmp,
    };
    const result = runHook(payload, tmp);
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);

    // No events.jsonl should be created for non-spec paths
    const eventsPath = path.join(tmp, '.deepflow', 'events.jsonl');
    assert.equal(fs.existsSync(eventsPath), false, 'events.jsonl should NOT be created for non-spec paths');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('creates .deepflow/ directory if absent and emits event', () => {
    const tmp = makeTmp();
    // Confirm .deepflow does not exist initially
    assert.equal(fs.existsSync(path.join(tmp, '.deepflow')), false);

    const payload = {
      tool_name: 'Write',
      tool_input: {
        file_path: 'specs/doing-my-feature.md',
        content: '# My Feature\n<!-- sub_state: doing -->',
      },
      cwd: tmp,
    };
    const result = runHook(payload, tmp);
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);

    // .deepflow/ and events.jsonl should now exist
    const eventsPath = path.join(tmp, '.deepflow', 'events.jsonl');
    assert.equal(fs.existsSync(eventsPath), true, 'events.jsonl should have been created');

    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one event should be emitted');

    const evt = JSON.parse(lines[0]);
    assert.equal(evt.spec, 'doing-my-feature.md');
    assert.equal(evt.to_column, 'doing');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('exits 0 for empty JSON object stdin (no tool_input)', () => {
    const tmp = makeTmp();
    const result = runHook({}, tmp);
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('emitted event has correct JSONL structure (end-to-end)', () => {
    const tmp = makeTmp();

    const payload = {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'specs/done-shipped.md',
        new_string: '# shipped\n<!-- sub_state: doing -->',
      },
      cwd: tmp,
    };
    const result = runHook(payload, tmp);
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);

    const eventsPath = path.join(tmp, '.deepflow', 'events.jsonl');
    assert.equal(fs.existsSync(eventsPath), true);

    const line = fs.readFileSync(eventsPath, 'utf8').trim();
    const evt = JSON.parse(line);

    // AC-3 keys
    const requiredKeys = ['ts', 'spec', 'from_column', 'to_column', 'sub_state', 'tool'];
    for (const key of requiredKeys) {
      assert.ok(key in evt, `event is missing key: ${key}`);
    }

    assert.equal(evt.spec, 'done-shipped.md');
    assert.equal(evt.to_column, 'done');
    assert.equal(evt.sub_state, 'doing');
    assert.match(evt.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
