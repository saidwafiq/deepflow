#!/usr/bin/env node
/**
 * regen.js — regenerate all prompt-compose *.expected.txt fixtures.
 *
 * Iterates the 7 template/context pairs, calls render() from prompt-compose.js
 * (the same code path the test uses), and overwrites each *.expected.txt
 * byte-for-byte.
 *
 * Usage (from repo root):
 *   node bin/fixtures/prompt-compose/regen.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { render, resolveTemplatePath } = require('../../prompt-compose.js');

// REPO_ROOT is derived via resolveTemplatePath's __dirname (bin/prompt-compose.js),
// so templates resolve correctly even in a git worktree.
const FIXTURES_DIR = __dirname;

const PAIRS = [
  'standard-task',
  'integration',
  'bootstrap',
  'wave-test',
  'spike',
  'optimize',
  'optimize-probe',
];

for (const name of PAIRS) {
  const templatePath = resolveTemplatePath(name);
  const ctxPath = path.join(FIXTURES_DIR, name + '.context.json');
  const expectedPath = path.join(FIXTURES_DIR, name + '.expected.txt');

  const template = fs.readFileSync(templatePath, 'utf8');
  const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
  const rendered = render(template, ctx);

  fs.writeFileSync(expectedPath, rendered);
  process.stdout.write('wrote ' + expectedPath + '\n');
}
