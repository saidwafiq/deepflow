/**
 * Tests for ratchet-hardening spec (T48).
 *
 * T48 — Verifies execute.md §5.5 RATCHET CHECK hardening:
 *   1. Uses `node bin/ratchet.js` instead of inline health check commands
 *   2. Outputs structured JSON (PASS/FAIL/SALVAGEABLE)
 *   3. Prohibits reinterpreting test failures
 *   4. Prohibits git stash, git checkout for investigation
 *   5. Prohibits inline edits to pre-existing test files
 *   6. Broken-tests policy requires separate PLAN.md task
 *   7. SALVAGEABLE spawns haiku fix agent
 *   8. Preserves metric gate, edit scope validation, token tracking
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
// Helper: extract §5.5 RATCHET CHECK section
// ---------------------------------------------------------------------------

function getExecuteContent() {
  return fs.readFileSync(executePath, 'utf8');
}

function getSection55(content) {
  // §5.5 runs from "### 5.5. RATCHET CHECK" until the next ### heading
  const match = content.match(/### 5\.5\. RATCHET CHECK[\s\S]*?(?=###\s)/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// T48: §5.5 uses node bin/ratchet.js
// ---------------------------------------------------------------------------

describe('T48 — §5.5 uses node bin/ratchet.js instead of inline health checks', () => {
  it('execute.md exists', () => {
    assert.equal(
      fs.existsSync(executePath),
      true,
      'execute.md must exist at src/commands/df/execute.md'
    );
  });

  it('§5.5 RATCHET CHECK section exists', () => {
    const content = getExecuteContent();
    assert.match(
      content,
      /### 5\.5\. RATCHET CHECK/,
      '§5.5 should be titled "RATCHET CHECK"'
    );
  });

  it('§5.5 contains node bin/ratchet.js call', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('node bin/ratchet.js'),
      '§5.5 should invoke node bin/ratchet.js'
    );
  });

  it('§5.5 does NOT contain inline health check table with | Build |', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.equal(
      section.includes('| Build |'),
      false,
      '§5.5 should NOT contain inline health check table row "| Build |"'
    );
  });

  it('§5.5 does NOT contain npm run build in ratchet section', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.equal(
      section.includes('npm run build'),
      false,
      '§5.5 should NOT contain "npm run build" inline command'
    );
  });

  it('§5.5 does NOT contain npm test in ratchet section', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.equal(
      section.includes('npm test'),
      false,
      '§5.5 should NOT contain "npm test" inline command'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Structured JSON output parsing
// ---------------------------------------------------------------------------

describe('T48 — §5.5 structured JSON output (PASS/FAIL/SALVAGEABLE)', () => {
  it('§5.5 documents PASS status', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('"PASS"'),
      '§5.5 should document PASS status in JSON output'
    );
  });

  it('§5.5 documents FAIL status', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('"FAIL"'),
      '§5.5 should document FAIL status in JSON output'
    );
  });

  it('§5.5 documents SALVAGEABLE status', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('"SALVAGEABLE"'),
      '§5.5 should document SALVAGEABLE status in JSON output'
    );
  });

  it('§5.5 documents exit codes for each status', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(section.includes('Exit 0'), '§5.5 should document exit code 0');
    assert.ok(section.includes('Exit 1'), '§5.5 should document exit code 1');
    assert.ok(section.includes('Exit 2'), '§5.5 should document exit code 2');
  });
});

// ---------------------------------------------------------------------------
// T48: Prohibition against reinterpreting test failures
// ---------------------------------------------------------------------------

describe('T48 — §5.5 prohibition on reinterpreting test failures', () => {
  it('§5.5 contains prohibition text about not reinterpreting test failures', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('MUST NOT inspect, classify, or reinterpret test failures'),
      '§5.5 should contain prohibition: "MUST NOT inspect, classify, or reinterpret test failures"'
    );
  });

  it('§5.5 states FAIL means revert with no exceptions', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('FAIL means revert. No exceptions'),
      '§5.5 should state "FAIL means revert. No exceptions"'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Prohibition against git stash and git checkout
// ---------------------------------------------------------------------------

describe('T48 — §5.5 prohibition on git stash and git checkout', () => {
  it('§5.5 prohibits git stash', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('git stash'),
      '§5.5 should mention git stash in prohibited actions'
    );
  });

  it('§5.5 prohibits git checkout for investigation', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('git checkout'),
      '§5.5 should mention git checkout in prohibited actions'
    );
  });

  it('§5.5 lists prohibited actions section', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Prohibited actions'),
      '§5.5 should have a "Prohibited actions" section'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Prohibition against inline edits to pre-existing test files
// ---------------------------------------------------------------------------

describe('T48 — §5.5 prohibition on inline edits to pre-existing test files', () => {
  it('§5.5 prohibits inline edits to pre-existing test files', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('No inline edits to pre-existing test files'),
      '§5.5 should prohibit inline edits to pre-existing test files'
    );
  });

  it('§5.5 prohibits reading raw test output to decide failures', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('No reading raw test output'),
      '§5.5 should prohibit reading raw test output to decide failures'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Broken-tests policy (separate PLAN.md task)
// ---------------------------------------------------------------------------

describe('T48 — §5.5 broken-tests policy', () => {
  it('§5.5 contains broken-tests policy', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Broken-tests policy'),
      '§5.5 should contain "Broken-tests policy" section'
    );
  });

  it('§5.5 requires separate dedicated task in PLAN.md for pre-existing test updates', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('separate dedicated task in PLAN.md'),
      '§5.5 should require a separate dedicated task in PLAN.md'
    );
  });

  it('§5.5 requires explicit justification for pre-existing test updates', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('explicit justification'),
      '§5.5 should require explicit justification'
    );
  });

  it('§5.5 forbids inline test updates during execution', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('never inline during execution'),
      '§5.5 should forbid inline test updates during execution'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: SALVAGEABLE handling with haiku agent
// ---------------------------------------------------------------------------

describe('T48 — §5.5 SALVAGEABLE handling with haiku agent', () => {
  it('§5.5 spawns haiku agent for SALVAGEABLE', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('haiku'),
      '§5.5 should reference haiku model for SALVAGEABLE fix'
    );
  });

  it('§5.5 SALVAGEABLE is for lint/typecheck only (build+tests passed)', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('lint/typecheck'),
      '§5.5 should specify SALVAGEABLE is for lint/typecheck issues'
    );
  });

  it('§5.5 re-runs ratchet after haiku fix', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.match(
      section,
      /Re-run.*ratchet|re-run.*ratchet|Re-run.*node bin\/ratchet/i,
      '§5.5 should re-run ratchet after haiku fix'
    );
  });

  it('§5.5 reverts if haiku fix still fails', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('still non-zero') || section.includes('revert both'),
      '§5.5 should revert if haiku fix still fails'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Preserved features — metric gate for OPTIMIZE
// ---------------------------------------------------------------------------

describe('T48 — §5.5 preserves metric gate for OPTIMIZE tasks', () => {
  it('§5.5 contains metric gate section', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Metric gate'),
      '§5.5 should contain "Metric gate" section'
    );
  });

  it('§5.5 metric gate is Optimize only', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Optimize only'),
      '§5.5 metric gate should be marked "Optimize only"'
    );
  });

  it('§5.5 metric gate requires both ratchet AND metric to pass', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('ratchet AND metric'),
      '§5.5 should require both ratchet AND metric to pass'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Preserved features — edit scope validation
// ---------------------------------------------------------------------------

describe('T48 — §5.5 preserves edit scope validation', () => {
  it('§5.5 contains edit scope validation', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Edit scope validation'),
      '§5.5 should contain "Edit scope validation"'
    );
  });

  it('§5.5 edit scope uses git diff for file list', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('git diff HEAD~1 --name-only'),
      '§5.5 should use git diff HEAD~1 --name-only for edit scope'
    );
  });

  it('§5.5 edit scope violation triggers revert', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.match(
      section,
      /Violation.*revert/,
      '§5.5 should revert on edit scope violation'
    );
  });
});

// ---------------------------------------------------------------------------
// T48: Preserved features — token tracking
// ---------------------------------------------------------------------------

describe('T48 — §5.5 preserves token tracking', () => {
  it('§5.5 contains token tracking section', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Token tracking'),
      '§5.5 should contain "Token tracking" section'
    );
  });

  it('§5.5 token tracking writes to results/T{N}.yaml', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.match(
      section,
      /\.deepflow\/results\/T\{N\}\.yaml/,
      '§5.5 should write token tracking to .deepflow/results/T{N}.yaml'
    );
  });

  it('§5.5 token tracking includes percentage fields', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('start_percentage') && section.includes('end_percentage') && section.includes('delta_percentage'),
      '§5.5 should include start/end/delta percentage fields'
    );
  });

  it('§5.5 token tracking never fails ratchet', () => {
    const content = getExecuteContent();
    const section = getSection55(content);
    assert.ok(section, 'Should have §5.5 section');
    assert.ok(
      section.includes('Never fail ratchet for tracking errors'),
      '§5.5 should state token tracking never fails ratchet'
    );
  });
});
