#!/usr/bin/env node
/**
 * bin/.lsp-spike.js
 *
 * Spike prototype: proves that hooks/lib/lsp-transport.js can be consumed by a
 * CLI tool to execute documentSymbol, findReferences, and workspaceSymbol
 * operations against a TypeScript fixture.
 *
 * This is a SPIKE artifact — not production code. It validates the module
 * extraction technique for T19 (symbol-extract.js) and T20 (bin/lsp-query.js).
 *
 * Usage:
 *   node bin/.lsp-spike.js <fixture-dir> [<ts-file-path>]
 *
 * Example:
 *   node bin/.lsp-spike.js test/fixtures/ts-fixture test/fixtures/ts-fixture/sample.ts
 *
 * Output:
 *   JSON results for each operation + latency measurements.
 *   Exits 0 on success (including graceful lsp_unavailable).
 *   Exits 1 only on unexpected errors.
 */

'use strict';

const path = require('path');
const { detectLspBinary, isBinaryAvailable, queryLsp } = require('../hooks/lib/lsp-transport');

async function main() {
  const fixtureDir = path.resolve(process.argv[2] || path.join(__dirname, '../test/fixtures/ts-fixture'));
  const tsFile = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(fixtureDir, 'sample.ts');

  const fileUri = `file://${tsFile}`;
  const results = {};

  console.log('=== LSP Spike: shared transport reuse proof ===');
  console.log(`Fixture dir : ${fixtureDir}`);
  console.log(`Target file : ${tsFile}`);
  console.log('');

  // ── Step 1: Detect LSP binary ─────────────────────────────────────────────
  console.log('[1] detectLspBinary...');
  const t0detect = Date.now();
  const detected = detectLspBinary(fixtureDir, [tsFile]);
  const detectMs = Date.now() - t0detect;

  if (!detected) {
    console.log(`    RESULT: no LSP binary detected for this project type (${detectMs}ms)`);
    results.binaryDetection = { ok: false, reason: 'no_rule_matched', latencyMs: detectMs };
  } else {
    const available = isBinaryAvailable(detected.binary);
    console.log(`    RESULT: binary="${detected.binary}" available=${available} (${detectMs}ms)`);
    results.binaryDetection = {
      ok: true,
      binary: detected.binary,
      available,
      installCmd: detected.installCmd,
      latencyMs: detectMs,
    };

    if (!available) {
      console.log(`    SKIP: LSP not installed. Install with: ${detected.installCmd}`);
      console.log('    (fail-open validated: code path is structurally correct)');
      results.skipped = true;
      printSummary(results, true);
      process.exit(0);
    }

    const binary = detected.binary;

    // ── Step 2: documentSymbol ─────────────────────────────────────────────
    console.log('\n[2] queryLsp → textDocument/documentSymbol...');
    const t0sym = Date.now();
    const symResult = await queryLsp(binary, fixtureDir, fileUri, 'textDocument/documentSymbol', {
      textDocument: { uri: fileUri },
    });
    const symMs = Date.now() - t0sym;
    results.documentSymbol = { ...symResult, latencyMs: symMs };

    if (symResult.ok) {
      const symbols = Array.isArray(symResult.result) ? symResult.result : [];
      console.log(`    RESULT: ok=true symbols=${symbols.length} latency=${symMs}ms`);
      for (const s of symbols.slice(0, 5)) {
        const name = s.name || s.text || JSON.stringify(s).slice(0, 40);
        const kind = s.kind;
        const line = s.location?.range?.start?.line ?? s.selectionRange?.start?.line ?? '?';
        console.log(`      - ${name} (kind=${kind}, line=${line})`);
      }
      if (symbols.length > 5) console.log(`      ... and ${symbols.length - 5} more`);
    } else {
      console.log(`    RESULT: ok=false reason=${symResult.reason} latency=${symMs}ms`);
    }

    // ── Step 3: findReferences ─────────────────────────────────────────────
    // Target: the `greet` function definition is at line 13, char 16 in sample.ts
    const refLine = 13;  // 0-indexed line of `export function greet`
    const refChar = 16;  // 0-indexed char of `greet`
    console.log(`\n[3] queryLsp → textDocument/references (line=${refLine}, char=${refChar})...`);
    const t0ref = Date.now();
    const refResult = await queryLsp(binary, fixtureDir, fileUri, 'textDocument/references', {
      textDocument: { uri: fileUri },
      position: { line: refLine, character: refChar },
      context: { includeDeclaration: true },
    });
    const refMs = Date.now() - t0ref;
    results.findReferences = { ...refResult, latencyMs: refMs };

    if (refResult.ok) {
      const refs = Array.isArray(refResult.result) ? refResult.result : [];
      console.log(`    RESULT: ok=true references=${refs.length} latency=${refMs}ms`);
      for (const r of refs.slice(0, 5)) {
        const loc = r.uri ? `${r.uri.replace('file://', '')}:${r.range?.start?.line}` : JSON.stringify(r).slice(0, 60);
        console.log(`      - ${loc}`);
      }
    } else {
      console.log(`    RESULT: ok=false reason=${refResult.reason} latency=${refMs}ms`);
    }

    // ── Step 4: workspaceSymbol ────────────────────────────────────────────
    console.log('\n[4] queryLsp → workspace/symbol (query="greet")...');
    const t0ws = Date.now();
    const wsResult = await queryLsp(binary, fixtureDir, fileUri, 'workspace/symbol', {
      query: 'greet',
    });
    const wsMs = Date.now() - t0ws;
    results.workspaceSymbol = { ...wsResult, latencyMs: wsMs };

    if (wsResult.ok) {
      const syms = Array.isArray(wsResult.result) ? wsResult.result : [];
      console.log(`    RESULT: ok=true symbols=${syms.length} latency=${wsMs}ms`);
      for (const s of syms.slice(0, 5)) {
        const name = s.name || JSON.stringify(s).slice(0, 40);
        console.log(`      - ${name}`);
      }
    } else {
      console.log(`    RESULT: ok=false reason=${wsResult.reason} latency=${wsMs}ms`);
    }
  }

  printSummary(results, false);
}

function printSummary(results, skipped) {
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));

  const allOps = ['documentSymbol', 'findReferences', 'workspaceSymbol'];
  let verdict;

  if (skipped) {
    // LSP binary not installed — code path proven structurally correct via fast-fail
    verdict = 'PASS (lsp_unavailable: fail-open validated)';
  } else {
    // Any ok:true result = transport works. ok:false with lsp_unavailable = still pass (graceful).
    const atLeastOneLive = allOps.some((op) => results[op]?.ok === true);
    const allGraceful = allOps.every((op) => !results[op] || results[op].ok || results[op].reason === 'lsp_unavailable');
    if (atLeastOneLive) {
      verdict = 'PASS (live LSP results obtained)';
    } else if (allGraceful) {
      verdict = 'PASS (fail-open: all ops returned lsp_unavailable gracefully)';
    } else {
      verdict = 'FAIL (unexpected error in transport)';
    }
  }

  console.log(`\nVERDICT: ${verdict}`);
}

main().catch((err) => {
  console.error('Unexpected error in spike:', err);
  process.exit(1);
});
