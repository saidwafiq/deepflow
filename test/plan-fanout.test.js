/**
 * Tests for plan-fanout spec (v2 design).
 *
 * Verifies §4.7 FAN-OUT ORCHESTRATION section in plan.md:
 *   - Section structure: 4.7, 4.7.1, 4.7.2, 4.7.3 subsections exist
 *   - Skip condition for single-spec case
 *   - Count & cap logic (1, 2-5, >5 ranges documented)
 *   - Thin dispatcher: sub-agent receives ONLY spec file path
 *   - Mini-plans saved to .deepflow/plans/doing-{name}.md (persistent)
 *   - Collect mini-plans error handling (graceful skip)
 *   - Flow continuity to §5
 *
 * v2 design changes:
 *   - Sub-agent prompt contains ONLY spec file path (no pre-computed context)
 *   - Mini-plans saved to .deepflow/plans/doing-{name}.md (persistent files)
 *   - Consolidator reads from .deepflow/plans/, delegates mechanical work to bin/plan-consolidator.js
 *   - Single-spec path runs monolithic (no fan-out)
 *   - Fan-out capped at 5 specs
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

  it('has subsection 4.7.3 Collect & Persist Mini-Plans', () => {
    const section = getFanOutSection();
    assert.match(section, /#### 4\.7\.3\. Collect & Persist Mini-Plans/);
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
// §4.7.2 Thin Dispatcher — v2 design
// ---------------------------------------------------------------------------

describe('§4.7.2 — thin dispatcher (v2 design)', () => {
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

  it('master orchestrator is a thin dispatcher', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('thin dispatcher'),
      'Must declare orchestrator is a thin dispatcher'
    );
  });

  it('sub-agent receives ONLY the spec file path (v2: no pre-computed context)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('ONLY the spec file path'),
      'v2: sub-agent must receive only the spec file path'
    );
    assert.ok(
      section.includes('no pre-computed context'),
      'v2: must explicitly state no pre-computed context'
    );
  });

  it('sub-agent prompt contains spec_file_path placeholder', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('{spec_file_path}'),
      'v2: sub-agent prompt must include spec_file_path placeholder'
    );
  });

  it('sub-agent reads spec via Read tool (self-directed analysis)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Read the spec') && section.includes('Read tool'),
      'v2: sub-agent must read the spec itself via Read tool'
    );
  });

  it('sub-agent independently computes spec layer', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Compute spec layer'),
      'v2: sub-agent must compute spec layer independently'
    );
  });

  it('sub-agent independently checks experiments', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Check experiments'),
      'v2: sub-agent must check experiments independently'
    );
  });

  it('sub-agent independently explores the codebase', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Explore the codebase'),
      'v2: sub-agent must independently explore codebase'
    );
  });

  it('sub-agent independently runs impact analysis for L3', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Impact analysis') && section.includes('L3 only'),
      'v2: sub-agent must run impact analysis for L3 specs'
    );
  });

  it('sub-agent prompt contains format enforcement clause', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('OUTPUT FORMAT — MANDATORY'),
      'Must include format enforcement clause'
    );
  });

  it('format clause specifies local T-numbering starting at T1', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('local T-numbering') && section.includes('T1'),
      'Format clause must specify local T-numbering starting at T1'
    );
  });

  it('format clause requires "Blocked by: none" (not N/A or empty)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('"Blocked by: none" is required') &&
      section.includes('not "N/A"') &&
      section.includes('not empty'),
      'Must mandate "Blocked by: none" and reject N/A or empty'
    );
  });

  it('format clause enforces one task = one atomic commit', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('One task = one atomic commit'),
      'Must enforce atomic commit rule'
    );
  });

  it('format clause documents spike task format with [SPIKE] tag', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('[SPIKE]'),
      'Must document [SPIKE] tag format'
    );
  });

  it('format clause restricts L0-L1 specs to spike tasks only', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('L0-L1 specs: ONLY spike tasks allowed'),
      'Must restrict L0-L1 to spikes only'
    );
  });

  it('format clause allows L2+ specs to have spikes + implementation tasks', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('L2+ specs: spikes + implementation tasks allowed'),
      'Must allow L2+ spikes and implementation'
    );
  });
});

// ---------------------------------------------------------------------------
// §4.7.3 Collect & Persist Mini-Plans — v2: disk persistence
// ---------------------------------------------------------------------------

describe('§4.7.3 — collect & persist mini-plans (v2: persistent files)', () => {
  it('documents graceful handling of empty sub-agent output', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('empty') && section.includes('skip spec'),
      'Should gracefully skip specs with empty output'
    );
  });

  it('documents graceful handling of unparseable sub-agent output', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('unparseable') && section.includes('skip spec'),
      'Should gracefully skip specs with unparseable output'
    );
  });

  it('does not fail the entire plan on sub-agent failure', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Continue processing remaining specs regardless of individual failures'),
      'Must not fail entire plan on individual sub-agent failure'
    );
  });

  it('v2: persists mini-plans to .deepflow/plans/doing-{specName}.md on disk', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('.deepflow/plans/doing-'),
      'v2: must persist mini-plans to .deepflow/plans/ directory'
    );
    assert.ok(
      section.includes('Persist to disk') || section.includes('write to `.deepflow/plans/'),
      'v2: must write mini-plans to disk'
    );
  });

  it('v2: creates .deepflow/plans/ directory if it does not exist', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes("Create `.deepflow/plans/` directory if it doesn't exist") ||
      section.includes('.deepflow/plans/') && section.includes("doesn't exist"),
      'v2: must create .deepflow/plans/ directory if needed'
    );
  });

  it('v2: §5B reads mini-plans from .deepflow/plans/', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('reads mini-plans from `.deepflow/plans/`') ||
      section.includes('reads mini-plans from `.deepflow/plans`') ||
      (section.includes('consolidator') && section.includes('.deepflow/plans/')),
      'v2: consolidator must read from .deepflow/plans/'
    );
  });

  it('passes successful mini-plans to §5 for consolidation', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('continue to §5') || section.includes('§5'),
      'Must pass results to §5 for consolidation'
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
// WAVE 2 — §5 TWO-PATH ARCHITECTURE
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
// §5B Consolidator — v2 structure (2-step, bin/plan-consolidator.js)
// ---------------------------------------------------------------------------

describe('§5B — multi-spec consolidator structure (v2)', () => {
  it('triggers when >1 plannable spec', () => {
    const s5b = getSection5B();
    assert.match(s5b, /\*\*When:\*\*.*>1 plannable spec/);
  });

  it('v2: references mini-plans in .deepflow/plans/', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('.deepflow/plans/'),
      'v2: §5B must reference .deepflow/plans/ as input'
    );
  });

  it('declares itself as the ONLY Opus invocation (REQ-12)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('ONLY Opus invocation in the fan-out path'),
      'Must declare single Opus invocation constraint'
    );
    assert.ok(s5b.includes('REQ-12'), 'Must reference REQ-12');
  });

  it('v2: delegates mechanical work to bin/plan-consolidator.js', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('bin/plan-consolidator.js'),
      'v2: must delegate mechanical work to bin/plan-consolidator.js'
    );
  });

  it('v2: Opus handles ONLY cross-spec prioritization and summary narrative', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Opus handles ONLY'),
      'v2: Opus role must be scoped to prioritization only'
    );
  });

  it('v2: Step 1 runs plan-consolidator via shell injection', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Step 1: Run plan-consolidator'),
      'v2: Step 1 must run plan-consolidator'
    );
    assert.ok(
      s5b.includes('node bin/plan-consolidator.js'),
      'v2: must invoke plan-consolidator via node'
    );
  });

  it('v2: Step 2 spawns single Opus invocation for prioritization', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Step 2: Opus prioritization') || s5b.includes('Step 2:'),
      'v2: Step 2 must spawn Opus for prioritization'
    );
    assert.ok(
      s5b.includes('Spawn a single') &&
      s5b.includes('subagent_type="reasoner"') &&
      s5b.includes('model="opus"'),
      'v2: §5B must spawn a single reasoner/opus Task'
    );
  });

  it('v2: Opus prompt role is "plan prioritizer" (not consolidator)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('You are the plan prioritizer'),
      'v2: Opus prompt must state "plan prioritizer" role'
    );
  });

  it('v2: Opus told NOT to renumber tasks (already done by consolidator)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Do NOT renumber tasks') || s5b.includes('Do NOT renumber T-ids'),
      'v2: Opus must be told not to renumber (already done mechanically)'
    );
  });

  it('v2: mini-plans persist after consolidation (REQ-3, REQ-7)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Mini-plans persist') || s5b.includes('persist in `.deepflow/plans/'),
      'v2: mini-plans must persist to disk (not ephemeral)'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B — Step 1: plan-consolidator mechanical work
// ---------------------------------------------------------------------------

describe('§5B Step 1 — plan-consolidator mechanical outputs', () => {
  it('produces globally sequential T-ids (no gaps, no duplicates)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Globally sequential T-ids') || s5b.includes('no gaps, no duplicates'),
      'plan-consolidator must produce globally sequential T-ids'
    );
  });

  it('remaps Blocked by references (local → global)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Remapped `Blocked by` references') ||
      s5b.includes('local → global'),
      'Must remap local Blocked by references to global'
    );
  });

  it('produces [file-conflict: {filename}] annotations for cross-spec overlaps', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('[file-conflict: {filename}]'),
      'Must produce file-conflict annotations'
    );
  });

  it('leaves mini-plan files unmodified (read-only)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('read-only') || s5b.includes('NOT modify these files'),
      'Mini-plan files must remain unmodified after consolidation'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B — Step 2: Opus prioritization (3 jobs)
// ---------------------------------------------------------------------------

describe('§5B Step 2 — Opus prioritization jobs', () => {
  it('Opus job 1: cross-spec prioritization', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Cross-Spec Prioritization'),
      'Opus must perform cross-spec prioritization'
    );
  });

  it('Opus job 2: requirement mapping & spec gaps', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Requirement Mapping') || s5b.includes('Requirement Mapping & Spec Gaps'),
      'Opus must perform requirement mapping and spec gap detection'
    );
  });

  it('Opus job 3: model + effort classification', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Model + Effort Classification'),
      'Opus must perform model/effort classification'
    );
  });

  it('routing matrix includes haiku-level tasks (bootstrap, browse-fetch)', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Bootstrap') && s5b.includes('haiku'));
    assert.ok(s5b.includes('browse-fetch'));
  });

  it('routing matrix includes sonnet-level tasks (multi-file, bug fix)', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('Multi-file with clear specs'));
    assert.ok(s5b.includes('Bug fix (clear repro)'));
  });

  it('routing matrix includes opus-level tasks (optimize, architecture)', () => {
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
// §5B — Output Format
// ---------------------------------------------------------------------------

describe('§5B — output format', () => {
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

  it('Opus must NOT alter T-ids (already set by plan-consolidator)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Do NOT renumber T-ids') || s5b.includes('Do NOT alter T-ids'),
      'Opus must not alter T-ids — they are already globally sequential'
    );
  });

  it('Opus inserts consolidated tasks verbatim with only Model/Effort additions', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('consolidated tasks from plan-consolidator verbatim') ||
      s5b.includes('verbatim'),
      'Opus must insert consolidated tasks verbatim'
    );
  });

  it('output preserves spike/optimize task markers', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('[SPIKE]') && s5b.includes('[OPTIMIZE]'),
      'Must keep spike/optimize markers'
    );
  });
});

// ---------------------------------------------------------------------------
// §5B — Post-Consolidation
// ---------------------------------------------------------------------------

describe('§5B — post-consolidation behavior', () => {
  it('mini-plans persist in .deepflow/plans/ after consolidation (REQ-3, REQ-7)', () => {
    const s5b = getSection5B();
    assert.ok(
      (s5b.includes('Mini-plans persist') || s5b.includes('.deepflow/plans/doing-')) &&
      (s5b.includes('REQ-3') || s5b.includes('REQ-7')),
      'Mini-plans must persist on disk for reuse by /df:execute'
    );
  });

  it('§8 cleanup and §9 output/rename run after consolidation in orchestrator (REQ-13)', () => {
    const s5b = getSection5B();
    assert.ok(s5b.includes('§8 cleanup') && s5b.includes('§9 output'));
    assert.ok(s5b.includes('run after this step in the orchestrator'));
  });

  it('sub-agents in §4.7 use Sonnet (confirmed)', () => {
    const s5b = getSection5B();
    assert.ok(
      s5b.includes('Sub-agents in §4.7 use Sonnet'),
      'Must confirm §4.7 sub-agents use Sonnet'
    );
  });
});

// ---------------------------------------------------------------------------
// §8/§9 remain in orchestrator (AC-13)
// ---------------------------------------------------------------------------

// Helper: extract §8 section
function getSection8() {
  const content = fs.readFileSync(planPath, 'utf8');
  const match = content.match(/### 8\. CLEANUP PLAN\.md[\s\S]*?(?=### 9\.)/);
  assert.ok(match, 'plan.md must contain §8 CLEANUP PLAN.md section');
  return match[0];
}

// Helper: extract §9 section
function getSection9() {
  const content = fs.readFileSync(planPath, 'utf8');
  const match = content.match(/### 9\. OUTPUT & RENAME[\s\S]*?(?=## Rules|$)/);
  assert.ok(match, 'plan.md must contain §9 OUTPUT & RENAME section');
  return match[0];
}

describe('AC-13 — §8 cleanup and §9 output remain in orchestrator', () => {
  it('post-consolidation notes §8 and §9 run in orchestrator', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    assert.ok(
      content.includes('§8 cleanup') && content.includes('§9 output'),
      'Must state §8/§9 run after consolidation'
    );
  });

  it('§8 runs ONLY after §5B consolidation is complete', () => {
    const s8 = getSection8();
    assert.ok(
      s8.includes('Run ONLY after §5B consolidation is complete'),
      '§8 must run only after §5B consolidation'
    );
  });

  it('§8 must NOT run inside sub-agents', () => {
    const s8 = getSection8();
    assert.ok(
      s8.includes('do NOT run inside sub-agents'),
      '§8 must not run inside sub-agents'
    );
  });

  it('§9 runs ONLY after §5B consolidation is complete (AC-13)', () => {
    const s9 = getSection9();
    assert.ok(
      s9.includes('Run ONLY after §5B consolidation is complete') &&
      s9.includes('AC-13'),
      '§9 must run only after consolidation and reference AC-13'
    );
  });

  it('§9 operates on successfully planned specs only', () => {
    const s9 = getSection9();
    assert.ok(
      s9.includes('successfully planned specs only') ||
      s9.includes('Operate on successfully planned specs only'),
      '§9 must operate on successfully planned specs only'
    );
  });

  it('§9 excludes failed specs from rename and PLAN.md', () => {
    const s9 = getSection9();
    assert.ok(
      s9.includes('NOT renamed and NOT appended to PLAN.md'),
      'Failed specs must not be renamed or appended to PLAN.md'
    );
  });
});

// ---------------------------------------------------------------------------
// §4.7.3 — Three-Condition Failure Check (AC-10 in v2, was AC-11 in v1)
// ---------------------------------------------------------------------------

describe('§4.7.3 graceful degradation — three failure conditions', () => {
  it('condition 1: sub-agent threw error or returned non-string', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('threw an error or returned a non-string value'),
      'Must detect error/non-string as failure condition'
    );
  });

  it('condition 2: output is empty (whitespace only)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Output is empty (whitespace only)'),
      'Must detect empty/whitespace-only output as failure condition'
    );
  });

  it('condition 3: output contains no task items (no T pattern)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('no task items') && section.includes('no `- [ ] **T` pattern'),
      'Must detect missing task items as failure condition'
    );
  });

  it('v2: references AC-10 (not AC-11)', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('AC-10'),
      'v2: Graceful degradation must reference AC-10'
    );
  });

  it('warning format includes specName and reason placeholders', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('{specName}') && section.includes('{reason}'),
      'Warning format must include {specName} and {reason} placeholders'
    );
  });

  it('warning includes ⚠ Warning prefix', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('⚠ Warning: sub-agent for'),
      'Warning must use ⚠ Warning prefix format'
    );
  });

  it('continues processing regardless of individual failures', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('Continue processing remaining specs regardless of individual failures'),
      'Must continue processing after individual failures'
    );
  });

  it('partial success continues to §5', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('at least 1 succeeds') && section.includes('continue to §5'),
      'Partial success must continue to §5'
    );
  });

  it('total failure (ALL sub-agents fail) aborts plan generation', () => {
    const section = getFanOutSection();
    assert.ok(
      section.includes('ALL sub-agents fail') && section.includes('abort plan generation'),
      'Total failure must abort plan generation'
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
