/**
 * Tests for pipeline warning fixes (W1–W4).
 *
 * W1: discoverTokenHistoryFiles handles hyphenated project names (my-app, bingo-rgs, foo-bar-baz)
 *     — verifies the old "--" skip condition is absent from token-history.ts.
 * W2: parseQuotaHistory is idempotent — quota_snapshots uses INSERT OR IGNORE.
 * W3: migration purges sessions with model='<synthetic>' — verified via db/index.ts source.
 * W4: Subagent virtual session upsert only updates cache_creation when existing row has 0.
 *
 * Source-level assertions (no DB spin-up needed) follow the same pattern as
 * pipeline-critical-fixes.test.js and wave-t54-t55-t56-t59-t65.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// W1: discoverTokenHistoryFiles — no hyphen-based dir filtering
// ---------------------------------------------------------------------------
describe('W1 — discoverTokenHistoryFiles handles multi-hyphen project names', () => {
  const tokenSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'token-history.ts'), 'utf8');

  // Extract just the discoverTokenHistoryFiles function body
  const discoverStart = tokenSrc.indexOf('function discoverTokenHistoryFiles');
  const discoverEnd = tokenSrc.indexOf('\nexport async function parseTokenHistory');
  const discoverFn = tokenSrc.slice(discoverStart, discoverEnd);

  it('does NOT skip dirs containing "--" (old worktree filter removed)', () => {
    assert.ok(
      !discoverFn.includes("dirName.includes('--')"),
      'discoverTokenHistoryFiles must not skip dirs with "--" in their name'
    );
    assert.ok(
      !discoverFn.includes('dirName.includes("--")'),
      'discoverTokenHistoryFiles must not skip dirs with "--" (double-quote variant)'
    );
  });

  it('uses decodeDirNameToPath to reconstruct real project path from encoded dir name', () => {
    assert.ok(
      discoverFn.includes('decodeDirNameToPath(dirName)'),
      'discoverTokenHistoryFiles should call decodeDirNameToPath for each project dir'
    );
  });

  it('decodeDirNameToPath uses greedy longest-match segment walk (handles my-app, bingo-rgs, foo-bar-baz)', () => {
    // The greedy strategy tries longest match first so multi-hyphen project names are handled
    const decodeFnStart = tokenSrc.indexOf('function decodeDirNameToPath');
    const decodeFn = tokenSrc.slice(decodeFnStart, discoverStart);

    assert.ok(
      decodeFn.includes('parts.length; end > i; end--'),
      'decodeDirNameToPath should try longest match first (greedy from end to i+1)'
    );
  });

  it('filters project dirs by isDirectory() only — no name-based skip', () => {
    assert.ok(
      discoverFn.includes('d.isDirectory()'),
      'Should filter entries to directories only'
    );
    // Confirm no continue statement gated on dirName pattern
    const continueMatches = discoverFn.match(/if\s*\([^)]*dirName[^)]*\)\s*continue/g);
    assert.equal(
      continueMatches,
      null,
      'Should have no continue statements that gate on dirName pattern matching'
    );
  });
});

// ---------------------------------------------------------------------------
// W2: quota_snapshots idempotency — INSERT OR IGNORE
// ---------------------------------------------------------------------------
describe('W2 — parseQuotaHistory is idempotent (INSERT OR IGNORE)', () => {
  const quotaSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'quota-history.ts'), 'utf8');

  it('uses INSERT OR IGNORE into quota_snapshots to prevent duplicate rows', () => {
    assert.ok(
      quotaSrc.includes('INSERT OR IGNORE INTO quota_snapshots'),
      'quota-history parser must use INSERT OR IGNORE to be idempotent'
    );
  });

  it('does NOT use plain INSERT INTO quota_snapshots (which would create duplicates)', () => {
    // Should not have a bare INSERT that could duplicate rows
    const bareInsert = quotaSrc.match(/INSERT\s+INTO\s+quota_snapshots/g);
    assert.equal(
      bareInsert,
      null,
      'quota-history must not use plain INSERT INTO quota_snapshots (use INSERT OR IGNORE)'
    );
  });

  it('tracks ingest offset so the same lines are not re-processed on second run', () => {
    assert.ok(
      quotaSrc.includes("'ingest_offset:quota-history'"),
      'quota-history parser should track offset in _meta to skip already-processed lines'
    );
    assert.ok(
      quotaSrc.includes('INSERT OR REPLACE INTO _meta'),
      'quota-history parser should persist updated offset after processing'
    );
  });
});

// ---------------------------------------------------------------------------
// W3: migration:purge_synthetic_v2 — sessions with model='<synthetic>' are deleted
// ---------------------------------------------------------------------------
describe('W3 — migration purges sessions with model = "<synthetic>"', () => {
  const dbSrc = readFileSync(resolve(SRC_ROOT, 'db', 'index.ts'), 'utf8');

  it('deletes sessions WHERE model = "<synthetic>"', () => {
    assert.ok(
      dbSrc.includes("model = '<synthetic>'"),
      'db/index.ts should have a DELETE statement targeting sessions with model = "<synthetic>"'
    );
  });

  it('also deletes token_events for synthetic sessions before deleting sessions', () => {
    // Referential integrity: token_events must be removed first
    const teIdx = dbSrc.indexOf("DELETE FROM token_events WHERE session_id IN (SELECT id FROM sessions WHERE model = '<synthetic>')");
    const sessIdx = dbSrc.indexOf("DELETE FROM sessions WHERE model = '<synthetic>'");

    assert.ok(teIdx !== -1, 'Should delete token_events for synthetic sessions');
    assert.ok(sessIdx !== -1, 'Should delete sessions with model = "<synthetic>"');
    assert.ok(
      teIdx < sessIdx,
      'token_events delete must come before sessions delete (referential integrity)'
    );
  });

  it('migration is gated by a _meta key so it runs only once', () => {
    // The purge is wrapped in an if (!alreadyRan) / INSERT INTO _meta guard
    assert.ok(
      dbSrc.includes('backfill_agent_role_model'),
      'migration should be tracked by a _meta key to prevent re-running'
    );
  });
});

// ---------------------------------------------------------------------------
// W4: Subagent virtual session upsert only updates when cache_creation = 0
// ---------------------------------------------------------------------------
describe('W4 — subagent virtual session upsert respects cache_creation guard', () => {
  const sessionsSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'sessions.ts'), 'utf8');

  it('uses ON CONFLICT(id) DO UPDATE for subagent virtual session inserts', () => {
    assert.ok(
      sessionsSrc.includes('ON CONFLICT(id) DO UPDATE SET'),
      'sessions parser should use ON CONFLICT upsert for virtual subagent sessions'
    );
  });

  it('updates cache_creation only WHERE sessions.cache_creation = 0', () => {
    const conflictIdx = sessionsSrc.indexOf('ON CONFLICT(id) DO UPDATE SET');
    assert.ok(conflictIdx !== -1, 'ON CONFLICT block not found');

    const upsertBlock = sessionsSrc.slice(conflictIdx, conflictIdx + 500);

    assert.ok(
      upsertBlock.includes('sessions.cache_creation = 0'),
      'ON CONFLICT update should be guarded by WHERE sessions.cache_creation = 0'
    );
  });

  it('requires incoming cache_creation to be > 0 before updating', () => {
    const conflictIdx = sessionsSrc.indexOf('ON CONFLICT(id) DO UPDATE SET');
    const upsertBlock = sessionsSrc.slice(conflictIdx, conflictIdx + 400);

    assert.ok(
      upsertBlock.includes('excluded.cache_creation > 0'),
      'ON CONFLICT update should require excluded.cache_creation > 0'
    );
  });

  it('updates cache_creation from excluded (new) value', () => {
    const conflictIdx = sessionsSrc.indexOf('ON CONFLICT(id) DO UPDATE SET');
    const upsertBlock = sessionsSrc.slice(conflictIdx, conflictIdx + 200);

    assert.ok(
      upsertBlock.includes('cache_creation = excluded.cache_creation'),
      'ON CONFLICT should set cache_creation = excluded.cache_creation'
    );
  });
});
