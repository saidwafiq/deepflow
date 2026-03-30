#!/usr/bin/env node
/**
 * lint-no-bare-stdin.js
 *
 * Guards against bare `process.stdin.on` calls being (re-)introduced in
 * hooks/df-*.js files. Hooks that need stdin must use readStdinIfMain()
 * from hooks/lib/hook-stdin.js instead.
 *
 * Excluded hooks (use alternative stdin strategies — documented below):
 *   df-check-update.js    — spawns detached background process; never reads stdin
 *   df-dashboard-push.js  — reads stdin synchronously via readFileSync('/dev/stdin')
 *   df-quota-logger.js    — spawns detached background process; never reads stdin
 *   df-spec-lint.js       — CLI tool (takes a filepath arg); never reads stdin
 *
 * Usage:
 *   node hooks/lib/lint-no-bare-stdin.js          # exits 0 (clean) or 1 (violations)
 *
 * Integration:
 *   Add to your CI / pre-commit as:
 *     node hooks/lib/lint-no-bare-stdin.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.resolve(__dirname, '..');
const PATTERN = /process\.stdin\.on\s*\(/;

function run() {
  // Collect hooks/df-*.js (not inside hooks/lib/)
  const entries = fs.readdirSync(HOOKS_DIR);
  const hookFiles = entries
    .filter((f) => f.startsWith('df-') && f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => path.join(HOOKS_DIR, f));

  const violations = [];

  for (const filePath of hookFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (PATTERN.test(line)) {
        violations.push({
          file: path.relative(path.resolve(__dirname, '..', '..'), filePath),
          line: idx + 1,
          text: line.trim(),
        });
      }
    });
  }

  if (violations.length === 0) {
    console.log('lint-no-bare-stdin: OK — no bare process.stdin.on calls found in hooks/df-*.js');
    process.exit(0);
  }

  console.error('lint-no-bare-stdin: FAIL — bare process.stdin.on calls detected:');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error('');
  console.error('Fix: use readStdinIfMain() from hooks/lib/hook-stdin.js instead of inline stdin listeners.');
  process.exit(1);
}

run();
