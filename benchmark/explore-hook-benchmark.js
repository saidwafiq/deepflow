#!/usr/bin/env node
/**
 * Benchmark: df-explore-protocol.js hook — 5-query spike (T11)
 *
 * Pipes 5 representative queries to the hook via stdin in the PreToolUse
 * JSON format, captures output, and reads explore-metrics.jsonl to compute
 * Phase 1 hit rate.
 *
 * Success: >= 80% (4/5) LSP hit rate.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(REPO_ROOT, 'hooks', 'df-explore-protocol.js');
const METRICS_PATH = path.join(REPO_ROOT, '.deepflow', 'explore-metrics.jsonl');

// ── 5 representative queries ────────────────────────────────────────────────

const QUERIES = [
  {
    id: 'Q1-function',
    prompt: 'How does the readLspTimeout function work in the explore hook?',
    description: 'Explore readLspTimeout function',
  },
  {
    id: 'Q2-file',
    prompt: 'What does df-explore-protocol.js do and what are its main exports?',
    description: 'Explore df-explore-protocol.js',
  },
  {
    id: 'Q3-config',
    prompt: 'How is config.yaml used for deepflow configuration?',
    description: 'Explore config.yaml usage',
  },
  {
    id: 'Q4-architecture',
    prompt: 'How do hooks work in the deepflow codebase?',
    description: 'Explore hook architecture',
  },
  {
    id: 'Q5-concept',
    prompt: 'What is the ratchet pattern and how is it implemented?',
    description: 'Explore ratchet pattern',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(msg + '\n');
}

function clearMetrics() {
  try {
    if (fs.existsSync(METRICS_PATH)) fs.unlinkSync(METRICS_PATH);
  } catch (_) {}
}

function readMetrics() {
  try {
    if (!fs.existsSync(METRICS_PATH)) return [];
    return fs
      .readFileSync(METRICS_PATH, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

/**
 * Invoke the hook by piping JSON to stdin.
 * Returns { stdout, stderr, exitCode, durationMs }
 */
function invokeHook(query) {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      prompt: query.prompt,
      subagent_type: 'Explore',
      description: query.description,
    },
    cwd: REPO_ROOT,
  };

  const start = Date.now();
  const result = spawnSync('node', [HOOK_PATH], {
    cwd: REPO_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60000, // 60s generous timeout for each query
  });
  const durationMs = Date.now() - start;

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
    durationMs,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

log('=== Explore Hook 5-Query Benchmark (T11) ===\n');
log(`Hook: ${HOOK_PATH}`);
log(`Metrics: ${METRICS_PATH}`);
log(`Queries: ${QUERIES.length}\n`);

// Clear previous metrics
clearMetrics();

const queryResults = [];

for (const query of QUERIES) {
  log(`--- ${query.id}: "${query.prompt.slice(0, 60)}..." ---`);
  const r = invokeHook(query);
  log(`  exit=${r.exitCode}  duration=${r.durationMs}ms`);

  let hookOutput = null;
  let phase1Hit = false;

  if (r.stdout.trim()) {
    try {
      hookOutput = JSON.parse(r.stdout.trim());
      const updatedPrompt =
        hookOutput?.hookSpecificOutput?.updatedInput?.prompt || '';
      phase1Hit = updatedPrompt.includes('[LSP Phase -- locations found]');
      log(`  phase1_hit=${phase1Hit}`);
      if (phase1Hit) {
        // Extract location count
        const locMatch = updatedPrompt.match(
          /\[LSP Phase -- locations found\]\n\n([\s\S]*?)\n\nRead ONLY/
        );
        if (locMatch) {
          const lines = locMatch[1].trim().split('\n').length;
          log(`  locations_injected=${lines}`);
        }
      }
    } catch (_) {
      log(`  output: (non-JSON) ${r.stdout.slice(0, 100)}`);
    }
  } else {
    log(`  output: (empty — hook exited silently, likely Phase 1 miss with fallback)`);
  }

  queryResults.push({
    id: query.id,
    prompt: query.prompt,
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    phase1Hit,
    hasOutput: !!r.stdout.trim(),
  });

  log('');
}

// ── Analyze metrics file ────────────────────────────────────────────────────

log('=== Metrics Analysis ===\n');

const metrics = readMetrics();
log(`Metrics entries written: ${metrics.length}`);

// The hook only writes metrics when it produces output (hit or fallback with template).
// Check phase1_hit from metrics
const metricsHits = metrics.filter((m) => m.phase1_hit).length;
const metricsMisses = metrics.filter((m) => !m.phase1_hit).length;
log(`From metrics file: hits=${metricsHits}, misses=${metricsMisses}`);

// From our own observation
const observedHits = queryResults.filter((r) => r.phase1Hit).length;
const observedMisses = queryResults.filter((r) => !r.phase1Hit).length;
const hitRate = queryResults.length > 0
  ? ((observedHits / queryResults.length) * 100).toFixed(0)
  : 0;

log(`\nFrom hook output observation: hits=${observedHits}, misses=${observedMisses}`);
log(`Hit rate: ${hitRate}% (${observedHits}/${queryResults.length})`);
log(`Target: >= 80% (4/5)\n`);

// ── Per-query summary ───────────────────────────────────────────────────────

log('=== Per-Query Results ===\n');
for (const r of queryResults) {
  const status = r.phase1Hit ? 'HIT' : 'MISS';
  log(`  ${r.id}: ${status}  ${r.durationMs}ms  "${r.prompt.slice(0, 50)}..."`);
}

// ── Tool-call expectations ──────────────────────────────────────────────────

log('\n=== Tool-Call Expectations ===\n');
log('When Phase 1 HITS: Explore agent gets LSP locations injected.');
log('  Expected tool calls: ~5-10 (Read targeted ranges only).');
log('When Phase 1 MISSES: Explore agent gets static template only.');
log('  Expected tool calls: ~15-25 (Glob + Grep + Read discovery pattern).');

// ── Verdict ─────────────────────────────────────────────────────────────────

const passed = parseInt(hitRate, 10) >= 80;

log('\n=== VERDICT ===\n');
log(`Hit rate: ${hitRate}% ${passed ? '>=' : '<'} 80% target`);
log(`Result: ${passed ? 'PASS' : 'FAIL'}\n`);

// ── Write summary to benchmark results ──────────────────────────────────────

const summary = {
  timestamp: new Date().toISOString(),
  task: 'T11-spike',
  queries: queryResults,
  metrics_entries: metrics.length,
  observed_hits: observedHits,
  observed_misses: observedMisses,
  hit_rate_pct: parseInt(hitRate, 10),
  target_hit_rate_pct: 80,
  passed,
};

const summaryPath = path.join(__dirname, 'explore-hook-benchmark-results.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
log(`Results written to: ${summaryPath}`);

process.exit(passed ? 0 : 1);
