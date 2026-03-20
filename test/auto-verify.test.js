/**
 * Tests for auto-verify spec (T45, T48).
 *
 * T45 — Verifies dual-condition auto-detect for L5 browser verification:
 *   1. verify.md contains "absent" auto-detect logic requiring BOTH conditions
 *   2. New skip reason "no browser_assertions in PLAN.md" exists
 *   3. L5 outcomes list includes the new skip reason
 *   4. Step 1 detection requires both frontend framework AND browser_assertions block
 *
 * T48 — Verifies three-state browser_verify in config template:
 *   1. browser_verify is commented out (not set to false)
 *   2. Comment explains three-state semantics (true/false/absent)
 *
 * Uses Node.js built-in node:test to match project conventions (see bin/install.test.js).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// T45: Dual-condition auto-detect for L5 browser verification
// ---------------------------------------------------------------------------

describe('T45 — L5 auto-detect requires BOTH frontend framework AND browser_assertions', () => {
  const verifyPath = path.join(ROOT, 'src', 'commands', 'df', 'verify.md');

  it('verify.md exists', () => {
    assert.equal(
      fs.existsSync(verifyPath),
      true,
      'verify.md must exist at src/commands/df/verify.md'
    );
  });

  it('Step 1 describes absent config triggering auto-detect with BOTH conditions', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    // The key phrase: "absent" triggers auto-detect using "BOTH" conditions
    assert.match(
      content,
      /absent.*auto-detect.*BOTH/is,
      'Step 1 should describe absent config auto-detecting using BOTH conditions'
    );
  });

  it('auto-detect requires frontend framework in package.json as condition 1', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /[Ff]rontend framework.*package\.json/,
      'Auto-detect should require frontend framework found in package.json'
    );
  });

  it('auto-detect requires browser_assertions block in PLAN.md as condition 2', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /browser_assertions.*block.*PLAN\.md/i,
      'Auto-detect should require browser_assertions block in PLAN.md'
    );
  });

  it('new skip reason "no browser_assertions in PLAN.md" exists in outcomes', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.ok(
      content.includes('no browser_assertions in PLAN.md'),
      'verify.md must contain skip reason "no browser_assertions in PLAN.md"'
    );
  });

  it('auto-detect outcomes list has three cases: no frontend, no browser_assertions, both met', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    // Extract the auto-detect outcomes section
    const outcomesMatch = content.match(/Auto-detect outcomes[\s\S]*?(?=\n\*\*Step 2)/);
    assert.ok(outcomesMatch, 'Should have an "Auto-detect outcomes" section');
    const outcomes = outcomesMatch[0];

    assert.ok(
      outcomes.includes('No frontend detected'),
      'Outcomes should include "No frontend detected" case'
    );
    assert.ok(
      outcomes.includes('no browser_assertions'),
      'Outcomes should include "no browser_assertions" case'
    );
    assert.ok(
      outcomes.includes('Both conditions met'),
      'Outcomes should include "Both conditions met" case'
    );
  });

  it('L5 outcomes list includes "no browser_assertions in PLAN.md" entry', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    // The "All L5 outcomes:" line should contain the new skip reason
    const outcomesLine = content.split('\n').find(l => l.includes('All L5 outcomes:'));
    assert.ok(outcomesLine, 'Should have an "All L5 outcomes:" line');
    assert.ok(
      outcomesLine.includes('no browser_assertions in PLAN.md'),
      'L5 outcomes line must list "no browser_assertions in PLAN.md"'
    );
  });

  it('config override still supports explicit false to skip L5', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /`false`.*skip/i,
      'verify.md should still document that false skips L5'
    );
  });

  it('config override still supports explicit true to force L5', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /`true`.*always run/i,
      'verify.md should still document that true forces L5'
    );
  });

  it('"no frontend" and "no browser_assertions" are distinct skip outcomes', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    // Both should appear as separate L5 dash outcomes
    assert.ok(
      content.includes('(no frontend)'),
      'Should have "(no frontend)" outcome'
    );
    assert.ok(
      content.includes('(no browser_assertions in PLAN.md)'),
      'Should have "(no browser_assertions in PLAN.md)" outcome'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Three-state browser_verify in config template
// ---------------------------------------------------------------------------

describe('T48 — config-template.yaml three-state browser_verify', () => {
  const configPath = path.join(ROOT, 'templates', 'config-template.yaml');

  it('config-template.yaml exists', () => {
    assert.equal(
      fs.existsSync(configPath),
      true,
      'config-template.yaml must exist at templates/config-template.yaml'
    );
  });

  it('browser_verify is commented out (not set to a value)', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    const lines = content.split('\n');
    // Find lines containing browser_verify
    const bvLines = lines.filter(l => l.includes('browser_verify'));
    assert.ok(bvLines.length > 0, 'Should have at least one line mentioning browser_verify');

    // The setting line should be commented out
    const settingLine = bvLines.find(l => !l.trim().startsWith('#') && l.includes('browser_verify:'));
    assert.equal(
      settingLine,
      undefined,
      'browser_verify should be commented out, not set as an active YAML key'
    );
  });

  it('has a commented-out "# browser_verify:" line', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.match(
      content,
      /^\s*#\s*browser_verify:/m,
      'Should have a commented-out browser_verify line'
    );
  });

  it('browser_verify is NOT set to false', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(
      !content.match(/^\s*browser_verify:\s*false/m),
      'browser_verify should NOT be set to false — it should be commented out for three-state semantics'
    );
  });

  it('comment explains three-state semantics: true, false, absent', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    // The comment should mention all three states
    assert.ok(
      content.includes('true') && content.includes('false') && content.includes('absent'),
      'Comment should explain all three states: true, false, absent/commented'
    );
  });

  it('comment mentions auto-detect behavior for absent/commented state', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.match(
      content,
      /auto-detect/i,
      'Comment should mention auto-detect for absent/commented state'
    );
  });

  it('comment mentions browser_assertions as part of auto-detect', () => {
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(
      content.includes('browser_assertions'),
      'Comment should reference browser_assertions as part of auto-detect logic'
    );
  });
});
