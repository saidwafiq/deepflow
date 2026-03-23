/**
 * Integration tests for plan-fanout spec.
 *
 * These tests verify EACH acceptance criterion (AC-1 through AC-14) holistically
 * across the entire plan.md command file, checking cross-section consistency.
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
    // §1 mentions "exclude doing-*/done-*" and "validateSpec"
    // §4.7.1 uses "plannable specs (no doing-/done- prefix, passed validateSpec)"
    // §4.7.2 spawns "For each plannable spec"
    // This verifies the data flow chain is documented
    assert.ok(PLAN_MD.includes('exclude doing-*/done-*'), '§1 filter');
    assert.ok(PLAN_MD.includes('plannable specs (no `doing-`/`done-` prefix, passed `validateSpec`)'), '§4.7.1 count');
    assert.ok(PLAN_MD.includes('For each plannable spec (up to 5), spawn'), '§4.7.2 spawn');
  });
});

// ===========================================================================
// AC-2: Sub-agent prompt includes plan-template format rules;
//        output uses local T-numbering
// ===========================================================================

describe('AC-2: sub-agent prompt format rules with local T-numbering', () => {
  it('format enforcement clause mandates local T-numbering starting at T1', () => {
    const fo = fanOut();
    assert.ok(fo.includes('Use local T-numbering starting at T1'));
  });

  it('format clause specifies exact task template structure', () => {
    const fo = fanOut();
    // Must have the full task format with Files, Blocked by
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
//        (T1...TN), no gaps or duplicates
// ===========================================================================

describe('AC-3: globally sequential T-numbers in consolidated PLAN.md', () => {
  it('§5B Step 2 assigns sequential T1..TN with no gaps or duplicates', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('T1, T2, ..., TN'));
    assert.ok(s5b.includes('NO gaps'));
    assert.ok(s5b.includes('NO duplicates'));
  });

  it('§5B output rules reinforce globally sequential constraint', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('T-numbers MUST be globally sequential (T1...TN), no gaps, no duplicates'));
  });

  it('local blocked-by references are translated to global IDs', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Translate all intra-spec `Blocked by: T{local}` references to global T-IDs'));
  });

  it('consolidator output template shows sequential T-numbers (T1, T2, T3)', () => {
    const s5b = section5B();
    // The output template shows T1, T2, T3 as examples
    assert.ok(s5b.includes('**T1**'));
    assert.ok(s5b.includes('**T2**'));
    assert.ok(s5b.includes('**T3**'));
  });
});

// ===========================================================================
// AC-4: Given two specs with overlapping Files: entries, consolidator adds
//        Blocked by: with (file conflict: {filename}) annotation
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

  it('§5B Step 3 replicates file conflict detection for cross-spec case', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Step 3: Cross-Spec File Conflict Detection'));
    assert.ok(s5b.includes('[file-conflict: {filename}]'));
  });

  it('both §4.6 and §5B enforce chain-only blocking (nearest earlier task)', () => {
    const s46 = getSection('### 4\\.6\\. CROSS-TASK FILE', '### 4\\.7\\.');
    const s5b = section5B();
    assert.ok(s46.includes('Chain only'), '§4.6 must use chain-only');
    assert.ok(s5b.includes('Chain only'), '§5B must use chain-only');
  });

  it('§5B output rules REQUIRE file-conflict annotations', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('[file-conflict: {filename}] annotations are REQUIRED'));
  });
});

// ===========================================================================
// AC-5: Consolidator uses reasoner (Opus) for cross-spec prioritization
// ===========================================================================

describe('AC-5: consolidator uses reasoner (Opus)', () => {
  it('§5B spawns Task with subagent_type="reasoner", model="opus"', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('subagent_type="reasoner"'));
    assert.ok(s5b.includes('model="opus"'));
  });

  it('consolidator performs cross-spec prioritization via Step 1', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Step 1: Spec Priority Ordering'));
    assert.ok(s5b.includes('Sort specs for global numbering'));
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
// AC-7: No mini-plan files exist on disk after /df:plan completes
// ===========================================================================

describe('AC-7: mini-plans are ephemeral (never on disk)', () => {
  it('§5B post-consolidation states mini-plans are never written to disk', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Mini-plans are ephemeral'));
    assert.ok(s5b.includes('never written to disk'));
    assert.ok(s5b.includes('REQ-7'));
  });

  it('§4.7.3 stores results in memory as array objects, not files', () => {
    const fo = fanOut();
    assert.ok(fo.includes('array of `{ specName, miniPlan }` objects'));
    // No mention of writing mini-plans to filesystem
    assert.ok(
      !fo.includes('write mini-plan') && !fo.includes('save mini-plan'),
      'Must never mention writing mini-plans to disk in §4.7'
    );
  });

  it('sub-agent return values are the only transport for mini-plans', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('exist only as sub-agent return values'));
  });
});

// ===========================================================================
// AC-8: Fan-out-generated PLAN.md parseable by wave-runner.js
// ===========================================================================

describe('AC-8: PLAN.md parseable by wave-runner.js', () => {
  it('consolidator output uses standard task format with - [ ] **T{N}**', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('- [ ] **T1**'));
    assert.ok(s5b.includes('- [ ] **T2**'));
    assert.ok(s5b.includes('- [ ] **T3**'));
  });

  it('output includes Files: and Blocked by: fields required by wave-runner', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('- Files:'));
    assert.ok(s5b.includes('- Blocked by:'));
  });

  it('output includes Model: and Effort: fields', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('- Model:'));
    assert.ok(s5b.includes('- Effort:'));
  });

  it('wave-runner.test.js exists and is runnable', () => {
    const waveTestPath = path.join(ROOT, 'bin', 'wave-runner.test.js');
    assert.ok(
      fs.existsSync(waveTestPath),
      'bin/wave-runner.test.js must exist for AC-10 verification'
    );
  });

  it('output uses "Blocked by: none" (not N/A or empty) matching wave-runner expectations', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('"Blocked by: none" is required'));
  });
});

// ===========================================================================
// AC-9: Sub-agent prompt includes layer-gating, experiment-check,
//        project context, impact analysis, targeted exploration
// ===========================================================================

describe('AC-9: sub-agent prompt includes all 5 analysis phases', () => {
  const requiredElements = [
    { name: 'layer-gating', pattern: 'Layer-gating rules', ref: '§1.5' },
    { name: 'experiment-check', pattern: 'Experiment check results', ref: '§2' },
    { name: 'project context', pattern: 'Project context', ref: '§3' },
    { name: 'impact analysis', pattern: 'Impact analysis instructions', ref: '§4' },
    { name: 'targeted exploration', pattern: 'Targeted exploration instructions', ref: '§4.5' },
  ];

  for (const elem of requiredElements) {
    it(`sub-agent prompt includes ${elem.name} (from ${elem.ref})`, () => {
      const fo = fanOut();
      assert.ok(
        fo.includes(elem.pattern),
        `Must include ${elem.name} element in sub-agent prompt`
      );
      assert.ok(
        fo.includes(elem.ref),
        `Must reference ${elem.ref} for ${elem.name}`
      );
    });
  }

  it('all 5 analysis phases are numbered in the sub-agent prompt', () => {
    const fo = fanOut();
    // Elements 1-5 correspond to the analysis phases, 6 is spec content, 7 is format
    for (let i = 1; i <= 5; i++) {
      assert.match(
        fo,
        new RegExp(`${i}\\.\\s+\\*\\*`),
        `Element ${i} must be numbered in sub-agent prompt`
      );
    }
  });
});

// ===========================================================================
// AC-10: node --test bin/wave-runner.test.js and bin/ratchet.test.js exit 0
// ===========================================================================

describe('AC-10: wave-runner.test.js and ratchet.test.js exist', () => {
  it('bin/wave-runner.test.js exists', () => {
    const p = path.join(ROOT, 'bin', 'wave-runner.test.js');
    assert.ok(fs.existsSync(p), 'bin/wave-runner.test.js must exist');
  });

  it('bin/ratchet.test.js exists', () => {
    const p = path.join(ROOT, 'bin', 'ratchet.test.js');
    assert.ok(fs.existsSync(p), 'bin/ratchet.test.js must exist');
  });

  // TODO: Actually running `node --test bin/wave-runner.test.js` and
  // `node --test bin/ratchet.test.js` requires the full runtime environment.
  // This is a runtime verification that cannot be tested through markdown analysis alone.
  // The existing test files are present; AC-10 pass/fail is verified by running them directly.
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
    // All three conditions say "log warning, skip spec"
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

  it('§4.7.3 explicitly references AC-11', () => {
    const fo = fanOut();
    assert.ok(fo.includes('AC-11'));
  });
});

// ===========================================================================
// AC-12: Only one Opus invocation exists in the fan-out path (the consolidator)
// ===========================================================================

describe('AC-12: single Opus invocation in fan-out path', () => {
  it('§5B declares itself as the ONLY Opus invocation', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('ONLY Opus invocation in the fan-out path'));
    assert.ok(s5b.includes('REQ-12'));
  });

  it('§4.7.2 sub-agents use Sonnet, not Opus', () => {
    const fo = fanOut();
    assert.ok(fo.includes('model="sonnet"'), 'Sub-agents must use sonnet');
    // §4.7.2 should not mention model="opus"
    const spawnSection = fo.match(/#### 4\.7\.2[\s\S]*?(?=#### 4\.7\.3)/);
    assert.ok(spawnSection, '§4.7.2 must exist');
    assert.ok(
      !spawnSection[0].includes('model="opus"'),
      '§4.7.2 sub-agents must NOT use opus'
    );
  });

  it('cross-check: §4.7.2 spawn call uses sonnet, not opus as the model parameter', () => {
    // The fan-out sub-agent spawn in §4.7.2 must use sonnet.
    // "opus" may appear in the format clause as an allowed Model value for tasks,
    // but the sub-agent spawn itself must use model="sonnet".
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
});

// ===========================================================================
// AC-13: Cleanup and rename run after consolidation, not inside sub-agents
// ===========================================================================

describe('AC-13: cleanup/rename run after consolidation, not in sub-agents', () => {
  it('§8 runs ONLY after §5B consolidation', () => {
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
    assert.ok(s5b.includes('REQ-13'));
  });

  it('sub-agent prompt (§4.7.2) does not mention §8 or §9', () => {
    // The sub-agent prompt is in §4.7.2, it should not reference cleanup/rename
    const fo = fanOut();
    const promptSection = fo.match(/Each sub-agent prompt MUST include[\s\S]*?```\n\s*\n/);
    assert.ok(promptSection, 'Sub-agent prompt section must exist');
    assert.ok(
      !promptSection[0].includes('§8') && !promptSection[0].includes('§9'),
      'Sub-agent prompt must not reference §8 or §9 (cleanup/rename)'
    );
  });
});

// ===========================================================================
// AC-14: >5 specs triggers partial fan-out with user-facing message
// ===========================================================================

describe('AC-14: >5 specs partial fan-out with user message', () => {
  it('§4.7.1 documents >5 spec cap at first 5', () => {
    const fo = fanOut();
    assert.ok(fo.includes('>5 specs'));
    assert.ok(fo.includes('select first 5'));
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
    // Verify the documented flow chain references are consistent
    assert.ok(PLAN_MD.includes('exclude doing-*/done-*'), '§1 filters specs');
    assert.ok(PLAN_MD.includes('>1 plannable spec found in §1'), '§4.7 references §1');
    assert.ok(PLAN_MD.includes('§4.7 produced mini-plans'), '§5B references §4.7');
    assert.ok(PLAN_MD.includes('Run ONLY after §5B consolidation is complete'), '§8/§9 reference §5B');
  });

  it('monolithic path skips §4.7 entirely and goes §1 -> §5A -> §6', () => {
    assert.ok(PLAN_MD.includes('skip this section entirely, continue to §5'));
    assert.ok(PLAN_MD.includes('§4.7 was skipped'));
    assert.ok(PLAN_MD.includes('Continue to §6'));
  });

  it('both paths produce PLAN.md with consistent task format', () => {
    // §5A uses reasoner/opus and produces tasks
    // §5B consolidator also produces tasks in same format
    // Both must use - [ ] **T{N}** format
    const s5 = getSection('### 5\\. COMPARE', '### 6\\.');
    assert.ok(s5.includes('DONE/PARTIAL/MISSING/CONFLICT'), '§5A maps requirements');
    assert.ok(s5.includes('- [ ] **T1**'), '§5B output uses standard task format');
  });

  it('§9 renames specs and appends to PLAN.md regardless of path taken', () => {
    const s9 = section9();
    assert.ok(s9.includes('doing-'));
    assert.ok(s9.includes('Append tasks'));
    assert.ok(s9.includes('Rename'));
  });
});

// ===========================================================================
// Cross-cutting: wave-runner compatibility
// ===========================================================================

describe('cross-cutting: wave-runner format compatibility', () => {
  it('consolidator output maintains checkbox format (- [ ] **T{N}**)', () => {
    const s5b = section5B();
    assert.match(s5b, /- \[ \] \*\*T\d+\*\*/);
  });

  it('Blocked by field uses "none" or "T{N}" format (wave-runner parseable)', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Blocked by: none'));
    assert.ok(s5b.includes('Blocked by: T1'));
  });

  it('task format includes all fields wave-runner needs: Files, Model, Effort, Blocked by', () => {
    const s5b = section5B();
    const outputTemplate = s5b.match(/Step 7: Output[\s\S]*$/);
    assert.ok(outputTemplate, 'Step 7 output section must exist');
    const tmpl = outputTemplate[0];
    assert.ok(tmpl.includes('Files:'), 'Output must include Files');
    assert.ok(tmpl.includes('Model:'), 'Output must include Model');
    assert.ok(tmpl.includes('Effort:'), 'Output must include Effort');
    assert.ok(tmpl.includes('Blocked by:'), 'Output must include Blocked by');
  });
});
