/**
 * Tests for auto-verify spec (T47).
 *
 * T47 — Verifies execute.md step 8.1 diagnostic verify on Final Test failure:
 *   1. Step 8.1c invokes df:verify --diagnostic on failure (not STOP)
 *   2. Writes diagnostics: key to final-test-{spec}.yaml with L0/L1/L2/L4
 *   3. Report format matches expected pattern with checkmarks/warnings
 *   4. Diagnostic verify is informational only — no fix agents, no retries
 *   5. Step 8.1b clarified: pass proceeds to step 8.2 (full L0-L5 verify + merge)
 *   6. Rules table updated: Final test row documents both branches
 *
 * Uses Node.js built-in node:test to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const executePath = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

// ---------------------------------------------------------------------------
// Helper: extract step 8.1 content
// ---------------------------------------------------------------------------

function getExecuteContent() {
  return fs.readFileSync(executePath, 'utf8');
}

function getStep81Section(content) {
  // Step 8.1 runs until step 8.2
  const match = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// T47: Diagnostic verify invocation on Final Test failure
// ---------------------------------------------------------------------------

describe('T47 — execute.md step 8.1c: diagnostic verify on failure', () => {
  it('execute.md exists', () => {
    assert.equal(
      fs.existsSync(executePath),
      true,
      'execute.md must exist at src/commands/df/execute.md'
    );
  });

  it('step 8.1 Final Test Agent section exists', () => {
    const content = getExecuteContent();
    assert.match(
      content,
      /8\.1\.\s+Final Test Agent/,
      'Step 8.1 should be titled "Final Test Agent"'
    );
  });

  it('step 8.1c invokes df:verify with --diagnostic flag on failure', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('--diagnostic'),
      'Step 8.1c should include --diagnostic flag'
    );
    assert.ok(
      step81.includes('df:verify'),
      'Step 8.1c should invoke df:verify'
    );
  });

  it('diagnostic verify uses --diagnostic doing-{name} argument pattern', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.match(
      step81,
      /--diagnostic\s+doing-\{name\}/,
      'Should use "--diagnostic doing-{name}" argument pattern'
    );
  });

  it('step 8.1c is triggered by test failure (not pass)', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    // 8.1c should be under the "Tests fail" branch
    assert.ok(
      step81.includes('Tests fail') || step81.includes('tests fail'),
      'Step 8.1c should be in the failure branch'
    );
  });
});

// ---------------------------------------------------------------------------
// T47: diagnostics: key in final-test-{spec}.yaml
// ---------------------------------------------------------------------------

describe('T47 — final-test-{spec}.yaml diagnostics key', () => {
  it('specifies writing to final-test-{spec}.yaml', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('final-test-{spec}.yaml'),
      'Should reference final-test-{spec}.yaml output file'
    );
  });

  it('yaml includes diagnostics: key', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('diagnostics:'),
      'YAML template should include diagnostics: key'
    );
  });

  it('diagnostics includes L0 level', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.match(
      step81,
      /L0:\s*\{pass\|fail\}/,
      'diagnostics should include L0 with pass/fail template'
    );
  });

  it('diagnostics includes L1 level', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.match(
      step81,
      /L1:\s*\{pass\|fail\}/,
      'diagnostics should include L1 with pass/fail template'
    );
  });

  it('diagnostics includes L2 level with warn option', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.match(
      step81,
      /L2:\s*\{pass\|warn\|fail\}/,
      'diagnostics should include L2 with pass/warn/fail template'
    );
  });

  it('diagnostics includes L4 level', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.match(
      step81,
      /L4:\s*\{pass\|fail\}/,
      'diagnostics should include L4 with pass/fail template'
    );
  });

  it('yaml includes status: blocked', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('status: blocked'),
      'YAML should include status: blocked'
    );
  });

  it('yaml includes reason field', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('reason:'),
      'YAML should include reason field'
    );
  });
});

// ---------------------------------------------------------------------------
// T47: Report format with checkmarks/warnings
// ---------------------------------------------------------------------------

describe('T47 — diagnostic report format', () => {
  it('report starts with failure marker', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('✗ Final tests failed'),
      'Report should start with "✗ Final tests failed"'
    );
  });

  it('report includes spec placeholder', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('for {spec}'),
      'Report should include "{spec}" placeholder'
    );
  });

  it('report includes "diagnostic verify:" label', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('diagnostic verify:'),
      'Report should include "diagnostic verify:" label'
    );
  });

  it('report shows L0 with checkmark/cross format', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.match(
      step81,
      /L0\s+\{[✓✗|]+\}/,
      'Report should show L0 with checkmark/cross placeholder'
    );
  });

  it('report shows L2 with warning option', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('⚠'),
      'Report should include warning symbol ⚠ for L2'
    );
  });

  it('report ends with "merge blocked"', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('merge blocked'),
      'Report should end with "merge blocked"'
    );
  });
});

// ---------------------------------------------------------------------------
// T47: Informational constraint — no fix agents, no retries
// ---------------------------------------------------------------------------

describe('T47 — diagnostic verify is informational only', () => {
  it('explicitly states "informational only"', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('informational only'),
      'Should explicitly state diagnostic verify is "informational only"'
    );
  });

  it('explicitly states "no fix agents"', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('no fix agents'),
      'Should explicitly state "no fix agents"'
    );
  });

  it('explicitly states "no retries"', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('no retries'),
      'Should explicitly state "no retries"'
    );
  });

  it('instructs to STOP after diagnostic', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('STOP'),
      'Should instruct to STOP after diagnostic verify'
    );
  });

  it('does NOT retry on failure (no re-spawn)', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('Do NOT retry') || step81.includes('Do not proceed to merge'),
      'Should not retry or proceed on failure'
    );
  });
});

// ---------------------------------------------------------------------------
// T47: Both branches — pass → full verify, fail → diagnostic
// ---------------------------------------------------------------------------

describe('T47 — step 8.1 both branches (pass/fail)', () => {
  it('step 8.1b: pass proceeds to step 8.2', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('Proceed to step 8.2'),
      'Pass branch should say "Proceed to step 8.2"'
    );
  });

  it('step 8.1b: pass branch mentions full L0-L5 verify', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('L0-L5'),
      'Pass branch should mention full L0-L5 verify'
    );
  });

  it('step 8.1b: pass branch mentions merge', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('verify + merge'),
      'Pass branch should mention merge alongside verify'
    );
  });

  it('step 8.1c: fail branch blocks merge', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('merge is blocked') || step81.includes('merge blocked'),
      'Fail branch should block merge'
    );
  });

  it('step 8.1c: fail branch sets tasks back to pending', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('status: "pending"'),
      'Fail branch should set tasks back to pending'
    );
  });

  it('step 8.1c: fail branch leaves worktree intact', () => {
    const content = getExecuteContent();
    const step81 = getStep81Section(content);
    assert.ok(step81, 'Should have step 8.1 section');
    assert.ok(
      step81.includes('Leave worktree intact'),
      'Fail branch should leave worktree intact'
    );
  });
});

// ---------------------------------------------------------------------------
// T47: Rules table update
// ---------------------------------------------------------------------------

describe('T47 — Rules table updated for Final Test row', () => {
  it('rules table has "Final test" row', () => {
    const content = getExecuteContent();
    assert.ok(
      content.includes('Final test before merge'),
      'Rules table should have "Final test before merge" row'
    );
  });

  it('rules table documents pass branch (full L0-L5 verify + merge)', () => {
    const content = getExecuteContent();
    // Find the Final test rule row
    const lines = content.split('\n');
    const ruleLine = lines.find(l => l.includes('Final test before merge'));
    assert.ok(ruleLine, 'Should have Final test rule row');
    assert.ok(
      ruleLine.includes('L0-L5') || ruleLine.includes('full'),
      'Final test rule should mention full L0-L5 verify for pass branch'
    );
  });

  it('rules table documents fail branch (diagnostic L0-L4)', () => {
    const content = getExecuteContent();
    const lines = content.split('\n');
    const ruleLine = lines.find(l => l.includes('Final test before merge'));
    assert.ok(ruleLine, 'Should have Final test rule row');
    assert.ok(
      ruleLine.includes('diagnostic'),
      'Final test rule should mention diagnostic for fail branch'
    );
  });

  it('rules table mentions final-test-{spec}.yaml', () => {
    const content = getExecuteContent();
    const lines = content.split('\n');
    const ruleLine = lines.find(l => l.includes('Final test before merge'));
    assert.ok(ruleLine, 'Should have Final test rule row');
    assert.ok(
      ruleLine.includes('final-test-{spec}.yaml'),
      'Final test rule should mention output file final-test-{spec}.yaml'
    );
  });

  it('rules table mentions merge blocked on failure', () => {
    const content = getExecuteContent();
    const lines = content.split('\n');
    const ruleLine = lines.find(l => l.includes('Final test before merge'));
    assert.ok(ruleLine, 'Should have Final test rule row');
    assert.ok(
      ruleLine.includes('merge blocked') || ruleLine.includes('blocked'),
      'Final test rule should mention merge blocked on failure'
    );
  });

  it('rules table documents both branches in same row', () => {
    const content = getExecuteContent();
    const lines = content.split('\n');
    const ruleLine = lines.find(l => l.includes('Final test before merge'));
    assert.ok(ruleLine, 'Should have Final test rule row');
    // Both pass and fail outcomes should be in the same row
    assert.ok(
      ruleLine.includes('pass') && (ruleLine.includes('fail') || ruleLine.includes('diagnostic')),
      'Final test rule should document both pass and fail branches'
    );
  });
});
