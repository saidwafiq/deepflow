/**
 * Tests for bin/wave-runner.js — DAG-based wave grouping of PLAN.md tasks.
 *
 * Tests cover:
 *   1. PLAN.md parsing: task extraction, dependency parsing, completed-task skipping
 *   2. Wave grouping: correct topological ordering via Kahn's algorithm
 *   3. --recalc --failed: stuck tasks and transitive dependents excluded
 *   4. Edge cases: no tasks, circular deps, all completed, single task
 *   5. CLI arg parsing
 *   6. Output formatting
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WAVE_RUNNER_PATH = path.resolve(__dirname, 'wave-runner.js');
const WAVE_RUNNER_SRC = fs.readFileSync(WAVE_RUNNER_PATH, 'utf8');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-wave-runner-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Extract pure functions from wave-runner.js source for unit testing.
// ---------------------------------------------------------------------------

const extractedFns = (() => {
  const modifiedSrc = WAVE_RUNNER_SRC
    .replace(/^main\(\);?\s*$/m, '')
    .replace(/^#!.*$/m, '');

  const wrapped = `
    ${modifiedSrc}
    return { parseArgs, parsePlan, buildWaves, formatWaves, formatWavesJson };
  `;

  const factory = new Function('require', 'process', '__dirname', '__filename', 'module', 'exports', wrapped);
  return factory(require, process, __dirname, __filename, module, exports);
})();

const { parseArgs, parsePlan, buildWaves, formatWaves, formatWavesJson } = extractedFns;

// ---------------------------------------------------------------------------
// CLI runner helper
// ---------------------------------------------------------------------------

function runWaveRunner(args = [], { cwd } = {}) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [WAVE_RUNNER_PATH, ...args],
      {
        cwd: cwd || os.tmpdir(),
        encoding: 'utf8',
      }
    );
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// 1. parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs — CLI argument parsing', () => {
  test('defaults to PLAN.md with no recalc', () => {
    const args = parseArgs(['node', 'wave-runner.js']);
    assert.equal(args.plan, 'PLAN.md');
    assert.equal(args.recalc, false);
    assert.deepEqual(args.failed, []);
  });

  test('--plan overrides default path', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--plan', 'custom/PLAN.md']);
    assert.equal(args.plan, 'custom/PLAN.md');
  });

  test('--recalc flag enables recalc mode', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--recalc']);
    assert.equal(args.recalc, true);
  });

  test('--failed accepts comma-separated task IDs', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--recalc', '--failed', 'T3,T5,T7']);
    assert.deepEqual(args.failed, ['T3', 'T5', 'T7']);
  });

  test('--failed accepts multiple --failed flags', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--recalc', '--failed', 'T3', '--failed', 'T5']);
    assert.deepEqual(args.failed, ['T3', 'T5']);
  });
});

// ---------------------------------------------------------------------------
// 2. parsePlan — PLAN.md task extraction
// ---------------------------------------------------------------------------

describe('parsePlan — PLAN.md parsing', () => {
  test('extracts pending tasks with IDs and descriptions', () => {
    const text = `
## Tasks
- [ ] **T1**: Build the parser
- [ ] **T2**: Wire up CLI
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 'T1');
    assert.equal(tasks[0].description, 'Build the parser');
    assert.equal(tasks[1].id, 'T2');
    assert.equal(tasks[1].description, 'Wire up CLI');
  });

  test('extracts blocked-by dependencies', () => {
    const text = `
- [ ] **T1**: First task
- [ ] **T2**: Second task
  - Blocked by: T1
- [ ] **T3**: Third task
  - Blocked by: T1, T2
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks[0].blockedBy, []);
    assert.deepEqual(tasks[1].blockedBy, ['T1']);
    assert.deepEqual(tasks[2].blockedBy, ['T1', 'T2']);
  });

  test('skips completed tasks (checked checkbox)', () => {
    const text = `
- [x] **T1**: Done task
- [ ] **T2**: Pending task
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T2');
  });

  test('handles tasks with tag brackets', () => {
    const text = `
- [ ] **T5** [SPIKE]: Investigate API design
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T5');
    assert.equal(tasks[0].description, 'Investigate API design');
  });

  test('returns empty array for empty input', () => {
    const tasks = parsePlan('');
    assert.equal(tasks.length, 0);
  });

  test('returns empty array when all tasks are completed', () => {
    const text = `
- [x] **T1**: Done
- [x] **T2**: Also done
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 0);
  });

  test('does not attach blocked-by annotations from completed tasks to next pending task', () => {
    const text = `
- [x] **T1**: Completed
  - Blocked by: T0
- [ ] **T2**: Pending with no deps
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T2');
    assert.deepEqual(tasks[0].blockedBy, []);
  });

  test('handles input with no task lines', () => {
    const text = `
# My Plan
Some descriptive text without any task checkboxes.
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. buildWaves — DAG to wave grouping (AC-1, AC-2)
// ---------------------------------------------------------------------------

describe('buildWaves — topological wave grouping', () => {
  test('independent tasks all go in wave 1', () => {
    const tasks = [
      { id: 'T1', num: 1, description: 'A', blockedBy: [] },
      { id: 'T2', num: 2, description: 'B', blockedBy: [] },
      { id: 'T3', num: 3, description: 'C', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set());
    assert.equal(waves.length, 1);
    assert.equal(waves[0].length, 3);
  });

  test('linear chain produces one task per wave', () => {
    // T1 → T2 → T3
    const tasks = [
      { id: 'T1', num: 1, description: 'First', blockedBy: [] },
      { id: 'T2', num: 2, description: 'Second', blockedBy: ['T1'] },
      { id: 'T3', num: 3, description: 'Third', blockedBy: ['T2'] },
    ];
    const waves = buildWaves(tasks, new Set());
    assert.equal(waves.length, 3);
    assert.equal(waves[0][0].id, 'T1');
    assert.equal(waves[1][0].id, 'T2');
    assert.equal(waves[2][0].id, 'T3');
  });

  test('diamond DAG groups correctly', () => {
    //   T1
    //  / \
    // T2  T3
    //  \ /
    //   T4
    const tasks = [
      { id: 'T1', num: 1, description: 'Root', blockedBy: [] },
      { id: 'T2', num: 2, description: 'Left', blockedBy: ['T1'] },
      { id: 'T3', num: 3, description: 'Right', blockedBy: ['T1'] },
      { id: 'T4', num: 4, description: 'Join', blockedBy: ['T2', 'T3'] },
    ];
    const waves = buildWaves(tasks, new Set());
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0].map(t => t.id), ['T1']);
    assert.deepEqual(waves[1].map(t => t.id), ['T2', 'T3']);
    assert.deepEqual(waves[2].map(t => t.id), ['T4']);
  });

  test('tasks appear after all their blocking dependencies waves', () => {
    // T1 (wave 1), T2 blocked by T1 (wave 2), T3 blocked by T1 (wave 2),
    // T4 blocked by T2 and T3 (wave 3)
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: [] },
      { id: 'T2', num: 2, description: '', blockedBy: ['T1'] },
      { id: 'T3', num: 3, description: '', blockedBy: ['T1'] },
      { id: 'T4', num: 4, description: '', blockedBy: ['T2', 'T3'] },
    ];
    const waves = buildWaves(tasks, new Set());

    // Build a map of task → wave index
    const taskWave = new Map();
    waves.forEach((wave, wi) => {
      for (const t of wave) taskWave.set(t.id, wi);
    });

    // T4 must be in a wave strictly after T2 and T3
    assert.ok(taskWave.get('T4') > taskWave.get('T2'));
    assert.ok(taskWave.get('T4') > taskWave.get('T3'));
    // T2 and T3 must be after T1
    assert.ok(taskWave.get('T2') > taskWave.get('T1'));
    assert.ok(taskWave.get('T3') > taskWave.get('T1'));
  });

  test('deps on completed (non-pending) tasks are treated as satisfied', () => {
    // T2 depends on T1, but T1 is not in the pending list (already completed)
    const tasks = [
      { id: 'T2', num: 2, description: 'Depends on completed T1', blockedBy: ['T1'] },
      { id: 'T3', num: 3, description: 'Independent', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set());
    // Both should be in wave 1 since T1 is not pending
    assert.equal(waves.length, 1);
    assert.equal(waves[0].length, 2);
  });

  test('tasks are sorted by task number within each wave', () => {
    const tasks = [
      { id: 'T10', num: 10, description: '', blockedBy: [] },
      { id: 'T3', num: 3, description: '', blockedBy: [] },
      { id: 'T7', num: 7, description: '', blockedBy: [] },
      { id: 'T1', num: 1, description: '', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set());
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T1', 'T3', 'T7', 'T10']);
  });

  test('empty task list produces no waves', () => {
    const waves = buildWaves([], new Set());
    assert.equal(waves.length, 0);
  });

  test('circular dependency results in tasks not appearing in any wave', () => {
    // T1 blocked by T2, T2 blocked by T1 — neither can ever be resolved
    const tasks = [
      { id: 'T1', num: 1, description: 'A', blockedBy: ['T2'] },
      { id: 'T2', num: 2, description: 'B', blockedBy: ['T1'] },
    ];
    const waves = buildWaves(tasks, new Set());
    // Kahn's algorithm: tasks in a cycle have in-degree > 0 forever, so no waves
    assert.equal(waves.length, 0);
  });

  test('partial circular dependency: non-cyclic tasks still appear', () => {
    // T1 and T2 form a cycle, but T3 is independent
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: ['T2'] },
      { id: 'T2', num: 2, description: '', blockedBy: ['T1'] },
      { id: 'T3', num: 3, description: '', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set());
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T3']);
  });
});

// ---------------------------------------------------------------------------
// 4. buildWaves with stuckIds — --recalc --failed (AC-3)
// ---------------------------------------------------------------------------

describe('buildWaves with stuckIds — recalc/failed mode', () => {
  test('stuck task is excluded from all waves', () => {
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: [] },
      { id: 'T2', num: 2, description: '', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set(['T1']));
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T2']);
  });

  test('transitive dependents of stuck task are also excluded', () => {
    // T1 → T2 → T3, T4 independent
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: [] },
      { id: 'T2', num: 2, description: '', blockedBy: ['T1'] },
      { id: 'T3', num: 3, description: '', blockedBy: ['T2'] },
      { id: 'T4', num: 4, description: '', blockedBy: [] },
    ];
    // T1 failed → T2 and T3 (transitive dependents) should also be excluded
    const waves = buildWaves(tasks, new Set(['T1']));
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T4']);
  });

  test('multiple stuck tasks exclude all their dependents', () => {
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: [] },
      { id: 'T2', num: 2, description: '', blockedBy: [] },
      { id: 'T3', num: 3, description: '', blockedBy: ['T1'] },
      { id: 'T4', num: 4, description: '', blockedBy: ['T2'] },
      { id: 'T5', num: 5, description: '', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set(['T1', 'T2']));
    // T1, T2 stuck → T3, T4 excluded → only T5 remains
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T5']);
  });

  test('stuck task that does not exist in task list is ignored', () => {
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set(['T99']));
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T1']);
  });

  test('all tasks stuck results in no waves', () => {
    const tasks = [
      { id: 'T1', num: 1, description: '', blockedBy: [] },
      { id: 'T2', num: 2, description: '', blockedBy: [] },
    ];
    const waves = buildWaves(tasks, new Set(['T1', 'T2']));
    assert.equal(waves.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. formatWaves — output formatting
// ---------------------------------------------------------------------------

describe('formatWaves — output formatting', () => {
  test('formats waves with task IDs and descriptions', () => {
    const waves = [
      [{ id: 'T1', description: 'Build parser' }, { id: 'T4', description: 'Setup CI' }],
      [{ id: 'T2', description: 'Wire CLI' }],
    ];
    const output = formatWaves(waves);
    assert.equal(output, 'Wave 1: T1 — Build parser, T4 — Setup CI\nWave 2: T2 — Wire CLI');
  });

  test('handles tasks with empty descriptions', () => {
    const waves = [
      [{ id: 'T1', description: '' }],
    ];
    const output = formatWaves(waves);
    assert.equal(output, 'Wave 1: T1');
  });

  test('returns "(no pending tasks)" for empty waves', () => {
    const output = formatWaves([]);
    assert.equal(output, '(no pending tasks)');
  });
});

// ---------------------------------------------------------------------------
// 6. Integration: parsePlan → buildWaves end-to-end
// ---------------------------------------------------------------------------

describe('Integration — parsePlan → buildWaves', () => {
  test('realistic PLAN.md produces correct waves', () => {
    const planText = `
# PLAN

## Tasks

- [x] **T1**: Setup project structure
- [ ] **T2**: Implement parser
  - Blocked by: T1
- [ ] **T3**: Add CLI interface
  - Blocked by: T1
- [ ] **T4**: Integration tests
  - Blocked by: T2, T3
- [ ] **T5**: Documentation
    `;

    const tasks = parsePlan(planText);
    // T1 is completed, so only T2, T3, T4, T5 are pending
    assert.equal(tasks.length, 4);

    const waves = buildWaves(tasks, new Set());
    // T2, T3, T5 have no pending deps (T1 is completed) → wave 1
    // T4 depends on T2 and T3 → wave 2
    assert.equal(waves.length, 2);
    assert.deepEqual(waves[0].map(t => t.id), ['T2', 'T3', 'T5']);
    assert.deepEqual(waves[1].map(t => t.id), ['T4']);
  });

  test('recalc with failed task excludes dependents from waves', () => {
    const planText = `
- [ ] **T1**: Base implementation
- [ ] **T2**: Feature A
  - Blocked by: T1
- [ ] **T3**: Feature B
  - Blocked by: T1
- [ ] **T4**: Feature C
    `;

    const tasks = parsePlan(planText);
    const waves = buildWaves(tasks, new Set(['T1']));
    // T1 stuck → T2, T3 excluded → only T4
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].map(t => t.id), ['T4']);
  });
});

// ---------------------------------------------------------------------------
// 7. CLI subprocess tests
// ---------------------------------------------------------------------------

describe('CLI — wave-runner.js subprocess', () => {
  test('exits 1 when PLAN.md is not found', () => {
    const tmpDir = makeTmpDir();
    try {
      const { code, stderr } = runWaveRunner([], { cwd: tmpDir });
      assert.equal(code, 1);
      assert.ok(stderr.includes('not found'), `Expected "not found" in stderr: ${stderr}`);
    } finally {
      rmrf(tmpDir);
    }
  });

  test('exits 0 and prints waves for valid PLAN.md', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [ ] **T1**: First\n- [ ] **T2**: Second\n  - Blocked by: T1\n'
      );
      const { code, stdout } = runWaveRunner([], { cwd: tmpDir });
      assert.equal(code, 0);
      assert.ok(stdout.includes('Wave 1:'));
      assert.ok(stdout.includes('T1'));
      assert.ok(stdout.includes('Wave 2:'));
      assert.ok(stdout.includes('T2'));
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--plan flag reads from custom path', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'custom.md'),
        '- [ ] **T1**: Only task\n'
      );
      const { code, stdout } = runWaveRunner(['--plan', 'custom.md'], { cwd: tmpDir });
      assert.equal(code, 0);
      assert.ok(stdout.includes('T1'));
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--recalc --failed excludes failed task and dependents', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [ ] **T1**: Base\n- [ ] **T2**: Depends on T1\n  - Blocked by: T1\n- [ ] **T3**: Independent\n'
      );
      const { code, stdout } = runWaveRunner(['--recalc', '--failed', 'T1'], { cwd: tmpDir });
      assert.equal(code, 0);
      assert.ok(stdout.includes('T3'), 'Independent task should appear');
      assert.ok(!stdout.includes('T1'), 'Failed task should not appear');
      assert.ok(!stdout.includes('T2'), 'Dependent of failed task should not appear');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('prints "(no pending tasks)" when all tasks are completed', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [x] **T1**: Done\n- [x] **T2**: Also done\n'
      );
      const { code, stdout } = runWaveRunner([], { cwd: tmpDir });
      assert.equal(code, 0);
      assert.ok(stdout.includes('(no pending tasks)'));
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. parseArgs — --json flag
// ---------------------------------------------------------------------------

describe('parseArgs — --json flag', () => {
  test('--json defaults to false', () => {
    const args = parseArgs(['node', 'wave-runner.js']);
    assert.equal(args.json, false);
  });

  test('--json flag enables JSON mode', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--json']);
    assert.equal(args.json, true);
  });

  test('--json combined with other flags', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--recalc', '--failed', 'T1', '--json']);
    assert.equal(args.json, true);
    assert.equal(args.recalc, true);
    assert.deepEqual(args.failed, ['T1']);
  });

  test('--json before other flags', () => {
    const args = parseArgs(['node', 'wave-runner.js', '--json', '--plan', 'custom.md']);
    assert.equal(args.json, true);
    assert.equal(args.plan, 'custom.md');
  });
});

// ---------------------------------------------------------------------------
// 9. parsePlan — metadata annotations (model, files, effort, spec)
// ---------------------------------------------------------------------------

describe('parsePlan — metadata annotations', () => {
  test('extracts Model annotation', () => {
    const text = `
- [ ] **T1**: Build parser
  - Model: opus
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].model, 'opus');
  });

  test('extracts Files annotation', () => {
    const text = `
- [ ] **T1**: Build parser
  - Files: src/parser.js, src/util.js
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].files, 'src/parser.js, src/util.js');
  });

  test('extracts Effort annotation', () => {
    const text = `
- [ ] **T1**: Build parser
  - Effort: high
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].effort, 'high');
  });

  test('extracts spec name from ### header', () => {
    const text = `
### my-feature
- [ ] **T1**: Build parser
- [ ] **T2**: Wire CLI
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, 'my-feature');
    assert.equal(tasks[1].spec, 'my-feature');
  });

  test('spec changes when a new ### header appears', () => {
    const text = `
### feature-a
- [ ] **T1**: Task in feature-a

### feature-b
- [ ] **T2**: Task in feature-b
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, 'feature-a');
    assert.equal(tasks[1].spec, 'feature-b');
  });

  test('spec is null when no ### header precedes a task', () => {
    const text = `
- [ ] **T1**: No spec header above
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, null);
  });

  test('metadata defaults to null when annotations are absent', () => {
    const text = `
- [ ] **T1**: Bare task
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].model, null);
    assert.equal(tasks[0].files, null);
    assert.equal(tasks[0].effort, null);
    assert.equal(tasks[0].spec, null);
  });

  test('all annotations on one task', () => {
    const text = `
### my-spec
- [ ] **T1**: Full task
  - Blocked by: T0
  - Model: sonnet
  - Files: a.js, b.js
  - Effort: low
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].blockedBy, ['T0']);
    assert.equal(tasks[0].model, 'sonnet');
    assert.equal(tasks[0].files, 'a.js, b.js');
    assert.equal(tasks[0].effort, 'low');
    assert.equal(tasks[0].spec, 'my-spec');
  });

  test('annotations are case-insensitive', () => {
    const text = `
- [ ] **T1**: Test case
  - model: OPUS
  - files: x.ts
  - effort: Medium
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].model, 'OPUS');
    assert.equal(tasks[0].files, 'x.ts');
    assert.equal(tasks[0].effort, 'Medium');
  });
});

// ---------------------------------------------------------------------------
// 10. formatWavesJson — JSON output formatting
// ---------------------------------------------------------------------------

describe('formatWavesJson — JSON output formatting', () => {
  test('returns valid JSON array', () => {
    const waves = [
      [{ id: 'T1', description: 'Build parser', model: 'opus', files: 'a.js', effort: 'high', blockedBy: [], spec: 'my-spec' }],
    ];
    const output = formatWavesJson(waves);
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed));
  });

  test('includes wave number for each task', () => {
    const waves = [
      [{ id: 'T1', description: 'First', model: null, files: null, effort: null, blockedBy: [], spec: null }],
      [{ id: 'T2', description: 'Second', model: null, files: null, effort: null, blockedBy: ['T1'], spec: null }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    assert.equal(parsed[0].wave, 1);
    assert.equal(parsed[1].wave, 2);
  });

  test('preserves all metadata fields', () => {
    const waves = [
      [{ id: 'T1', description: 'Do stuff', model: 'opus', files: 'src/a.js', effort: 'high', blockedBy: ['T0'], spec: 'my-spec' }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    const t = parsed[0];
    assert.equal(t.id, 'T1');
    assert.equal(t.description, 'Do stuff');
    assert.equal(t.model, 'opus');
    assert.equal(t.files, 'src/a.js');
    assert.equal(t.effort, 'high');
    assert.deepEqual(t.blockedBy, ['T0']);
    assert.equal(t.spec, 'my-spec');
    assert.equal(t.wave, 1);
  });

  test('null fields for missing metadata', () => {
    const waves = [
      [{ id: 'T1', description: '', model: null, files: null, effort: null, blockedBy: [], spec: null }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    const t = parsed[0];
    assert.equal(t.description, null); // empty string becomes null
    assert.equal(t.model, null);
    assert.equal(t.files, null);
    assert.equal(t.effort, null);
    assert.equal(t.spec, null);
  });

  test('multiple tasks across multiple waves', () => {
    const waves = [
      [
        { id: 'T1', description: 'A', model: null, files: null, effort: null, blockedBy: [], spec: null },
        { id: 'T2', description: 'B', model: null, files: null, effort: null, blockedBy: [], spec: null },
      ],
      [
        { id: 'T3', description: 'C', model: null, files: null, effort: null, blockedBy: ['T1'], spec: null },
      ],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].wave, 1);
    assert.equal(parsed[1].wave, 1);
    assert.equal(parsed[2].wave, 2);
  });

  test('empty waves returns empty JSON array', () => {
    const parsed = JSON.parse(formatWavesJson([]));
    assert.deepEqual(parsed, []);
  });

  test('output is pretty-printed with 2-space indent', () => {
    const waves = [
      [{ id: 'T1', description: 'X', model: null, files: null, effort: null, blockedBy: [], spec: null }],
    ];
    const output = formatWavesJson(waves);
    // Pretty-printed JSON starts with [\n  {
    assert.ok(output.startsWith('[\n  {'));
  });
});

// ---------------------------------------------------------------------------
// 11. formatWavesJson — additional edge cases
// ---------------------------------------------------------------------------

describe('formatWavesJson — edge cases and field completeness', () => {
  test('output contains the required fields per task (including new AC/domain/detail fields)', () => {
    const waves = [
      [{ id: 'T1', description: 'Desc', model: 'opus', files: 'a.js', effort: 'low', blockedBy: ['T0'], spec: 'my-spec', tag: null, num: 1 }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    const keys = Object.keys(parsed[0]).sort();
    assert.deepEqual(keys, [
      'acceptance_criteria', 'blockedBy', 'description', 'domain_model',
      'effort', 'files', 'id', 'isIntegration', 'isOptimize', 'isSpike',
      'model', 'spec', 'tag', 'task_detail_body', 'wave',
    ]);
    // New fields default to empty when spec file not found
    assert.deepEqual(parsed[0].acceptance_criteria, []);
    assert.equal(parsed[0].domain_model, '');
    assert.equal(parsed[0].task_detail_body, '');
  });

  test('empty string description is coerced to null', () => {
    const waves = [
      [{ id: 'T1', description: '', model: null, files: null, effort: null, blockedBy: [], spec: null }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    assert.equal(parsed[0].description, null);
  });

  test('non-empty string fields pass through as-is (only empty string and null become null)', () => {
    // formatWavesJson uses `t.X || null` — only falsy values (null, undefined, '') become null
    // Non-empty strings like 'haiku' are preserved
    const waves = [
      [{ id: 'T5', description: 'desc', model: 'haiku', files: 'src/x.js', effort: 'low', blockedBy: [], spec: 'my-spec' }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    assert.equal(parsed[0].model, 'haiku');
    assert.equal(parsed[0].files, 'src/x.js');
    assert.equal(parsed[0].effort, 'low');
    assert.equal(parsed[0].spec, 'my-spec');
  });

  test('blockedBy array is preserved intact', () => {
    const waves = [
      [{ id: 'T4', description: 'D', model: null, files: null, effort: null, blockedBy: ['T1', 'T2', 'T3'], spec: null }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    assert.deepEqual(parsed[0].blockedBy, ['T1', 'T2', 'T3']);
  });

  test('wave numbers are 1-indexed and sequential', () => {
    const waves = [
      [{ id: 'T1', description: 'A', model: null, files: null, effort: null, blockedBy: [], spec: null }],
      [{ id: 'T2', description: 'B', model: null, files: null, effort: null, blockedBy: [], spec: null }],
      [{ id: 'T3', description: 'C', model: null, files: null, effort: null, blockedBy: [], spec: null }],
    ];
    const parsed = JSON.parse(formatWavesJson(waves));
    assert.equal(parsed[0].wave, 1);
    assert.equal(parsed[1].wave, 2);
    assert.equal(parsed[2].wave, 3);
  });
});

// ---------------------------------------------------------------------------
// 12. parsePlan — doing-{name} spec header extraction
// ---------------------------------------------------------------------------

describe('parsePlan — doing-{name} spec header extraction', () => {
  test('extracts spec from ### doing-{name} header verbatim', () => {
    const text = `
### doing-plan-fanout-v2
- [ ] **T1**: First task
- [ ] **T2**: Second task
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, 'doing-plan-fanout-v2');
    assert.equal(tasks[1].spec, 'doing-plan-fanout-v2');
  });

  test('extracts spec from ### done-{name} header', () => {
    const text = `
### done-my-feature
- [ ] **T1**: Leftover task
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, 'done-my-feature');
  });

  test('spec switches from doing- to another spec mid-file', () => {
    const text = `
### doing-spec-a
- [ ] **T1**: In spec-a

### doing-spec-b
- [ ] **T2**: In spec-b
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, 'doing-spec-a');
    assert.equal(tasks[1].spec, 'doing-spec-b');
  });

  test('spec header with extra whitespace is trimmed', () => {
    const text = `
###   my-spec-with-spaces
- [ ] **T1**: Task
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].spec, 'my-spec-with-spaces');
  });

  test('mixed pending and completed tasks under same spec header', () => {
    const text = `
### doing-mixed
- [x] **T1**: Done
- [ ] **T2**: Pending
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T2');
    assert.equal(tasks[0].spec, 'doing-mixed');
  });
});

// ---------------------------------------------------------------------------
// 13. parsePlan — metadata not leaked across task boundaries
// ---------------------------------------------------------------------------

describe('parsePlan — metadata isolation across task boundaries', () => {
  test('model annotation not leaked to subsequent task', () => {
    const text = `
- [ ] **T1**: First
  - Model: opus
- [ ] **T2**: Second
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].model, 'opus');
    assert.equal(tasks[1].model, null);
  });

  test('files annotation not leaked to subsequent task', () => {
    const text = `
- [ ] **T1**: First
  - Files: a.js
- [ ] **T2**: Second
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].files, 'a.js');
    assert.equal(tasks[1].files, null);
  });

  test('effort annotation not leaked to subsequent task', () => {
    const text = `
- [ ] **T1**: First
  - Effort: high
- [ ] **T2**: Second
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].effort, 'high');
    assert.equal(tasks[1].effort, null);
  });

  test('completed task between two pending tasks resets annotation context', () => {
    const text = `
- [ ] **T1**: Pending
  - Model: opus
- [x] **T2**: Completed with model
  - Model: sonnet
- [ ] **T3**: Next pending
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 'T1');
    assert.equal(tasks[0].model, 'opus');
    assert.equal(tasks[1].id, 'T3');
    assert.equal(tasks[1].model, null);
  });

  test('annotations in non-standard order are all captured', () => {
    const text = `
- [ ] **T1**: Task
  - Effort: medium
  - Blocked by: T0
  - Files: x.js
  - Model: haiku
    `;
    const tasks = parsePlan(text);
    assert.equal(tasks[0].effort, 'medium');
    assert.deepEqual(tasks[0].blockedBy, ['T0']);
    assert.equal(tasks[0].files, 'x.js');
    assert.equal(tasks[0].model, 'haiku');
  });
});

// ---------------------------------------------------------------------------
// 15. CLI — --json subprocess tests
// ---------------------------------------------------------------------------

describe('CLI — --json flag subprocess', () => {
  test('--json outputs valid JSON array', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [ ] **T1**: First task\n- [ ] **T2**: Second task\n  - Blocked by: T1\n'
      );
      const { code, stdout } = runWaveRunner(['--json'], { cwd: tmpDir });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed.length, 2);
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--json includes wave numbers', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [ ] **T1**: First\n- [ ] **T2**: Second\n  - Blocked by: T1\n'
      );
      const { code, stdout } = runWaveRunner(['--json'], { cwd: tmpDir });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed[0].id, 'T1');
      assert.equal(parsed[0].wave, 1);
      assert.equal(parsed[1].id, 'T2');
      assert.equal(parsed[1].wave, 2);
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--json includes metadata annotations', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '### my-spec\n- [ ] **T1**: Task with metadata\n  - Model: opus\n  - Files: src/a.js\n  - Effort: high\n'
      );
      const { code, stdout } = runWaveRunner(['--json'], { cwd: tmpDir });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed[0].model, 'opus');
      assert.equal(parsed[0].files, 'src/a.js');
      assert.equal(parsed[0].effort, 'high');
      assert.equal(parsed[0].spec, 'my-spec');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--json with --recalc --failed excludes stuck tasks', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [ ] **T1**: Base\n- [ ] **T2**: Depends\n  - Blocked by: T1\n- [ ] **T3**: Independent\n'
      );
      const { code, stdout } = runWaveRunner(['--json', '--recalc', '--failed', 'T1'], { cwd: tmpDir });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'T3');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--json with no pending tasks returns empty array', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [x] **T1**: Done\n- [x] **T2**: Also done\n'
      );
      const { code, stdout } = runWaveRunner(['--json'], { cwd: tmpDir });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.deepEqual(parsed, []);
    } finally {
      rmrf(tmpDir);
    }
  });

  test('--json still exits 1 when PLAN.md not found', () => {
    const tmpDir = makeTmpDir();
    try {
      const { code } = runWaveRunner(['--json'], { cwd: tmpDir });
      assert.equal(code, 1);
    } finally {
      rmrf(tmpDir);
    }
  });

  test('without --json flag, output is plain text (not JSON)', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'PLAN.md'),
        '- [ ] **T1**: Task\n'
      );
      const { code, stdout } = runWaveRunner([], { cwd: tmpDir });
      assert.equal(code, 0);
      assert.ok(stdout.includes('Wave 1:'));
      assert.throws(() => JSON.parse(stdout));
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8: round-trip — acceptance_criteria, domain_model, task_detail_body
// ---------------------------------------------------------------------------

describe('AC-8: formatWavesJson round-trip with spec and mini-plan fixtures', () => {
  test('acceptance_criteria, domain_model, task_detail_body are populated from fixture files', () => {
    const tmpDir = makeTmpDir();
    try {
      // Create directory structure
      fs.mkdirSync(path.join(tmpDir, 'specs'));
      fs.mkdirSync(path.join(tmpDir, '.deepflow'));
      fs.mkdirSync(path.join(tmpDir, '.deepflow', 'plans'));

      // Spec file with Acceptance Criteria and Domain Model sections
      const specContent = [
        '# doing-demo',
        '',
        '## Acceptance Criteria',
        '',
        '- **AC-1**: First criterion',
        '- **AC-2**: Second criterion',
        '',
        '## Domain Model',
        '',
        'Entity: Foo — represents a widget.',
        'Entity: Bar — represents a gadget.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'specs', 'doing-demo.md'), specContent, 'utf8');

      // Mini-plan file with a T1 block
      const planContent = [
        '# doing-demo plan',
        '',
        '### T1 \u2014 Implement core feature',
        '',
        'This task covers the main implementation.',
        'It has multiple lines of detail.',
        '',
        '### T2 \u2014 Write tests',
        '',
        'This should not appear in T1 body.',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.deepflow', 'plans', 'doing-demo.md'), planContent, 'utf8');

      // PLAN.md referencing the demo spec
      const planMd = [
        '### demo',
        '- [ ] **T1**: Implement core feature',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'PLAN.md'), planMd, 'utf8');

      const { code, stdout } = runWaveRunner(['--json'], { cwd: tmpDir });
      assert.equal(code, 0, `wave-runner exited with non-zero: ${stdout}`);

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.length, 1);
      const task = parsed[0];

      // AC-2: acceptance_criteria is an array of AC identifiers
      assert.deepEqual(task.acceptance_criteria, ['AC-1', 'AC-2']);

      // AC-3: domain_model is the Domain Model section content (trimmed)
      assert.ok(task.domain_model.includes('Entity: Foo'), `domain_model missing expected content: ${task.domain_model}`);
      assert.ok(task.domain_model.includes('Entity: Bar'), `domain_model missing second entity: ${task.domain_model}`);

      // AC-4: task_detail_body is the body under ### T1 — block
      assert.ok(task.task_detail_body.includes('This task covers the main implementation.'), `task_detail_body missing expected content: ${task.task_detail_body}`);
      assert.ok(!task.task_detail_body.includes('This should not appear'), `task_detail_body must not bleed into T2 section: ${task.task_detail_body}`);
    } finally {
      rmrf(tmpDir);
    }
  });
});
