/**
 * Tests for df-explore-metrics.js — PreToolUse hook
 *
 * Smoke tests verifying the module can be required and processes
 * Explore agent input by writing an entry to explore-metrics.jsonl.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOOK_PATH = path.resolve(__dirname, 'df-explore-metrics.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the hook as a child process with JSON piped to stdin.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { cwd } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env };
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      encoding: 'utf8',
      timeout: 10000,
      cwd: cwd || undefined,
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('df-explore-metrics hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-explore-metrics-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Smoke: module can be required without hanging or throwing
  // -------------------------------------------------------------------------
  test('smoke: module can be required without side effects', () => {
    // Should not throw and should not hang (readStdinIfMain guards against stdin read)
    assert.doesNotThrow(() => {
      require(HOOK_PATH);
    });
  });

  // -------------------------------------------------------------------------
  // Core: writes a metrics entry to explore-metrics.jsonl on Explore agent input
  // -------------------------------------------------------------------------
  test('writes explore-metrics.jsonl entry for Explore agent tool call', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: database connection' },
      cwd: tmpDir,
    };

    const { code } = runHook(input);
    assert.equal(code, 0);

    const metricsPath = path.join(tmpDir, '.deepflow', 'explore-metrics.jsonl');
    assert.ok(fs.existsSync(metricsPath), 'explore-metrics.jsonl should be created');

    const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'Should write exactly one entry');

    const entry = JSON.parse(lines[0]);
    assert.ok(entry.timestamp, 'Entry should have a timestamp');
    assert.equal(entry.query, 'Find: database connection');
    assert.equal(entry.phase1_hit, false, 'phase1_hit should be false when no LSP marker in prompt');
  });

  // -------------------------------------------------------------------------
  // phase1_hit: true when prompt contains LSP Phase marker
  // -------------------------------------------------------------------------
  test('records phase1_hit=true when prompt already contains LSP Phase marker', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt: 'Find: something\n\n## [LSP Phase -- locations found]\n\n/some/file.ts:10 -- foo (function)',
      },
      cwd: tmpDir,
    };

    const { code } = runHook(input);
    assert.equal(code, 0);

    const metricsPath = path.join(tmpDir, '.deepflow', 'explore-metrics.jsonl');
    const entry = JSON.parse(fs.readFileSync(metricsPath, 'utf8').trim());
    assert.equal(entry.phase1_hit, true, 'phase1_hit should be true when LSP Phase marker present');
  });

  // -------------------------------------------------------------------------
  // Pass-through: non-Agent tool calls produce no output and no metrics file
  // -------------------------------------------------------------------------
  test('ignores non-Agent tool calls — no metrics file written', () => {
    const input = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' },
      cwd: tmpDir,
    };

    const { code, stdout } = runHook(input);
    assert.equal(code, 0);
    assert.equal(stdout, '');

    const metricsPath = path.join(tmpDir, '.deepflow', 'explore-metrics.jsonl');
    assert.ok(!fs.existsSync(metricsPath), 'No metrics file should be created for non-Explore calls');
  });

  // -------------------------------------------------------------------------
  // Pass-through: non-Explore agent calls produce no metrics file
  // -------------------------------------------------------------------------
  test('ignores non-Explore agent calls — no metrics file written', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reasoner', prompt: 'Analyze this code' },
      cwd: tmpDir,
    };

    const { code } = runHook(input);
    assert.equal(code, 0);

    const metricsPath = path.join(tmpDir, '.deepflow', 'explore-metrics.jsonl');
    assert.ok(!fs.existsSync(metricsPath), 'No metrics file should be created for non-Explore agents');
  });

  // -------------------------------------------------------------------------
  // Resilience: exits 0 on malformed JSON input
  // -------------------------------------------------------------------------
  test('exits 0 on malformed JSON stdin', () => {
    const { code, stdout } = runHook('not valid json {{ }}');
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  // -------------------------------------------------------------------------
  // Append: multiple runs append multiple entries
  // -------------------------------------------------------------------------
  test('appends entries across multiple invocations', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: routes' },
      cwd: tmpDir,
    };

    runHook(input);
    runHook(input);

    const metricsPath = path.join(tmpDir, '.deepflow', 'explore-metrics.jsonl');
    const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'Should have two entries after two invocations');
    lines.forEach(line => {
      const entry = JSON.parse(line);
      assert.ok(entry.timestamp, 'Each entry should have a timestamp');
    });
  });
});
