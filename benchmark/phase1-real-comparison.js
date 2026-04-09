#!/usr/bin/env node
/**
 * SPIKE: Measure REAL tool calls and tokens comparing Explore agent
 * WITH vs WITHOUT regex Phase 1 symbol injection.
 *
 * Runs 6 claude --print sessions (3 queries x 2 modes) and compares
 * tool_calls, tokens, and wall_time.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Regex extraction (reused from phase1-no-limit-spike.js) ──────────────

const DECLARATION_PATTERNS = {
  '.py': [
    /^(?:async\s+)?(?:def|class)\s+(\w+)/gm,
    /^(\w+)\s*=\s*/gm,
  ],
  '.go': [
    /^func(?:\s*\([^)]*\))?\s+(\w+)/gm,
    /^type\s+(\w+)\s+(?:struct|interface|func)/gm,
    /^var\s+(\w+)\s/gm,
    /^const\s+(\w+)\s/gm,
  ],
  '.ts': [
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+(\w+)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/gm,
  ],
};
DECLARATION_PATTERNS['.tsx'] = DECLARATION_PATTERNS['.ts'];
DECLARATION_PATTERNS['.js'] = DECLARATION_PATTERNS['.ts'];
DECLARATION_PATTERNS['.jsx'] = DECLARATION_PATTERNS['.ts'];

function collectFiles(dir, extensions, excludeDirs) {
  const results = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (excludeDirs.includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); }
      else if (extensions.some(ext => e.name.endsWith(ext))) { results.push(full); }
    }
  }
  walk(dir);
  return results;
}

function extractSymbols(filePath) {
  const ext = path.extname(filePath);
  const patterns = DECLARATION_PATTERNS[ext];
  if (!patterns) return [];
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const symbols = [];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(content)) !== null) {
      const name = m[1] || m[2];
      if (!name) continue;
      const offset = m.index;
      let lineNo = 1;
      for (let i = 0; i < offset && i < content.length; i++) {
        if (content[i] === '\n') lineNo++;
      }
      symbols.push({ name, file: filePath, line: lineNo });
    }
  }
  return symbols;
}

function matchSymbols(symbols, queryWords) {
  return symbols.filter(s => {
    const lower = s.name.toLowerCase();
    return queryWords.some(w => lower.includes(w));
  });
}

// ── Configuration ────────────────────────────────────────────────────────

const EXCLUDE_DIRS = ['node_modules', '__pycache__', '.git', 'build', '.egg-info',
  'htmlcov', '.tox', '.venv', 'dist', '.next', 'vendor', '.deepflow'];

const PROJECTS = [
  {
    name: 'bingoSim',
    language: 'Python',
    root: '/Users/saidsalles/apps/bingoSim',
    extensions: ['.py'],
    query: 'how does the prize calculation work',
    queryWords: ['prize', 'calculation', 'calculate', 'calc'],
  },
  {
    name: 'bingo-rgs',
    language: 'Go',
    root: '/Users/saidsalles/apps/bingo-rgs',
    extensions: ['.go'],
    query: 'how does the game engine handle draws',
    queryWords: ['engine', 'draw', 'game', 'handle'],
  },
  {
    name: 'dashboard',
    language: 'TypeScript',
    root: '/Users/saidsalles/apps/reporteiClone/dashboard',
    extensions: ['.ts', '.tsx', '.js'],
    query: 'how does the page routing work',
    queryWords: ['page', 'route', 'routing', 'router'],
  },
];

const MAX_BUDGET_USD = 1.50;  // per session — generous to avoid early cutoff
const TIMEOUT_MS = 300000;    // 5 min per session

// ── Phase 1 symbol block generator ──────────────────────────────────────

function generatePhase1Block(project) {
  const files = collectFiles(project.root, project.extensions, EXCLUDE_DIRS);
  const allSymbols = [];
  for (const f of files) {
    allSymbols.push(...extractSymbols(f));
  }
  const matched = matchSymbols(allSymbols, project.queryWords);

  if (matched.length === 0) return { block: '', symbolCount: 0 };

  const lines = matched.map(s => {
    const rel = path.relative(project.root, s.file);
    return `${rel}:${s.line} -- ${s.name}`;
  });

  // Determine kind from patterns
  const block = `## [LSP Phase -- locations found]\n${lines.join('\n')}\n\nRead ONLY these ranges. Focus on the symbols listed above.`;
  return { block, symbolCount: matched.length };
}

// ── Run a single claude session ─────────────────────────────────────────

function runSession(projectRoot, prompt, label) {
  console.log(`\n  Running: ${label}...`);
  const startTime = Date.now();

  let output;
  try {
    // Use --output-format json to get structured data with token/tool metrics
    // Pipe prompt via stdin to avoid shell escaping issues with long prompts
    // Run from a temp dir to avoid loading deepflow's CLAUDE.md/hooks
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'df-bench-'));
    const result = spawnSync('claude', [
      '--print', '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--max-budget-usd', String(MAX_BUDGET_USD),
      '--add-dir', projectRoot,
    ], {
      input: prompt,
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      cwd: tmpDir,
    });
    try { fs.rmdirSync(tmpDir); } catch {}
    output = result.stdout || '';
    if (result.error) {
      console.log(`    ERROR: Session failed - ${result.error.message?.slice(0, 100)}`);
      if (!output) return null;
    }
    if (result.status !== 0 && !output) {
      console.log(`    ERROR: Exit code ${result.status} - ${(result.stderr || '').slice(0, 200)}`);
      return null;
    }
  } catch (err) {
    console.log(`    ERROR: Session failed - ${err.message?.slice(0, 100)}`);
    return null;
  }
  const wallTime = Date.now() - startTime;

  // Parse JSON output
  let events;
  try {
    events = JSON.parse(output);
  } catch {
    // Sometimes output is NDJSON lines
    try {
      events = output.trim().split('\n').map(line => JSON.parse(line));
    } catch {
      console.log(`    ERROR: Could not parse output`);
      return null;
    }
  }

  // Count tool calls by type
  const toolCalls = { Read: 0, Grep: 0, Glob: 0, Bash: 0, other: 0, total: 0 };
  for (const evt of events) {
    if (evt.type === 'assistant') {
      const content = evt.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          toolCalls.total++;
          const name = block.name;
          if (name in toolCalls) toolCalls[name]++;
          else toolCalls.other++;
        }
      }
    }
  }

  // Get token usage from result event
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, cost: 0 };
  let numTurns = 0;
  let durationMs = 0;
  for (const evt of events) {
    if (evt.type === 'result') {
      const mu = evt.modelUsage || {};
      for (const model of Object.values(mu)) {
        tokens.input += model.inputTokens || 0;
        tokens.output += model.outputTokens || 0;
        tokens.cacheRead += model.cacheReadInputTokens || 0;
        tokens.cacheCreation += model.cacheCreationInputTokens || 0;
        tokens.cost += model.costUSD || 0;
      }
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
      numTurns = evt.num_turns || 0;
      durationMs = evt.duration_ms || 0;
    }
  }

  return { toolCalls, tokens, numTurns, wallTime, durationMs };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 1 Real Comparison: Baseline vs Regex Symbol Injection');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Budget per session: $${MAX_BUDGET_USD}`);
  console.log(`Timeout per session: ${TIMEOUT_MS / 1000}s`);

  const results = [];

  for (const project of PROJECTS) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`=== Query ${results.length + 1}: ${project.name} (${project.language}) — "${project.query}" ===`);

    // Generate Phase 1 block
    const { block: phase1Block, symbolCount } = generatePhase1Block(project);
    console.log(`  Phase 1 symbols found: ${symbolCount}`);

    // Baseline prompt (no Phase 1)
    const baselinePrompt = `Working directory: ${project.root}. ${project.query}`;

    // Phase 1 prompt (with symbol injection)
    const phase1Prompt = `Working directory: ${project.root}.\n\n${phase1Block}\n\n${project.query}`;

    // Run baseline
    const baseline = runSession(project.root, baselinePrompt, 'BASELINE (no Phase 1)');

    // Small delay between sessions
    await new Promise(r => setTimeout(r, 2000));

    // Run with Phase 1
    const withPhase1 = runSession(project.root, phase1Prompt, 'WITH PHASE 1 (regex symbols)');

    results.push({ project, baseline, withPhase1, symbolCount });
  }

  // ── Output Results ──────────────────────────────────────────────────

  console.log(`\n${'='.repeat(70)}`);
  console.log('=== DETAILED RESULTS ===');

  for (const r of results) {
    const { project, baseline, withPhase1, symbolCount } = r;
    console.log(`\n=== Query: ${project.name} (${project.language}) — "${project.query}" ===`);
    console.log(`  Phase 1 symbols injected: ${symbolCount}`);

    if (baseline) {
      const tc = baseline.toolCalls;
      console.log(`\n  BASELINE (no Phase 1):`);
      console.log(`    tool_calls: ${tc.total} (Read: ${tc.Read}, Grep: ${tc.Grep}, Glob: ${tc.Glob}, Bash: ${tc.Bash}, other: ${tc.other})`);
      console.log(`    wall_time: ${(baseline.wallTime / 1000).toFixed(1)}s`);
      console.log(`    turns: ${baseline.numTurns}`);
      console.log(`    tokens: ${baseline.tokens.total} (input: ${baseline.tokens.input}, output: ${baseline.tokens.output}, cache_read: ${baseline.tokens.cacheRead}, cache_create: ${baseline.tokens.cacheCreation})`);
      console.log(`    cost: $${baseline.tokens.cost.toFixed(4)}`);
    } else {
      console.log(`\n  BASELINE: FAILED`);
    }

    if (withPhase1) {
      const tc = withPhase1.toolCalls;
      console.log(`\n  WITH PHASE 1 (regex symbols injected):`);
      console.log(`    tool_calls: ${tc.total} (Read: ${tc.Read}, Grep: ${tc.Grep}, Glob: ${tc.Glob}, Bash: ${tc.Bash}, other: ${tc.other})`);
      console.log(`    wall_time: ${(withPhase1.wallTime / 1000).toFixed(1)}s`);
      console.log(`    turns: ${withPhase1.numTurns}`);
      console.log(`    tokens: ${withPhase1.tokens.total} (input: ${withPhase1.tokens.input}, output: ${withPhase1.tokens.output}, cache_read: ${withPhase1.tokens.cacheRead}, cache_create: ${withPhase1.tokens.cacheCreation})`);
      console.log(`    cost: $${withPhase1.tokens.cost.toFixed(4)}`);
    } else {
      console.log(`\n  WITH PHASE 1: FAILED`);
    }

    if (baseline && withPhase1) {
      const dtc = withPhase1.toolCalls.total - baseline.toolCalls.total;
      const dtcPct = baseline.toolCalls.total > 0
        ? ((dtc / baseline.toolCalls.total) * 100).toFixed(0)
        : 'N/A';
      const dtok = withPhase1.tokens.total - baseline.tokens.total;
      const dtokPct = baseline.tokens.total > 0
        ? ((dtok / baseline.tokens.total) * 100).toFixed(0)
        : 'N/A';
      const dwt = withPhase1.wallTime - baseline.wallTime;
      const dwtPct = baseline.wallTime > 0
        ? ((dwt / baseline.wallTime) * 100).toFixed(0)
        : 'N/A';
      const dcost = withPhase1.tokens.cost - baseline.tokens.cost;

      console.log(`\n  DELTA:`);
      console.log(`    tool_calls: ${dtc >= 0 ? '+' : ''}${dtc} (${dtcPct}%)`);
      console.log(`    tokens: ${dtok >= 0 ? '+' : ''}${dtok} (${dtokPct}%)`);
      console.log(`    wall_time: ${dwt >= 0 ? '+' : ''}${(dwt / 1000).toFixed(1)}s (${dwtPct}%)`);
      console.log(`    cost: ${dcost >= 0 ? '+' : ''}$${dcost.toFixed(4)}`);
    }
  }

  // ── Aggregate Table ─────────────────────────────────────────────────

  const validResults = results.filter(r => r.baseline && r.withPhase1);

  if (validResults.length > 0) {
    console.log(`\n${'='.repeat(70)}`);
    console.log('=== AGGREGATE ===');
    console.log(`Valid comparisons: ${validResults.length}/${results.length}`);

    const avgBaseline = {
      toolCalls: validResults.reduce((s, r) => s + r.baseline.toolCalls.total, 0) / validResults.length,
      tokens: validResults.reduce((s, r) => s + r.baseline.tokens.total, 0) / validResults.length,
      wallTime: validResults.reduce((s, r) => s + r.baseline.wallTime, 0) / validResults.length,
      cost: validResults.reduce((s, r) => s + r.baseline.tokens.cost, 0) / validResults.length,
    };
    const avgPhase1 = {
      toolCalls: validResults.reduce((s, r) => s + r.withPhase1.toolCalls.total, 0) / validResults.length,
      tokens: validResults.reduce((s, r) => s + r.withPhase1.tokens.total, 0) / validResults.length,
      wallTime: validResults.reduce((s, r) => s + r.withPhase1.wallTime, 0) / validResults.length,
      cost: validResults.reduce((s, r) => s + r.withPhase1.tokens.cost, 0) / validResults.length,
    };

    const fmtDelta = (base, phase1) => {
      const d = phase1 - base;
      const pct = base > 0 ? ((d / base) * 100).toFixed(0) : 'N/A';
      return { delta: d, pct };
    };

    const tcD = fmtDelta(avgBaseline.toolCalls, avgPhase1.toolCalls);
    const tokD = fmtDelta(avgBaseline.tokens, avgPhase1.tokens);
    const wtD = fmtDelta(avgBaseline.wallTime, avgPhase1.wallTime);
    const costD = fmtDelta(avgBaseline.cost, avgPhase1.cost);

    console.log('');
    console.log('| Metric     | Baseline Avg | Phase 1 Avg | Delta    | % Change |');
    console.log('|------------|-------------|-------------|----------|----------|');
    console.log(`| tool_calls | ${avgBaseline.toolCalls.toFixed(1).padStart(11)} | ${avgPhase1.toolCalls.toFixed(1).padStart(11)} | ${(tcD.delta >= 0 ? '+' : '') + tcD.delta.toFixed(1)} | ${tcD.pct}% |`);
    console.log(`| tokens     | ${avgBaseline.tokens.toFixed(0).padStart(11)} | ${avgPhase1.tokens.toFixed(0).padStart(11)} | ${(tokD.delta >= 0 ? '+' : '') + tokD.delta.toFixed(0)} | ${tokD.pct}% |`);
    console.log(`| wall_time  | ${(avgBaseline.wallTime / 1000).toFixed(1).padStart(10)}s | ${(avgPhase1.wallTime / 1000).toFixed(1).padStart(10)}s | ${(wtD.delta >= 0 ? '+' : '') + (wtD.delta / 1000).toFixed(1)}s | ${wtD.pct}% |`);
    console.log(`| cost       | $${avgBaseline.cost.toFixed(4).padStart(9)} | $${avgPhase1.cost.toFixed(4).padStart(9)} | ${(costD.delta >= 0 ? '+' : '') + '$' + costD.delta.toFixed(4)} | ${costD.pct}% |`);

    // Total cost
    const totalCost = results.reduce((s, r) => {
      return s + (r.baseline?.tokens.cost || 0) + (r.withPhase1?.tokens.cost || 0);
    }, 0);
    console.log(`\nTotal cost for all sessions: $${totalCost.toFixed(4)}`);
  }

  console.log(`\nTASK_STATUS:${validResults.length >= 2 ? 'pass' : 'fail'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  console.log('TASK_STATUS:fail');
  process.exit(1);
});

/*
=== RUN OUTPUT (2026-04-09) ===

Phase 1 Real Comparison: Baseline vs Regex Symbol Injection
Date: 2026-04-09T11:17:51.024Z
Budget per session: $1.5
Timeout per session: 300s

=== Query: bingoSim (Python) — "how does the prize calculation work" ===
  Phase 1 symbols injected: 99

  BASELINE (no Phase 1):
    tool_calls: 24 (Read: 11, Grep: 2, Glob: 1, Bash: 9, other: 1)
    wall_time: 54.5s
    turns: 2
    tokens: 396113 (input: 2700, output: 3692, cache_read: 337543, cache_create: 52178)
    cost: $0.1636

  WITH PHASE 1 (regex symbols injected):
    tool_calls: 3 (Read: 3, Grep: 0, Glob: 0, Bash: 0, other: 0)
    wall_time: 22.8s
    turns: 4
    tokens: 37100 (input: 4, output: 810, cache_read: 28062, cache_create: 8224)
    cost: $0.0857

  DELTA:
    tool_calls: -21 (-88%)
    tokens: -359013 (-91%)
    wall_time: -31.6s (-58%)
    cost: $-0.0779

=== Query: bingo-rgs (Go) — "how does the game engine handle draws" ===
  Phase 1 symbols injected: 276

  BASELINE (no Phase 1):
    tool_calls: 30 (Read: 13, Grep: 13, Glob: 2, Bash: 1, other: 1)
    wall_time: 77.8s
    turns: 2
    tokens: 576322 (input: 9052, output: 5109, cache_read: 520503, cache_create: 41658)
    cost: $0.1836

  WITH PHASE 1 (regex symbols injected):
    tool_calls: 13 (Read: 6, Grep: 3, Glob: 1, Bash: 0, other: 3)
    wall_time: 49.9s
    turns: 2
    tokens: 166586 (input: 496, output: 3013, cache_read: 132541, cache_create: 30536)
    cost: $0.1600

  DELTA:
    tool_calls: -17 (-57%)
    tokens: -409736 (-71%)
    wall_time: -27.8s (-36%)
    cost: $-0.0237

=== Query: dashboard (TypeScript) — "how does the page routing work" ===
  Phase 1 symbols injected: 5

  BASELINE (no Phase 1):
    tool_calls: 13 (Read: 6, Grep: 2, Glob: 4, Bash: 0, other: 1)
    wall_time: 34.4s
    turns: 2
    tokens: 164773 (input: 43, output: 1893, cache_read: 145921, cache_create: 16916)
    cost: $0.0806

  WITH PHASE 1 (regex symbols injected):
    tool_calls: 5 (Read: 1, Grep: 1, Glob: 2, Bash: 1, other: 0)
    wall_time: 40.0s
    turns: 6
    tokens: 73266 (input: 7, output: 681, cache_read: 68977, cache_create: 3601)
    cost: $0.0741

  DELTA:
    tool_calls: -8 (-62%)
    tokens: -91507 (-56%)
    wall_time: +5.6s (16%)
    cost: $-0.0066

=== AGGREGATE ===
Valid comparisons: 3/3

| Metric     | Baseline Avg | Phase 1 Avg | Delta    | % Change |
|------------|-------------|-------------|----------|----------|
| tool_calls |        22.3 |         7.0 | -15.3    | -69%     |
| tokens     |      379069 |       92317 | -286752  | -76%     |
| wall_time  |       55.5s |       37.6s | -17.9s   | -32%     |
| cost       | $   0.1426  | $   0.1066  | $-0.0361 | -25%     |

Total cost for all sessions: $0.7476

TASK_STATUS:pass
*/
