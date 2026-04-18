/**
 * Integration tests for Plan Fan-Out v2 spec.
 *
 * Black-box tests verifying EACH acceptance criterion (AC-1 through AC-12)
 * through public interfaces only: CLI tools, markdown command files, and
 * file system artifacts.
 *
 * Uses Node.js built-in node:test to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PLAN_CMD_PATH = path.join(ROOT, 'src', 'commands', 'df', 'plan.md');
const EXEC_CMD_PATH = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');
const WAVE_RUNNER_PATH = path.join(ROOT, 'bin', 'wave-runner.js');
const CONSOLIDATOR_PATH = path.join(ROOT, 'bin', 'plan-consolidator.js');

// Read command files once
const PLAN_MD = fs.readFileSync(PLAN_CMD_PATH, 'utf8');
const EXEC_MD = fs.readFileSync(EXEC_CMD_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-pfv2-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Extract a section from plan.md between two heading patterns */
function getSection(startPattern, endPattern) {
  const re = new RegExp(startPattern + '[\\s\\S]*?(?=' + endPattern + ')');
  const match = PLAN_MD.match(re);
  assert.ok(match, `Section matching ${startPattern} must exist`);
  return match[0];
}

const fanOut = () => getSection('### 4\\.7\\. FAN-OUT', '### 5\\.');
const section5B = () => {
  const s5 = getSection('### 5\\. COMPARE', '### 5\\.5\\.');
  const m = s5.match(/#### 5B\. MULTI-SPEC CONSOLIDATOR[\s\S]*/);
  assert.ok(m, '5B must exist');
  return m[0];
};

/** Create a mini-plan file with standard format */
function writeMiniPlan(dir, specName, tasks) {
  const filePath = path.join(dir, `doing-${specName}.md`);
  const content = `### ${specName}\n\n` + tasks.map(t =>
    `- [ ] **T${t.id}**: ${t.desc}\n  - Files: ${t.files}\n  - Blocked by: ${t.blockedBy || 'none'}\n`
  ).join('\n');
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ===========================================================================
// AC-1 (REQ-1): Master prompt contains only spec file path — no pre-computed
//               context blocks
// ===========================================================================

describe('AC-1: master prompt contains only spec file path', () => {
  it('sub-agent receives ONLY the spec file path, no pre-computed context', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('ONLY the spec file path'),
      'Must state sub-agent receives only spec file path'
    );
    assert.ok(
      fo.includes('no pre-computed context, no spec content, no impact analysis, no experiment results'),
      'Must explicitly exclude pre-computed context blocks'
    );
  });

  it('orchestrator is declared as a thin dispatcher', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('The master orchestrator is a thin dispatcher'),
      'Must declare thin dispatcher role'
    );
  });

  it('sub-agent prompt template uses {spec_file_path} placeholder only', () => {
    const fo = fanOut();
    // The sub-agent prompt section should have {spec_file_path} as the only
    // variable data — no {spec_content}, {impact_analysis}, {experiments} etc.
    assert.ok(fo.includes('{spec_file_path}'), 'Must use {spec_file_path}');
    // The prompt template should NOT inject pre-computed context variables
    const promptSection = fo.match(/Each sub-agent prompt:[\s\S]*?```[\s\S]*?```/);
    assert.ok(promptSection, 'Sub-agent prompt template must exist');
    const template = promptSection[0];
    assert.ok(!template.includes('{spec_content}'), 'Must NOT inject spec content');
    assert.ok(!template.includes('{impact_analysis}'), 'Must NOT inject impact analysis');
    assert.ok(!template.includes('{experiment_results}'), 'Must NOT inject experiment results');
  });
});

// ===========================================================================
// AC-2 (REQ-2): Sub-agent independently performs spec read, codebase
//               exploration, layer-gated analysis
// ===========================================================================

describe('AC-2: sub-agent independently performs analysis', () => {
  it('sub-agent reads spec via Read tool (step 1)', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Read the spec') && fo.includes('Read tool'),
      'Sub-agent must read spec itself via Read tool'
    );
  });

  it('sub-agent computes spec layer independently (step 2)', () => {
    const fo = fanOut();
    assert.ok(fo.includes('Compute spec layer'), 'Sub-agent must compute layer');
  });

  it('sub-agent checks experiments independently (step 3)', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Check experiments') && fo.includes('.deepflow/experiments/'),
      'Sub-agent must check experiments'
    );
  });

  it('sub-agent explores codebase independently (step 4)', () => {
    const fo = fanOut();
    assert.ok(fo.includes('Explore the codebase'), 'Sub-agent must explore codebase');
  });

  it('sub-agent runs impact analysis for L3 only (step 5)', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Impact analysis') && fo.includes('L3 only'),
      'Sub-agent must run impact analysis for L3 specs'
    );
  });

  it('sub-agent runs targeted exploration (step 6)', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Targeted exploration'),
      'Sub-agent must run targeted exploration'
    );
  });

  it('sub-agent prompt embeds layer-gating rules table', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Layer-gating rules'),
      'Sub-agent prompt must embed layer-gating rules'
    );
    // Verify all four layers mentioned in the embedded table
    assert.ok(fo.includes('| L0 |'));
    assert.ok(fo.includes('| L1 |'));
    assert.ok(fo.includes('| L2 |'));
    assert.ok(fo.includes('| L3 |'));
  });
});

// ===========================================================================
// AC-3 (REQ-3): After fan-out, .deepflow/plans/doing-{name}.md files exist
//               on disk for each spec
// ===========================================================================

describe('AC-3: mini-plan files persisted to .deepflow/plans/', () => {
  it('section 4.7.3 writes mini-plans to .deepflow/plans/doing-{specName}.md', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('.deepflow/plans/doing-{specName}.md'),
      'Must write to .deepflow/plans/doing-{specName}.md'
    );
    assert.ok(
      fo.includes('Persist to disk (REQ-3)'),
      'Must reference REQ-3'
    );
  });

  it('creates .deepflow/plans/ directory if it does not exist', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes("Create `.deepflow/plans/` directory if it doesn't exist"),
      'Must create plans directory'
    );
  });

  it('mini-plans persist after consolidation for /df:execute reuse', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('Mini-plans persist in `.deepflow/plans/doing-'),
      'Mini-plans must persist after consolidation'
    );
    assert.ok(
      s5b.includes('REQ-3') && s5b.includes('REQ-7'),
      'Must reference REQ-3 and REQ-7'
    );
  });
});

// ===========================================================================
// AC-4 (REQ-4): PLAN.md has globally sequential T-ids (no gaps/duplicates)
//               with cross-spec conflict annotations
// ===========================================================================

describe('AC-4: globally sequential T-ids with conflict annotations', () => {
  it('plan-consolidator produces sequential T-ids with no gaps or duplicates', () => {
    const s5b = section5B();
    assert.ok(s5b.includes('Globally sequential T-ids (no gaps, no duplicates)'));
  });

  it('plan-consolidator remaps Blocked by references from local to global', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('Remapped `Blocked by` references (local → global)'),
      'Must remap blocked-by references'
    );
  });

  it('plan-consolidator adds [file-conflict: {filename}] annotations', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('[file-conflict: {filename}]'),
      'Must add file-conflict annotations'
    );
  });

  it('plan-consolidator CLI: creates temp mini-plans, consolidates, validates T-ids', () => {
    const tmpDir = makeTmpDir();
    try {
      // Create two mini-plans with local T-numbering
      writeMiniPlan(tmpDir, 'spec-a', [
        { id: 1, desc: 'Task A1', files: 'src/a.js', blockedBy: 'none' },
        { id: 2, desc: 'Task A2', files: 'src/a2.js', blockedBy: 'T1' },
      ]);
      writeMiniPlan(tmpDir, 'spec-b', [
        { id: 1, desc: 'Task B1', files: 'src/b.js', blockedBy: 'none' },
        { id: 2, desc: 'Task B2', files: 'src/b2.js', blockedBy: 'T1' },
      ]);

      const result = spawnSync('node', [CONSOLIDATOR_PATH, '--plans-dir', tmpDir], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0, `Consolidator must exit 0, stderr: ${result.stderr}`);

      const output = result.stdout;

      // Extract all T-ids from the output
      const tIds = [];
      const tIdPattern = /\*\*T(\d+)\*\*/g;
      let match;
      while ((match = tIdPattern.exec(output)) !== null) {
        tIds.push(parseInt(match[1], 10));
      }

      // Must have 4 tasks
      assert.equal(tIds.length, 4, `Expected 4 tasks, got ${tIds.length}`);

      // Must be sequential with no gaps: T1, T2, T3, T4
      for (let i = 0; i < tIds.length; i++) {
        assert.equal(tIds[i], i + 1, `T-id at position ${i} should be ${i + 1}, got ${tIds[i]}`);
      }

      // No duplicates
      const unique = new Set(tIds);
      assert.equal(unique.size, tIds.length, 'T-ids must have no duplicates');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('plan-consolidator detects cross-spec file conflicts', () => {
    const tmpDir = makeTmpDir();
    try {
      // Two specs with overlapping file (src/shared.js)
      writeMiniPlan(tmpDir, 'spec-a', [
        { id: 1, desc: 'Task A1', files: 'src/shared.js', blockedBy: 'none' },
      ]);
      writeMiniPlan(tmpDir, 'spec-b', [
        { id: 1, desc: 'Task B1', files: 'src/shared.js', blockedBy: 'none' },
      ]);

      const result = spawnSync('node', [CONSOLIDATOR_PATH, '--plans-dir', tmpDir], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0, `Consolidator must exit 0, stderr: ${result.stderr}`);

      const output = result.stdout;
      assert.ok(
        output.includes('[file-conflict:') || output.includes('file-conflict'),
        `Output must contain file-conflict annotation for overlapping src/shared.js. Output: ${output}`
      );
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ===========================================================================
// AC-5 (REQ-5): Mini-plan files are byte-identical before and after
//               consolidation
// ===========================================================================

describe('AC-5: mini-plan files byte-identical after consolidation', () => {
  it('section 5B states consolidator must NOT modify mini-plan files', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('must NOT modify these files (REQ-5)'),
      'Must state files are not modified, referencing REQ-5'
    );
  });

  it('mini-plan files left byte-identical (read-only) per spec', () => {
    const s5b = section5B();
    assert.ok(
      s5b.includes('Mini-plan files left byte-identical (read-only)'),
      'Must state byte-identical'
    );
  });

  it('plan-consolidator CLI: files are byte-identical before and after', () => {
    const tmpDir = makeTmpDir();
    try {
      const fileA = writeMiniPlan(tmpDir, 'spec-a', [
        { id: 1, desc: 'Task A1', files: 'src/a.js', blockedBy: 'none' },
      ]);
      const fileB = writeMiniPlan(tmpDir, 'spec-b', [
        { id: 1, desc: 'Task B1', files: 'src/b.js', blockedBy: 'none' },
      ]);

      // Capture file contents before consolidation
      const beforeA = fs.readFileSync(fileA);
      const beforeB = fs.readFileSync(fileB);

      // Run consolidator
      const result = spawnSync('node', [CONSOLIDATOR_PATH, '--plans-dir', tmpDir], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 0, `Consolidator must exit 0, stderr: ${result.stderr}`);

      // Compare file contents after consolidation
      const afterA = fs.readFileSync(fileA);
      const afterB = fs.readFileSync(fileB);

      assert.ok(
        Buffer.compare(beforeA, afterA) === 0,
        'Mini-plan file A must be byte-identical after consolidation'
      );
      assert.ok(
        Buffer.compare(beforeB, afterB) === 0,
        'Mini-plan file B must be byte-identical after consolidation'
      );
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ===========================================================================
// AC-6 (REQ-6): `node bin/wave-runner.js --json` outputs valid JSON with
//               T-id, description, Model, Files, Effort, Blocked by, spec
// ===========================================================================

describe('AC-6: wave-runner --json outputs valid JSON with required fields', () => {
  it('wave-runner --json outputs valid JSON structure', () => {
    // Create a temp PLAN.md with tasks
    const tmpDir = makeTmpDir();
    const planFile = path.join(tmpDir, 'PLAN.md');
    try {
      fs.writeFileSync(planFile, `# Plan

## Tasks

### doing-test-spec

- [ ] **T1**: Implement feature A
  - Files: src/a.js
  - Model: sonnet
  - Effort: medium
  - Blocked by: none

- [ ] **T2**: Implement feature B
  - Files: src/b.js
  - Model: opus
  - Effort: high
  - Blocked by: T1
`);

      const result = spawnSync('node', [WAVE_RUNNER_PATH, '--json', '--plan', planFile], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0, `wave-runner --json must exit 0, stderr: ${result.stderr}`);

      // Must be valid JSON
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `Output must be valid JSON. Got: ${result.stdout.slice(0, 500)}`);

      // Output is a flat array of task objects with wave field
      assert.ok(Array.isArray(parsed), 'Output must be a JSON array');
      assert.ok(parsed.length >= 1, 'Must have at least one task');

      // Check first task has required fields
      const task = parsed[0];
      assert.ok(task.id, 'Task must have id field');
      assert.ok(task.description, 'Task must have description field');
      assert.ok(task.files, 'Task must have files field');
      assert.ok(typeof task.wave === 'number', 'Task must have numeric wave field');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('wave-runner --json includes T-id, description, files, model, effort, blockedBy, spec', () => {
    const tmpDir = makeTmpDir();
    const planFile = path.join(tmpDir, 'PLAN.md');
    try {
      fs.writeFileSync(planFile, `# Plan

## Tasks

### doing-example

- [ ] **T1**: Build the widget
  - Files: src/widget.js, src/utils.js
  - Model: haiku
  - Effort: low
  - Blocked by: none
`);

      const result = spawnSync('node', [WAVE_RUNNER_PATH, '--json', '--plan', planFile], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0, `Must exit 0, stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.ok(Array.isArray(parsed) && parsed.length > 0);
      const task = parsed[0];

      assert.equal(task.id, 'T1', 'Task id must be T1');
      assert.ok(task.description.includes('Build the widget'), 'Description must contain task text');
      assert.ok(task.files, 'Files must be present');
      assert.equal(task.model, 'haiku', 'Model must be haiku');
      assert.equal(task.effort, 'low', 'Effort must be low');
      assert.ok(Array.isArray(task.blockedBy), 'blockedBy must be an array');
      assert.equal(task.spec, 'doing-example', 'spec must match heading');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('wave-runner --json includes blocked tasks in later waves', () => {
    const tmpDir = makeTmpDir();
    const planFile = path.join(tmpDir, 'PLAN.md');
    try {
      fs.writeFileSync(planFile, `# Plan

## Tasks

### doing-example

- [ ] **T1**: First task
  - Files: src/a.js
  - Blocked by: none

- [ ] **T2**: Blocked task
  - Files: src/b.js
  - Blocked by: T1
`);

      const result = spawnSync('node', [WAVE_RUNNER_PATH, '--json', '--plan', planFile], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);

      const t1 = parsed.find(t => t.id === 'T1');
      const t2 = parsed.find(t => t.id === 'T2');

      assert.ok(t1, 'T1 must be in output');
      assert.ok(t2, 'T2 must be in output');
      assert.ok(t2.wave > t1.wave, 'T2 must be in a later wave than T1');
      assert.ok(t2.blockedBy.includes('T1'), 'T2 must be blocked by T1');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('wave-runner --json spec field present when tasks grouped under spec heading', () => {
    const tmpDir = makeTmpDir();
    const planFile = path.join(tmpDir, 'PLAN.md');
    try {
      fs.writeFileSync(planFile, `# Plan

## Tasks

### doing-my-feature

- [ ] **T1**: Do something
  - Files: src/x.js
  - Blocked by: none
`);

      const result = spawnSync('node', [WAVE_RUNNER_PATH, '--json', '--plan', planFile], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.ok(Array.isArray(parsed) && parsed.length > 0);

      const task = parsed[0];
      assert.equal(task.spec, 'doing-my-feature', 'spec field must match the heading name');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ===========================================================================
// AC-7 (REQ-7): Execute reads --json output for scheduling and
//               .deepflow/plans/ for task detail
// ===========================================================================

describe('AC-7: execute reads --json output and .deepflow/plans/', () => {
  it('execute.md uses wave-runner --json for scheduling', () => {
    assert.ok(
      EXEC_MD.includes('node bin/wave-runner.js --json --plan PLAN.md'),
      'execute.md must shell-inject wave-runner --json'
    );
  });

  it('execute.md parses JSON wave output for ready set', () => {
    assert.ok(
      EXEC_MD.includes('WAVE_JSON'),
      'execute.md must assign WAVE_JSON variable'
    );
    assert.ok(
      EXEC_MD.includes('waves[0].tasks'),
      'execute.md must use waves[0].tasks as ready set'
    );
  });

  it('execute.md reads .deepflow/plans/ for per-task detail files', () => {
    assert.ok(
      EXEC_MD.includes('.deepflow/plans/doing-'),
      'execute.md must reference .deepflow/plans/doing-*.md'
    );
    assert.ok(
      EXEC_MD.includes('PLAN_TASK_FILES'),
      'execute.md must have PLAN_TASK_FILES variable'
    );
  });

  it('execute.md loads task detail on demand for agent prompt', () => {
    assert.ok(
      EXEC_MD.includes('TASK_DETAIL'),
      'execute.md must have TASK_DETAIL variable'
    );
    assert.ok(
      EXEC_MD.includes('.deepflow/plans/doing-{specName}.md'),
      'execute.md must reference per-task detail file pattern'
    );
  });

  it('execute.md falls back to PLAN.md inline block when detail file absent', () => {
    assert.ok(
      EXEC_MD.includes('NOT_FOUND') && EXEC_MD.includes('fall back'),
      'execute.md must fall back to PLAN.md when detail file not found'
    );
  });
});

// ===========================================================================
// AC-8 (REQ-8): section 4.7 no longer contains pre-computed context injection
//               (layer, experiments, impact blocks removed from master)
// ===========================================================================

describe('AC-8: no pre-computed context injection in section 4.7', () => {
  it('sub-agent prompt does not inject layer computation result', () => {
    const fo = fanOut();
    const promptSection = fo.match(/Each sub-agent prompt:[\s\S]*?```[\s\S]*?```/);
    assert.ok(promptSection, 'Sub-agent prompt template must exist');
    const template = promptSection[0];
    // Should NOT have pre-computed layer like {layer} or {spec_layer}
    assert.ok(!template.includes('{layer}'), 'Must NOT inject pre-computed layer');
    assert.ok(!template.includes('{spec_layer}'), 'Must NOT inject pre-computed spec_layer');
  });

  it('sub-agent prompt does not inject experiment results', () => {
    const fo = fanOut();
    const promptSection = fo.match(/Each sub-agent prompt:[\s\S]*?```[\s\S]*?```/);
    const template = promptSection[0];
    assert.ok(!template.includes('{experiment_results}'), 'Must NOT inject experiment_results');
    assert.ok(!template.includes('{experiments}'), 'Must NOT inject experiments');
  });

  it('sub-agent prompt does not inject impact analysis blocks', () => {
    const fo = fanOut();
    const promptSection = fo.match(/Each sub-agent prompt:[\s\S]*?```[\s\S]*?```/);
    const template = promptSection[0];
    assert.ok(!template.includes('{impact_analysis}'), 'Must NOT inject impact_analysis');
    assert.ok(!template.includes('{impact}'), 'Must NOT inject impact block');
  });

  it('no pre-computed context, no spec content, no impact analysis stated', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('no pre-computed context, no spec content, no impact analysis, no experiment results'),
      'Must explicitly enumerate excluded context types'
    );
  });
});

// ===========================================================================
// AC-9 (REQ-9): Single plannable spec runs monolithic path — no sub-agent
//               spawned, no .deepflow/plans/ written
// ===========================================================================

describe('AC-9: single spec runs monolithic path', () => {
  it('section 4.7 skip condition: exactly 1 spec skips entirely', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('If exactly 1 plannable spec → skip this section entirely'),
      'Must skip section for single spec'
    );
  });

  it('zero overhead for single spec — no fan-out code runs', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('zero overhead'),
      'Must state zero overhead'
    );
    assert.ok(
      fo.includes('No fan-out code runs'),
      'Must state no fan-out code runs'
    );
  });

  it('section 4.7.1 routes 1 spec to monolithic path (section 5)', () => {
    const fo = fanOut();
    assert.match(fo, /\*\*1 spec\*\*.*skip to §5/);
  });

  it('section 5A handles single-spec case and notes 4.7 was skipped', () => {
    const s5 = getSection('### 5\\. COMPARE', '### 5\\.5\\.');
    assert.ok(s5.includes('SINGLE-SPEC (MONOLITHIC PATH)'));
    assert.ok(s5.includes('§4.7 was skipped'));
  });

  it('section 5A uses reasoner (Opus) for analysis', () => {
    const s5 = getSection('### 5\\. COMPARE', '### 5\\.5\\.');
    assert.ok(
      s5.includes('subagent_type="reasoner"') && s5.includes('model="opus"'),
      'Single-spec path must use reasoner/opus'
    );
  });
});

// ===========================================================================
// AC-10 (REQ-10): Sub-agent failure logged as warning; PLAN.md generated
//                 from remaining mini-plans
// ===========================================================================

describe('AC-10: sub-agent failure graceful degradation', () => {
  it('documents three failure conditions', () => {
    const fo = fanOut();
    assert.ok(fo.includes('threw an error or returned a non-string value'));
    assert.ok(fo.includes('Output is empty (whitespace only)'));
    assert.ok(fo.includes('no task items'));
  });

  it('each failure condition logs a warning and skips spec', () => {
    const fo = fanOut();
    const logWarningCount = (fo.match(/log warning/g) || []).length;
    assert.ok(logWarningCount >= 3, `Must have at least 3 log warning directives, found ${logWarningCount}`);
  });

  it('warning format includes specName and reason', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('sub-agent for {specName} failed — {reason}'),
      'Warning must include specName and reason'
    );
  });

  it('continues processing remaining specs regardless of individual failures', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Continue processing remaining specs regardless of individual failures'),
      'Must continue with remaining specs'
    );
  });

  it('partial success continues to consolidation; total failure aborts', () => {
    const fo = fanOut();
    assert.ok(fo.includes('at least 1 succeeds'));
    assert.ok(fo.includes('ALL sub-agents fail'));
    assert.ok(fo.includes('abort plan generation'));
  });

  it('only successfully parsed mini-plans are stored', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('Only successfully parsed mini-plans are stored'),
      'Must only store successful mini-plans'
    );
  });

  it('section 9 renames only successfully planned specs', () => {
    const s9 = getSection('### 9\\. OUTPUT', '## Rules');
    assert.ok(
      s9.includes('successfully planned specs only') ||
      s9.includes('specs whose sub-agents failed'),
      'Section 9 must only rename successfully planned specs'
    );
  });
});

// ===========================================================================
// AC-11 (REQ-11): >5 specs triggers partial fan-out with user message
//                 listing deferred specs
// ===========================================================================

describe('AC-11: >5 specs triggers partial fan-out', () => {
  it('section 4.7.1 documents three ranges: 1, 2-5, >5', () => {
    const fo = fanOut();
    assert.match(fo, /\*\*1 spec\*\*/);
    assert.match(fo, /\*\*2.5 specs\*\*/);
    assert.match(fo, /\*\*>5 specs\*\*/);
  });

  it('>5 specs selects first 5 by filesystem order', () => {
    const fo = fanOut();
    assert.ok(
      fo.includes('select first 5 by filesystem') || fo.includes('first 5 by filesystem `ls` order'),
      'Must select first 5 by filesystem order'
    );
  });

  it('user message lists total count, deferred specs, and re-run instruction', () => {
    const fo = fanOut();
    assert.ok(fo.includes('{total} specs found'));
    assert.ok(fo.includes('Planning first 5 now'));
    assert.ok(fo.includes('Queued for next run'));
    assert.ok(fo.includes('Re-run /df:plan to process remaining specs'));
  });

  it('user message lists individual deferred spec filenames', () => {
    const fo = fanOut();
    assert.ok(fo.includes('- {spec6.md}'));
    assert.ok(fo.includes('- {spec7.md}'));
  });

  it('2-5 specs fans out all (no cap)', () => {
    const fo = fanOut();
    assert.match(fo, /\*\*2.5 specs\*\*.*fan-out all/);
  });
});

// ===========================================================================
// AC-12 (REQ-8): `node --test bin/wave-runner.test.js` and
//                `node --test bin/ratchet.test.js` exit 0
// ===========================================================================

describe('AC-12: wave-runner.test.js and ratchet.test.js pass', () => {
  it('node --test bin/wave-runner.test.js exits 0', () => {
    const result = spawnSync('node', ['--test', path.join(ROOT, 'bin', 'wave-runner.test.js')], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: ROOT,
    });
    assert.equal(
      result.status, 0,
      `wave-runner.test.js must exit 0. Status: ${result.status}. stderr: ${(result.stderr || '').slice(-500)}`
    );
  });

  it('node --test bin/ratchet.test.js exits 0', () => {
    const result = spawnSync('node', ['--test', path.join(ROOT, 'bin', 'ratchet.test.js')], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: ROOT,
    });
    assert.equal(
      result.status, 0,
      `ratchet.test.js must exit 0. Status: ${result.status}. stderr: ${(result.stderr || '').slice(-500)}`
    );
  });

  it('bin/wave-runner.test.js file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'bin', 'wave-runner.test.js')),
      'bin/wave-runner.test.js must exist'
    );
  });

  it('bin/ratchet.test.js file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'bin', 'ratchet.test.js')),
      'bin/ratchet.test.js must exist'
    );
  });
});

// ===========================================================================
// Cross-cutting: end-to-end data flow consistency
// ===========================================================================

describe('cross-cutting: data flow from plan to execute', () => {
  it('plan.md produces .deepflow/plans/ files that execute.md reads', () => {
    // plan.md writes: .deepflow/plans/doing-{specName}.md
    const fo = fanOut();
    assert.ok(fo.includes('.deepflow/plans/doing-'));

    // execute.md reads: .deepflow/plans/doing-*.md
    assert.ok(EXEC_MD.includes('.deepflow/plans/doing-'));
  });

  it('plan.md produces PLAN.md that execute.md feeds to wave-runner --json', () => {
    // plan.md appends tasks to PLAN.md (section 9)
    const s9 = getSection('### 9\\. OUTPUT', '## Rules');
    assert.ok(s9.includes('Append tasks'));

    // execute.md runs wave-runner --json --plan PLAN.md
    assert.ok(EXEC_MD.includes('node bin/wave-runner.js --json --plan PLAN.md'));
  });

  it('plan-consolidator output is compatible with wave-runner parser', () => {
    // Verify by running consolidator then wave-runner in sequence
    const tmpDir = makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    fs.mkdirSync(plansDir);

    try {
      writeMiniPlan(plansDir, 'spec-a', [
        { id: 1, desc: 'Task A1', files: 'src/a.js', blockedBy: 'none' },
      ]);
      writeMiniPlan(plansDir, 'spec-b', [
        { id: 1, desc: 'Task B1', files: 'src/b.js', blockedBy: 'none' },
      ]);

      // Run consolidator
      const consolidatorResult = spawnSync('node', [CONSOLIDATOR_PATH, '--plans-dir', plansDir], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(consolidatorResult.status, 0, 'Consolidator must exit 0');

      // Consolidator outputs markdown starting with "## Tasks" — write it as PLAN.md
      const planFile = path.join(tmpDir, 'PLAN.md');
      fs.writeFileSync(planFile, `# Plan\n\n${consolidatorResult.stdout}`);

      // Run wave-runner --json on consolidated plan
      const waveResult = spawnSync('node', [WAVE_RUNNER_PATH, '--json', '--plan', planFile], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(waveResult.status, 0, `wave-runner must parse consolidator output. stderr: ${waveResult.stderr}`);

      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(waveResult.stdout);
      }, 'wave-runner --json output must be valid JSON');

      // Output is a flat array of tasks
      assert.ok(Array.isArray(parsed), 'Must produce JSON array');
      assert.ok(parsed.length >= 2, 'Must have at least 2 tasks from 2 specs');

      // T-ids should be globally sequential (T1, T2)
      const ids = parsed.map(t => t.id);
      assert.ok(ids.includes('T1'), 'Must include T1');
      assert.ok(ids.includes('T2'), 'Must include T2');
    } finally {
      rmrf(tmpDir);
    }
  });
});
