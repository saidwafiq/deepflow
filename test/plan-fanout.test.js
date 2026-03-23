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

// ===========================================================================
// WAVE 2 — §5 TWO-PATH ARCHITECTURE (T5)
// ===========================================================================

// Helper: extract the full §5 section (from ### 5. up to ### 5.5. or ### 6.)
function getSection5() {
  const content = fs.readFileSync(planPath, 'utf8');
  const match = content.match(/### 5\. COMPARE & PRIORITIZE[\s\S]*?(?=### 5\.5\.|### 6\.)/);
  assert.ok(match, 'plan.md must contain §5 COMPARE & PRIORITIZE section');
  return match[0];
}

// Helper: extract §5A subsection
function getSection5A() {
  const s5 = getSection5();
  const match = s5.match(/#### 5A\. SINGLE-SPEC[\s\S]*?(?=#### 5B\.)/);
  assert.ok(match, 'plan.md must contain §5A SINGLE-SPEC subsection');
  return match[0];
}

// Helper: extract §5B subsection
function getSection5B() {
  const s5 = getSection5();
  const match = s5.match(/#### 5B\. MULTI-SPEC CONSOLIDATOR[\s\S]*/);
  assert.ok(match, 'plan.md must contain §5B MULTI-SPEC CONSOLIDATOR subsection');
  return match[0];
}

// Helper: extract §5.5 section
function getSection55() {
  const content = fs.readFileSync(planPath, 'utf8');
  const match = content.match(/### 5\.5\. CLASSIFY MODEL \+ EFFORT[\s\S]*?(?=### 6\.)/);
  assert.ok(match, 'plan.md must contain §5.5 section');
  return match[0];
}

// ---------------------------------------------------------------------------
// §5 Two-Path Routing
// ---------------------------------------------------------------------------

describe('§5 — two-path architecture', () => {
  it('§5 heading exists', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    assert.match(content, /### 5\. COMPARE & PRIORITIZE/);
  });

  it('declares two paths determined by spec count', () => {
    const s5 = getSection5();
    assert.ok(
      s5.includes('Two paths') && s5.includes('spec count'),
      '§5 must state two paths determined by spec count'
    );
  });

  it('contains §5A subsection', () => {
    const s5 = getSection5();
    assert.match(s5, /#### 5A\. SINGLE-SPEC/);
  });

  it('contains §5B subsection', () => {
    const s5 = getSection5();
    assert.match(s5, /#### 5B\. MULTI-SPEC CONSOLIDATOR/);
  });

  it('§5A appears before §5B', () => {
    const s5 = getSection5();
    const idxA = s5.indexOf('5A.');
    const idxB = s5.indexOf('5B.');
    assert.ok(idxA < idxB, '§5A must come before §5B');
  });
});

// ---------------------------------------------------------------------------
// §5A Monolithic Path Preservation
// ---------------------------------------------------------------------------

describe('§5A — single-spec monolithic path', () => {
  it('triggers when exactly 1 plannable spec', () => {
    const s5a = getSection5A();
    assert.match(s5a, /\*\*When:\*\*.*[Ee]xactly 1 plannable spec/);
  });

  it('notes §4.7 was skipped', () => {
    const s5a = getSection5A();
    assert.ok(
      s5a.includes('§4.7 was skipped'),
      '§5A must note that §4.7 was skipped for single spec'
    );
  });

  it('spawns reasoner with opus model', () => {
    const s5a = getSection5A();
    assert.ok(
      s5a.includes('subagent_type="reasoner"') && s5a.includes('model="opus"'),
      '§5A must spawn Task with reasoner/opus'
    );
  });

  it('maps requirements to DONE/PARTIAL/MISSING/CONFLICT', () => {
    const s5a = getSection5A();
    assert.ok(s5a.includes('DONE'), 'Must include DONE status');
    assert.ok(s5a.includes('PARTIAL'), 'Must include PARTIAL status');
    assert.ok(s5a.includes('MISSING'), 'Must include MISSING status');
    assert.ok(s5a.includes('CONFLICT'), 'Must include CONFLICT status');
  });

  it('preserves metric AC detection subsection', () => {
    const s5a = getSection5A();
    assert.match(s5a, /Metric AC Detection/);
  });

  it('metric AC detection scans for operator pattern', () => {
    const s5a = getSection5A();
    assert.ok(
      s5a.includes('{metric}') && s5a.includes('{operator}') && s5a.includes('{number}'),
      'Metric AC must document the scan pattern'
    );
  });

  it('continues to §6 after completion', () => {
    const s5a = getSection5A();
    assert.ok(
      s5a.includes('Continue to §6'),
      '§5A must direct to §6 after completion'
    );
  });

  it('applies §5.5 routing matrix', () => {
    const s5a = getSection5A();
    assert.ok(
      s5a.includes('§5.5 routing matrix'),
      '§5A must reference §5.5 routing matrix'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B Consolidator — Structure
// ---------------------------------------------------------------------------

describe('§5B — multi-spec consolidator structure', () => {
  it('triggers when >1 plannable spec', () => {
    const s5b = getSection5B();
    assert.match(s5b, /\*\*When:\*\*.*>1 plannable spec/);
  });

  it('notes §4.7 produced mini-plans', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('§4.7 produced mini-plans'),
      '§5B must state §4.7 produced mini-plans'
    );
  });

  it('spawns single Task with reasoner/opus', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Spawn a single') &&
      s5b.includes('subagent_type="reasoner"') &&
      s5b.includes('model="opus"'),
      '§5B must spawn a single reasoner/opus Task'
    );
  });

  it('consolidator prompt starts with role declaration', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('You are the plan consolidator'),
      'Prompt must start with plan consolidator role'
    );
  });

  it('prompt includes input mini-plans template with specName iteration', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('{for each entry in miniPlans array:}') &&
      s5b.includes('{specName}') &&
      s5b.includes('{miniPlan content}'),
      'Prompt must template mini-plan iteration'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B Consolidator — 7 Steps
// ---------------------------------------------------------------------------

describe('§5B consolidator — step completeness', () => {
  it('contains all 7 instruction steps', () => {
    const s5b = getSection5B();
    for (let i = 1; i <= 7; i++) {
      assert.match(
        s5b,
        new RegExp(`### Step ${i}:`),
        `Consolidator must contain Step ${i}`
      );
    }
  });

  it('Step 1: Spec Priority Ordering', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 1: Spec Priority Ordering'));
  });

  it('Step 2: Global T-Number Assignment', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 2: Global T-Number Assignment'));
  });

  it('Step 3: Cross-Spec File Conflict Detection', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 3: Cross-Spec File Conflict Detection'));
  });

  it('Step 4: Requirement Mapping', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 4: Requirement Mapping'));
  });

  it('Step 5: Metric AC Detection', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 5: Metric AC Detection'));
  });

  it('Step 6: Model + Effort Classification', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 6: Model + Effort Classification'));
  });

  it('Step 7: Output', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Step 7: Output'));
  });
});

// ---------------------------------------------------------------------------
// §5B — Global T-Numbering (Step 2)
// ---------------------------------------------------------------------------

describe('§5B Step 2 — global T-number assignment', () => {
  it('assigns sequential T-numbers T1..TN', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('T1, T2, ..., TN'),
      'Must specify sequential T1..TN numbering'
    );
  });

  it('requires NO gaps and NO duplicates', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('NO gaps') && s5b.includes('NO duplicates'),
      'Must forbid gaps and duplicates'
    );
  });

  it('preserves local task ordering within each spec', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('preserve the local task ordering'),
      'Must preserve local ordering'
    );
  });

  it('translates local Blocked-by references to global T-IDs', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Translate all intra-spec') && s5b.includes('global T-IDs'),
      'Must translate local blocked-by to global IDs'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B — Cross-Spec File Conflict Detection (Step 3)
// ---------------------------------------------------------------------------

describe('§5B Step 3 — cross-spec file conflict detection', () => {
  it('builds file → [global task IDs] map', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('file → [global task IDs]'),
      'Must build file-to-task-IDs map'
    );
  });

  it('detects files in >1 task across different specs', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('>1 task across different specs'),
      'Must detect cross-spec file overlaps'
    );
  });

  it('adds Blocked by from later task to earlier task', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('later task → the earlier task'),
      'Must block later task on earlier one'
    );
  });

  it('requires [file-conflict: {filename}] annotation', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('[file-conflict: {filename}]'),
      'Must annotate with [file-conflict: {filename}]'
    );
  });

  it('skips if dependency already exists (direct or transitive)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Skip if a dependency already exists'),
      'Must skip redundant dependencies'
    );
  });

  it('chains only to nearest earlier task (not all earlier)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Chain only') && s5b.includes('nearest earlier task'),
      'Must chain to nearest, not all earlier tasks'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B — Model/Effort Routing (Step 6)
// ---------------------------------------------------------------------------

describe('§5B Step 6 — model + effort routing inside consolidator', () => {
  it('contains routing matrix table', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('| Task type | Model | Effort |'),
      'Must contain routing matrix table header'
    );
  });

  it('includes haiku-level tasks (bootstrap, browse-fetch)', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Bootstrap') && s5b.includes('haiku'));
    assert.ok(s5b.includes('browse-fetch'));
  });

  it('includes sonnet-level tasks (multi-file, bug fix)', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Multi-file with clear specs'));
    assert.ok(s5b.includes('Bug fix (clear repro)'));
  });

  it('includes opus-level tasks (optimize, architecture)', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Optimize (metric AC)'));
    assert.ok(s5b.includes('Architecture change'));
  });

  it('documents retry escalation (raise one level)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Retried after revert') && s5b.includes('raise one level'),
      'Must document retry escalation'
    );
  });

  it('defaults to sonnet / medium', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Defaults: sonnet / medium'),
      'Must default to sonnet/medium'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B — Summary Table in Output (Step 7)
// ---------------------------------------------------------------------------

describe('§5B Step 7 — output format', () => {
  it('output includes Summary table with 4 metrics', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Specs analyzed'));
    assert.ok(s5b.includes('Tasks created'));
    assert.ok(s5b.includes('Ready (no blockers)'));
    assert.ok(s5b.includes('Blocked'));
  });

  it('output includes Spec Gaps section', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('## Spec Gaps'),
      'Must include Spec Gaps section'
    );
  });

  it('groups tasks under ### doing-{spec-name} headers', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('### doing-{spec-name-1}') && s5b.includes('### doing-{spec-name-2}'),
      'Tasks must be grouped under doing-{spec-name} headers'
    );
  });

  it('task format includes Files, Model, Effort, Blocked by fields', () => {
    const s5b = getSection5B();
    // Check within the output template
    assert.ok(s5b.includes('- Files:'));
    assert.ok(s5b.includes('- Model:'));
    assert.ok(s5b.includes('- Effort:'));
    assert.ok(s5b.includes('- Blocked by:'));
  });
});

// ---------------------------------------------------------------------------
// §5B — Output Rules
// ---------------------------------------------------------------------------

describe('§5B — output rules', () => {
  it('T-numbers MUST be globally sequential with no gaps/duplicates', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('T-numbers MUST be globally sequential'),
      'Must enforce globally sequential T-numbers'
    );
  });

  it('requires doing-{spec-name} grouping', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Group tasks under `### doing-{spec-name}` headers'),
      'Must require spec-name grouping'
    );
  });

  it('preserves optional fields from mini-plans', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Preserve all optional fields from mini-plans'),
      'Must preserve optional fields'
    );
  });

  it('requires [file-conflict] annotations for cross-spec overlaps', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('[file-conflict: {filename}] annotations are REQUIRED'),
      'Must require file-conflict annotations'
    );
  });

  it('mandates "Blocked by: none" format (not N/A or empty)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('"Blocked by: none" is required') &&
      s5b.includes('not "N/A"') &&
      s5b.includes('not empty'),
      'Must mandate Blocked by: none format'
    );
  });

  it('spike tasks keep [SPIKE] or [OPTIMIZE] markers', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('[SPIKE]') && s5b.includes('[OPTIMIZE]'),
      'Must keep spike/optimize markers'
    );
  });
});

// ---------------------------------------------------------------------------
// REQ-12: Single Opus Invocation
// ---------------------------------------------------------------------------

describe('REQ-12 — single Opus invocation in fan-out path', () => {
  it('§5B states it is the ONLY Opus invocation in fan-out path', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('ONLY Opus invocation in the fan-out path'),
      'Must declare single Opus invocation constraint'
    );
  });

  it('§5B references REQ-12', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('REQ-12'),
      'Must reference REQ-12'
    );
  });

  it('sub-agents in §4.7 use Sonnet (not Opus)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Sub-agents in §4.7 use Sonnet'),
      'Must confirm §4.7 sub-agents use Sonnet'
    );
  });
});

// ---------------------------------------------------------------------------
// REQ-7: Ephemeral Mini-Plans
// ---------------------------------------------------------------------------

describe('REQ-7 — ephemeral mini-plans', () => {
  it('mini-plans are never written to disk', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('never written to disk'),
      'Mini-plans must be ephemeral, never persisted'
    );
  });

  it('mini-plans exist only as sub-agent return values', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('exist only as sub-agent return values'),
      'Mini-plans must only be in-memory return values'
    );
  });

  it('references REQ-7', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('REQ-7'),
      'Must reference REQ-7'
    );
  });
});

// ---------------------------------------------------------------------------
// §8/§9 remain in orchestrator (REQ-13)
// ---------------------------------------------------------------------------

describe('REQ-13 — §8 cleanup and §9 output remain in orchestrator', () => {
  it('post-consolidation notes §8 and §9 run in orchestrator', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('§8 cleanup') && s5b.includes('§9 output'),
      'Must state §8/§9 run after consolidation'
    );
  });

  it('references REQ-13', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('REQ-13'),
      'Must reference REQ-13'
    );
  });

  it('§8/§9 run after consolidation step', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('run after this step in the orchestrator'),
      'Must confirm §8/§9 run after consolidation in orchestrator'
    );
  });
});

// ---------------------------------------------------------------------------
// §5.5 Monolithic-Only Scoping
// ---------------------------------------------------------------------------

describe('§5.5 — monolithic-only scoping', () => {
  it('§5.5 notes it applies only to monolithic path (§5A)', () => {
    const s55 = getSection55();
    assert.ok(
      s55.includes('applies only to the monolithic path'),
      '§5.5 must be scoped to monolithic path only'
    );
  });

  it('§5.5 notes fan-out path handles classification inside consolidator', () => {
    const s55 = getSection55();
    assert.ok(
      s55.includes('fan-out path') && s55.includes('consolidator prompt'),
      '§5.5 must note fan-out classification is in consolidator'
    );
  });
});
