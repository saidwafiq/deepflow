/**
 * Tests for execution-history orphaned task_end warning (T58).
 *
 * Verifies that parseExecutionHistory emits a console.warn when a task_end
 * record has no matching task_start, and does NOT warn when pairs match.
 *
 * Uses Node.js built-in node:test with mock to intercept console.warn.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We import the compiled JS from dist (ESM).
// The module depends on fetchPricing + computeCost from ../../pricing.js,
// and filesystem discovery. We set up a real temp dir structure so the
// discovery function finds our test files, and mock the pricing module
// via a dynamic import approach.

// Since mocking ESM pricing is hard, we instead test at a higher level:
// we build the exact dir structure the discovery function expects,
// provide a mock db, and capture console.warn output.

/** Build a claudeDir with projects/<encoded>/ structure pointing to a
 *  temp project dir that contains .deepflow/execution-history.jsonl.
 *
 *  The discovery function decodes dir names via:
 *    '/' + dirName.replace(/^-/, '').replace(/-/g, '/')
 *  So we must ensure our project dir path has NO hyphens in any segment.
 *  We create a deterministic path under /tmp using only underscores.
 */
let fixtureCounter = 0;

function setupFixture(jsonlLines) {
  // Use a path with no hyphens so the encode/decode roundtrip works.
  const projectDir = join(tmpdir(), `exechist_proj_${process.pid}_${++fixtureCounter}`);
  mkdirSync(projectDir, { recursive: true });

  const deepflowDir = join(projectDir, '.deepflow');
  mkdirSync(deepflowDir, { recursive: true });
  writeFileSync(
    join(deepflowDir, 'execution-history.jsonl'),
    jsonlLines.map(l => JSON.stringify(l)).join('\n') + '\n'
  );

  // Encode: strip leading '/', replace '/' with '-', prepend '-'
  const encoded = '-' + projectDir.slice(1).replace(/\//g, '-');

  const claudeDir = join(tmpdir(), `exechist_claude_${process.pid}_${fixtureCounter}`);
  const projectsDir = join(claudeDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(join(projectsDir, encoded), { recursive: true });

  return { claudeDir, projectDir, cleanup: () => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  }};
}

/** Minimal mock DB that records calls */
function createMockDb() {
  const inserts = [];
  const meta = new Map();
  return {
    get(sql, params) {
      if (sql.includes('_meta')) {
        return meta.get(params[0]) ?? undefined;
      }
      return undefined;
    },
    all(sql, params) {
      // token_events query — return empty
      return [];
    },
    run(sql, params) {
      if (sql.includes('_meta')) {
        meta.set(params[0], { value: params[1] });
      } else if (sql.includes('INSERT INTO task_attempts')) {
        inserts.push(params);
      }
    },
    inserts,
  };
}

describe('execution-history orphan warning', () => {
  let warnCalls;
  let originalWarn;

  beforeEach(() => {
    warnCalls = [];
    originalWarn = console.warn;
    console.warn = (...args) => {
      warnCalls.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('emits warning for orphaned task_end (no matching task_start)', async () => {
    const fixture = setupFixture([
      { type: 'task_end', task_id: 'T99', session_id: 'sess-orphan', status: 'pass', timestamp: '2026-01-01T00:01:00Z' },
    ]);

    try {
      const { parseExecutionHistory } = await import('../dist/ingest/parsers/execution-history.js');
      const db = createMockDb();
      await parseExecutionHistory(db, fixture.claudeDir);

      const orphanWarnings = warnCalls.filter(w => w.includes('Orphaned task_end'));
      assert.ok(orphanWarnings.length > 0, 'Expected at least one orphan warning');
      assert.ok(
        orphanWarnings.some(w => w.includes('task_id=T99')),
        'Warning should mention the orphaned task_id'
      );
      assert.ok(
        orphanWarnings.some(w => w.includes('session_id=sess-orphan')),
        'Warning should mention the orphaned session_id'
      );
      // No inserts should have occurred for the orphan
      assert.equal(db.inserts.length, 0, 'Orphaned task_end should not be inserted');
    } finally {
      fixture.cleanup();
    }
  });

  it('does NOT emit orphan warning when task_start and task_end are paired', async () => {
    const fixture = setupFixture([
      { type: 'task_start', task_id: 'T1', session_id: 'sess-1', spec: 'my-spec', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task_end', task_id: 'T1', session_id: 'sess-1', status: 'pass', timestamp: '2026-01-01T00:01:00Z' },
    ]);

    try {
      const { parseExecutionHistory } = await import('../dist/ingest/parsers/execution-history.js');
      const db = createMockDb();
      await parseExecutionHistory(db, fixture.claudeDir);

      const orphanWarnings = warnCalls.filter(w => w.includes('Orphaned task_end'));
      assert.equal(orphanWarnings.length, 0, 'No orphan warning expected for matched pair');
      // The paired record should have been inserted
      assert.equal(db.inserts.length, 1, 'Matched pair should produce one insert');
      assert.equal(db.inserts[0][0], 'T1', 'Inserted task_id should be T1');
    } finally {
      fixture.cleanup();
    }
  });

  it('warns only for the orphan when mixed paired and orphaned records exist', async () => {
    const fixture = setupFixture([
      { type: 'task_start', task_id: 'T1', session_id: 'sess-1', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task_end', task_id: 'T1', session_id: 'sess-1', status: 'pass', timestamp: '2026-01-01T00:01:00Z' },
      { type: 'task_end', task_id: 'T-orphan', session_id: 'sess-x', status: 'fail', timestamp: '2026-01-01T00:02:00Z' },
    ]);

    try {
      const { parseExecutionHistory } = await import('../dist/ingest/parsers/execution-history.js');
      const db = createMockDb();
      await parseExecutionHistory(db, fixture.claudeDir);

      const orphanWarnings = warnCalls.filter(w => w.includes('Orphaned task_end'));
      assert.equal(orphanWarnings.length, 1, 'Exactly one orphan warning expected');
      assert.ok(orphanWarnings[0].includes('T-orphan'), 'Warning should be for the orphaned task');
      assert.equal(db.inserts.length, 1, 'Only matched pair should be inserted');
    } finally {
      fixture.cleanup();
    }
  });

  it('handles orphaned task_end with undefined session_id', async () => {
    const fixture = setupFixture([
      { type: 'task_end', task_id: 'T-no-session', status: 'pass', timestamp: '2026-01-01T00:01:00Z' },
    ]);

    try {
      const { parseExecutionHistory } = await import('../dist/ingest/parsers/execution-history.js');
      const db = createMockDb();
      await parseExecutionHistory(db, fixture.claudeDir);

      const orphanWarnings = warnCalls.filter(w => w.includes('Orphaned task_end'));
      assert.ok(orphanWarnings.length > 0, 'Should warn for orphan with no session_id');
      assert.ok(
        orphanWarnings.some(w => w.includes('T-no-session')),
        'Warning should mention the task_id'
      );
      assert.equal(db.inserts.length, 0, 'No insert for orphaned record');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not warn when there are no task_end records at all', async () => {
    const fixture = setupFixture([
      { type: 'task_start', task_id: 'T1', session_id: 'sess-1', timestamp: '2026-01-01T00:00:00Z' },
    ]);

    try {
      const { parseExecutionHistory } = await import('../dist/ingest/parsers/execution-history.js');
      const db = createMockDb();
      await parseExecutionHistory(db, fixture.claudeDir);

      const orphanWarnings = warnCalls.filter(w => w.includes('Orphaned task_end'));
      assert.equal(orphanWarnings.length, 0, 'No orphan warning when no task_end records');
      assert.equal(db.inserts.length, 0, 'No inserts when no task_end records');
    } finally {
      fixture.cleanup();
    }
  });
});
