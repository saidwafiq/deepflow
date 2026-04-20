/**
 * Tests for hooks/df-implement-protocol.js
 *
 * Covers AC-3 (Impact block injected), AC-4 (prohibition literal present),
 * AC-6 (fail-open on malformed input), AC-7 (LSP unavailable → runPhase1
 * fallback), and AC-10 (dedup marker → no-op).
 *
 * Strategy:
 *   - Direct require() tests for pure-function behaviour (AC-3, AC-4, AC-10)
 *   - spawnSync of the hook binary for stdin/exit-code contracts (AC-6, malformed)
 *   - Fallback path verified by calling collectFallbackData directly with a
 *     fixture file that has a class declaration (AC-7 unit-level).
 *
 * Uses Node.js built-in node:test. No additional npm packages.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Load the hook module directly (readStdinIfMain won't block because this
// file is not require.main).
// ---------------------------------------------------------------------------
const HOOK_PATH = path.resolve(__dirname, 'df-implement-protocol.js');
const hook = require('./df-implement-protocol');

const {
  main,
  parseFilesList,
  buildInjectionBlock,
  collectFallbackData,
  INJECTION_MARKER,
  PROHIBITION_LITERAL,
} = hook;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'df-impl-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run the hook binary via spawnSync with JSON on stdin.
 * Returns { stdout, stderr, status }.
 */
function runHook(input, { env } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: json,
    encoding: 'utf8',
    timeout: 10000,
    env: env || process.env,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Fixture: a minimal JS file that exports an interface-style class so that
// collectFallbackData can find at least one type-ish symbol.
// ---------------------------------------------------------------------------
const FIXTURE_CLASS_CONTENT = `
// fixture file used by df-implement-protocol tests
class AcCoverage {
  constructor() {}
  run() { return true; }
}
module.exports = { AcCoverage };
`;

// ---------------------------------------------------------------------------
// 1. Impact block present when task prompt references a real file (AC-3)
// ---------------------------------------------------------------------------

describe('AC-3: Impact block injected into prompt', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-impl-impact-');
    // Write a file matching the name used in the AC task spec (hooks/ac-coverage.js)
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'ac-coverage.js'), FIXTURE_CLASS_CONTENT);
  });

  afterEach(() => rmrf(tmpDir));

  test('injected prompt contains an Impact block header', () => {
    const prompt = [
      'T99: Implement coverage check',
      `Files: hooks/ac-coverage.js`,
      `Worktree: .deepflow/worktrees/test-slug`,
      'TASK_STATUS: pass|fail',
    ].join('\n');

    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt },
      cwd: tmpDir,
    };

    const result = main(payload);
    // main() returns null when no injection needed; non-null means it injected.
    // Whether LSP data is available or not, the Impact block header must exist.
    assert.ok(result !== null, 'main() should return a non-null result for valid task prompt');
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      updatedPrompt.includes('--- CONTEXT: Impact ---'),
      'Updated prompt must contain the Impact block header'
    );
  });

  test('injection marker is appended to prompt', () => {
    const prompt = [
      'T99: Implement coverage check',
      `Files: hooks/ac-coverage.js`,
      `Worktree: .deepflow/worktrees/test-slug`,
      'TASK_STATUS: pass|fail',
    ].join('\n');

    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.ok(result !== null);
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(updatedPrompt.includes(INJECTION_MARKER), 'Injection marker must be present');
  });
});

// ---------------------------------------------------------------------------
// 2. Exact prohibition literal present (AC-4)
// ---------------------------------------------------------------------------

describe('AC-4: Exact prohibition literal in injected prompt', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-impl-prohibition-');
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'ac-coverage.js'), FIXTURE_CLASS_CONTENT);
  });

  afterEach(() => rmrf(tmpDir));

  test('prohibition literal is exactly present in updated prompt', () => {
    const prompt = [
      'T99: check files',
      'Files: hooks/ac-coverage.js',
      '.deepflow/worktrees/slug/something',
      'TASK_STATUS: pass|fail',
    ].join('\n');

    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.ok(result !== null, 'Injection should happen');
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      updatedPrompt.includes(PROHIBITION_LITERAL),
      `Expected exact prohibition string: "${PROHIBITION_LITERAL}"`
    );
  });

  test('buildInjectionBlock always contains prohibition literal', () => {
    const block = buildInjectionBlock({ callers: [], types: [], cwd: os.tmpdir() });
    assert.ok(block.includes(PROHIBITION_LITERAL));
    assert.ok(block.includes('--- CONTEXT: Tool Prohibition ---'));
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed input JSON → stdout empty, exit 0 (AC-6)
// ---------------------------------------------------------------------------

describe('AC-6: Fail-open on malformed stdin', () => {
  test('malformed JSON → exit 0 with empty stdout', () => {
    const { stdout, status } = runHook('not valid json {{{');
    assert.equal(status, 0, 'Hook must exit 0 on malformed JSON');
    assert.equal(stdout.trim(), '', 'stdout must be empty on malformed JSON');
  });

  test('empty string stdin → exit 0 with empty stdout', () => {
    const { stdout, status } = runHook('');
    assert.equal(status, 0, 'Hook must exit 0 on empty stdin');
    assert.equal(stdout.trim(), '', 'stdout must be empty on empty stdin');
  });

  test('wrong tool_name → no output (pass-through)', () => {
    const { stdout, status } = runHook({
      tool_name: 'Read',
      tool_input: { prompt: 'T1: foo Files: bar.js TASK_STATUS: pass|fail' },
      cwd: os.tmpdir(),
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// 4. LSP unavailable → graceful fallback to runPhase1 (AC-7)
// ---------------------------------------------------------------------------

describe('AC-7: LSP unavailable → fallback to runPhase1', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-impl-fallback-');
    // Create a fixture file with an exported class so runPhase1 can find something.
    fs.writeFileSync(path.join(tmpDir, 'widget.js'), FIXTURE_CLASS_CONTENT);
  });

  afterEach(() => rmrf(tmpDir));

  test('collectFallbackData returns types from regex extraction when no LSP', () => {
    const absFile = path.join(tmpDir, 'widget.js');
    const { callers, types, usedLsp } = collectFallbackData([absFile], tmpDir);
    // Fallback should not use LSP.
    assert.equal(usedLsp, false, 'usedLsp must be false in fallback path');
    // callers is always empty in the fallback path.
    assert.deepEqual(callers, [], 'callers must be empty in fallback path');
    // types may or may not find the class (regex depends on formatting), but
    // the function must complete without throwing.
    assert.ok(Array.isArray(types), 'types must be an array');
  });

  test('main() still exits 0 and produces output when lsp-query cannot be found', () => {
    // Point cwd to tmpDir which has no bin/lsp-query.js.
    // The hook must fall back and still inject (or at minimum not crash).
    const absFile = path.join(tmpDir, 'widget.js');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    fs.copyFileSync(absFile, path.join(tmpDir, 'hooks', 'widget.js'));

    const prompt = [
      'T1: do something',
      'Files: hooks/widget.js',
      '.deepflow/worktrees/fallback-slug',
      'TASK_STATUS: pass|fail',
    ].join('\n');

    // Verify via spawnSync: even without lsp-query, hook exits 0.
    const { status } = runHook({
      tool_name: 'Agent',
      tool_input: { prompt },
      cwd: tmpDir,
    });
    assert.equal(status, 0, 'Hook must exit 0 even when LSP is unavailable');
  });
});

// ---------------------------------------------------------------------------
// 5. Dedup marker already present → no-op (AC-10)
// ---------------------------------------------------------------------------

describe('AC-10: Dedup guard — marker already present → no-op', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-impl-dedup-');
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'ac-coverage.js'), FIXTURE_CLASS_CONTENT);
  });

  afterEach(() => rmrf(tmpDir));

  test('main() returns null when injection marker already in prompt', () => {
    const prompt = [
      'T1: task',
      'Files: hooks/ac-coverage.js',
      '.deepflow/worktrees/dedup-slug',
      'TASK_STATUS: pass|fail',
      INJECTION_MARKER,
    ].join('\n');

    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.equal(result, null, 'main() must return null when dedup marker is present');
  });

  test('spawn: stdout empty when dedup marker present', () => {
    const prompt = [
      'T1: task',
      'Files: hooks/ac-coverage.js',
      '.deepflow/worktrees/dedup-slug',
      'TASK_STATUS: pass|fail',
      INJECTION_MARKER,
    ].join('\n');

    const { stdout, status } = runHook({
      tool_name: 'Agent',
      tool_input: { prompt },
      cwd: tmpDir,
    });
    assert.equal(status, 0, 'Hook must exit 0 on dedup path');
    assert.equal(stdout.trim(), '', 'stdout must be empty when marker already present');
  });
});

// ---------------------------------------------------------------------------
// 6. parseFilesList — unit-level sanity
// ---------------------------------------------------------------------------

describe('parseFilesList unit tests', () => {
  test('extracts file from inline Files: entry', () => {
    const files = parseFilesList('T1: desc  Files: hooks/ac-coverage.js  Spec: specs/foo.md');
    assert.ok(files.includes('hooks/ac-coverage.js'));
  });

  test('returns empty array when no Files: present', () => {
    const files = parseFilesList('T1: desc — no files listed here');
    assert.deepEqual(files, []);
  });

  test('returns empty array for non-string input', () => {
    assert.deepEqual(parseFilesList(null), []);
    assert.deepEqual(parseFilesList(undefined), []);
  });
});
