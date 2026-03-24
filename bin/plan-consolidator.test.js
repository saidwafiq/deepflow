/**
 * Tests for bin/plan-consolidator.js — mechanical consolidation of mini-plans.
 *
 * Tests cover:
 *   1. Mini-plan parsing: task extraction, tags, files, blocked-by
 *   2. T-id renumbering from local to global (sequential, no gaps)
 *   3. Blocked-by reference remapping to global T-ids
 *   4. Cross-spec file-conflict detection with [file-conflict: {filename}] annotations
 *   5. Input mini-plan files are never modified (read-only)
 *   6. Edge cases: single spec, empty plans, duplicate files, no tasks
 *   7. CLI: --plans-dir argument parsing and stdout output
 *   8. Output formatting: wave-runner-compatible markdown
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONSOLIDATOR_PATH = path.resolve(__dirname, 'plan-consolidator.js');
const CONSOLIDATOR_SRC = fs.readFileSync(CONSOLIDATOR_PATH, 'utf8');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-plan-consolidator-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Extract pure functions from plan-consolidator.js source for unit testing.
// ---------------------------------------------------------------------------

const extractedFns = (() => {
  const modifiedSrc = CONSOLIDATOR_SRC
    .replace(/^main\(\);?\s*$/m, '')
    .replace(/^#!.*$/m, '');

  const wrapped = `
    ${modifiedSrc}
    return { parseArgs, parseMiniPlan, detectFileConflicts, consolidate, formatConsolidated };
  `;

  const factory = new Function('require', 'process', '__dirname', '__filename', 'module', 'exports', wrapped);
  return factory(require, process, __dirname, __filename, module, exports);
})();

const { parseArgs, parseMiniPlan, detectFileConflicts, consolidate, formatConsolidated } = extractedFns;

// ---------------------------------------------------------------------------
// CLI runner helper
// ---------------------------------------------------------------------------

function runConsolidator(args = [], { cwd } = {}) {
  const result = spawnSync(
    process.execPath,
    [CONSOLIDATOR_PATH, ...args],
    {
      cwd: cwd || os.tmpdir(),
      encoding: 'utf8',
    }
  );
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status ?? 1,
  };
}

// ---------------------------------------------------------------------------
// 1. parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('extracts --plans-dir value', () => {
    const args = parseArgs(['node', 'plan-consolidator.js', '--plans-dir', '/tmp/plans']);
    assert.equal(args.plansDir, '/tmp/plans');
  });

  test('returns null when --plans-dir missing', () => {
    const args = parseArgs(['node', 'plan-consolidator.js']);
    assert.equal(args.plansDir, null);
  });

  test('returns null when --plans-dir has no following value', () => {
    const args = parseArgs(['node', 'plan-consolidator.js', '--plans-dir']);
    assert.equal(args.plansDir, null);
  });
});

// ---------------------------------------------------------------------------
// 2. parseMiniPlan
// ---------------------------------------------------------------------------

describe('parseMiniPlan', () => {
  test('parses basic pending tasks', () => {
    const text = `## Tasks

- [ ] **T1**: Set up project structure
- [ ] **T2**: Add routing layer
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].localId, 'T1');
    assert.equal(tasks[0].num, 1);
    assert.equal(tasks[0].description, 'Set up project structure');
    assert.equal(tasks[1].localId, 'T2');
    assert.equal(tasks[1].description, 'Add routing layer');
  });

  test('parses tasks with tags', () => {
    const text = '- [ ] **T1** [spike]: Explore API design\n';
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].tags, '[spike]');
    assert.equal(tasks[0].description, 'Explore API design');
  });

  test('parses Files annotation', () => {
    const text = `- [ ] **T1**: Do something
  - Files: src/a.js, src/b.js
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].files, ['src/a.js', 'src/b.js']);
  });

  test('parses Blocked by annotation', () => {
    const text = `- [ ] **T1**: First task
- [ ] **T2**: Second task
  - Blocked by: T1
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks[1].blockedBy, ['T1']);
  });

  test('parses multiple blocked-by refs', () => {
    const text = `- [ ] **T1**: A
- [ ] **T2**: B
- [ ] **T3**: C
  - Blocked by: T1, T2
`;
    const tasks = parseMiniPlan(text);
    assert.deepEqual(tasks[2].blockedBy, ['T1', 'T2']);
  });

  test('skips completed tasks', () => {
    const text = `- [x] **T1**: Done task
- [ ] **T2**: Pending task
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].localId, 'T2');
  });

  test('does not attach annotations from after a completed task to a previous pending task', () => {
    const text = `- [ ] **T1**: First
- [x] **T2**: Completed
  - Files: should-not-attach.js
- [ ] **T3**: Third
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 2);
    // Files line after completed T2 should not attach to T1
    assert.deepEqual(tasks[0].files, []);
  });

  test('returns empty array for text with no tasks', () => {
    const tasks = parseMiniPlan('# Just a heading\n\nSome prose.\n');
    assert.equal(tasks.length, 0);
  });

  test('returns empty array for empty string', () => {
    const tasks = parseMiniPlan('');
    assert.equal(tasks.length, 0);
  });

  test('handles task with no description', () => {
    const text = '- [ ] **T1**:\n';
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].description, '');
  });
});

// ---------------------------------------------------------------------------
// 3. detectFileConflicts
// ---------------------------------------------------------------------------

describe('detectFileConflicts', () => {
  test('detects files touched by multiple specs', () => {
    const specEntries = [
      { specName: 'auth', tasks: [{ files: ['src/user.js', 'src/db.js'] }] },
      { specName: 'billing', tasks: [{ files: ['src/db.js', 'src/payment.js'] }] },
    ];
    const conflicts = detectFileConflicts(specEntries);
    assert.equal(conflicts.size, 1);
    assert.ok(conflicts.has('src/db.js'));
    const specs = conflicts.get('src/db.js');
    assert.ok(specs.includes('auth'));
    assert.ok(specs.includes('billing'));
  });

  test('returns empty map when no conflicts', () => {
    const specEntries = [
      { specName: 'auth', tasks: [{ files: ['src/auth.js'] }] },
      { specName: 'billing', tasks: [{ files: ['src/billing.js'] }] },
    ];
    const conflicts = detectFileConflicts(specEntries);
    assert.equal(conflicts.size, 0);
  });

  test('returns empty map for single spec', () => {
    const specEntries = [
      { specName: 'auth', tasks: [{ files: ['src/a.js'] }, { files: ['src/a.js'] }] },
    ];
    const conflicts = detectFileConflicts(specEntries);
    assert.equal(conflicts.size, 0);
  });

  test('returns empty map when no files declared', () => {
    const specEntries = [
      { specName: 'auth', tasks: [{ files: [] }] },
      { specName: 'billing', tasks: [{ files: [] }] },
    ];
    const conflicts = detectFileConflicts(specEntries);
    assert.equal(conflicts.size, 0);
  });

  test('detects multiple conflicted files', () => {
    const specEntries = [
      { specName: 'a', tasks: [{ files: ['shared.js', 'utils.js'] }] },
      { specName: 'b', tasks: [{ files: ['shared.js', 'utils.js'] }] },
      { specName: 'c', tasks: [{ files: ['shared.js'] }] },
    ];
    const conflicts = detectFileConflicts(specEntries);
    assert.equal(conflicts.size, 2);
    assert.equal(conflicts.get('shared.js').length, 3);
    assert.equal(conflicts.get('utils.js').length, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. consolidate — T-id renumbering and blocked-by remapping
// ---------------------------------------------------------------------------

describe('consolidate', () => {
  test('renumbers T-ids globally in sequential order', () => {
    const specEntries = [
      {
        specName: 'alpha',
        tasks: [
          { localId: 'T1', num: 1, description: 'A1', tags: '', blockedBy: [], files: [] },
          { localId: 'T2', num: 2, description: 'A2', tags: '', blockedBy: [], files: [] },
        ],
      },
      {
        specName: 'beta',
        tasks: [
          { localId: 'T1', num: 1, description: 'B1', tags: '', blockedBy: [], files: [] },
          { localId: 'T2', num: 2, description: 'B2', tags: '', blockedBy: [], files: [] },
        ],
      },
    ];
    const result = consolidate(specEntries, new Map());
    assert.equal(result.length, 4);
    assert.equal(result[0].globalId, 'T1');
    assert.equal(result[1].globalId, 'T2');
    assert.equal(result[2].globalId, 'T3');
    assert.equal(result[3].globalId, 'T4');
  });

  test('remaps blocked-by references to global T-ids', () => {
    const specEntries = [
      {
        specName: 'alpha',
        tasks: [
          { localId: 'T1', num: 1, description: 'A1', tags: '', blockedBy: [], files: [] },
          { localId: 'T2', num: 2, description: 'A2', tags: '', blockedBy: ['T1'], files: [] },
        ],
      },
      {
        specName: 'beta',
        tasks: [
          { localId: 'T1', num: 1, description: 'B1', tags: '', blockedBy: [], files: [] },
          { localId: 'T2', num: 2, description: 'B2', tags: '', blockedBy: ['T1'], files: [] },
        ],
      },
    ];
    const result = consolidate(specEntries, new Map());
    // alpha T2 blocked by alpha T1 → global T2 blocked by T1
    assert.deepEqual(result[1].blockedBy, ['T1']);
    // beta T2 blocked by beta T1 → global T4 blocked by T3
    assert.deepEqual(result[3].blockedBy, ['T3']);
  });

  test('drops cross-spec blocked-by references that do not exist in local map', () => {
    const specEntries = [
      {
        specName: 'alpha',
        tasks: [
          { localId: 'T1', num: 1, description: 'A1', tags: '', blockedBy: ['T99'], files: [] },
        ],
      },
    ];
    const result = consolidate(specEntries, new Map());
    assert.deepEqual(result[0].blockedBy, []);
  });

  test('adds file-conflict annotations to affected tasks', () => {
    const specEntries = [
      {
        specName: 'alpha',
        tasks: [
          { localId: 'T1', num: 1, description: 'A1', tags: '', blockedBy: [], files: ['shared.js'] },
        ],
      },
    ];
    const fileConflicts = new Map([['shared.js', ['alpha', 'beta']]]);
    const result = consolidate(specEntries, fileConflicts);
    assert.deepEqual(result[0].conflictAnnotations, ['[file-conflict: shared.js]']);
  });

  test('no conflict annotations when file is not conflicted', () => {
    const specEntries = [
      {
        specName: 'alpha',
        tasks: [
          { localId: 'T1', num: 1, description: 'A1', tags: '', blockedBy: [], files: ['only-mine.js'] },
        ],
      },
    ];
    const result = consolidate(specEntries, new Map());
    assert.deepEqual(result[0].conflictAnnotations, []);
  });

  test('handles empty spec entries', () => {
    const result = consolidate([], new Map());
    assert.equal(result.length, 0);
  });

  test('handles spec with no tasks', () => {
    const specEntries = [{ specName: 'empty', tasks: [] }];
    const result = consolidate(specEntries, new Map());
    assert.equal(result.length, 0);
  });

  test('preserves tags and specName on consolidated tasks', () => {
    const specEntries = [
      {
        specName: 'auth',
        tasks: [
          { localId: 'T1', num: 1, description: 'spike it', tags: '[spike]', blockedBy: [], files: [] },
        ],
      },
    ];
    const result = consolidate(specEntries, new Map());
    assert.equal(result[0].tags, '[spike]');
    assert.equal(result[0].specName, 'auth');
  });
});

// ---------------------------------------------------------------------------
// 5. formatConsolidated
// ---------------------------------------------------------------------------

describe('formatConsolidated', () => {
  test('outputs empty state for no tasks', () => {
    const output = formatConsolidated([]);
    assert.ok(output.includes('(no tasks found)'));
    assert.ok(output.startsWith('## Tasks'));
  });

  test('groups tasks under spec headings', () => {
    const tasks = [
      { globalId: 'T1', specName: 'auth', description: 'Login', tags: '', blockedBy: [], files: [], conflictAnnotations: [] },
      { globalId: 'T2', specName: 'auth', description: 'Logout', tags: '', blockedBy: ['T1'], files: [], conflictAnnotations: [] },
      { globalId: 'T3', specName: 'billing', description: 'Charge', tags: '', blockedBy: [], files: ['billing.js'], conflictAnnotations: [] },
    ];
    const output = formatConsolidated(tasks);
    assert.ok(output.includes('### auth'));
    assert.ok(output.includes('### billing'));
    assert.ok(output.includes('- [ ] **T1**: Login'));
    assert.ok(output.includes('- [ ] **T2**: Logout'));
    assert.ok(output.includes('Blocked by: T1'));
    assert.ok(output.includes('Blocked by: none'));
    assert.ok(output.includes('Files: billing.js'));
  });

  test('appends file-conflict annotations to description', () => {
    const tasks = [
      {
        globalId: 'T1', specName: 'x', description: 'Do stuff', tags: '',
        blockedBy: [], files: ['shared.js'], conflictAnnotations: ['[file-conflict: shared.js]'],
      },
    ];
    const output = formatConsolidated(tasks);
    assert.ok(output.includes('[file-conflict: shared.js]'));
  });

  test('includes tags in task header', () => {
    const tasks = [
      { globalId: 'T1', specName: 'x', description: 'Spike it', tags: '[spike]', blockedBy: [], files: [], conflictAnnotations: [] },
    ];
    const output = formatConsolidated(tasks);
    assert.ok(output.includes('**T1** [spike]: Spike it'));
  });
});

// ---------------------------------------------------------------------------
// 6. CLI integration tests
// ---------------------------------------------------------------------------

describe('CLI integration', () => {
  test('exits 1 when --plans-dir is missing', () => {
    const result = runConsolidator([]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('--plans-dir'));
  });

  test('exits 1 when plans directory does not exist', () => {
    const result = runConsolidator(['--plans-dir', '/tmp/nonexistent-df-test-dir-' + Date.now()]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('not found'));
  });

  test('outputs empty message for directory with no doing- files', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('no mini-plan files'));
    } finally {
      rmrf(tmpDir);
    }
  });

  test('consolidates a single mini-plan file', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'doing-auth.md'), `## Tasks

- [ ] **T1**: Set up auth module
  - Files: src/auth.js
- [ ] **T2**: Add login endpoint
  - Files: src/auth.js, src/routes.js
  - Blocked by: T1
`);
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('**T1**'));
      assert.ok(result.stdout.includes('**T2**'));
      assert.ok(result.stdout.includes('Blocked by: T1'));
      assert.ok(result.stdout.includes('### auth'));
    } finally {
      rmrf(tmpDir);
    }
  });

  test('consolidates multiple mini-plans with global renumbering', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'doing-auth.md'), `## Tasks
- [ ] **T1**: Auth task 1
- [ ] **T2**: Auth task 2
  - Blocked by: T1
`);
      fs.writeFileSync(path.join(tmpDir, 'doing-billing.md'), `## Tasks
- [ ] **T1**: Billing task 1
- [ ] **T2**: Billing task 2
  - Blocked by: T1
`);
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);

      // auth T1→T1, auth T2→T2, billing T1→T3, billing T2→T4
      assert.ok(result.stdout.includes('**T1**: Auth task 1'));
      assert.ok(result.stdout.includes('**T2**: Auth task 2'));
      assert.ok(result.stdout.includes('**T3**: Billing task 1'));
      assert.ok(result.stdout.includes('**T4**: Billing task 2'));

      // Blocked-by remapping: billing T2 blocked by billing T1 → T4 blocked by T3
      assert.ok(result.stdout.includes('Blocked by: T3'));
    } finally {
      rmrf(tmpDir);
    }
  });

  test('detects cross-spec file conflicts and annotates tasks', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'doing-auth.md'), `## Tasks
- [ ] **T1**: Touch shared file
  - Files: src/shared.js
`);
      fs.writeFileSync(path.join(tmpDir, 'doing-billing.md'), `## Tasks
- [ ] **T1**: Also touch shared file
  - Files: src/shared.js
`);
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('[file-conflict: src/shared.js]'));
      // Conflict warning on stderr
      assert.ok(result.stderr.includes('conflict'), 'stderr should mention conflict');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('input mini-plan files are never modified', () => {
    const tmpDir = makeTmpDir();
    try {
      const content = `## Tasks
- [ ] **T1**: Original task
  - Files: src/a.js
  - Blocked by: T99
`;
      const filePath = path.join(tmpDir, 'doing-readonly.md');
      fs.writeFileSync(filePath, content);
      const mtimeBefore = fs.statSync(filePath).mtimeMs;

      runConsolidator(['--plans-dir', tmpDir]);

      const contentAfter = fs.readFileSync(filePath, 'utf8');
      const mtimeAfter = fs.statSync(filePath).mtimeMs;
      assert.equal(contentAfter, content, 'File content must not change');
      assert.equal(mtimeAfter, mtimeBefore, 'File mtime must not change');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('ignores non-doing files in plans directory', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'done-old.md'), `- [ ] **T1**: Should be ignored\n`);
      fs.writeFileSync(path.join(tmpDir, 'some-notes.md'), `- [ ] **T1**: Also ignored\n`);
      fs.writeFileSync(path.join(tmpDir, 'doing-active.md'), `- [ ] **T1**: Included\n`);

      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('**T1**: Included'));
      assert.ok(!result.stdout.includes('Should be ignored'));
      assert.ok(!result.stdout.includes('Also ignored'));
    } finally {
      rmrf(tmpDir);
    }
  });

  test('processes files in alphabetical order for determinism', () => {
    const tmpDir = makeTmpDir();
    try {
      // Write in reverse alphabetical order
      fs.writeFileSync(path.join(tmpDir, 'doing-zebra.md'), `- [ ] **T1**: Zebra task\n`);
      fs.writeFileSync(path.join(tmpDir, 'doing-alpha.md'), `- [ ] **T1**: Alpha task\n`);

      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      // alpha sorts before zebra, so alpha T1 → T1, zebra T1 → T2
      const t1Pos = result.stdout.indexOf('**T1**: Alpha task');
      const t2Pos = result.stdout.indexOf('**T2**: Zebra task');
      assert.ok(t1Pos >= 0, 'Alpha task should be T1');
      assert.ok(t2Pos >= 0, 'Zebra task should be T2');
      assert.ok(t1Pos < t2Pos, 'Alpha should appear before Zebra');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('derives spec name correctly from hyphenated filename', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'doing-my-feature-name.md'), `- [ ] **T1**: Some task\n`);
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('### my-feature-name'), 'spec name should preserve hyphens');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('handles mini-plan with mixed completed and pending tasks', () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'doing-mixed.md'), `## Tasks

- [x] **T1**: Already done
  - Files: src/done.js
- [ ] **T2**: Still pending
  - Files: src/pending.js
  - Blocked by: T1
- [x] **T3**: Also done
- [ ] **T4**: Last pending
  - Blocked by: T2
`);
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      // Only pending tasks included; T2 and T4 renumbered to T1 and T2
      assert.ok(result.stdout.includes('**T1**: Still pending'), 'T2 becomes global T1');
      assert.ok(result.stdout.includes('**T2**: Last pending'), 'T4 becomes global T2');
      assert.ok(!result.stdout.includes('Already done'), 'completed tasks excluded');
      assert.ok(!result.stdout.includes('Also done'), 'completed tasks excluded');
    } finally {
      rmrf(tmpDir);
    }
  });

  test('blocked-by remapping skips completed task ids correctly', () => {
    // T4 is blocked by T2 in the local plan; T1 and T3 are completed.
    // After parsing, only T2→globalT1, T4→globalT2 remain. T4's dep on T2 → globalT1.
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'doing-partial.md'), `## Tasks

- [x] **T1**: Completed first
- [ ] **T2**: Pending second
- [x] **T3**: Completed third
- [ ] **T4**: Pending fourth
  - Blocked by: T2
`);
      const result = runConsolidator(['--plans-dir', tmpDir]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('**T1**: Pending second'));
      assert.ok(result.stdout.includes('**T2**: Pending fourth'));
      assert.ok(result.stdout.includes('Blocked by: T1'), 'T4 dep on T2 remapped to global T1');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. parseMiniPlan — additional edge cases
// ---------------------------------------------------------------------------

describe('parseMiniPlan — edge cases', () => {
  test('parses task with large T-number (T100)', () => {
    const text = '- [ ] **T100**: Big numbered task\n';
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].localId, 'T100');
    assert.equal(tasks[0].num, 100);
    assert.equal(tasks[0].description, 'Big numbered task');
  });

  test('parses task with both tags and files+blocked-by annotations', () => {
    const text = `- [ ] **T1** [spike]: Explore caching
  - Files: src/cache.js, src/utils.js
  - Blocked by: T0
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].tags, '[spike]');
    assert.equal(tasks[0].description, 'Explore caching');
    assert.deepEqual(tasks[0].files, ['src/cache.js', 'src/utils.js']);
    assert.deepEqual(tasks[0].blockedBy, ['T0']);
  });

  test('File: singular form is also parsed', () => {
    const text = `- [ ] **T1**: Single file task
  - File: src/only.js
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].files, ['src/only.js']);
  });

  test('ignores whitespace-only file entries in files list', () => {
    // If someone writes "Files: src/a.js,  , src/b.js" — empty segments filtered out
    const text = `- [ ] **T1**: Task
  - Files: src/a.js,  , src/b.js
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    // filter(Boolean) removes empty strings after trim
    assert.ok(!tasks[0].files.includes(''), 'no empty string in files');
    assert.ok(tasks[0].files.includes('src/a.js'));
    assert.ok(tasks[0].files.includes('src/b.js'));
  });

  test('multiple pending tasks with non-contiguous numbers', () => {
    // Mini-plan might have T1, T3, T5 if someone manually edited it
    const text = `- [ ] **T1**: First
- [ ] **T3**: Third (T2 was removed)
- [ ] **T5**: Fifth
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].localId, 'T1');
    assert.equal(tasks[1].localId, 'T3');
    assert.equal(tasks[2].localId, 'T5');
  });

  test('malformed blocked-by line with no valid T-refs is parsed as empty', () => {
    const text = `- [ ] **T1**: Task
  - Blocked by: none
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    // "none" does not match /^T\d+$/ so blockedBy stays empty
    assert.deepEqual(tasks[0].blockedBy, []);
  });

  test('case-insensitive blocked by', () => {
    const text = `- [ ] **T1**: A
- [ ] **T2**: B
  - blocked by: T1
`;
    const tasks = parseMiniPlan(text);
    assert.deepEqual(tasks[1].blockedBy, ['T1']);
  });

  test('case-insensitive completed task marker [X]', () => {
    const text = `- [X] **T1**: Done uppercase X
- [ ] **T2**: Pending
`;
    const tasks = parseMiniPlan(text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].localId, 'T2');
  });
});

// ---------------------------------------------------------------------------
// 8. consolidate — additional edge cases
// ---------------------------------------------------------------------------

describe('consolidate — additional edge cases', () => {
  test('renumbers large task set with correct global offset', () => {
    // First spec has T1..T10, second spec has T1..T5
    const firstSpec = {
      specName: 'big',
      tasks: Array.from({ length: 10 }, (_, i) => ({
        localId: `T${i + 1}`, num: i + 1,
        description: `Task ${i + 1}`, tags: '', blockedBy: [], files: [],
      })),
    };
    const secondSpec = {
      specName: 'small',
      tasks: Array.from({ length: 5 }, (_, i) => ({
        localId: `T${i + 1}`, num: i + 1,
        description: `Small ${i + 1}`, tags: '', blockedBy: [], files: [],
      })),
    };
    const result = consolidate([firstSpec, secondSpec], new Map());
    assert.equal(result.length, 15);
    assert.equal(result[9].globalId, 'T10');  // last of first spec
    assert.equal(result[10].globalId, 'T11'); // first of second spec
    assert.equal(result[14].globalId, 'T15'); // last of second spec
  });

  test('task with multiple files where only some conflict gets all conflict annotations', () => {
    const specEntries = [
      {
        specName: 'alpha',
        tasks: [{
          localId: 'T1', num: 1, description: 'Mixed files', tags: '',
          blockedBy: [], files: ['shared.js', 'mine-only.js', 'also-shared.js'],
        }],
      },
    ];
    const fileConflicts = new Map([
      ['shared.js', ['alpha', 'beta']],
      ['also-shared.js', ['alpha', 'gamma']],
    ]);
    const result = consolidate(specEntries, fileConflicts);
    assert.equal(result[0].conflictAnnotations.length, 2);
    assert.ok(result[0].conflictAnnotations.includes('[file-conflict: shared.js]'));
    assert.ok(result[0].conflictAnnotations.includes('[file-conflict: also-shared.js]'));
  });

  test('chain-only: blocked-by ref to a non-local T-id is dropped silently', () => {
    // T2 tries to block on T5 which doesn't exist in this spec
    const specEntries = [
      {
        specName: 'solo',
        tasks: [
          { localId: 'T1', num: 1, description: 'A', tags: '', blockedBy: [], files: [] },
          { localId: 'T2', num: 2, description: 'B', tags: '', blockedBy: ['T1', 'T5'], files: [] },
        ],
      },
    ];
    const result = consolidate(specEntries, new Map());
    // T5 doesn't exist in this spec — should be silently dropped
    assert.deepEqual(result[1].blockedBy, ['T1']);
  });

  test('spec with all completed tasks contributes nothing to consolidated output', () => {
    // parseMiniPlan skips completed tasks; simulate a spec that had all tasks done
    const specEntries = [
      { specName: 'done-spec', tasks: [] },
      {
        specName: 'active-spec',
        tasks: [{ localId: 'T1', num: 1, description: 'Active', tags: '', blockedBy: [], files: [] }],
      },
    ];
    const result = consolidate(specEntries, new Map());
    assert.equal(result.length, 1);
    assert.equal(result[0].globalId, 'T1');
    assert.equal(result[0].specName, 'active-spec');
  });
});

// ---------------------------------------------------------------------------
// 9. formatConsolidated — additional edge cases
// ---------------------------------------------------------------------------

describe('formatConsolidated — additional edge cases', () => {
  test('task with both tags and conflict annotations renders correctly', () => {
    const tasks = [
      {
        globalId: 'T1', specName: 'x', description: 'Risky spike',
        tags: '[spike]', blockedBy: [], files: ['shared.js'],
        conflictAnnotations: ['[file-conflict: shared.js]'],
      },
    ];
    const output = formatConsolidated(tasks);
    assert.ok(output.includes('**T1** [spike]: Risky spike [file-conflict: shared.js]'));
  });

  test('task with no description but has conflict annotation', () => {
    const tasks = [
      {
        globalId: 'T1', specName: 'x', description: '',
        tags: '', blockedBy: [], files: ['shared.js'],
        conflictAnnotations: ['[file-conflict: shared.js]'],
      },
    ];
    const output = formatConsolidated(tasks);
    // descPart = ('' + ' [file-conflict: shared.js]').trim() = '[file-conflict: shared.js]'
    assert.ok(output.includes(': [file-conflict: shared.js]'));
  });

  test('multiple specs produce separate section headings each time spec changes', () => {
    const tasks = [
      { globalId: 'T1', specName: 'alpha', description: 'A1', tags: '', blockedBy: [], files: [], conflictAnnotations: [] },
      { globalId: 'T2', specName: 'beta', description: 'B1', tags: '', blockedBy: [], files: [], conflictAnnotations: [] },
      { globalId: 'T3', specName: 'alpha', description: 'A2', tags: '', blockedBy: [], files: [], conflictAnnotations: [] },
    ];
    const output = formatConsolidated(tasks);
    // alpha appears twice (tasks interleaved) — two ### alpha headings
    const headingMatches = output.match(/### alpha/g);
    assert.equal(headingMatches.length, 2, 'alpha heading appears twice when tasks interleave');
  });

  test('multiple files are joined with comma-space in output', () => {
    const tasks = [
      {
        globalId: 'T1', specName: 'x', description: 'Multi-file',
        tags: '', blockedBy: [], files: ['a.js', 'b.js', 'c.js'],
        conflictAnnotations: [],
      },
    ];
    const output = formatConsolidated(tasks);
    assert.ok(output.includes('Files: a.js, b.js, c.js'));
  });

  test('multiple blocked-by refs are joined with comma-space', () => {
    const tasks = [
      {
        globalId: 'T3', specName: 'x', description: 'Multi-dep',
        tags: '', blockedBy: ['T1', 'T2'], files: [],
        conflictAnnotations: [],
      },
    ];
    const output = formatConsolidated(tasks);
    assert.ok(output.includes('Blocked by: T1, T2'));
  });
});
