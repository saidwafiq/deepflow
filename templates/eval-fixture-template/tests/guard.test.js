#!/usr/bin/env node
/**
 * Guard tests for eval fixture
 *
 * These tests constitute the binary guard check in the eval loop.
 * ALL tests must pass for the iteration to proceed to metric collection.
 * A failing guard causes immediate git revert and logs status:guard_fail.
 *
 * Run: node tests/guard.test.js
 * Exit 0 = all pass, exit 1 = one or more failed
 */

const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixture');

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Structural tests — fixture files must exist before skill evaluation runs
// ---------------------------------------------------------------------------

console.log('\n[guard] Structural integrity checks');

assert(
  'fixture/package.json exists',
  fs.existsSync(path.join(FIXTURE_DIR, 'package.json'))
);

assert(
  'fixture/src/index.js exists',
  fs.existsSync(path.join(FIXTURE_DIR, 'src', 'index.js'))
);

assert(
  'fixture/src/skills/example-skill/SKILL.md exists',
  fs.existsSync(path.join(FIXTURE_DIR, 'src', 'skills', 'example-skill', 'SKILL.md'))
);

assert(
  'fixture/specs/ contains at least one doing-*.md',
  fs.readdirSync(path.join(FIXTURE_DIR, 'specs')).some(
    (f) => f.startsWith('doing-') && f.endsWith('.md')
  )
);

assert(
  'fixture/.deepflow/decisions.md exists',
  fs.existsSync(path.join(FIXTURE_DIR, '.deepflow', 'decisions.md'))
);

// ---------------------------------------------------------------------------
// Content tests — critical fields must be present in key files
// ---------------------------------------------------------------------------

console.log('\n[guard] Content validity checks');

const skillPath = path.join(FIXTURE_DIR, 'src', 'skills', 'example-skill', 'SKILL.md');
const skillContent = fs.readFileSync(skillPath, 'utf8');

assert(
  'SKILL.md has YAML frontmatter',
  skillContent.startsWith('---')
);

assert(
  'SKILL.md has allowed-tools',
  skillContent.includes('allowed-tools')
);

const pkgPath = path.join(FIXTURE_DIR, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

assert(
  'package.json has test script',
  typeof pkg.scripts?.test === 'string'
);

assert(
  'package.json has build script',
  typeof pkg.scripts?.build === 'string'
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n[guard] ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('[guard] GUARD FAILED — iteration will be reverted');
  process.exit(1);
}

console.log('[guard] All guard checks passed');
process.exit(0);
