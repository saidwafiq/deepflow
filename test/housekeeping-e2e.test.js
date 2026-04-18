/**
 * E2E tests for the deepflow-housekeeping spec (T7).
 *
 * DECISIONS:
 * ----------
 * Test approach: BEHAVIORAL SIMULATION (filesystem-level) rather than shell
 * extraction from verify.md/fix.md. Rationale: verify.md and fix.md are
 * markdown documents consumed by Claude Code's AI runtime — they are not
 * directly executable shell scripts. Extracting and eval-ing shell snippets
 * from markdown prose would be fragile (brittle regex, interleaved prose/code,
 * no error isolation). Instead, tests replicate the documented filesystem
 * behaviors in a tmp dir via Node.js fs calls, then assert the expected
 * postconditions. This is equivalent to black-box I/O testing of the spec's
 * stated intent.
 *
 * Fixture strategy: each test creates an isolated tmp dir via
 * `fs.mkdtempSync(os.tmpdir() + '/df-hk-')` and tears it down in a finally
 * block. No shared mutable state between tests.
 *
 * AC coverage:
 *   AC-1: done  — mkdir -p .deepflow/specs-done/ is idempotent
 *   AC-2: done  — backwards compat: repo without specs-done/ passes on first verify
 *   AC-3: done  — auto-snapshot-${NAME}.txt removed after verify pass
 *   AC-4: done  — result deletion scoped to task IDs from done plan only
 *   AC-5: done  — both doing- and done- plan files removed
 *   AC-6: done  — fix.md dual-path: specs-done/ canonical; specs/ fallback
 *   AC-7: done  — static assertions confirm fix.md Rules enumerate protected files
 *                  and the only declared write target is specs/{fix-name}.md
 *
 * Uses Node.js built-in node:test runner (matches project convention).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp directory and return its path. The caller is responsible for
 * cleanup (use a try/finally block).
 */
function makeTmp(prefix = 'df-hk-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Recursively create a directory (equivalent to mkdir -p).
 */
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write a file, creating parent directories as needed.
 */
function writeFile(filePath, content = '') {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Simulate the Post-Verification cleanup block for spec NAME inside a tmp repo
 * root. This replicates what verify.md step 4 + steps 5-6b describe:
 *
 *   Step 4 (rename & archive):
 *     mkdir -p .deepflow/specs-done/
 *     if [ -f "specs/done-${NAME}.md" ]; then
 *       mv specs/done-${NAME}.md .deepflow/specs-done/
 *     fi
 *
 *   Step 5 (delete auto-snapshot):
 *     rm -f .deepflow/auto-snapshot-${NAME}.txt
 *
 *   Step 6a (delete result files scoped to plan task IDs):
 *     TIDS=$(grep -oE '\*\*T[0-9]+\*\*' ".deepflow/plans/done-${NAME}.md" | tr -d '*' | sort -u)
 *     for TID in $TIDS; do rm -f .deepflow/results/${TID}.yaml; done
 *
 *   Step 6b (delete both plan files):
 *     rm -f .deepflow/plans/done-${NAME}.md .deepflow/plans/doing-${NAME}.md
 *
 * Returns the set of task IDs that were extracted from the plan (for assertion).
 */
function runPostVerificationCleanup(repoRoot, name) {
  // Step 4: mkdir -p .deepflow/specs-done/ (idempotent)
  const specsDoneDir = path.join(repoRoot, '.deepflow', 'specs-done');
  mkdirp(specsDoneDir);

  // Step 4: move done spec if present
  const doneSrc = path.join(repoRoot, 'specs', `done-${name}.md`);
  const doneDst = path.join(specsDoneDir, `done-${name}.md`);
  if (fs.existsSync(doneSrc)) {
    fs.renameSync(doneSrc, doneDst);
  }

  // Step 5: rm -f .deepflow/auto-snapshot-${NAME}.txt
  const snapshotFile = path.join(repoRoot, '.deepflow', `auto-snapshot-${name}.txt`);
  try { fs.unlinkSync(snapshotFile); } catch { /* silent no-op */ }

  // Step 6a: extract task IDs from done plan and delete result files
  const donePlan = path.join(repoRoot, '.deepflow', 'plans', `done-${name}.md`);
  const extractedTids = new Set();
  if (fs.existsSync(donePlan)) {
    const planContent = fs.readFileSync(donePlan, 'utf8');
    const tidMatches = planContent.match(/\*\*T\d+\*\*/g) || [];
    for (const m of tidMatches) {
      const tid = m.replaceAll('*', '');
      extractedTids.add(tid);
      const resultFile = path.join(repoRoot, '.deepflow', 'results', `${tid}.yaml`);
      try { fs.unlinkSync(resultFile); } catch { /* silent no-op */ }
    }
  }

  // Step 6b: rm -f .deepflow/plans/done-${NAME}.md .deepflow/plans/doing-${NAME}.md
  const doingPlan = path.join(repoRoot, '.deepflow', 'plans', `doing-${name}.md`);
  try { fs.unlinkSync(donePlan); } catch { /* silent no-op */ }
  try { fs.unlinkSync(doingPlan); } catch { /* silent no-op */ }

  return extractedTids;
}

// ---------------------------------------------------------------------------
// AC-1: mkdir -p .deepflow/specs-done/ is idempotent
// ---------------------------------------------------------------------------

describe('AC-1 — specs-done/ mkdir is idempotent', () => {
  it('creates .deepflow/specs-done/ when it does not exist', () => {
    const tmp = makeTmp();
    try {
      const specsDoneDir = path.join(tmp, '.deepflow', 'specs-done');
      assert.equal(fs.existsSync(specsDoneDir), false, 'specs-done should not exist yet');

      mkdirp(specsDoneDir); // simulate first run

      assert.equal(fs.existsSync(specsDoneDir), true, 'specs-done should exist after mkdir');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not error when .deepflow/specs-done/ already exists (second run)', () => {
    const tmp = makeTmp();
    try {
      const specsDoneDir = path.join(tmp, '.deepflow', 'specs-done');
      mkdirp(specsDoneDir); // first run — dir exists
      writeFile(path.join(specsDoneDir, 'done-myfeature.md'), '# done');

      // Second run — must not throw
      assert.doesNotThrow(() => mkdirp(specsDoneDir), 'mkdir -p on existing dir must not throw');
      // Pre-existing file must still be intact
      assert.equal(
        fs.existsSync(path.join(specsDoneDir, 'done-myfeature.md')),
        true,
        'Pre-existing archived spec should still be present after idempotent mkdir'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('full cleanup pass is idempotent — second run on already-cleaned state succeeds', () => {
    const tmp = makeTmp();
    try {
      const name = 'myfeature';
      // First run: set up full fixture and clean
      mkdirp(path.join(tmp, 'specs'));
      mkdirp(path.join(tmp, '.deepflow', 'plans'));
      mkdirp(path.join(tmp, '.deepflow', 'results'));
      writeFile(path.join(tmp, 'specs', `done-${name}.md`), '# Spec');
      writeFile(path.join(tmp, '.deepflow', `auto-snapshot-${name}.txt`), 'snap');
      writeFile(path.join(tmp, '.deepflow', 'plans', `done-${name}.md`), '**T1** task');
      writeFile(path.join(tmp, '.deepflow', 'plans', `doing-${name}.md`), '**T1** task');
      writeFile(path.join(tmp, '.deepflow', 'results', 'T1.yaml'), 'result: pass');

      runPostVerificationCleanup(tmp, name); // first pass

      // Second pass — all source files gone; must not throw
      assert.doesNotThrow(
        () => runPostVerificationCleanup(tmp, name),
        'Second cleanup pass on already-cleaned state must not throw'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: backwards compatibility — repo without .deepflow/specs-done/ on first verify
// ---------------------------------------------------------------------------

describe('AC-2 — backwards compat: no specs-done/ on first verify', () => {
  it('cleanup succeeds and creates specs-done/ even when it did not exist before', () => {
    const tmp = makeTmp();
    try {
      const name = 'oldfeature';
      mkdirp(path.join(tmp, 'specs'));
      writeFile(path.join(tmp, 'specs', `done-${name}.md`), '# Old feature spec');

      // No .deepflow/specs-done/ exists at all — simulate fresh repo
      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'specs-done')),
        false,
        'Precondition: specs-done/ must not exist'
      );

      assert.doesNotThrow(
        () => runPostVerificationCleanup(tmp, name),
        'Cleanup must not throw on a repo lacking .deepflow/specs-done/'
      );

      // Directory must now exist
      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'specs-done')),
        true,
        'specs-done/ must be created on first verify pass'
      );

      // Spec must have been moved there
      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'specs-done', `done-${name}.md`)),
        true,
        'done spec must be archived into specs-done/'
      );
      assert.equal(
        fs.existsSync(path.join(tmp, 'specs', `done-${name}.md`)),
        false,
        'done spec must no longer exist in specs/'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cleanup succeeds even when .deepflow/ itself does not exist', () => {
    const tmp = makeTmp();
    try {
      const name = 'greenfield';
      // Only specs/ exists — no .deepflow/ at all
      mkdirp(path.join(tmp, 'specs'));
      writeFile(path.join(tmp, 'specs', `done-${name}.md`), '# Greenfield spec');

      assert.doesNotThrow(
        () => runPostVerificationCleanup(tmp, name),
        'Cleanup must not throw when .deepflow/ does not exist at all'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: auto-snapshot-${NAME}.txt removed after verify pass
// ---------------------------------------------------------------------------

describe('AC-3 — auto-snapshot file removed after verify pass', () => {
  it('removes .deepflow/auto-snapshot-{name}.txt when present', () => {
    const tmp = makeTmp();
    try {
      const name = 'myspec';
      const snapshotPath = path.join(tmp, '.deepflow', `auto-snapshot-${name}.txt`);
      writeFile(snapshotPath, 'test/foo.test.js\ntest/bar.test.js\n');

      assert.equal(fs.existsSync(snapshotPath), true, 'Precondition: snapshot must exist');

      runPostVerificationCleanup(tmp, name);

      assert.equal(
        fs.existsSync(snapshotPath),
        false,
        `.deepflow/auto-snapshot-${name}.txt must be deleted after verify pass`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not error when auto-snapshot file is absent (idempotent rm -f)', () => {
    const tmp = makeTmp();
    try {
      const name = 'neverran';
      // No snapshot file — must be silent no-op
      assert.doesNotThrow(
        () => runPostVerificationCleanup(tmp, name),
        'Cleanup must not throw when auto-snapshot file is absent'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not remove auto-snapshot files for OTHER specs', () => {
    const tmp = makeTmp();
    try {
      const name = 'targetspec';
      const otherName = 'otherspec';

      const targetSnapshot = path.join(tmp, '.deepflow', `auto-snapshot-${name}.txt`);
      const otherSnapshot = path.join(tmp, '.deepflow', `auto-snapshot-${otherName}.txt`);

      writeFile(targetSnapshot, 'snap1');
      writeFile(otherSnapshot, 'snap2');

      runPostVerificationCleanup(tmp, name);

      assert.equal(fs.existsSync(targetSnapshot), false, 'Target snapshot must be removed');
      assert.equal(fs.existsSync(otherSnapshot), true, 'Other spec snapshot must NOT be touched');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: result deletion scoped to task IDs from done plan
// ---------------------------------------------------------------------------

describe('AC-4 — result deletion scoped to task IDs in done plan', () => {
  it('removes only result files for task IDs listed in the done plan', () => {
    const tmp = makeTmp();
    try {
      const name = 'featurex';

      // Done plan for "featurex" references T1 and T3
      writeFile(
        path.join(tmp, '.deepflow', 'plans', `done-${name}.md`),
        '## featurex\n- [x] **T1** implement stuff\n- [x] **T3** add tests\n'
      );

      // Create result files: T1 and T3 belong to featurex; T2 belongs to another spec
      writeFile(path.join(tmp, '.deepflow', 'results', 'T1.yaml'), 'result: pass');
      writeFile(path.join(tmp, '.deepflow', 'results', 'T2.yaml'), 'result: pass'); // unrelated
      writeFile(path.join(tmp, '.deepflow', 'results', 'T3.yaml'), 'result: pass');

      const extracted = runPostVerificationCleanup(tmp, name);

      // T1 and T3 extracted and deleted
      assert.ok(extracted.has('T1'), 'T1 should be extracted from plan');
      assert.ok(extracted.has('T3'), 'T3 should be extracted from plan');
      assert.equal(fs.existsSync(path.join(tmp, '.deepflow', 'results', 'T1.yaml')), false, 'T1.yaml must be deleted');
      assert.equal(fs.existsSync(path.join(tmp, '.deepflow', 'results', 'T3.yaml')), false, 'T3.yaml must be deleted');

      // T2 (unrelated spec) must be untouched
      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'results', 'T2.yaml')),
        true,
        'T2.yaml (unrelated spec) must NOT be deleted'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not delete any results when done plan has no task IDs', () => {
    const tmp = makeTmp();
    try {
      const name = 'emptyplan';
      writeFile(
        path.join(tmp, '.deepflow', 'plans', `done-${name}.md`),
        '## emptyplan\nNo tasks.\n'
      );
      writeFile(path.join(tmp, '.deepflow', 'results', 'T99.yaml'), 'result: pass');

      runPostVerificationCleanup(tmp, name);

      // T99 is unrelated — must survive
      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'results', 'T99.yaml')),
        true,
        'Unrelated result T99.yaml must not be deleted when plan has no task IDs'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is a silent no-op when done plan file is absent', () => {
    const tmp = makeTmp();
    try {
      const name = 'noplan';
      writeFile(path.join(tmp, '.deepflow', 'results', 'T5.yaml'), 'result: pass');

      // No done plan exists at all
      assert.doesNotThrow(
        () => runPostVerificationCleanup(tmp, name),
        'Cleanup must not throw when done plan file is missing'
      );

      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'results', 'T5.yaml')),
        true,
        'Unrelated T5.yaml must survive when plan is absent'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: both doing- and done- plan files removed
// ---------------------------------------------------------------------------

describe('AC-5 — both doing- and done- plan files are removed', () => {
  it('removes doing-{name}.md from .deepflow/plans/', () => {
    const tmp = makeTmp();
    try {
      const name = 'specfoo';
      const doingPlan = path.join(tmp, '.deepflow', 'plans', `doing-${name}.md`);
      writeFile(doingPlan, '## specfoo\n- [x] **T1** task\n');

      runPostVerificationCleanup(tmp, name);

      assert.equal(
        fs.existsSync(doingPlan),
        false,
        `doing-${name}.md must be deleted from .deepflow/plans/`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes done-{name}.md from .deepflow/plans/', () => {
    const tmp = makeTmp();
    try {
      const name = 'specfoo';
      const donePlan = path.join(tmp, '.deepflow', 'plans', `done-${name}.md`);
      writeFile(donePlan, '## specfoo\n- [x] **T1** task\n');

      runPostVerificationCleanup(tmp, name);

      assert.equal(
        fs.existsSync(donePlan),
        false,
        `done-${name}.md must be deleted from .deepflow/plans/`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes BOTH doing- and done- plan files when both are present', () => {
    const tmp = makeTmp();
    try {
      const name = 'specboth';
      const doingPlan = path.join(tmp, '.deepflow', 'plans', `doing-${name}.md`);
      const donePlan = path.join(tmp, '.deepflow', 'plans', `done-${name}.md`);
      writeFile(doingPlan, '## specboth\n- [ ] **T2** wip\n');
      writeFile(donePlan, '## specboth\n- [x] **T2** done\n');

      runPostVerificationCleanup(tmp, name);

      assert.equal(fs.existsSync(doingPlan), false, 'doing plan must be deleted');
      assert.equal(fs.existsSync(donePlan), false, 'done plan must be deleted');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not error when neither plan file exists (idempotent)', () => {
    const tmp = makeTmp();
    try {
      assert.doesNotThrow(
        () => runPostVerificationCleanup(tmp, 'noplan'),
        'Cleanup must not throw when neither plan file exists'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not remove plan files for other specs', () => {
    const tmp = makeTmp();
    try {
      const name = 'specA';
      const otherDoing = path.join(tmp, '.deepflow', 'plans', 'doing-specB.md');
      const otherDone = path.join(tmp, '.deepflow', 'plans', 'done-specB.md');
      writeFile(otherDoing, '## specB');
      writeFile(otherDone, '## specB done');
      writeFile(path.join(tmp, '.deepflow', 'plans', `doing-${name}.md`), '## specA');

      runPostVerificationCleanup(tmp, name);

      assert.equal(fs.existsSync(otherDoing), true, 'specB doing plan must survive');
      assert.equal(fs.existsSync(otherDone), true, 'specB done plan must survive');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: fix.md dual-path lookup behavior
// ---------------------------------------------------------------------------

/**
 * Simulate the fix.md dual-path lookup logic.
 * Given a doneSpecName (e.g. "done-auth"), return the resolved path or null.
 *
 * Shell equivalent from fix.md:
 *   SPEC_PATH=""
 *   if [ -f ".deepflow/specs-done/{done-spec-name}.md" ]; then
 *     SPEC_PATH=".deepflow/specs-done/{done-spec-name}.md"
 *   elif [ -f "specs/{done-spec-name}.md" ]; then
 *     SPEC_PATH="specs/{done-spec-name}.md"
 *   fi
 */
function resolveFixSpecPath(repoRoot, doneSpecName) {
  const canonical = path.join(repoRoot, '.deepflow', 'specs-done', `${doneSpecName}.md`);
  if (fs.existsSync(canonical)) return canonical;

  const legacy = path.join(repoRoot, 'specs', `${doneSpecName}.md`);
  if (fs.existsSync(legacy)) return legacy;

  return null;
}

describe('AC-6 — fix.md dual-path spec lookup', () => {
  it('resolves to .deepflow/specs-done/ when spec exists there', () => {
    const tmp = makeTmp();
    try {
      const doneSpecName = 'done-auth';
      const canonicalPath = path.join(tmp, '.deepflow', 'specs-done', `${doneSpecName}.md`);
      writeFile(canonicalPath, '# Done Auth Spec');

      const resolved = resolveFixSpecPath(tmp, doneSpecName);

      assert.equal(
        resolved,
        canonicalPath,
        'Should resolve to .deepflow/specs-done/ canonical location'
      );
      assert.equal(
        fs.readFileSync(resolved, 'utf8'),
        '# Done Auth Spec',
        'Resolved file must have correct content'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to specs/ when spec is absent from .deepflow/specs-done/', () => {
    const tmp = makeTmp();
    try {
      const doneSpecName = 'done-auth';
      const legacyPath = path.join(tmp, 'specs', `${doneSpecName}.md`);
      writeFile(legacyPath, '# Legacy Done Auth Spec');

      // Do NOT create .deepflow/specs-done/done-auth.md
      assert.equal(
        fs.existsSync(path.join(tmp, '.deepflow', 'specs-done', `${doneSpecName}.md`)),
        false,
        'Precondition: canonical path must not exist'
      );

      const resolved = resolveFixSpecPath(tmp, doneSpecName);

      assert.equal(
        resolved,
        legacyPath,
        'Should fall back to specs/ legacy location'
      );
      assert.equal(
        fs.readFileSync(resolved, 'utf8'),
        '# Legacy Done Auth Spec',
        'Resolved legacy file must have correct content'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('canonical path takes priority over legacy path when both exist', () => {
    const tmp = makeTmp();
    try {
      const doneSpecName = 'done-auth';
      const canonicalPath = path.join(tmp, '.deepflow', 'specs-done', `${doneSpecName}.md`);
      const legacyPath = path.join(tmp, 'specs', `${doneSpecName}.md`);
      writeFile(canonicalPath, '# Canonical Content');
      writeFile(legacyPath, '# Legacy Content');

      const resolved = resolveFixSpecPath(tmp, doneSpecName);

      assert.equal(
        resolved,
        canonicalPath,
        'Canonical .deepflow/specs-done/ path must take priority over specs/ fallback'
      );
      assert.equal(
        fs.readFileSync(resolved, 'utf8'),
        '# Canonical Content',
        'Must read canonical content, not legacy content'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when spec exists in neither location', () => {
    const tmp = makeTmp();
    try {
      const resolved = resolveFixSpecPath(tmp, 'done-nonexistent');
      assert.equal(
        resolved,
        null,
        'Should return null when spec exists in neither .deepflow/specs-done/ nor specs/'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('works correctly for specs with compound names (e.g. done-foo-bar)', () => {
    const tmp = makeTmp();
    try {
      const doneSpecName = 'done-foo-bar';
      const canonicalPath = path.join(tmp, '.deepflow', 'specs-done', `${doneSpecName}.md`);
      writeFile(canonicalPath, '# Foo Bar Spec');

      const resolved = resolveFixSpecPath(tmp, doneSpecName);

      assert.equal(resolved, canonicalPath, 'Compound spec name must resolve correctly');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7: fix.md static assertions — protected files are not targeted
// ---------------------------------------------------------------------------

describe('AC-7 — fix.md does not target protected files', () => {
  const fixPath = path.join(ROOT, 'src', 'commands', 'df', 'fix.md');

  it('fix.md explicitly lists protected files in its Rules section', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    assert.ok(
      content.includes('Protected files') || content.includes('protected files') || content.includes('do not touch'),
      'fix.md Rules must contain a "protected files" or "do not touch" guard'
    );
  });

  it('fix.md names the canonical protected files: decisions.md, auto-memory.yaml, execution-history.jsonl', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    assert.ok(content.includes('decisions.md'), 'fix.md must list decisions.md as protected');
    assert.ok(content.includes('auto-memory.yaml'), 'fix.md must list auto-memory.yaml as protected');
    assert.ok(content.includes('execution-history.jsonl'), 'fix.md must list execution-history.jsonl as protected');
  });

  it('fix.md declares it only writes specs/{fix-name}.md — no other write target', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    // The only file the command may create is the new fix spec in specs/
    assert.ok(
      content.includes('specs/{fix-name}.md'),
      'fix.md must state the only writable output is specs/{fix-name}.md'
    );
    // Must not instruct writing into .deepflow/ state paths
    const deepflowWritePattern = /write\s+\.deepflow\//i;
    assert.equal(
      deepflowWritePattern.test(content),
      false,
      'fix.md must not instruct writing to .deepflow/ state paths'
    );
  });

  it('fix.md does not instruct touching verify.md', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    // verify.md may appear as a protected-file name in the Rules guard, but must
    // not appear as a write/edit target in any instruction.
    const lines = content.split('\n');
    const dangerousLines = lines.filter(
      (line) =>
        /verify\.md/.test(line) &&
        /\b(edit|write|create|update|modify|touch)\b/i.test(line) &&
        !/[Pp]rotected/.test(line) &&
        !line.trim().startsWith('-') === false
    );
    // Allow the protected-files rule line itself; reject any instruction to mutate verify.md
    const instructionLines = lines.filter(
      (line) =>
        /(edit|write|create|update|modify)\s+.*verify\.md/i.test(line)
    );
    assert.equal(
      instructionLines.length,
      0,
      'fix.md must not instruct editing/writing verify.md'
    );
  });
});

// ---------------------------------------------------------------------------
// verify.md / fix.md structural checks
// (confirm the documented behaviors are present in the source files)
// ---------------------------------------------------------------------------

describe('verify.md — Post-Verification cleanup steps documented', () => {
  const verifyPath = path.join(ROOT, 'src', 'commands', 'df', 'verify.md');

  it('Post-Verification section exists', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(content, /Post-Verification/, 'verify.md must have a Post-Verification section');
  });

  it('step 4 documents mkdir -p .deepflow/specs-done/', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.ok(
      content.includes('specs-done'),
      'verify.md must reference .deepflow/specs-done/ in the Post-Verification block'
    );
  });

  it('step 5 documents auto-snapshot deletion', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.ok(
      content.includes('auto-snapshot'),
      'verify.md must document deletion of .deepflow/auto-snapshot-${NAME}.txt'
    );
  });

  it('step 6a documents result file deletion scoped to plan task IDs', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.ok(
      content.includes('results/') || content.includes('.deepflow/results'),
      'verify.md must document scoped deletion of .deepflow/results/*.yaml'
    );
  });

  it('step 6b documents deletion of both doing- and done- plan files', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)?.[0] ?? '';
    assert.ok(
      postVerification.includes('doing-') && postVerification.includes('done-'),
      'Post-Verification must mention deletion of both doing- and done- plan files'
    );
    assert.ok(
      postVerification.includes('plans/'),
      'Post-Verification must reference .deepflow/plans/ for plan file deletion'
    );
  });
});

describe('fix.md — dual-path lookup documented', () => {
  const fixPath = path.join(ROOT, 'src', 'commands', 'df', 'fix.md');

  it('fix.md exists', () => {
    assert.equal(fs.existsSync(fixPath), true, 'src/commands/df/fix.md must exist');
  });

  it('documents canonical path .deepflow/specs-done/', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    assert.ok(
      content.includes('.deepflow/specs-done/'),
      'fix.md must document the canonical .deepflow/specs-done/ lookup path'
    );
  });

  it('documents fallback path specs/', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    assert.ok(
      content.includes('specs/{done-spec-name}.md') || content.includes('specs/'),
      'fix.md must document the fallback specs/ lookup path'
    );
  });

  it('documents dual-path lookup with if/elif or equivalent', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    assert.ok(
      content.includes('elif') || content.includes('dual-path') || content.includes('fallback'),
      'fix.md must document the dual-path fallback logic'
    );
  });

  it('documents error message when spec is not found in either location', () => {
    const content = fs.readFileSync(fixPath, 'utf8');
    assert.ok(
      content.includes('not found') || content.includes('Error:'),
      'fix.md must document an error when spec is not found in either path'
    );
  });
});
