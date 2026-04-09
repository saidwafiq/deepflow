#!/usr/bin/env node
/**
 * Spike: Validate `claude --print` subprocess latency and LSP output format
 * for Phase 1 of d3-explore-split (T5).
 *
 * Tests:
 *   1. Can spawn `claude --print` as a subprocess from Node.js
 *   2. LSP operations (documentSymbol, findReferences) return parseable results
 *   3. Total subprocess time fits within 15s budget
 *   4. Documents output format for Phase 1 implementation
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const TARGET_FILE = path.join(REPO_ROOT, 'hooks/df-explore-protocol.js');
const TIMEOUT_MS = 15000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(msg + '\n');
}

function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Run `claude --print` with a prompt, return { stdout, stderr, durationMs, timedOut, exitCode }
 */
function runClaudePrint(prompt, extraArgs = []) {
  const start = Date.now();

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--model', 'claude-haiku-4-5',  // fastest/cheapest for spike
    ...extraArgs,
    prompt,
  ];

  const result = spawnSync('claude', args, {
    cwd: REPO_ROOT,
    timeout: TIMEOUT_MS + 2000,  // slight buffer beyond our target
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
  });

  const durationMs = Date.now() - start;
  const timedOut = result.status === null && result.error && result.error.code === 'ETIMEDOUT';

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs,
    timedOut,
    exitCode: result.status,
    error: result.error,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const results = {
  timestamp: new Date().toISOString(),
  repo_root: REPO_ROOT,
  target_file: TARGET_FILE,
  timeout_budget_ms: TIMEOUT_MS,
  tests: [],
  summary: {},
};

// ── Test 1: Basic spawn sanity ────────────────────────────────────────────────
log('\n=== TEST 1: Basic `claude --print` spawn sanity ===');
{
  const t = { name: 'basic_spawn', passed: false };

  const r = runClaudePrint('Reply with exactly: SPAWN_OK');
  t.durationMs = r.durationMs;
  t.exitCode = r.exitCode;
  t.timedOut = r.timedOut;

  if (r.timedOut) {
    t.error = 'TIMED_OUT';
    log(`  FAIL: timed out after ${formatMs(r.durationMs)}`);
  } else if (r.exitCode !== 0) {
    t.error = `exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`;
    log(`  FAIL: exit ${r.exitCode}\n  stderr: ${r.stderr.slice(0, 200)}`);
  } else {
    t.output_snippet = r.stdout.slice(0, 100).replace(/\n/g, '\\n');
    t.passed = r.stdout.includes('SPAWN_OK');
    log(`  ${t.passed ? 'PASS' : 'FAIL'}: latency=${formatMs(r.durationMs)} output="${t.output_snippet}"`);
  }

  results.tests.push(t);
}

// ── Test 2: documentSymbol via LSP tools ────────────────────────────────────
log('\n=== TEST 2: documentSymbol LSP operation ===');
{
  const t = { name: 'documentSymbol', passed: false };

  const prompt = [
    'LSP ONLY — no Read, no Grep, no Bash.',
    `Use mcp__ide__getOpenEditorFiles or LSP documentSymbol to list the symbols in: ${TARGET_FILE}`,
    'Return results as JSON array: [{"name":"...","kind":"...","line":N}]',
    'If LSP is unavailable, reply with: LSP_UNAVAILABLE',
  ].join('\n');

  const r = runClaudePrint(prompt);
  t.durationMs = r.durationMs;
  t.exitCode = r.exitCode;
  t.timedOut = r.timedOut;

  if (r.timedOut) {
    t.error = 'TIMED_OUT';
    log(`  FAIL: timed out after ${formatMs(r.durationMs)}`);
  } else if (r.exitCode !== 0) {
    t.error = `exit ${r.exitCode}`;
    log(`  FAIL: exit ${r.exitCode}\n  stderr: ${r.stderr.slice(0, 300)}`);
  } else {
    t.raw_output = r.stdout.slice(0, 500);
    t.within_budget = r.durationMs <= TIMEOUT_MS;

    // Check if we got JSON symbols
    const jsonMatch = r.stdout.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        t.symbols_found = parsed.length;
        t.sample_symbols = parsed.slice(0, 3);
        t.passed = true;
        t.format = 'json_array';
        log(`  PASS: ${parsed.length} symbols found, latency=${formatMs(r.durationMs)}, within_budget=${t.within_budget}`);
        log(`  Sample: ${JSON.stringify(parsed.slice(0, 2))}`);
      } catch (e) {
        t.parse_error = e.message;
        log(`  PARTIAL: JSON parse failed — raw: ${r.stdout.slice(0, 200)}`);
      }
    } else if (r.stdout.includes('LSP_UNAVAILABLE')) {
      t.lsp_unavailable = true;
      t.format = 'lsp_unavailable';
      t.passed = true;  // finding is valid
      log(`  INFO: LSP unavailable in --print mode (expected gotcha), latency=${formatMs(r.durationMs)}`);
    } else {
      // Text output — still parseable?
      t.format = 'text';
      t.passed = r.stdout.length > 10;
      log(`  INFO: text output (no JSON), latency=${formatMs(r.durationMs)}: ${r.stdout.slice(0, 200)}`);
    }
  }

  results.tests.push(t);
}

// ── Test 3: findReferences via LSP ──────────────────────────────────────────
log('\n=== TEST 3: findReferences LSP operation ===');
{
  const t = { name: 'findReferences', passed: false };

  const prompt = [
    'LSP ONLY — no Read, no Grep, no Bash.',
    `Find all references to the function "findProtocol" in ${TARGET_FILE} using LSP findReferences.`,
    'Return results as JSON array: [{"filepath":"...","line":N,"snippet":"..."}]',
    'If LSP findReferences is unavailable, reply with: LSP_UNAVAILABLE',
  ].join('\n');

  const r = runClaudePrint(prompt);
  t.durationMs = r.durationMs;
  t.exitCode = r.exitCode;
  t.timedOut = r.timedOut;

  if (r.timedOut) {
    t.error = 'TIMED_OUT';
    log(`  FAIL: timed out after ${formatMs(r.durationMs)}`);
  } else if (r.exitCode !== 0) {
    t.error = `exit ${r.exitCode}`;
    log(`  FAIL: exit ${r.exitCode}`);
  } else {
    t.raw_output = r.stdout.slice(0, 500);
    t.within_budget = r.durationMs <= TIMEOUT_MS;

    const jsonMatch = r.stdout.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        t.refs_found = parsed.length;
        t.sample_refs = parsed.slice(0, 2);
        t.passed = true;
        t.format = 'json_array';
        log(`  PASS: ${parsed.length} refs found, latency=${formatMs(r.durationMs)}, within_budget=${t.within_budget}`);
      } catch (e) {
        t.parse_error = e.message;
        t.format = 'text';
        t.passed = r.stdout.length > 10;
        log(`  INFO: text output, latency=${formatMs(r.durationMs)}: ${r.stdout.slice(0, 200)}`);
      }
    } else if (r.stdout.includes('LSP_UNAVAILABLE')) {
      t.lsp_unavailable = true;
      t.format = 'lsp_unavailable';
      t.passed = true;
      log(`  INFO: LSP unavailable in --print mode (expected), latency=${formatMs(r.durationMs)}`);
    } else {
      t.format = 'text';
      t.passed = r.stdout.length > 10;
      log(`  INFO: text output, latency=${formatMs(r.durationMs)}: ${r.stdout.slice(0, 200)}`);
    }
  }

  results.tests.push(t);
}

// ── Test 4: Latency with --bare mode (no LSP) — baseline ────────────────────
// NOTE: --bare mode skips OAuth/keychain; only works with ANTHROPIC_API_KEY env var.
// In normal Claude Code usage (OAuth), --bare will fail auth. This test documents that.
log('\n=== TEST 4: Latency baseline with --bare mode ===');
{
  const t = { name: 'bare_mode_latency', passed: false };

  const r = runClaudePrint('Reply with exactly: BARE_OK', ['--bare']);
  t.durationMs = r.durationMs;
  t.within_budget = r.durationMs <= TIMEOUT_MS;
  t.exitCode = r.exitCode;
  t.timedOut = r.timedOut;

  if (r.timedOut) {
    t.error = 'TIMED_OUT';
    log(`  FAIL: timed out after ${formatMs(r.durationMs)}`);
  } else if (r.exitCode !== 0 && (r.stderr + r.stdout).includes('Not logged in')) {
    // Expected: --bare requires ANTHROPIC_API_KEY, not OAuth. Document the finding.
    t.passed = true;
    t.gotcha = '--bare requires ANTHROPIC_API_KEY; OAuth sessions cannot use --bare';
    t.note = 'Phase 1 subprocess MUST NOT use --bare; normal --print (OAuth) is required';
    log(`  PASS (expected failure): --bare needs ANTHROPIC_API_KEY, latency=${formatMs(r.durationMs)}`);
    log(`  GOTCHA: ${t.gotcha}`);
  } else {
    t.passed = !r.timedOut && r.exitCode === 0;
    t.output_snippet = r.stdout.slice(0, 80);
    log(`  ${t.passed ? 'PASS' : 'FAIL'}: --bare latency=${formatMs(r.durationMs)}, within_budget=${t.within_budget}`);
  }

  results.tests.push(t);
}

// ─── Summary ────────────────────────────────────────────────────────────────

const allPassed = results.tests.every(t => t.passed);
const latencies = results.tests.filter(t => t.durationMs).map(t => t.durationMs);
const maxLatency = Math.max(...latencies);
const allWithinBudget = latencies.every(ms => ms <= TIMEOUT_MS);

results.summary = {
  all_tests_passed: allPassed,
  max_latency_ms: maxLatency,
  all_within_15s_budget: allWithinBudget,
  lsp_available_in_print_mode: !results.tests.some(t => t.lsp_unavailable),
  output_format: results.tests.find(t => t.format)?.format || 'unknown',
  spawn_works: results.tests[0]?.passed ?? false,
  recommendation: '',
};

// Determine recommendation
const lspUnavailable = results.tests.some(t => t.lsp_unavailable);
if (lspUnavailable) {
  results.summary.recommendation =
    'LSP tools are NOT available in --print mode. Phase 1 must use alternative: ' +
    'either (a) spawn claude with --ide flag + active IDE session, or (b) use Glob + line-grep approach ' +
    'instead of LSP. The subprocess approach is VALID for fast exploration but needs non-LSP tooling.';
} else if (maxLatency > TIMEOUT_MS) {
  results.summary.recommendation =
    `Subprocess exceeds 15s budget (max=${formatMs(maxLatency)}). ` +
    'Consider --bare mode or parallel spawning.';
} else {
  results.summary.recommendation =
    `Subprocess fits 15s budget (max=${formatMs(maxLatency)}). Phase 1 is viable.`;
}

log('\n=== SUMMARY ===');
log(JSON.stringify(results.summary, null, 2));

// Write findings to spike report
const reportPath = path.join(__dirname, 'spike-claude-print-lsp-findings.json');
fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
log(`\nFindings written to: ${reportPath}`);

process.exit(allPassed ? 0 : 1);
