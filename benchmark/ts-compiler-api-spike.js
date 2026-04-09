#!/usr/bin/env node
/**
 * SPIKE: TypeScript Compiler API for symbol extraction (Phase 1 of d3-explore-split)
 *
 * Validates whether ts.createSourceFile() can replace LSP documentSymbol
 * for fast, no-tsconfig symbol discovery.
 *
 * Questions:
 *   1. Can we extract Class/Interface/Enum/TypeAlias/Function declarations?
 *   2. Latency per file? (target: <200ms per file, <1s for 10 files)
 *   3. Works without tsconfig / full program creation?
 *   4. Works for both .ts and .js?
 *   5. Can we match symbols to a query string?
 */

'use strict';

const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// -- Representative files: mix of .ts and .js, different sizes --
const TEST_FILES = [
  'hooks/df-quota-logger.js',               // 120 lines, .js, has "quota" in name
  'hooks/df-invariant-check.js',             // 1261 lines, .js, largest hook
  'hooks/df-explore-protocol.js',            // 225 lines, .js
  'bin/install.js',                          // 746 lines, .js
  'bin/ratchet.js',                          // 392 lines, .js
  'packages/deepflow-dashboard/src/backfill.ts',                  // 345 lines, .ts, has interface
  'packages/deepflow-dashboard/src/ingest/parsers/history.ts',    // 52 lines, .ts, exported async fn
  'packages/deepflow-dashboard/src/api/tasks.ts',                 // 119 lines, .ts
  'packages/deepflow-dashboard/src/api/activity.ts',              // 32 lines, .ts
  'packages/deepflow-dashboard/src/client/hooks/useApi.ts',       // 24 lines, .ts
].map(f => path.join(ROOT, f));

// -- Map TS SyntaxKind to human-readable symbol kind --
function symbolKind(node) {
  if (ts.isFunctionDeclaration(node))   return 'Function';
  if (ts.isClassDeclaration(node))      return 'Class';
  if (ts.isInterfaceDeclaration(node))  return 'Interface';
  if (ts.isEnumDeclaration(node))       return 'Enum';
  if (ts.isTypeAliasDeclaration(node))  return 'TypeAlias';
  if (ts.isVariableStatement(node))     return 'Variable';
  if (ts.isModuleDeclaration(node))     return 'Module';
  return null;
}

// -- Extract top-level symbols from a source file AST --
function extractSymbols(sourceFile) {
  const symbols = [];

  function visit(node) {
    const kind = symbolKind(node);
    if (kind) {
      if (kind === 'Variable') {
        // Variable statements can declare multiple names
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

// -- Parse a single file and extract symbols --
function parseFile(filePath) {
  const ext = path.extname(filePath);
  const scriptKind = (ext === '.ts' || ext === '.tsx')
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  const langVersion = ts.ScriptTarget.Latest;

  const code = fs.readFileSync(filePath, 'utf-8');
  const start = performance.now();
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    code,
    langVersion,
    /* setParentNodes */ true,
    scriptKind
  );
  const symbols = extractSymbols(sourceFile);
  const elapsed = performance.now() - start;

  return { filePath, symbols, elapsed, lines: code.split('\n').length };
}

// -- Query matcher: case-insensitive substring match on symbol name or file path --
function matchQuery(results, query) {
  const q = query.toLowerCase();
  const matches = [];
  for (const r of results) {
    const fileMatch = path.basename(r.filePath).toLowerCase().includes(q);
    const symbolMatches = r.symbols.filter(s => s.name.toLowerCase().includes(q));
    if (fileMatch || symbolMatches.length > 0) {
      matches.push({
        file: path.relative(ROOT, r.filePath),
        fileMatch,
        symbolMatches: symbolMatches.map(s => `${s.kind} ${s.name} (line ${s.line})`),
      });
    }
  }
  return matches;
}

// -- Main --
console.log('=== TypeScript Compiler API Spike ===');
console.log(`TypeScript version: ${ts.version}`);
console.log(`Files to parse: ${TEST_FILES.length}\n`);

const results = [];
let totalElapsed = 0;

for (const filePath of TEST_FILES) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP (not found): ${path.relative(ROOT, filePath)}`);
    continue;
  }

  const result = parseFile(filePath);
  results.push(result);
  totalElapsed += result.elapsed;

  const rel = path.relative(ROOT, filePath);
  console.log(`--- ${rel} (${result.lines} lines) ---`);
  console.log(`  Parse + extract: ${result.elapsed.toFixed(2)}ms`);
  console.log(`  Symbols found: ${result.symbols.length}`);
  for (const s of result.symbols) {
    console.log(`    ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (line ${s.line})`);
  }
  console.log();
}

console.log('=== Timing Summary ===');
console.log(`Total files parsed: ${results.length}`);
console.log(`Total time: ${totalElapsed.toFixed(2)}ms`);
console.log(`Average per file: ${(totalElapsed / results.length).toFixed(2)}ms`);
console.log(`Max per file: ${Math.max(...results.map(r => r.elapsed)).toFixed(2)}ms`);
console.log(`Min per file: ${Math.min(...results.map(r => r.elapsed)).toFixed(2)}ms`);
console.log();

// Query test
console.log('=== Query Test: "quota" ===');
const quotaMatches = matchQuery(results, 'quota');
if (quotaMatches.length === 0) {
  console.log('  No matches');
} else {
  for (const m of quotaMatches) {
    console.log(`  ${m.file}:`);
    if (m.fileMatch) console.log('    (filename match)');
    for (const s of m.symbolMatches) console.log(`    ${s}`);
  }
}
console.log();

console.log('=== Query Test: "backfill" ===');
const backfillMatches = matchQuery(results, 'backfill');
if (backfillMatches.length === 0) {
  console.log('  No matches');
} else {
  for (const m of backfillMatches) {
    console.log(`  ${m.file}:`);
    if (m.fileMatch) console.log('    (filename match)');
    for (const s of m.symbolMatches) console.log(`    ${s}`);
  }
}
console.log();

console.log('=== Query Test: "parse" ===');
const parseMatches = matchQuery(results, 'parse');
if (parseMatches.length === 0) {
  console.log('  No matches');
} else {
  for (const m of parseMatches) {
    console.log(`  ${m.file}:`);
    if (m.fileMatch) console.log('    (filename match)');
    for (const s of m.symbolMatches) console.log(`    ${s}`);
  }
}
console.log();

// Summary
const allKinds = new Set(results.flatMap(r => r.symbols.map(s => s.kind)));
console.log('=== Findings ===');
console.log(`Symbol kinds extracted: ${[...allKinds].sort().join(', ')}`);
console.log(`tsconfig required: NO (createSourceFile works standalone)`);
console.log(`Works for .js: ${results.some(r => r.filePath.endsWith('.js')) ? 'YES' : 'NO'}`);
console.log(`Works for .ts: ${results.some(r => r.filePath.endsWith('.ts')) ? 'YES' : 'NO'}`);
const under200 = results.every(r => r.elapsed < 200);
const totalUnder1s = totalElapsed < 1000;
console.log(`All files <200ms: ${under200 ? 'YES' : 'NO'}`);
console.log(`Total <1s for ${results.length} files: ${totalUnder1s ? 'YES' : 'NO'}`);
console.log();

if (under200 && totalUnder1s && allKinds.has('Function') && allKinds.has('Interface')) {
  console.log('TASK_STATUS:pass');
} else {
  console.log('TASK_STATUS:fail');
  if (!under200) console.log('  FAIL: Some files took >200ms');
  if (!totalUnder1s) console.log('  FAIL: Total >1s');
  if (!allKinds.has('Function')) console.log('  FAIL: No Function symbols found');
  if (!allKinds.has('Interface')) console.log('  FAIL: No Interface symbols found');
}
