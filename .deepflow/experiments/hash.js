#!/usr/bin/env node
// Throwaway spike: prove stable hashing of (level, file, rule) issue tuples.
// Run: node hash.js

const crypto = require('crypto');

/**
 * Normalize a single issue tuple.
 * - level: trim + lowercase (e.g. "L4 " -> "l4")
 * - file: trim + lowercase + normalize path separators to forward slash
 *         strip line numbers (colons and anything after the last path segment)
 * - rule: trim + lowercase
 * Line numbers are intentionally excluded: same rule, same file, different
 * line still counts as "same issue category" for no-progress detection.
 */
function normalizeTuple(issue) {
  const level = String(issue.level).trim().toLowerCase();
  // Strip line/col suffix e.g. "src/foo.ts:42:5" -> "src/foo.ts"
  const rawFile = String(issue.file).trim().replace(/\\/g, '/');
  const file = rawFile.replace(/:\d+.*$/, '').toLowerCase();
  const rule = String(issue.rule).trim().toLowerCase();
  return { level, file, rule };
}

/**
 * Compute a stable signature for a set of issues.
 * Algorithm:
 *   1. Normalize each tuple (level, file, rule).
 *   2. Deduplicate (same normalized tuple seen twice => counted once).
 *   3. Sort lexicographically by JSON representation.
 *   4. Serialize as newline-joined "level|file|rule" strings.
 *   5. SHA-256, return first 16 hex chars (64-bit prefix).
 *
 * SHA-256 chosen over MD5 (known collisions) and SHA-1 (deprecated).
 * 16-char prefix gives 2^64 collision resistance — vastly more than needed
 * for a set of build/test failures in a single project.
 */
function computeSignature(issues) {
  const normalized = issues.map(normalizeTuple);
  // Deduplicate
  const seen = new Set();
  const unique = normalized.filter(t => {
    const key = `${t.level}|${t.file}|${t.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Sort
  unique.sort((a, b) => {
    const ka = `${a.level}|${a.file}|${a.rule}`;
    const kb = `${b.level}|${b.file}|${b.rule}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // Serialize
  const serialized = unique.map(t => `${t.level}|${t.file}|${t.rule}`).join('\n');
  // Hash
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  return hash.slice(0, 16);
}

// ── Demo ──────────────────────────────────────────────────────────────────────

// Set A: two runs that produce the same logical issues (different line numbers,
// mixed case paths, trailing whitespace in level)
const runA1 = [
  { level: 'L4 ', file: 'src/Foo.ts:42:1',  rule: 'TS2345' },
  { level: 'l0',  file: 'src/bar.ts:7',     rule: 'build-error' },
];
const runA2 = [
  { level: 'l0',  file: 'SRC/bar.ts',       rule: 'BUILD-ERROR' },  // case differs
  { level: 'L4',  file: 'src/foo.ts:99:3',  rule: 'ts2345' },        // line differs
];

// Set B: one issue changed (different rule)
const runB = [
  { level: 'L4',  file: 'src/foo.ts:42:1',  rule: 'TS2304' },  // rule changed
  { level: 'l0',  file: 'src/bar.ts:7',     rule: 'build-error' },
];

const sigA1 = computeSignature(runA1);
const sigA2 = computeSignature(runA2);
const sigB  = computeSignature(runB);

console.log('=== Signature Hashing Spike ===\n');
console.log('Run A1 issues:', JSON.stringify(runA1));
console.log('Run A2 issues:', JSON.stringify(runA2));
console.log('Run B  issues:', JSON.stringify(runB));
console.log();
console.log(`sig(A1) = ${sigA1}`);
console.log(`sig(A2) = ${sigA2}`);
console.log(`sig(B)  = ${sigB}`);
console.log();
console.log(`A1 === A2 (expected TRUE):  ${sigA1 === sigA2}`);
console.log(`A1 === B  (expected FALSE): ${sigA1 === sigB}`);

// Determinism check: run twice on same input
const sigA1b = computeSignature(runA1);
console.log(`\nDeterminism (A1 run twice, expected TRUE): ${sigA1 === sigA1b}`);

// Edge case: order independence
const runA1Reversed = [...runA1].reverse();
const sigA1rev = computeSignature(runA1Reversed);
console.log(`Order independence (reversed, expected TRUE): ${sigA1 === sigA1rev}`);
