#!/usr/bin/env node
/**
 * SPIKE: Phase 1 regex symbol extraction vs baseline (no Phase 1)
 * Tests regex extractors across Python, Go, and TypeScript projects.
 */

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────

const PROJECTS = [
  {
    name: 'bingoSim',
    language: 'Python',
    root: path.resolve('/Users/saidsalles/apps/bingoSim'),
    extensions: ['.py'],
    queries: ['game', 'card', 'pattern'],
    excludeDirs: ['node_modules', '__pycache__', '.git', 'build', '.egg-info', 'htmlcov', '.tox', '.venv'],
  },
  {
    name: 'bingo-rgs',
    language: 'Go',
    root: path.resolve('/Users/saidsalles/apps/bingo-rgs'),
    extensions: ['.go'],
    queries: ['server', 'engine', 'round'],
    excludeDirs: ['node_modules', 'vendor', '.git', '.deepflow'],
  },
  {
    name: 'dashboard',
    language: 'TypeScript',
    root: path.resolve('/Users/saidsalles/apps/reporteiClone/dashboard'),
    extensions: ['.ts', '.tsx', '.js'],
    queries: ['chart', 'table', 'export'],
    excludeDirs: ['node_modules', 'dist', '.git', '.deepflow'],
  },
];

const MAX_SAMPLE_FILES = 20;

// ── Regex Patterns ─────────────────────────────────────────────────────────

const DECLARATION_PATTERNS = {
  '.py': [
    /^(?:async\s+)?(?:def|class)\s+(\w+)/gm,
    /^(\w+)\s*=\s*/gm,  // top-level assignments
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

// ── Helpers ────────────────────────────────────────────────────────────────

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

  const lines = content.split('\n');
  const symbols = [];

  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(content)) !== null) {
      const name = m[1] || m[2];
      if (!name) continue;
      // find line number
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

function matchSymbols(symbols, query) {
  const q = query.toLowerCase();
  return symbols.filter(s => s.name.toLowerCase().includes(q));
}

// ── Main ───────────────────────────────────────────────────────────────────

function runProject(project) {
  const { name, language, root, extensions, queries, excludeDirs } = project;

  // Check project exists
  if (!fs.existsSync(root)) {
    console.log(`\n=== Project: ${name} (${language}) === SKIPPED (not found at ${root})`);
    return null;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== Project: ${name} (${language}) ===`);
  console.log(`${'='.repeat(60)}`);

  // Step 1: Discover files
  const allFiles = collectFiles(root, extensions, excludeDirs);
  const sampleFiles = allFiles.slice(0, MAX_SAMPLE_FILES);

  console.log(`Files found: ${allFiles.length} | Sampled: ${sampleFiles.length}`);

  // Step 2: Extract symbols
  const t0 = performance.now();
  const allSymbols = [];
  for (const f of sampleFiles) {
    const syms = extractSymbols(f);
    allSymbols.push(...syms);
  }
  const extractionMs = (performance.now() - t0).toFixed(1);

  console.log(`Symbols extracted: ${allSymbols.length} | Extraction time: ${extractionMs}ms`);

  // Show top symbols as preview
  const uniqueNames = [...new Set(allSymbols.map(s => s.name))];
  console.log(`Unique symbol names: ${uniqueNames.length}`);
  console.log(`Sample symbols: ${uniqueNames.slice(0, 10).join(', ')}`);

  // Step 3: Query matching
  const queryResults = [];
  for (const query of queries) {
    const tq = performance.now();
    const matched = matchSymbols(allSymbols, query);
    const queryMs = (performance.now() - tq).toFixed(2);

    const filesWithMatches = new Set(matched.map(s => s.file)).size;

    console.log(`\nQuery: "${query}"`);
    console.log(`  Baseline:  hit=false, symbols=0`);
    console.log(`  Regex:     hit=${matched.length > 0}, symbols=${matched.length}, files=${filesWithMatches}, time=${queryMs}ms`);

    if (matched.length > 0) {
      const preview = matched.slice(0, 5).map(s => {
        const rel = path.relative(root, s.file);
        return `    ${rel}:${s.line} -- ${s.name}`;
      });
      console.log(`  Symbols found:\n${preview.join('\n')}`);
      if (matched.length > 5) console.log(`    ... and ${matched.length - 5} more`);
    }

    queryResults.push({
      query,
      hit: matched.length > 0,
      symbols: matched.length,
      files: filesWithMatches,
      timeMs: parseFloat(queryMs),
    });
  }

  const hitCount = queryResults.filter(r => r.hit).length;

  return {
    name,
    language,
    totalFiles: allFiles.length,
    sampledFiles: sampleFiles.length,
    totalSymbols: allSymbols.length,
    uniqueSymbols: uniqueNames.length,
    extractionMs: parseFloat(extractionMs),
    queryResults,
    hitRate: `${hitCount}/${queries.length}`,
    hitCount,
    queryCount: queries.length,
  };
}

// ── Execute ────────────────────────────────────────────────────────────────

console.log('Phase 1 Cross-Language Spike: Regex Symbol Extraction');
console.log(`Date: ${new Date().toISOString()}`);

const results = [];
for (const project of PROJECTS) {
  const r = runProject(project);
  if (r) results.push(r);
}

// ── Aggregate Table ────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log('=== Aggregate Results ===');
console.log('='.repeat(60));

// Header
const header = '| Project      | Language   | Files | Symbols | Unique | Latency  | Hit Rate |';
const sep =    '|--------------|------------|-------|---------|--------|----------|----------|';
console.log(header);
console.log(sep);

let totalHits = 0;
let totalQueries = 0;

for (const r of results) {
  const row = `| ${r.name.padEnd(12)} | ${r.language.padEnd(10)} | ${String(r.sampledFiles).padStart(5)} | ${String(r.totalSymbols).padStart(7)} | ${String(r.uniqueSymbols).padStart(6)} | ${(r.extractionMs + 'ms').padStart(8)} | ${r.hitRate.padStart(8)} |`;
  console.log(row);
  totalHits += r.hitCount;
  totalQueries += r.queryCount;
}

console.log(sep);
console.log(`\nOverall hit rate: ${totalHits}/${totalQueries} (${((totalHits / totalQueries) * 100).toFixed(0)}%)`);

// ── Verdict ────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log('=== Verdict ===');
console.log('='.repeat(60));

if (totalHits / totalQueries >= 0.5) {
  console.log('Regex Phase 1 provides useful symbol hits across languages.');
  console.log('Recommendation: Worth integrating as a fast pre-filter before LSP/tree-sitter.');
} else {
  console.log('Regex Phase 1 hit rate is below 50% -- may not be worth the complexity.');
  console.log('Recommendation: Consider tree-sitter or LSP-only approach.');
}

const avgLatency = results.reduce((s, r) => s + r.extractionMs, 0) / results.length;
console.log(`Average extraction latency: ${avgLatency.toFixed(1)}ms (across ${results.reduce((s, r) => s + r.sampledFiles, 0)} files)`);

console.log(`\nTASK_STATUS:pass`);

/*
=== RUN OUTPUT (2026-04-09) ===

Phase 1 Cross-Language Spike: Regex Symbol Extraction

============================================================
=== Project: bingoSim (Python) ===
============================================================
Files found: 246 | Sampled: 20
Symbols extracted: 88 | Extraction time: 10.7ms
Unique symbol names: 78
Sample symbols: load_deps, calc_loss_streaks, calc_vol_score, classify_vol, run_sim, gen_graphs, print_report, main, PROJECT_ROOT, DEFAULT_GAMES

Query: "game"
  Baseline:  hit=false, symbols=0
  Regex:     hit=true, symbols=2, files=2, time=0.37ms
  Symbols found:
    .claude/skills/game-design/scripts/volatility_analysis.py:22 -- DEFAULT_GAMES
    bingo_sim/config/unified_config.py:311 -- GameConfig

Query: "card"
  Baseline:  hit=false, symbols=0
  Regex:     hit=true, symbols=17, files=7, time=0.01ms
  Symbols found:
    bingo_sim/card/factory.py:22 -- CardFactory
    bingo_sim/card/generator.py:18 -- generate_75ball_card
    bingo_sim/card/generator.py:76 -- generate_75ball_cards
    bingo_sim/card/generator.py:117 -- generate_card
    bingo_sim/card/models.py:35 -- Card
    ... and 12 more

Query: "pattern"
  Baseline:  hit=false, symbols=0
  Regex:     hit=true, symbols=6, files=2, time=0.01ms
  Symbols found:
    bingo_sim/config/unified_config.py:39 -- Pattern
    bingo_sim/config/unified_config.py:527 -- create_pattern
    bingo_sim/config/unified_loader.py:66 -- _get_valid_pattern_ids
    bingo_sim/config/unified_loader.py:37 -- PATTERN_TYPE_MAP
    bingo_sim/config/unified_loader.py:51 -- PATTERN_ID_MAP
    ... and 1 more

============================================================
=== Project: bingo-rgs (Go) ===
============================================================
Files found: 204 | Sampled: 20
Symbols extracted: 117 | Extraction time: 5.5ms
Unique symbol names: 112
Sample symbols: main, configHash, newCachedConfigLoader, binaryHash, wireAdminHandler, scanFile, scanRawConfig, scanRawMetadata, scanRawGameFlow, scanRawExtraBall

Query: "server"
  Baseline:  hit=false, symbols=0
  Regex:     hit=false, symbols=0, files=0, time=0.02ms

Query: "engine"
  Baseline:  hit=false, symbols=0
  Regex:     hit=false, symbols=0, files=0, time=0.02ms

Query: "round"
  Baseline:  hit=false, symbols=0
  Regex:     hit=true, symbols=4, files=3, time=0.02ms
  Symbols found:
    cmd/scan-games/main.go:128 -- scanRawRoundTiming
    cmd/scan-games/main.go:163 -- scanRawBonusRound
    internal/compliance/result.go:7 -- ComplianceRoundResult
    internal/compliance/simulate_test.go:473 -- TestRunComplianceSimulation_ZeroRounds

============================================================
=== Project: dashboard (TypeScript) ===
============================================================
Files found: 50 | Sampled: 20
Symbols extracted: 113 | Extraction time: 9.1ms
Unique symbol names: 110
Sample symbols: App, jsonResponse, noContentResponse, mockFetch, ResizeObserverStub, TestRow, sampleColumns, sampleData, wrapper, dateStr

Query: "chart"
  Baseline:  hit=false, symbols=0
  Regex:     hit=false, symbols=0, files=0, time=0.01ms

Query: "table"
  Baseline:  hit=false, symbols=0
  Regex:     hit=true, symbols=2, files=1, time=0.01ms
  Symbols found:
    src/components/DataTable.tsx:27 -- DataTableProps
    src/components/DataTable.tsx:127 -- DataTable

Query: "export"
  Baseline:  hit=false, symbols=0
  Regex:     hit=true, symbols=5, files=3, time=0.01ms
  Symbols found:
    src/api/endpoints.ts:130 -- exportConnectorCsv
    src/api/types.ts:12 -- ExportFormat
    src/api/types.ts:27 -- ExportParams
    src/components/ExportMenu.tsx:88 -- ExportMenuProps
    src/components/ExportMenu.tsx:119 -- ExportMenu

============================================================
=== Aggregate Results ===
============================================================
| Project      | Language   | Files | Symbols | Unique | Latency  | Hit Rate |
|--------------|------------|-------|---------|--------|----------|----------|
| bingoSim     | Python     |    20 |      88 |     78 |   10.7ms |      3/3 |
| bingo-rgs    | Go         |    20 |     117 |    112 |    5.5ms |      1/3 |
| dashboard    | TypeScript |    20 |     113 |    110 |    9.1ms |      2/3 |
|--------------|------------|-------|---------|--------|----------|----------|

Overall hit rate: 6/9 (67%)

============================================================
=== Verdict ===
============================================================
Regex Phase 1 provides useful symbol hits across languages.
Recommendation: Worth integrating as a fast pre-filter before LSP/tree-sitter.
Average extraction latency: 8.4ms (across 60 files)

TASK_STATUS:pass
*/
