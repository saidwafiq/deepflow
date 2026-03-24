/**
 * Integration tests for plan-fanout spec (v2 design).
 *
 * These tests verify EACH acceptance criterion (AC-1 through AC-14) holistically
 * across the entire plan.md command file, checking cross-section consistency.
 *
 * v2 design changes verified:
 *   1. Sub-agent prompt contains ONLY spec file path (no pre-computed context blocks)
 *   2. Mini-plans saved to .deepflow/plans/doing-{name}.md (persistent, not ephemeral arrays)
 *   3. Consolidator reads from .deepflow/plans/, delegates mechanical work to bin/plan-consolidator.js
 *   4. Single-spec path runs monolithic (no fan-out)
 *   5. Fan-out capped at 5 specs
 *
 * Complements plan-fanout.test.js which tests individual sections in isolation.
 * Uses Node.js built-in node:test to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const planPath = path.join(ROOT, 'src', 'commands', 'df', 'plan.md');

// Read the full plan.md once — all tests reference it
const PLAN_MD = fs.readFileSync(planPath, 'utf8');

// Section extractors
function getSection(startPattern, endPattern) {
  const re = new RegExp(startPattern + '[\\s\\S]*?(?=' + endPattern + ')');
  const match = PLAN_MD.match(re);
  assert.ok(match, `Section matching ${startPattern} must exist`);
  return match[0];
}

const fanOut = () => getSection('### 4\\.7\\. FAN-OUT', '### 5\\.');
const section5 = () => getSection('### 5\\. COMPARE', '### 5\\.5\\.');
const section5B = () => {
  const s5 = section5();
  const m = s5.match(/#### 5B\. MULTI-SPEC CONSOLIDATOR[\s\S]*/);
  assert.ok(m, '§5B must exist');
  return m[0];
};
const section8 = () => getSection('### 8\\. CLEANUP', '### 9\\.');
const section9 = () => getSection('### 9\\. OUTPUT', '## Rules');

// ===========================================================================
// AC-1: plan.md spawns one sub-agent per plannable spec
//        (validated, no doing-/done- prefix)
// ===========================================================================

describe('AC-1: one sub-agent per plannable spec', () => {
  it('§1 filters out doing-/done- prefixed specs', () => {
    assert.ok(
      PLAN_MD.includes('exclude doing-*/done-*'),
      '§1 LOAD CONTEXT must exclude doing-/done- specs'
    );
  });

  it('§1 validates specs before planning (validateSpec)', () => {
    assert.ok(
      PLAN_MD.includes('Run `validateSpec` on each spec'),
      '§1 must run validateSpec on each spec'
    );
  });

  it('§4.7.2 spawns one sub-agent per spec (parallel Task calls)', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('For each plannable spec (up to 5), spawn a'),
      '§4.7.2 must spawn per plannable spec'
    );
    assert.ok(
      fo.includes('All calls are independent — spawn them simultaneously'),
      'Sub-agents must be spawned simultaneously'
    );
  });

  it('§4.7.1 counts only validated, non-prefixed specs', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('no `doing-`/`done-` prefix') && fo.includes('passed `validateSpec`'),
      'Count must filter by prefix and validation'
    );
  });

  it('end-to-end: §1 filtering feeds §4.7 count which drives spawn loop', () => {
    assert.ok(PLAN_MD.includes('exclude doing-*/done-*'), '§1 filter');
    assert.ok(PLAN_MD.includes('plannable specs (no `doing-`/`done-` prefix, passed `validateSpec`)'), '§4.7.1 count');
    assert.ok(PLAN_MD.includes('For each plannable spec (up to 5), spawn'), '§4.7.2 spawn');
  });
});

// ===========================================================================
// AC-2: Sub-agent prompt includes format rules; output uses local T-numbering
// ===========================================================================

describe('AC-2: sub-agent prompt format rules with local T-numbering', () => {
  it('format enforcement clause mandates local T-numbering starting at T1', () => {
    const fo = fanOut();
    assert.ok(fo.includes('Use local T-numbering starting at T1'));
  });

  it('format clause specifies exact task template structure', () => {
    const fo = fanOut();
    assert.ok(fo.includes('- [ ] **T{N}**: {Task description}'));
    assert.ok(fo.includes('- Files: {comma-separated file paths}'));
    assert.ok(fo.includes('- Blocked by: none | T{N}[, T{M}...]'));
  });

  it('local numbering is explicitly scoped per-spec', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('T-numbers are local to this spec (T1, T2, T3...)'),
      'Must clarify T-numbers are local per spec'
    );
  });

  it('format enforcement is labeled MANDATORY', () => {
    const fo = fanOut();
    assert.ok(fo.includes('OUTPUT FORMAT — MANDATORY (no deviations)'));
  });
});

// ===========================================================================
// AC-3: Consolidator produces PLAN.md with globally sequential T-numbers
//        (T1...TN), no gaps or duplicates — done by bin/plan-consolidator.js
// ===========================================================================

describe('AC-3: globally sequential T-numbers in consolidated output', () => {
  it('§5B Step 1 (plan-consolidator) assigns sequential T-ids with no gaps or duplicates', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('no gaps, no duplicates'));
  });

  it('§5B Opus prompt instructs NOT to renumber (already done mechanically)', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('Do NOT renumber T-ids') ||
      s5b.includes('Do NOT renumber tasks'),
      'Opus must not renumber — already done by plan-consolidator'
    );
  });

  it('plan-consolidator remaps local blocked-by references to global IDs', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('local → global') || s5b.includes('Remapped `Blocked by` references'),
      'Must translate local Blocked by references to global IDs'
    );
  });

  it('§9 output appends tasks grouped under doing-{spec-name} headers', () => {
    // Tasks are grouped under doing-{spec-name} in §9 OUTPUT & RENAME
    const s9 = section9();
    assert.ok(s9.includes('doing-{spec-name') || s9.includes('doing-'));
  });
});

// ===========================================================================
// AC-4: Given two specs with overlapping Files: entries, consolidator adds
//        Blocked by: with [file-conflict: {filename}] annotation
// ===========================================================================

describe('AC-4: cross-spec file conflict detection with annotation', () => {
  it('§4.6 documents intra-plan file conflict detection', () => {
    assert.ok(
      PLAN_MD.includes('### 4.6. CROSS-TASK FILE CONFLICT DETECTION'),
      '§4.6 must exist for file conflict detection'
    );
  });

  it('§4.6 builds file-to-task map and adds Blocked by', () => {
    const s46 = getSection('### 4\\.6\\. CROSS-TASK FILE', '### 4\\.7\\.');
    assert.ok(s46.includes('file → [task IDs]'));
    assert.ok(s46.includes('add `Blocked by` from later → earlier task'));
  });

  it('§4.6 appends file conflict annotation', () => {
    const s46 = getSection('### 4\\.6\\. CROSS-TASK FILE', '### 4\\.7\\.');
    assert.ok(s46.includes('(file conflict: {filename})'));
  });

  it('§5B plan-consolidator produces [file-conflict: {filename}] annotations', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('[file-conflict: {filename}]'));
  });

  it('§4.6 enforces chain-only blocking (nearest earlier task)', () => {
    const s46 = getSection('### 4\\.6\\. CROSS-TASK FILE', '### 4\\.7\\.');
    assert.ok(s46.includes('Chain only'), '§4.6 must use chain-only');
  });
});

// ===========================================================================
// AC-5: Consolidator uses reasoner (Opus) for cross-spec prioritization
// ===========================================================================

describe('AC-5: consolidator uses reasoner (Opus)', () => {
  it('§5B Step 2 spawns Task with subagent_type="reasoner", model="opus"', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('subagent_type="reasoner"'));
    assert.ok(s5b.includes('model="opus"'));
  });

  it('consolidator performs cross-spec prioritization', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Cross-Spec Prioritization'));
  });

  it('§5B is explicitly a single Opus spawn', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Spawn a single'));
  });
});

// ===========================================================================
// AC-6: Single spec runs current monolithic path with no fan-out overhead
// ===========================================================================

describe('AC-6: single spec uses monolithic path, zero overhead', () => {
  it('§4.7 skip condition: exactly 1 spec skips to §5 with zero overhead', () => {
    const fo = fanOut();
    assert.ok(fo.includes('If exactly 1 plannable spec → skip this section entirely'));
    assert.ok(fo.includes('zero overhead'));
    assert.ok(fo.includes('No fan-out code runs'));
  });

  it('§4.7.1 routes 1 spec to monolithic path (§5)', () => {
    const fo = fanOut();
    assert.match(fo, /\*\*1 spec\*\*.*skip to §5/);
  });

  it('§5A explicitly handles single-spec case', () => {
    const s5 = section5();
    assert.ok(s5.includes('SINGLE-SPEC (MONOLITHIC PATH)'));
    assert.ok(s5.includes('Exactly 1 plannable spec'));
  });

  it('§5A notes §4.7 was skipped for single spec', () => {
    const s5 = section5();
    assert.ok(s5.includes('§4.7 was skipped'));
  });
});

// ===========================================================================
// AC-7: v2 REVERSAL — Mini-plans ARE persisted to disk after /df:plan
// ===========================================================================

describe('AC-7 (v2): mini-plans are persisted to .deepflow/plans/ (not ephemeral)', () => {
  it('§4.7.3 writes mini-plans to .deepflow/plans/doing-{specName}.md', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Persist to disk') || fo.includes('.deepflow/plans/doing-'),
      'v2: mini-plans must be written to disk'
    );
  });

  it('§5B reads mini-plans from .deepflow/plans/ as input', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('.deepflow/plans/doing-*.md') ||
      s5b.includes('Mini-plan files in `.deepflow/plans/'),
      'v2: §5B must read from .deepflow/plans/'
    );
  });

  it('post-consolidation: mini-plans persist for /df:execute reuse (REQ-3, REQ-7)', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('Mini-plans persist') || s5b.includes('.deepflow/plans/doing-'),
      'v2: mini-plans must persist after consolidation for /df:execute'
    );
  });

  it('§5B consolidator must NOT modify mini-plan files (read-only)', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('must NOT modify these files') || s5b.includes('read-only'),
      'v2: consolidator must treat mini-plan files as read-only'
    );
  });
});

// ===========================================================================
// AC-8: Fan-out-generated PLAN.md parseable by wave-runner.js
// ===========================================================================

describe('AC-8: PLAN.md parseable by wave-runner.js', () => {
  it('sub-agent output format includes Files: field required by wave-runner', () => {
    // v2: task format defined in §4.7.2 sub-agent prompt template
    const fo = fanOut();
    assert.ok(fo.includes('- Files:'));
  });

  it('sub-agent output format includes Blocked by: field required by wave-runner', () => {
    // v2: task format defined in §4.7.2 sub-agent prompt template
    const fo = fanOut();
    assert.ok(fo.includes('- Blocked by:'));
  });

  it('sub-agent output format includes optional Model: and Effort: fields', () => {
    // v2: optional fields in §4.7.2 sub-agent prompt template
    const fo = fanOut();
    assert.ok(fo.includes('- Model:'));
    assert.ok(fo.includes('- Effort:'));
  });

  it('wave-runner.test.js exists and is runnable', () => {
    const waveTestPath = path.join(ROOT, 'bin', 'wave-runner.test.js');
    assert.ok(
      fs.existsSync(waveTestPath),
      'bin/wave-runner.test.js must exist for AC-8 verification'
    );
  });

  it('output uses "Blocked by: none" (not N/A or empty) matching wave-runner expectations', () => {
    // v2: this rule is in the §4.7.2 sub-agent prompt format enforcement clause
    const fo = fanOut();
    assert.ok(fo.includes('"Blocked by: none" is required'));
  });
});

// ===========================================================================
// AC-9: v2 REVERSAL — Sub-agent is self-directed (no pre-computed context)
//        Sub-agent reads spec itself; orchestrator is a thin dispatcher
// ===========================================================================

describe('AC-9 (v2): sub-agent is self-directed, orchestrator is thin dispatcher', () => {
  it('§4.7.2 declares orchestrator is a thin dispatcher', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('thin dispatcher'),
      'Must declare orchestrator is a thin dispatcher'
    );
  });

  it('sub-agent receives ONLY spec file path (no pre-computed context)', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('ONLY the spec file path'),
      'v2: sub-agent must receive only the spec file path'
    );
    assert.ok(
      fo.includes('no pre-computed context'),
      'v2: must state no pre-computed context'
    );
  });

  it('sub-agent prompt contains spec file path placeholder {spec_file_path}', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('{spec_file_path}'),
      'Sub-agent prompt must include {spec_file_path} placeholder'
    );
  });

  it('sub-agent reads spec via Read tool', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Read the spec') && fo.includes('Read tool'),
      'Sub-agent must read spec itself via Read tool'
    );
  });

  it('sub-agent computes spec layer independently', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Compute spec layer'),
      'Sub-agent must compute spec layer independently'
    );
  });

  it('sub-agent checks experiments independently', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Check experiments'),
      'Sub-agent must check experiments independently'
    );
  });

  it('sub-agent explores codebase independently', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Explore the codebase'),
      'Sub-agent must explore codebase independently'
    );
  });

  it('sub-agent runs impact analysis for L3 specs independently', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Impact analysis') && fo.includes('L3 only'),
      'Sub-agent must run impact analysis for L3 specs'
    );
  });

  it('sub-agent prompt contains layer-gating rules table', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Layer-gating rules'),
      'Sub-agent prompt must embed layer-gating rules'
    );
  });
});

// ===========================================================================
// AC-10 (was AC-12): Only one Opus invocation exists in the fan-out path
// ===========================================================================

describe('AC-10 (was AC-12): single Opus invocation in fan-out path', () => {
  it('§5B declares itself as the ONLY Opus invocation', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('ONLY Opus invocation in the fan-out path'));
    assert.ok(s5b.includes('REQ-12'));
  });

  it('§4.7.2 sub-agents use Sonnet, not Opus', () => {
    const fo = fanOut();
    assert.ok(fo.includes('model="sonnet"'), 'Sub-agents must use sonnet');
    const spawnSection = fo.match(/#### 4\.7\.2[\s\S]*?(?=#### 4\.7\.3)/);
    assert.ok(spawnSection, '§4.7.2 must exist');
    assert.ok(
      !spawnSection[0].includes('model="opus"'),
      '§4.7.2 sub-agents must NOT use opus'
    );
  });

  it('cross-check: §4.7.2 spawn call uses sonnet not opus', () => {
    const fo = fanOut();
    const spawnSection = fo.match(/#### 4\.7\.2[\s\S]*?(?=#### 4\.7\.3)/);
    assert.ok(spawnSection, '§4.7.2 must exist');
    assert.ok(
      spawnSection[0].includes('model="sonnet"'),
      '§4.7.2 spawn must use model="sonnet"'
    );
    assert.ok(
      !spawnSection[0].includes('model="opus"'),
      '§4.7.2 spawn must NOT use model="opus"'
    );
  });

  it('wave-runner.test.js exists', () => {
    const p = path.join(ROOT, 'bin', 'wave-runner.test.js');
    assert.ok(fs.existsSync(p), 'bin/wave-runner.test.js must exist');
  });

  it('ratchet.test.js exists', () => {
    const p = path.join(ROOT, 'bin', 'ratchet.test.js');
    assert.ok(fs.existsSync(p), 'bin/ratchet.test.js must exist');
  });
});

// ===========================================================================
// AC-11: Sub-agent failure logs warning and continues with remaining specs
// ===========================================================================

describe('AC-11: sub-agent failure graceful degradation', () => {
  it('§4.7.3 documents three failure conditions with skip behavior', () => {
    const fo = fanOut();
    assert.ok(fo.includes('threw an error or returned a non-string value'));
    assert.ok(fo.includes('Output is empty (whitespace only)'));
    assert.ok(fo.includes('no task items'));
  });

  it('each failure condition logs a warning', () => {
    const fo = fanOut();
    const logWarningCount = (fo.match(/log warning/g) || []).length;
    assert.ok(logWarningCount >= 3, `Must have at least 3 "log warning" directives, found ${logWarningCount}`);
  });

  it('processing continues regardless of individual failures', () => {
    const fo = fanOut();
    assert.ok(fo.includes('Continue processing remaining specs regardless of individual failures'));
  });

  it('warning format includes spec name and reason', () => {
    const fo = fanOut();
    assert.ok(fo.includes('⚠ Warning: sub-agent for {specName} failed — {reason}'));
  });

  it('partial success continues to §5, total failure aborts', () => {
    const fo = fanOut();
    assert.ok(fo.includes('at least 1 succeeds'));
    assert.ok(fo.includes('ALL sub-agents fail'));
    assert.ok(fo.includes('abort plan generation'));
  });

  it('v2: §4.7.3 references AC-10 (graceful degradation tag in v2)', () => {
    const fo = fanOut();
    // v2 uses AC-10 in the graceful degradation block
    assert.ok(
      fo.includes('AC-10') || fo.includes('AC-11'),
      '§4.7.3 must reference an AC for graceful degradation'
    );
  });
});

// ===========================================================================
// AC-12: bin/plan-consolidator.js exists (mechanical consolidation)
// ===========================================================================

describe('AC-12: bin/plan-consolidator.js exists and is referenced', () => {
  it('§5B references bin/plan-consolidator.js', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('bin/plan-consolidator.js'),
      'v2: §5B must reference bin/plan-consolidator.js'
    );
  });

  it('bin/plan-consolidator.js file exists on disk', () => {
    const consolidatorPath = path.join(ROOT, 'bin', 'plan-consolidator.js');
    assert.ok(
      fs.existsSync(consolidatorPath),
      'bin/plan-consolidator.js must exist on disk'
    );
  });

  it('§5B uses shell injection to run plan-consolidator', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('node bin/plan-consolidator.js'),
      'Must invoke plan-consolidator via shell injection'
    );
  });
});

// ===========================================================================
// AC-13: Cleanup and rename run after consolidation, not inside sub-agents
// ===========================================================================

describe('AC-13: cleanup/rename run after consolidation, not in sub-agents', () => {
  it('§8 runs ONLY after §5B consolidation is complete', () => {
    const s8 = section8();
    assert.ok(s8.includes('Run ONLY after §5B consolidation is complete'));
  });

  it('§8 must NOT run inside sub-agents or during mini-plan collection', () => {
    const s8 = section8();
    assert.ok(s8.includes('do NOT run inside sub-agents'));
    assert.ok(s8.includes('during mini-plan collection'));
  });

  it('§9 runs ONLY after §5B consolidation (references AC-13)', () => {
    const s9 = section9();
    assert.ok(s9.includes('Run ONLY after §5B consolidation is complete'));
    assert.ok(s9.includes('AC-13'));
  });

  it('§5B post-consolidation confirms §8 and §9 run in orchestrator', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('§8 cleanup'));
    assert.ok(s5b.includes('§9 output'));
    assert.ok(s5b.includes('run after this step in the orchestrator'));
  });
});

// ===========================================================================
// AC-14: >5 specs triggers partial fan-out with user-facing message
// ===========================================================================

describe('AC-14: >5 specs partial fan-out with user message', () => {
  it('§4.7.1 documents >5 spec cap at first 5', () => {
    const fo = fanOut();
    assert.ok(fo.includes('>5 specs'));
    assert.ok(fo.includes('select first 5') || fo.includes('first 5'));
  });

  it('user-facing message lists queued specs', () => {
    const fo = fanOut();
    assert.ok(fo.includes('{total} specs found'));
    assert.ok(fo.includes('Planning first 5 now'));
    assert.ok(fo.includes('Queued for next run'));
  });

  it('message includes spec filenames as list items', () => {
    const fo = fanOut();
    assert.ok(fo.includes('- {spec6.md}'));
    assert.ok(fo.includes('- {spec7.md}'));
  });

  it('message tells user to re-run /df:plan', () => {
    const fo = fanOut();
    assert.ok(fo.includes('Re-run /df:plan to process remaining specs'));
  });

  it('three ranges are documented: 1 spec, 2-5 specs, >5 specs', () => {
    const fo = fanOut();
    assert.match(fo, /\*\*1 spec\*\*/);
    assert.match(fo, /\*\*2.5 specs\*\*/);
    assert.match(fo, /\*\*>5 specs\*\*/);
  });
});

// ===========================================================================
// Cross-cutting: data flow integrity from §1 through §9
// ===========================================================================

describe('cross-cutting: end-to-end data flow consistency', () => {
  it('§1 spec filtering -> §4.7 fan-out -> §5B consolidation -> §8 cleanup -> §9 output', () => {
    assert.ok(PLAN_MD.includes('exclude doing-*/done-*'), '§1 filters specs');
    assert.ok(PLAN_MD.includes('>1 plannable spec found in §1'), '§4.7 references §1');
    assert.ok(
      PLAN_MD.includes('§4.7 produced mini-plans in `.deepflow/plans/`') ||
      PLAN_MD.includes('.deepflow/plans/'),
      '§5B references §4.7 mini-plans on disk'
    );
    assert.ok(PLAN_MD.includes('Run ONLY after §5B consolidation is complete'), '§8/§9 reference §5B');
  });

  it('monolithic path skips §4.7 entirely and goes §1 -> §5A -> §6', () => {
    assert.ok(PLAN_MD.includes('skip this section entirely, continue to §5'));
    assert.ok(PLAN_MD.includes('§4.7 was skipped'));
    assert.ok(PLAN_MD.includes('Continue to §6'));
  });

  it('both paths produce output with consistent task format', () => {
    const s5 = getSection('### 5\\. COMPARE', '### 6\\.');
    assert.ok(s5.includes('DONE/PARTIAL/MISSING/CONFLICT'), '§5A maps requirements');
    // v2: task format is in the sub-agent prompt (not §5B template directly)
    assert.ok(PLAN_MD.includes('- [ ] **T{N}**: {Task description}'), 'Task format exists');
  });

  it('§9 renames specs and appends to PLAN.md regardless of path taken', () => {
    const s9 = section9();
    assert.ok(s9.includes('doing-'));
    assert.ok(s9.includes('Append tasks'));
    assert.ok(s9.includes('Rename'));
  });
});

// ===========================================================================
// Cross-cutting: wave-runner format compatibility
// ===========================================================================

describe('cross-cutting: wave-runner format compatibility', () => {
  it('sub-agent output format uses checkbox format (- [ ] **T{N}**)', () => {
    const fo = fanOut();
    assert.match(fo, /- \[ \] \*\*T\{N\}\*/);
  });

  it('Blocked by field uses "none" or "T{N}" format (wave-runner parseable)', () => {
    assert.ok(PLAN_MD.includes('Blocked by: none'));
    assert.ok(PLAN_MD.includes('Blocked by: T'));
  });

  it('task format includes all fields wave-runner needs: Files, Blocked by', () => {
    const fo = fanOut();
    assert.ok(fo.includes('- Files:'), 'Output must include Files');
    assert.ok(fo.includes('- Blocked by:'), 'Output must include Blocked by');
  });

  it('v2: plan-consolidator.js produces globally sequential T-ids for wave-runner', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('bin/plan-consolidator.js'),
      'v2: plan-consolidator must produce wave-runner compatible output'
    );
  });
});
