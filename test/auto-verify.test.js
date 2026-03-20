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

// ---------------------------------------------------------------------------
// T46: Diagnostic mode for df:verify
// ---------------------------------------------------------------------------

describe('T46 — --diagnostic flag in df:verify', () => {
  const verifyPath = path.join(ROOT, 'src', 'commands', 'df', 'verify.md');
  let content;

  it('verify.md exists', () => {
    assert.equal(
      fs.existsSync(verifyPath),
      true,
      'verify.md must exist at src/commands/df/verify.md'
    );
    content = fs.readFileSync(verifyPath, 'utf8');
  });

  // --- Usage section ---

  it('usage section shows --diagnostic flag with a spec argument', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /--diagnostic\s+doing-\w+/,
      'Usage should show --diagnostic with a doing-* spec argument'
    );
  });

  it('usage section includes --diagnostic as a distinct usage line', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    const usageBlock = content.match(/```[\s\S]*?--diagnostic[\s\S]*?```/);
    assert.ok(usageBlock, 'Usage code block should contain --diagnostic');
  });

  // --- Diagnostic Mode section ---

  it('has a dedicated "Diagnostic Mode" section', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /##\s+Diagnostic Mode\s*\(`--diagnostic`\)/,
      'Should have a "Diagnostic Mode (`--diagnostic`)" section header'
    );
  });

  it('diagnostic mode runs L0-L4 only and skips L5', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /L0-L4 only.*skip L5/i,
      'Diagnostic mode should specify L0-L4 only, skip L5'
    );
  });

  it('diagnostic mode skips L5 even if frontend is detected', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /skip L5.*even if frontend/i,
      'Should explicitly state L5 is skipped even when frontend is detected'
    );
  });

  // --- Results file output ---

  it('writes results to .deepflow/results/final-test-{spec}.yaml', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /\.deepflow\/results\/final-test-\{spec\}\.yaml/,
      'Should write to .deepflow/results/final-test-{spec}.yaml'
    );
  });

  it('results are written under a diagnostics: key', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /`diagnostics:`\s*key/,
      'Results should be under a diagnostics: key'
    );
  });

  it('diagnostics yaml includes spec, timestamp, L0-L4, and summary fields', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    const diagSection = content.match(/```yaml\s*\n\s*diagnostics:[\s\S]*?```/);
    assert.ok(diagSection, 'Should have a diagnostics YAML example block');
    const block = diagSection[0];
    assert.ok(block.includes('spec:'), 'Diagnostics should include spec field');
    assert.ok(block.includes('timestamp:'), 'Diagnostics should include timestamp field');
    assert.ok(block.includes('L0:'), 'Diagnostics should include L0 field');
    assert.ok(block.includes('L1:'), 'Diagnostics should include L1 field');
    assert.ok(block.includes('L2:'), 'Diagnostics should include L2 field');
    assert.ok(block.includes('L4:'), 'Diagnostics should include L4 field');
    assert.ok(block.includes('summary:'), 'Diagnostics should include summary field');
  });

  // --- Output format ---

  it('output is prefixed with [DIAGNOSTIC]', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /\[DIAGNOSTIC\]/,
      'Diagnostic output should use [DIAGNOSTIC] prefix'
    );
  });

  // --- Skip conditions ---

  it('diagnostic mode skips merge (post-verification)', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /[Ss]kip.*merge/i,
      'Diagnostic mode should skip merge'
    );
  });

  it('diagnostic mode skips fix task creation', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /[Ss]kip.*fix task/i,
      'Diagnostic mode should skip fix task creation'
    );
  });

  it('diagnostic mode skips spec rename', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /[Ss]kip.*spec rename/i,
      'Diagnostic mode should skip spec rename'
    );
  });

  it('diagnostic mode skips decision extraction', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /[Ss]kip.*decision extraction/i,
      'Diagnostic mode should skip decision extraction'
    );
  });

  it('diagnostic mode skips PLAN.md cleanup (step 6)', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /PLAN\.md cleanup/i,
      'Diagnostic mode should skip PLAN.md cleanup'
    );
  });

  // --- Circuit breaker and snapshot ---

  it('does not count as a revert for circuit breaker', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /not.*count.*revert.*circuit breaker/is,
      'Diagnostic mode should not count as revert for circuit breaker'
    );
  });

  it('does not modify auto-snapshot.txt', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /not.*modify.*auto-snapshot\.txt/is,
      'Diagnostic mode should not modify auto-snapshot.txt'
    );
  });

  // --- Post-Verification header guard ---

  it('post-verification section excludes --diagnostic runs', () => {
    content = content || fs.readFileSync(verifyPath, 'utf8');
    const postVerif = content.match(/Post-Verification[\s\S]*?`--diagnostic`\s*was\s*NOT\s*used/i);
    assert.ok(
      postVerif,
      'Post-Verification section should guard against --diagnostic runs'
    );
  });
});
