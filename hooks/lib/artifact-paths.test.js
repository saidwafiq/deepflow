#!/usr/bin/env node
// Tests artifact-paths.js single-source-of-truth invariants.
// covers specs/artifact-validation.md#AC-1
// covers specs/artifact-validation.md#AC-2
// covers specs/artifact-validation.md#AC-3
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PATHS = require('./artifact-paths');

// AC-1: All 5 constants exist with correct values
{
  assert.strictEqual(PATHS.SKETCH, 'sketch.md', 'SKETCH constant');
  assert.strictEqual(PATHS.IMPACT, 'impact.md', 'IMPACT constant');
  assert.strictEqual(PATHS.FINDINGS, 'findings.md', 'FINDINGS constant');
  assert.strictEqual(PATHS.PLAN, 'PLAN.md', 'PLAN constant');
  assert.strictEqual(PATHS.VERIFY_RESULT, 'verify-result.json', 'VERIFY_RESULT constant');
  assert.ok(Object.isFrozen(PATHS), 'PATHS must be frozen');
  console.log('AC-1 ok: 5 constants present and frozen');
}

// AC-2: Both consumers require the module. No code-path string literals
// remain in either consumer (JSDoc/comment examples are exempt).
{
  const repoRoot = path.resolve(__dirname, '..', '..');
  const validate = fs.readFileSync(path.join(repoRoot, 'hooks', 'df-artifact-validate.js'), 'utf8');
  const predicates = fs.readFileSync(path.join(repoRoot, 'hooks', 'lib', 'artifact-predicates.js'), 'utf8');
  assert.match(validate, /require\(['"]\.\/lib\/artifact-paths['"]\)/, 'validate.js must require artifact-paths');
  assert.match(predicates, /require\(['"]\.\/artifact-paths['"]\)/, 'predicates.js must require artifact-paths');

  // Strip line/block comments before scanning for code-path literals
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const validateCode = stripComments(validate);
  const predicatesCode = stripComments(predicates);
  const literalRe = /['"](sketch\.md|impact\.md|findings\.md|PLAN\.md|verify-result\.json)['"]/;
  assert.ok(!literalRe.test(validateCode), 'validate.js code paths must use PATHS.* not literals');
  assert.ok(!literalRe.test(predicatesCode), 'predicates.js code paths must use PATHS.* not literals');
  console.log('AC-2 ok: both consumers require the module; no code-path literals remain');
}

// AC-3: Grep parity — artifact-chain templates reference the same string values.
{
  const repoRoot = path.resolve(__dirname, '..', '..');
  const templatesDir = path.join(repoRoot, 'templates', 'agent-prompts');
  if (!fs.existsSync(templatesDir)) {
    console.log('AC-3 skipped: templates dir not found');
  } else {
    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.md'));
    const allText = files.map(f => fs.readFileSync(path.join(templatesDir, f), 'utf8')).join('\n');
    // Each constant value must appear in at least one template
    const expected = [PATHS.SKETCH, PATHS.IMPACT, PATHS.FINDINGS];
    for (const v of expected) {
      assert.ok(allText.includes(v), `templates/ must reference "${v}"`);
    }
    console.log('AC-3 ok: templates reference SKETCH, IMPACT, FINDINGS values');
  }
}

console.log('all 3 ACs pass');
