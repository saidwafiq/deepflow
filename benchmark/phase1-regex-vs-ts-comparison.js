#!/usr/bin/env node
/**
 * SPIKE: Compare regex-based symbol extraction vs TypeScript Compiler API
 *
 * Evaluates whether regex grep (zero deps, ~80% accuracy) is sufficient
 * as Phase 1 symbol extraction, or if the TS Compiler API (3ms/file, 99%
 * accuracy, requires typescript) justifies the dependency.
 *
 * Metrics: Precision, Recall, F1, latency per file.
 * Ground truth: TS Compiler API output.
 */

'use strict';

const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Test files — mix of JS and TS with varied patterns
// ---------------------------------------------------------------------------
const TEST_FILES = [
  // JS files
  'hooks/df-explore-protocol.js',       // module.exports, spawnSync import, nested functions
  'hooks/df-invariant-check.js',        // large file (1261 lines), many top-level functions
  'bin/install.js',                      // complex script with destructured requires
  'hooks/ac-coverage.js',               // hook with parsing logic
  'benchmark/repo-inspect/score.js',    // small utility

  // TS files
  'packages/deepflow-dashboard/src/backfill.ts',                   // interfaces, exported async functions
  'packages/deepflow-dashboard/src/lib/quota-window-parser.ts',    // generator functions, type exports
  'packages/deepflow-dashboard/src/api/tasks.ts',                  // API module with type aliases
  'packages/deepflow-dashboard/src/client/hooks/useApi.ts',        // React hook pattern
  'packages/deepflow-dashboard/src/ingest/parsers/history.ts',     // parser with exports
].map(f => path.join(ROOT, f));

// ---------------------------------------------------------------------------
// TS Compiler API extractor (ground truth) — from ts-compiler-api-spike.js
// ---------------------------------------------------------------------------

function tsSymbolKind(node) {
  if (ts.isFunctionDeclaration(node))   return 'Function';
  if (ts.isClassDeclaration(node))      return 'Class';
  if (ts.isInterfaceDeclaration(node))  return 'Interface';
  if (ts.isEnumDeclaration(node))       return 'Enum';
  if (ts.isTypeAliasDeclaration(node))  return 'TypeAlias';
  if (ts.isVariableStatement(node))     return 'Variable';
  if (ts.isModuleDeclaration(node))     return 'Module';
  return null;
}

function extractSymbolsTS(sourceFile) {
  const symbols = [];
  function visit(node) {
    const kind = tsSymbolKind(node);
    if (kind) {
      if (kind === 'Variable') {
        const decls = node.declarationList?.declarations ?? [];
        for (const d of decls) {
          const name = d.name?.getText?.(sourceFile) ?? d.name?.text ?? '<anonymous>';
          const line = sourceFile.getLineAndCharacterOfPosition(d.getStart(sourceFile)).line + 1;
          const exported = !!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Export)
            || node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
          symbols.push({ name, kind, line, exported: !!exported });
        }
      } else {
        const name = node.name?.getText?.(sourceFile) ?? node.name?.text ?? '<anonymous>';
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const exported = !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export)
          || node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        symbols.push({ name, kind, line, exported: !!exported });
      }
    }
    // Only visit top-level children (don't recurse into function bodies)
    if (ts.isSourceFile(node)) {
      ts.forEachChild(node, visit);
    }
  }
  visit(sourceFile);
  return symbols;
}

function parseFileTS(filePath) {
  const ext = path.extname(filePath);
  const scriptKind = (ext === '.ts' || ext === '.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const code = fs.readFileSync(filePath, 'utf-8');
  const start = performance.now();
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const symbols = extractSymbolsTS(sourceFile);
  const elapsed = performance.now() - start;
  return { symbols, elapsed, lines: code.split('\n').length };
}

// ---------------------------------------------------------------------------
// Regex extractor
// ---------------------------------------------------------------------------

function extractSymbolsRegex(code) {
  const start = performance.now();
  const symbols = [];
  const lines = code.split('\n');

  // Track brace depth to skip nested scopes
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Update brace depth — crude but sufficient for top-level detection
    // Count braces outside of strings/comments (rough heuristic)
    const stripped = line
      .replace(/\/\/.*$/, '')          // strip line comments
      .replace(/'[^']*'/g, '')         // strip single-quoted strings
      .replace(/"[^"]*"/g, '')         // strip double-quoted strings
      .replace(/`[^`]*`/g, '');        // strip template literals (single-line only)

    // Only extract symbols at top level (braceDepth === 0)
    if (braceDepth === 0) {
      let m;

      // Pattern 1: function/class/interface/type/enum declarations
      // Handles: export, default, async, generator (function*)
      m = line.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum)\s+(\w+)/
      );
      if (m) {
        const name = m[1];
        const kind = detectKindFromKeyword(line);
        const exported = /^export\s/.test(line);
        symbols.push({ name, kind, line: lineNum, exported });
      }

      // Pattern 2: const/let/var declarations (top-level)
      // Handles: export const handler = async () => {}
      if (!m) {
        m = line.match(
          /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/
        );
        if (m) {
          const name = m[1];
          const exported = /^export\s/.test(line);
          symbols.push({ name, kind: 'Variable', line: lineNum, exported });
        }
      }

      // Pattern 3: Re-exports — export { foo, bar } from './module'
      // These yield individual symbol names
      if (!m) {
        const reExport = line.match(/^export\s*\{([^}]+)\}/);
        if (reExport) {
          const names = reExport[1].split(',').map(s => {
            const parts = s.trim().split(/\s+as\s+/);
            return parts[parts.length - 1].trim();  // use the alias if present
          }).filter(Boolean);
          for (const name of names) {
            symbols.push({ name, kind: 'ReExport', line: lineNum, exported: true });
          }
        }
      }

      // Pattern 4: module.exports = ... (CommonJS default export)
      if (!m) {
        m = line.match(/^module\.exports\s*=\s*(?:function\s+)?(\w+)?/);
        if (m && m[1]) {
          symbols.push({ name: m[1], kind: 'Variable', line: lineNum, exported: true });
        }
      }

      // Pattern 5: Destructured requires — const { foo, bar } = require('...')
      // We extract these as variable symbols
      if (!m) {
        const destr = line.match(/^(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(/);
        if (destr) {
          const names = destr[1].split(',').map(s => s.trim().split(/\s*:\s*/)[0].trim()).filter(Boolean);
          for (const name of names) {
            symbols.push({ name, kind: 'Variable', line: lineNum, exported: false });
          }
        }
      }
    }

    // Update brace depth after extraction
    for (const ch of stripped) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }
    if (braceDepth < 0) braceDepth = 0; // safety
  }

  const elapsed = performance.now() - start;
  return { symbols, elapsed };
}

function detectKindFromKeyword(line) {
  if (/\binterface\b/.test(line)) return 'Interface';
  if (/\bclass\b/.test(line)) return 'Class';
  if (/\benum\b/.test(line)) return 'Enum';
  if (/\btype\b/.test(line) && /\btype\s+\w+\s*[=<]/.test(line)) return 'TypeAlias';
  if (/\bfunction\b/.test(line)) return 'Function';
  return 'Variable';
}

function parseFileRegex(filePath) {
  const code = fs.readFileSync(filePath, 'utf-8');
  const result = extractSymbolsRegex(code);
  return { symbols: result.symbols, elapsed: result.elapsed, lines: code.split('\n').length };
}

// ---------------------------------------------------------------------------
// Comparison engine
// ---------------------------------------------------------------------------

function compareResults(tsResult, regexResult, filePath) {
  const tsNames = new Set(tsResult.symbols.map(s => s.name));
  const regexNames = new Set(regexResult.symbols.map(s => s.name));

  const truePositives = [...regexNames].filter(n => tsNames.has(n));
  const falsePositives = [...regexNames].filter(n => !tsNames.has(n));
  const falseNegatives = [...tsNames].filter(n => !regexNames.has(n));

  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  return {
    file: path.relative(ROOT, filePath),
    tsCount: tsResult.symbols.length,
    regexCount: regexResult.symbols.length,
    tp, fp, fn,
    precision, recall, f1,
    truePositives,
    falsePositives,
    falseNegatives,
    tsLatency: tsResult.elapsed,
    regexLatency: regexResult.elapsed,
    tsSymbols: tsResult.symbols,
    regexSymbols: regexResult.symbols,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('=== Phase 1: Regex vs TS Compiler API — Symbol Extraction Comparison ===\n');
console.log(`TypeScript version: ${ts.version}`);
console.log(`Test files: ${TEST_FILES.length}\n`);

const allResults = [];

for (const filePath of TEST_FILES) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP (not found): ${path.relative(ROOT, filePath)}`);
    continue;
  }

  const tsResult = parseFileTS(filePath);
  const regexResult = parseFileRegex(filePath);
  const comparison = compareResults(tsResult, regexResult, filePath);
  allResults.push(comparison);

  // Per-file report
  console.log(`--- ${comparison.file} ---`);
  console.log(`  TS API:  ${comparison.tsCount} symbols in ${comparison.tsLatency.toFixed(2)}ms`);
  console.log(`  Regex:   ${comparison.regexCount} symbols in ${comparison.regexLatency.toFixed(2)}ms`);
  console.log(`  TP=${comparison.tp}  FP=${comparison.fp}  FN=${comparison.fn}`);
  console.log(`  Precision=${comparison.precision.toFixed(3)}  Recall=${comparison.recall.toFixed(3)}  F1=${comparison.f1.toFixed(3)}`);

  if (comparison.falsePositives.length > 0) {
    console.log(`  False positives (regex found, TS didn't): ${comparison.falsePositives.join(', ')}`);
  }
  if (comparison.falseNegatives.length > 0) {
    console.log(`  False negatives (TS found, regex missed): ${comparison.falseNegatives.join(', ')}`);
  }

  // Show symbol-level detail
  console.log('  TS symbols:');
  for (const s of comparison.tsSymbols) {
    console.log(`    ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (line ${s.line})`);
  }
  console.log('  Regex symbols:');
  for (const s of comparison.regexSymbols) {
    console.log(`    ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (line ${s.line})`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Aggregate summary
// ---------------------------------------------------------------------------

console.log('=== AGGREGATE RESULTS ===\n');

const totalTP = allResults.reduce((s, r) => s + r.tp, 0);
const totalFP = allResults.reduce((s, r) => s + r.fp, 0);
const totalFN = allResults.reduce((s, r) => s + r.fn, 0);
const aggPrecision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
const aggRecall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1;
const aggF1 = aggPrecision + aggRecall > 0 ? 2 * (aggPrecision * aggRecall) / (aggPrecision + aggRecall) : 0;

console.log('Precision/Recall/F1 (micro-averaged across all files):');
console.log(`  True positives:  ${totalTP}`);
console.log(`  False positives: ${totalFP}`);
console.log(`  False negatives: ${totalFN}`);
console.log(`  Precision: ${aggPrecision.toFixed(3)}`);
console.log(`  Recall:    ${aggRecall.toFixed(3)}`);
console.log(`  F1:        ${aggF1.toFixed(3)}`);
console.log();

// Latency comparison
const totalTsLatency = allResults.reduce((s, r) => s + r.tsLatency, 0);
const totalRegexLatency = allResults.reduce((s, r) => s + r.regexLatency, 0);
const speedup = totalTsLatency / totalRegexLatency;

console.log('Latency comparison:');
console.log(`  TS API total:    ${totalTsLatency.toFixed(2)}ms (avg ${(totalTsLatency / allResults.length).toFixed(2)}ms/file)`);
console.log(`  Regex total:     ${totalRegexLatency.toFixed(2)}ms (avg ${(totalRegexLatency / allResults.length).toFixed(2)}ms/file)`);
console.log(`  Regex speedup:   ${speedup.toFixed(1)}x faster`);
console.log();

// All false positives and negatives
const allFP = allResults.flatMap(r => r.falsePositives.map(n => `${r.file}: ${n}`));
const allFN = allResults.flatMap(r => r.falseNegatives.map(n => `${r.file}: ${n}`));

if (allFP.length > 0) {
  console.log('All false positives (regex noise):');
  for (const fp of allFP) console.log(`  - ${fp}`);
  console.log();
}

if (allFN.length > 0) {
  console.log('All false negatives (regex misses):');
  for (const fn of allFN) console.log(`  - ${fn}`);
  console.log();
}

// Metadata quality comparison
console.log('Metadata quality:');
console.log('  TS API: name, kind (Function/Class/Interface/Enum/TypeAlias/Variable/Module), line, exported');
console.log('  Regex:  name, kind (approximate), line, exported (approximate)');
console.log('  Note: Regex kind detection is heuristic — e.g., cannot distinguish arrow-fn Variable from data Variable');
console.log();

// Per-file summary table
console.log('Per-file summary:');
console.log('  File                                                       | TS  | Regex | P     | R     | F1    | TS ms  | Regex ms');
console.log('  ' + '-'.repeat(110));
for (const r of allResults) {
  const f = r.file.padEnd(57);
  console.log(`  ${f}| ${String(r.tsCount).padStart(3)} | ${String(r.regexCount).padStart(5)} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} | ${r.f1.toFixed(3)} | ${r.tsLatency.toFixed(2).padStart(6)} | ${r.regexLatency.toFixed(2)}`);
}
console.log();

// Verdict
console.log('=== VERDICT ===\n');
if (aggF1 >= 0.85) {
  console.log(`Regex achieves F1=${aggF1.toFixed(3)} which is >= 0.85 threshold.`);
  console.log(`Regex is ${speedup.toFixed(1)}x faster and has zero dependencies.`);
  console.log('RECOMMENDATION: Regex is viable for Phase 1 with known limitations.');
  console.log('Consider TS API as Phase 2 upgrade for precision-critical workflows.');
} else {
  console.log(`Regex achieves F1=${aggF1.toFixed(3)} which is below 0.85 threshold.`);
  console.log('RECOMMENDATION: TS Compiler API is worth the dependency for accuracy.');
}
console.log();
console.log(`False positive rate: ${allFP.length} total across ${allResults.length} files`);
console.log(`False negative rate: ${allFN.length} total across ${allResults.length} files`);
console.log();

if (aggF1 >= 0.70) {
  console.log('TASK_STATUS:pass');
} else {
  console.log('TASK_STATUS:fail');
}

/*
=== RESULTS (2026-04-09, TypeScript 6.0.2) ===

Aggregate:
  TP=94  FP=6  FN=6
  Precision: 0.940   Recall: 0.940   F1: 0.940

Latency:
  TS API total:  35.25ms (avg 3.53ms/file)
  Regex total:    8.27ms (avg 0.83ms/file)
  Regex speedup: 4.3x faster

Per-file:
  hooks/df-explore-protocol.js             | TS  9 | Regex  9 | P=0.778 R=0.778 F1=0.778
  hooks/df-invariant-check.js              | TS 30 | Regex 30 | P=0.900 R=0.900 F1=0.900
  bin/install.js                           | TS 25 | Regex 25 | P=0.960 R=0.960 F1=0.960
  hooks/ac-coverage.js                     | TS  6 | Regex  6 | P=1.000 R=1.000 F1=1.000
  benchmark/repo-inspect/score.js          | TS  4 | Regex  4 | P=1.000 R=1.000 F1=1.000
  backfill.ts                              | TS 10 | Regex 10 | P=1.000 R=1.000 F1=1.000
  quota-window-parser.ts                   | TS 13 | Regex 13 | P=1.000 R=1.000 F1=1.000
  tasks.ts                                 | TS  1 | Regex  1 | P=1.000 R=1.000 F1=1.000
  useApi.ts                                | TS  1 | Regex  1 | P=1.000 R=1.000 F1=1.000
  history.ts                               | TS  1 | Regex  1 | P=1.000 R=1.000 F1=1.000

All FP/FN are from destructured requires: const { foo } = require('...')
  Regex extracts "foo" (the binding name), TS API extracts "{ foo }" (the pattern).
  These are the SAME symbol — it's a name-representation mismatch, not a real error.
  Effective accuracy is ~100% on these test files.

Verdict: Regex is viable for Phase 1 (F1=0.94, 4.3x faster, zero deps).
  Only weakness: destructured require name formatting.
  TS API recommended for Phase 2 when precision-critical.

TASK_STATUS:pass
*/
