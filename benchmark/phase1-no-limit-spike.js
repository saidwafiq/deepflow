#!/usr/bin/env node
/**
 * SPIKE: Phase 1 regex extraction with NO file limit on 3 real projects.
 * Re-runs the cross-language regex Phase 1 extraction removing the 20-file cap
 * that caused 3/9 misses in the previous spike. Also adds 2 more queries per project.
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
    queries: ['game', 'card', 'pattern', 'prize', 'ball'],
    excludeDirs: ['node_modules', '__pycache__', '.git', 'build', '.egg-info', 'htmlcov', '.tox', '.venv', 'dist', '.next'],
  },
  {
    name: 'bingo-rgs',
    language: 'Go',
    root: path.resolve('/Users/saidsalles/apps/bingo-rgs'),
    extensions: ['.go'],
    queries: ['server', 'engine', 'round', 'pool', 'merge'],
    excludeDirs: ['node_modules', 'vendor', '.git', '.deepflow', 'dist', '.next', 'build'],
  },
  {
    name: 'dashboard',
    language: 'TypeScript',
    root: path.resolve('/Users/saidsalles/apps/reporteiClone/dashboard'),
    extensions: ['.ts', '.tsx', '.js'],
    queries: ['chart', 'table', 'export', 'page', 'date'],
    excludeDirs: ['node_modules', 'dist', '.git', '.deepflow', '.next', 'build', 'vendor', '__pycache__'],
  },
];

// Previous spike results (20-file limit) for comparison
const PREV_RESULTS = {
  bingoSim: { files: 20, symbols: 88, latencyMs: 10.7, hits: 3, queries: 3 },
  'bingo-rgs': { files: 20, symbols: 117, latencyMs: 5.5, hits: 1, queries: 3 },
  dashboard: { files: 20, symbols: 113, latencyMs: 9.1, hits: 2, queries: 3 },
};

// ── Regex Patterns (same as previous spike) ───────────────────────────────

const DECLARATION_PATTERNS = {
  '.py': [
    /^(?:async\s+)?(?:def|class)\s+(\w+)/gm,
    /^(\w+)\s*=\s*/gm, // top-level assignments
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

function matchSymbols(symbols, query) {
  const q = query.toLowerCase();
  return symbols.filter(s => s.name.toLowerCase().includes(q));
}

// ── Main ───────────────────────────────────────────────────────────────────

function runProject(project) {
  const { name, language, root, extensions, queries, excludeDirs } = project;

  if (!fs.existsSync(root)) {
    console.log(`\n=== Project: ${name} (${language}) === SKIPPED (not found at ${root})`);
    return null;
  }

  console.log(`\n=== Project: ${name} (${language}) ===`);

  // Step 1: Discover ALL files (no limit)
  const allFiles = collectFiles(root, extensions, excludeDirs);
  console.log(`Total source files: ${allFiles.length} (was limited to 20 before)`);

  // Step 2: Extract symbols from ALL files
  const t0 = performance.now();
  const allSymbols = [];
  for (const f of allFiles) {
    const syms = extractSymbols(f);
    allSymbols.push(...syms);
  }
  const extractionMs = (performance.now() - t0).toFixed(1);

  console.log(`Total symbols extracted: ${allSymbols.length}`);
  console.log(`Extraction time: ${extractionMs}ms`);

  // Step 3: Query matching
  const queryResults = [];
  for (const query of queries) {
    const tq = performance.now();
    const matched = matchSymbols(allSymbols, query);
    const queryMs = (performance.now() - tq).toFixed(2);

    const filesWithMatches = new Set(matched.map(s => s.file)).size;

    console.log(`\nQuery: "${query}"`);
    console.log(`  hit=${matched.length > 0}, symbols=${matched.length}, files_with_matches=${filesWithMatches}`);

    if (matched.length > 0) {
      const preview = matched.slice(0, 5).map(s => {
        const rel = path.relative(root, s.file);
        return `  ${rel}:${s.line} -- ${s.name}`;
      });
      console.log(`  Top 5 matches:`);
      console.log(preview.join('\n'));
      if (matched.length > 5) console.log(`  ... and ${matched.length - 5} more`);
    }

    queryResults.push({
      query,
      hit: matched.length > 0,
      symbols: matched.length,
      files: filesWithMatches,
      timeMs: parseFloat(queryMs),
    });
  }

  return {
    name,
    language,
    totalFiles: allFiles.length,
    totalSymbols: allSymbols.length,
    extractionMs: parseFloat(extractionMs),
    queryResults,
    hitCount: queryResults.filter(r => r.hit).length,
    queryCount: queries.length,
  };
}

// ── Execute ────────────────────────────────────────────────────────────────

console.log('Phase 1 No-Limit Spike: Regex Symbol Extraction (ALL files)');
console.log(`Date: ${new Date().toISOString()}`);

const results = [];
for (const project of PROJECTS) {
  const r = runProject(project);
  if (r) results.push(r);
}

// ── Comparison Table ──────────────────────────────────────────────────────

console.log(`\n=== COMPARISON: 20-file limit vs no limit ===`);
console.log('| Project      | Lang       | Files (20) | Files (all) | Symbols (20) | Symbols (all) | Latency (20) | Latency (all) | Hits (20) | Hits (all) |');
console.log('|--------------|------------|------------|-------------|--------------|---------------|--------------|---------------|-----------|------------|');

for (const r of results) {
  const prev = PREV_RESULTS[r.name];
  if (!prev) continue;
  // Hits for the original 3 queries only (for fair comparison)
  const origQueries = r.queryResults.slice(0, 3);
  const origHits = origQueries.filter(q => q.hit).length;
  const row = `| ${r.name.padEnd(12)} | ${r.language.padEnd(10)} | ${String(prev.files).padStart(10)} | ${String(r.totalFiles).padStart(11)} | ${String(prev.symbols).padStart(12)} | ${String(r.totalSymbols).padStart(13)} | ${(prev.latencyMs + 'ms').padStart(12)} | ${(r.extractionMs + 'ms').padStart(13)} | ${(prev.hits + '/' + prev.queries).padStart(9)} | ${(origHits + '/3').padStart(10)} |`;
  console.log(row);
}

// ── Aggregate ─────────────────────────────────────────────────────────────

console.log(`\n=== AGGREGATE ===`);
const totalHits = results.reduce((s, r) => s + r.hitCount, 0);
const totalQueries = results.reduce((s, r) => s + r.queryCount, 0);
const totalFiles = results.reduce((s, r) => s + r.totalFiles, 0);
const avgLatency = results.length > 0
  ? (results.reduce((s, r) => s + r.extractionMs, 0) / results.length).toFixed(1)
  : 0;

console.log(`Overall hit rate: ${totalHits}/${totalQueries}`);
console.log(`Avg extraction latency: ${avgLatency}ms`);
console.log(`Total files scanned: ${totalFiles}`);

// ── Verdict ───────────────────────────────────────────────────────────────

const hitRate = totalHits / totalQueries;
console.log(`\nHit rate: ${(hitRate * 100).toFixed(0)}%`);
if (hitRate >= 0.8) {
  console.log('Removing the file limit resolves the sampling bottleneck.');
} else if (hitRate >= 0.5) {
  console.log('Improved but still has gaps -- regex patterns may need tuning for some symbol types.');
} else {
  console.log('Still below 50% -- issue is not just sampling.');
}

console.log(`\nTASK_STATUS:${hitRate >= 0.5 ? 'pass' : 'fail'}`);

/*
=== RUN OUTPUT (2026-04-09) ===

Phase 1 No-Limit Spike: Regex Symbol Extraction (ALL files)
Date: 2026-04-09T11:00:43.069Z

=== Project: bingoSim (Python) ===
Total source files: 246 (was limited to 20 before)
Total symbols extracted: 1594
Extraction time: 88.0ms

Query: "game"
  hit=true, symbols=72, files_with_matches=35
  Top 5 matches:
  .claude/skills/game-design/scripts/volatility_analysis.py:22 -- DEFAULT_GAMES
  bingo_sim/config/unified_config.py:311 -- GameConfig
  bingo_sim/game/audit.py:80 -- GameAuditLog
  bingo_sim/game/builder.py:43 -- GameComponents
  bingo_sim/game/builder.py:103 -- GameBuilder
  ... and 67 more

Query: "card"
  hit=true, symbols=104, files_with_matches=47
  Top 5 matches:
  bingo_sim/card/factory.py:22 -- CardFactory
  bingo_sim/card/generator.py:18 -- generate_75ball_card
  bingo_sim/card/generator.py:76 -- generate_75ball_cards
  bingo_sim/card/generator.py:117 -- generate_card
  bingo_sim/card/models.py:35 -- Card
  ... and 99 more

Query: "pattern"
  hit=true, symbols=170, files_with_matches=67
  Top 5 matches:
  bingo_sim/config/unified_config.py:39 -- Pattern
  bingo_sim/config/unified_config.py:527 -- create_pattern
  bingo_sim/config/unified_loader.py:66 -- _get_valid_pattern_ids
  bingo_sim/config/unified_loader.py:37 -- PATTERN_TYPE_MAP
  bingo_sim/config/unified_loader.py:51 -- PATTERN_ID_MAP
  ... and 165 more

Query: "prize"
  hit=true, symbols=32, files_with_matches=24
  Top 5 matches:
  bingo_sim/config/unified_config.py:128 -- ConsolationPrizeBehavior
  bingo_sim/game/collectibles.py:331 -- calculate_collectible_prize
  bingo_sim/game/models.py:20 -- PrizeInfo
  bingo_sim/game/modifiers/models.py:52 -- PRIZE_MODIFIERS
  bingo_sim/game/modifiers/prize_modifiers.py:22 -- get_prize_multiplier
  ... and 27 more

Query: "ball"
  hit=true, symbols=120, files_with_matches=50
  Top 5 matches:
  bingo_sim/card/constants.py:47 -- BALL_90_ROWS
  bingo_sim/card/constants.py:48 -- BALL_90_COLS
  bingo_sim/card/constants.py:49 -- BALL_90_TOTAL_NUMBERS
  bingo_sim/card/constants.py:50 -- BALL_90_NUMBERS_PER_ROW
  bingo_sim/card/constants.py:51 -- BALL_90_MIN_NUMBERS_PER_COL
  ... and 115 more

=== Project: bingo-rgs (Go) ===
Total source files: 204 (was limited to 20 before)
Total symbols extracted: 1816
Extraction time: 69.5ms

Query: "server"
  hit=true, symbols=11, files_with_matches=8
  Top 5 matches:
  internal/rgs/api_health_test.go:73 -- newHealthServer
  internal/rgs/server.go:65 -- NewServer
  internal/rgs/server.go:17 -- Server
  internal/rgs/server_rewire_test.go:14 -- newTestServer
  internal/server/api_roleplay_test.go:56 -- newRoleplayServer
  ... and 6 more

Query: "engine"
  hit=true, symbols=2, files_with_matches=1
  Top 5 matches:
  pkg/engine/acceptance_test.go:185 -- findEngineRoot
  pkg/engine/acceptance_test.go:19 -- engineDirs

Query: "round"
  hit=true, symbols=242, files_with_matches=52
  Top 5 matches:
  cmd/scan-games/main.go:128 -- scanRawRoundTiming
  cmd/scan-games/main.go:163 -- scanRawBonusRound
  internal/compliance/result.go:7 -- ComplianceRoundResult
  internal/compliance/simulate_test.go:473 -- TestRunComplianceSimulation_ZeroRounds
  internal/parallel/split.go:5 -- ChunkRounds
  ... and 237 more

Query: "pool"
  hit=true, symbols=21, files_with_matches=12
  Top 5 matches:
  internal/compliance/e2e_test.go:187 -- buildSequentialPool
  internal/compliance/pool.go:24 -- InitPool
  internal/compliance/pool.go:10 -- PoolMetadata
  internal/compliance/pool_test.go:19 -- TestInitPool_Deterministic
  internal/compliance/pool_test.go:92 -- TestInitPool_75Balls
  ... and 16 more

Query: "merge"
  hit=true, symbols=12, files_with_matches=4
  Top 5 matches:
  internal/parallel/merge.go:13 -- MergeSimulationResults
  internal/parallel/merge_engagement.go:21 -- MergeEngagementRaw
  internal/parallel/merge_refill.go:18 -- MergeRefillRaw
  internal/parallel/merge_test.go:13 -- TestMerge_TwoParts
  internal/parallel/merge_test.go:96 -- TestMerge_SinglePart
  ... and 7 more

=== Project: dashboard (TypeScript) ===
Total source files: 50 (was limited to 20 before)
Total symbols extracted: 225
Extraction time: 9.5ms

Query: "chart"
  hit=true, symbols=11, files_with_matches=5
  Top 5 matches:
  src/components/charts/BarChart.tsx:20 -- BarChartProps
  src/components/charts/BarChart.tsx:46 -- BarChart
  src/components/charts/ChartWrapper.tsx:3 -- ChartWrapperProps
  src/components/charts/ChartWrapper.tsx:73 -- ChartWrapper
  src/components/charts/LineChart.tsx:19 -- LineChartProps
  ... and 6 more

Query: "table"
  hit=true, symbols=4, files_with_matches=2
  Top 5 matches:
  src/components/DataTable.tsx:27 -- DataTableProps
  src/components/DataTable.tsx:127 -- DataTable
  src/components/TableSkeleton.tsx:1 -- TableSkeletonProps
  src/components/TableSkeleton.tsx:14 -- TableSkeleton

Query: "export"
  hit=true, symbols=8, files_with_matches=4
  Top 5 matches:
  src/api/endpoints.ts:130 -- exportConnectorCsv
  src/api/types.ts:12 -- ExportFormat
  src/api/types.ts:27 -- ExportParams
  src/components/ExportMenu.tsx:88 -- ExportMenuProps
  src/components/ExportMenu.tsx:119 -- ExportMenu
  ... and 3 more

Query: "page"
  hit=true, symbols=5, files_with_matches=5
  Top 5 matches:
  src/pages/GoogleAdsPage.tsx:296 -- GoogleAdsPage
  src/pages/MetaAdsPage.tsx:254 -- MetaAdsPage
  src/pages/OverviewPage.tsx:259 -- OverviewPage
  src/pages/TikTokAdsPage.tsx:285 -- TikTokAdsPage
  src/pages/WhatsAppPage.tsx:218 -- WhatsAppPage

Query: "date"
  hit=true, symbols=12, files_with_matches=5
  Top 5 matches:
  src/__tests__/date-range.test.tsx:17 -- dateStr
  src/api/types.ts:17 -- ISODate
  src/api/types.ts:20 -- ISODateTime
  src/api/types.ts:22 -- DateRangeParams
  src/components/DateRangePicker.tsx:9 -- formatDate
  ... and 7 more

=== COMPARISON: 20-file limit vs no limit ===
| Project      | Lang       | Files (20) | Files (all) | Symbols (20) | Symbols (all) | Latency (20) | Latency (all) | Hits (20) | Hits (all) |
|--------------|------------|------------|-------------|--------------|---------------|--------------|---------------|-----------|------------|
| bingoSim     | Python     |         20 |         246 |           88 |          1594 |       10.7ms |          88ms |       3/3 |        3/3 |
| bingo-rgs    | Go         |         20 |         204 |          117 |          1816 |        5.5ms |        69.5ms |       1/3 |        3/3 |
| dashboard    | TypeScript |         20 |          50 |          113 |           225 |        9.1ms |         9.5ms |       2/3 |        3/3 |

=== AGGREGATE ===
Overall hit rate: 15/15
Avg extraction latency: 55.7ms
Total files scanned: 500

Hit rate: 100%
Removing the file limit resolves the sampling bottleneck.

TASK_STATUS:pass
*/
