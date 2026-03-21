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
    return { parseArgs, parsePlan, buildWaves, formatWaves };
  `;

  const factory = new Function('require', 'process', '__dirname', '__filename', 'module', 'exports', wrapped);
  return factory(require, process, __dirname, __filename, module, exports);
})();

const { parseArgs, parsePlan, buildWaves, formatWaves } = extractedFns;

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
