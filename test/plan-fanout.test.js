/**
 * Tests for plan-fanout spec (T4).
 *
 * Verifies §4.7 FAN-OUT ORCHESTRATION section in plan.md:
 *   - Section structure: 4.7, 4.7.1, 4.7.2, 4.7.3 subsections exist
 *   - Skip condition for single-spec case
 *   - Count & cap logic (1, 2-5, >5 ranges documented)
 *   - Sub-agent prompt template includes all 7 required elements
 *   - Format enforcement clause contains mandatory rules
 *   - Collect mini-plans error handling (graceful skip)
 *   - Flow continuity to §5
 *
 * Uses Node.js built-in node:test to match project conventions (see bin/install.test.js).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const planPath = path.join(ROOT, 'src', 'commands', 'df', 'plan.md');

// Helper: extract the §4.7 section (from ### 4.7 up to ### 5.)
function getFanOutSection() {
  const content = fs.readFileSync(planPath, 'utf8');
  const match = content.match(/### 4\.7\. FAN-OUT ORCHESTRATION[\s\S]*?(?=### 5\.)/);
  assert.ok(match, 'plan.md must contain §4.7 FAN-OUT ORCHESTRATION section');
  return match[0];
}

// ---------------------------------------------------------------------------
// §4.7 Section Structure
// ---------------------------------------------------------------------------

describe('§4.7 FAN-OUT ORCHESTRATION — structure', () => {
  it('§4.7 section exists with correct heading', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    assert.match(content, /### 4\.7\. FAN-OUT ORCHESTRATION \(MULTI-SPEC\)/);
  });

  it('has subsection 4.7.1 Count & Cap', () => {
    const section = getFanOutSection();
    assert.match(section, /#### 4\.7\.1\. Count & Cap/);
  });

  it('has subsection 4.7.2 Spawn Sub-Agents', () => {
    const section = getFanOutSection();
    assert.match(section, /#### 4\.7\.2\. Spawn Sub-Agents/);
  });

  it('has subsection 4.7.3 Collect Mini-Plans', () => {
    const section = getFanOutSection();
    assert.match(section, /#### 4\.7\.3\. Collect Mini-Plans/);
  });

  it('subsections appear in correct order (4.7.1 → 4.7.2 → 4.7.3)', () => {
    const section = getFanOutSection();
    const idx1 = section.indexOf('4.7.1');
    const idx2 = section.indexOf('4.7.2');
    const idx3 = section.indexOf('4.7.3');
    assert.ok(idx1 < idx2, '4.7.1 must come before 4.7.2');
    assert.ok(idx2 < idx3, '4.7.2 must come before 4.7.3');
  });
});

// ---------------------------------------------------------------------------
// §4.7 Skip Condition
// ---------------------------------------------------------------------------

describe('§4.7 — skip condition for single spec', () => {
  it('documents the single-spec skip condition', () => {
    const section = getFanOutSection();
    assert.match(section, /[Ss]kip condition/);
  });

  it('skip triggers when exactly 1 plannable spec', () => {
    const section = getFanOutSection();
    assert.match(section, /exactly 1 plannable spec/);
  });

  it('skip directs to §5 monolithic path', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('skip to §5') || section.includes('continue to §5'),
      'Skip condition should route to §5 monolithic path'
    );
  });

  it('skip explicitly mentions zero overhead', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('zero overhead'),
      'Skip condition should emphasize zero overhead for single-spec case'
    );
  });
});

// ---------------------------------------------------------------------------
// §4.7.1 Count & Cap
// ---------------------------------------------------------------------------

describe('§4.7.1 — Count & Cap logic', () => {
  it('documents the 1-spec path (monolithic)', () => {
    const section = getFanOutSection();
    assert.match(section, /\*\*1 spec\*\*.*skip to §5/);
  });

  it('documents the 2-5 spec range (fan-out all)', () => {
    const section = getFanOutSection();
    assert.match(section, /2.5 specs/);
    assert.ok(section.includes('fan-out all'), 'Should fan-out all for 2-5 specs');
  });

  it('documents the >5 spec cap at 5', () => {
    const section = getFanOutSection();
    assert.match(section, />5 specs/);
    assert.ok(section.includes('first 5'), 'Should select first 5 specs');
  });

  it('documents filesystem ls order for >5 selection', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('ls') && section.includes('order'),
      'Should specify filesystem ls order for spec selection'
    );
  });

  it('documents re-run message for queued specs', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Re-run /df:plan') || section.includes('Re-run'),
      'Should tell user to re-run for remaining specs'
    );
  });

  it('counts only plannable specs (no doing-/done- prefix)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('doing-') && section.includes('done-'),
      'Should exclude doing-/done- prefixed specs from count'
    );
  });

  it('requires validateSpec to pass', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('validateSpec'),
      'Should require specs pass validateSpec'
    );
  });
});

// ---------------------------------------------------------------------------
// §4.7.2 Sub-Agent Prompt — Required Elements
// ---------------------------------------------------------------------------

describe('§4.7.2 — sub-agent prompt required elements', () => {
  it('specifies parallel non-background Task calls', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('parallel non-background'),
      'Should specify parallel non-background execution'
    );
  });

  it('specifies model as sonnet', () => {
    const section = getFanOutSection();
    assert.match(section, /model.*sonnet/i);
  });

  it('prompt element 1: layer-gating rules from §1.5', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Layer-gating rules') && section.includes('§1.5'),
      'Must include layer-gating rules referencing §1.5'
    );
  });

  it('prompt element 2: experiment check results from §2', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Experiment check results') && section.includes('§2'),
      'Must include experiment check results referencing §2'
    );
  });

  it('prompt element 2: references experiment statuses (passed/failed/active)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('--passed.md') &&
      section.includes('--failed.md') &&
      section.includes('--active.md'),
      'Must reference all three experiment statuses'
    );
  });

  it('prompt element 3: project context from §3', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Project context') && section.includes('§3'),
      'Must include project context referencing §3'
    );
  });

  it('prompt element 4: impact analysis instructions from §4 (L3 only)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Impact analysis instructions') && section.includes('L3 specs only'),
      'Must include impact analysis for L3 specs, referencing §4'
    );
  });

  it('prompt element 5: targeted exploration instructions from §4.5', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Targeted exploration instructions') && section.includes('§4.5'),
      'Must include targeted exploration referencing §4.5'
    );
  });

  it('prompt element 5: references explore-agent.md template', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('explore-agent.md'),
      'Must reference explore-agent.md template'
    );
  });

  it('prompt element 6: the spec content (full text)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('The spec content') && section.includes('Full text'),
      'Must include full spec content'
    );
  });

  it('prompt element 7: format enforcement clause', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Format enforcement clause'),
      'Must include format enforcement clause'
    );
  });

  it('all 7 prompt elements are numbered', () => {
    const section = getFanOutSection();
    // Check that numbered list items 1-7 exist
    for (let i = 1; i <= 7; i++) {
      assert.match(
        section,
        new RegExp(`${i}\\.\\s+\\*\\*`),
        `Numbered prompt element ${i} must exist`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §4.7.2 Format Enforcement Clause
// ---------------------------------------------------------------------------

describe('§4.7.2 — format enforcement clause contents', () => {
  it('contains OUTPUT FORMAT — MANDATORY header', () => {
    const section = getFanOutSection();
    assert.ok(section.includes('OUTPUT FORMAT — MANDATORY'));
  });

  it('requires local T-numbering starting at T1', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('local T-numbering') && section.includes('T1'),
      'Format clause must specify local T-numbering starting at T1'
    );
  });

  it('requires "Blocked by: none" (not N/A or empty)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('"Blocked by: none" is required') &&
      section.includes('not "N/A"') &&
      section.includes('not empty'),
      'Must mandate "Blocked by: none" and reject N/A or empty'
    );
  });

  it('enforces one task = one atomic commit', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('One task = one atomic commit'),
      'Must enforce atomic commit rule'
    );
  });

  it('documents spike task format with [SPIKE] tag', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('[SPIKE]'),
      'Must document [SPIKE] tag format'
    );
  });

  it('restricts L0-L1 specs to spike tasks only', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('L0-L1 specs: ONLY spike tasks allowed'),
      'Must restrict L0-L1 to spikes only'
    );
  });

  it('allows L2+ specs to have spikes + implementation tasks', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('L2+ specs: spikes + implementation tasks allowed'),
      'Must allow L2+ spikes and implementation'
    );
  });

  it('requires Impact blocks for L3 specs', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('L3 specs: include Impact:'),
      'Must require Impact blocks for L3 specs'
    );
  });

  it('includes Files field in task format', () => {
    const section = getFanOutSection();
    assert.match(section, /Files:.*comma-separated/);
  });

  it('includes optional Model, Effort, Impact, Optimize fields', () => {
    const section = getFanOutSection();
    assert.ok(section.includes('Model: haiku | sonnet | opus'));
    assert.ok(section.includes('Effort: low | medium | high'));
    assert.ok(section.includes('Impact:'));
    assert.ok(section.includes('Optimize:'));
  });
});

// ---------------------------------------------------------------------------
// §4.7.3 Collect Mini-Plans — Error Handling
// ---------------------------------------------------------------------------

describe('§4.7.3 — collect mini-plans', () => {
  it('documents graceful handling of empty sub-agent output', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('empty') && section.includes('skip that spec'),
      'Should gracefully skip specs with empty output'
    );
  });

  it('documents graceful handling of unparseable sub-agent output', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('unparseable') && section.includes('skip that spec'),
      'Should gracefully skip specs with unparseable output'
    );
  });

  it('does not fail the entire plan on sub-agent failure', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('do not fail the entire plan'),
      'Must not fail entire plan on individual sub-agent failure'
    );
  });

  it('stores results as { specName, miniPlan } objects', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('specName') && section.includes('miniPlan'),
      'Must store results with specName and miniPlan fields'
    );
  });

  it('passes collected mini-plans to §5 for consolidation', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('passed to §5') && section.includes('consolidation'),
      'Must pass results to §5 for consolidation'
    );
  });

  it('§5 handles both monolithic and multi-spec paths', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('single-spec monolithic path') &&
      section.includes('multi-spec consolidation path'),
      '§5 must handle both paths'
    );
  });
});

// ---------------------------------------------------------------------------
// §4.7 — Trigger condition
// ---------------------------------------------------------------------------

describe('§4.7 — trigger condition', () => {
  it('triggers when >1 plannable spec found in §1', () => {
    const section = getFanOutSection();
    assert.match(section, /\*\*When:\*\*.*>1 plannable spec/);
  });

  it('references §1 for spec discovery', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('found in §1'),
      'Trigger must reference §1 for spec discovery'
    );
  });
});
