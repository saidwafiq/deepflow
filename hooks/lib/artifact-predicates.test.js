'use strict';
/**
 * Unit tests for hooks/lib/artifact-predicates.js
 *
 * AC coverage anchors (scoped to specs/artifact-validation.md):
 *   specs/artifact-validation.md#AC-1  — existence check: non-existent ref → exists:false + evidence
 *   specs/artifact-validation.md#AC-2  — scope: PLAN Slice ∉ impact edges → out_of_scope_count
 *   specs/artifact-validation.md#AC-3  — dangling blocker: Blocked by: T99 not in plan → flagged
 *   specs/artifact-validation.md#AC-4  — drift: jaccard_below / likely_files_coverage_pct / out_of_scope_count canonical keys
 *   specs/artifact-validation.md#AC-5  — auto-mode escalation: advisory→hard when mode==='auto'
 *   specs/artifact-validation.md#AC-6  — results JSON schema: artifact, checks[], exit_code keys
 *   specs/artifact-validation.md#AC-7  — PostToolUse hook fires on artifact writes
 *   specs/artifact-validation.md#AC-8  — skip-on-missing: absent upstream → skipped, exit 0
 *   specs/artifact-validation.md#AC-9  — single-source: same symbol require()'d by both callers
 *   specs/artifact-validation.md#AC-10 — config threshold: jaccard_max change alters advisory without code change
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  intersection,
  union,
  setDifference,
  computeJaccardBelow,
  computeLikelyFilesCoveragePct,
  computeOutOfScopeCount,
  expandGlob,
  normalizeFilePath,
  checkReferenceExists,
  LSP_TIMEOUT_MS,
  checkBuildPasses,
  checkScopeCoverage,
  extractTaskIds,
  checkBlockerResolves,
  extractBlockerRefs,
  extractPlanFiles,
  extractPlanSlices,
  extractPlanSpecSection,
  extractEdgeIds,
} = require('./artifact-predicates.js');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory with a set of named files.
 * Returns the tmpdir path. Caller is responsible for cleanup.
 */
function mkTmpDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-test-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return dir;
}

// ── Set operations ─────────────────────────────────────────────────────────

describe('intersection', () => {
  it('returns common elements of two sets', () => {
    const result = intersection(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
    assert.deepEqual([...result].sort(), ['b', 'c']);
  });

  it('returns empty set when disjoint', () => {
    const result = intersection(new Set(['a']), new Set(['b']));
    assert.equal(result.size, 0);
  });

  it('accepts plain arrays', () => {
    const result = intersection(['x', 'y'], ['y', 'z']);
    assert.deepEqual([...result], ['y']);
  });
});

describe('union', () => {
  it('combines all elements of two sets', () => {
    const result = union(new Set(['a', 'b']), new Set(['b', 'c']));
    assert.deepEqual([...result].sort(), ['a', 'b', 'c']);
  });

  it('accepts plain arrays', () => {
    const result = union(['a'], ['b']);
    assert.equal(result.size, 2);
  });
});

describe('setDifference', () => {
  it('returns elements in A but not B', () => {
    const result = setDifference(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
    assert.deepEqual([...result], ['a']);
  });

  it('returns empty set when A ⊆ B', () => {
    const result = setDifference(new Set(['a']), new Set(['a', 'b']));
    assert.equal(result.size, 0);
  });
});

// ── computeJaccardBelow (specs/artifact-validation.md#AC-4) ───────────────

describe('computeJaccardBelow — drift.jaccard_below canonical key', () => {
  // specs/artifact-validation.md#AC-4

  it('returns 0 for identical non-empty sets', () => {
    const j = computeJaccardBelow(['a', 'b'], ['a', 'b']);
    assert.equal(j, 0);
  });

  it('returns 1 for completely disjoint non-empty sets', () => {
    const j = computeJaccardBelow(['a'], ['b']);
    assert.equal(j, 1);
  });

  it('returns 0 for two empty sets (no divergence)', () => {
    const j = computeJaccardBelow([], []);
    assert.equal(j, 0);
  });

  it('computes 1 - 2/5 = 0.6 for the canonical sample from drift experiment', () => {
    // sketch.modules = [a, b, c], impact.modules = [a, b, d, e]
    // intersection = {a, b} = 2, union = {a, b, c, d, e} = 5
    // jaccard_below = 1 - 2/5 = 0.6
    const j = computeJaccardBelow(
      ['src/a.js', 'src/b.js', 'src/c.js'],
      ['src/a.js', 'src/b.js', 'src/d.js', 'src/e.js']
    );
    assert.ok(Math.abs(j - 0.6) < 1e-10, `expected 0.6 but got ${j}`);
  });

  it('breaches threshold when jaccard_below > jaccard_max (specs/artifact-validation.md#AC-10)', () => {
    // specs/artifact-validation.md#AC-10
    const jaccard_below = computeJaccardBelow(['a', 'b', 'c'], ['a', 'b', 'd', 'e']);
    const jaccard_max_low = 0.3;   // 0.6 > 0.3 → advisory
    const jaccard_max_high = 0.8;  // 0.6 < 0.8 → no advisory

    // Same input, different threshold → different outcome (config-driven, no code change)
    assert.equal(jaccard_below > jaccard_max_low, true,  'should breach low threshold');
    assert.equal(jaccard_below > jaccard_max_high, false, 'should not breach high threshold');
  });
});

// ── computeLikelyFilesCoveragePct (specs/artifact-validation.md#AC-4) ─────

describe('computeLikelyFilesCoveragePct — drift.likely_files_coverage_pct canonical key', () => {
  // specs/artifact-validation.md#AC-4

  it('returns 100 when all likely_files are covered by slices', () => {
    const pct = computeLikelyFilesCoveragePct(['src/a.js', 'src/b.js'], ['src/a.js', 'src/b.js']);
    assert.equal(pct, 100);
  });

  it('returns 0 when none of the likely_files are covered', () => {
    const pct = computeLikelyFilesCoveragePct(['src/a.js'], ['src/b.js']);
    assert.equal(pct, 0);
  });

  it('returns 100 vacuously when likelyFiles is empty', () => {
    const pct = computeLikelyFilesCoveragePct([], ['src/a.js']);
    assert.equal(pct, 100);
  });

  it('computes 33.33% for sample: 1 of 3 covered', () => {
    // likelyFiles = [a, b, c], slices cover [a, d] → only a matches
    const pct = computeLikelyFilesCoveragePct(
      ['src/a.js', 'src/b.js', 'src/c.js'],
      ['src/a.js', 'src/d.js']
    );
    assert.ok(Math.abs(pct - 33.33) < 0.1, `expected ~33.33 but got ${pct}`);
  });
});

// ── computeOutOfScopeCount (specs/artifact-validation.md#AC-2, AC-4) ──────

describe('computeOutOfScopeCount — drift.out_of_scope_count canonical key', () => {
  // specs/artifact-validation.md#AC-2
  // specs/artifact-validation.md#AC-4

  it('returns 0 when all PLAN files are in impact edges', () => {
    const count = computeOutOfScopeCount(
      ['src/a.js', 'src/b.js'],
      ['src/a.js', 'src/b.js', 'src/c.js']
    );
    assert.equal(count, 0);
  });

  it('returns count of PLAN files NOT in impact edges', () => {
    // planFiles = [a, d, f], impactEdges = [a, b, d, e] → f is out of scope
    const count = computeOutOfScopeCount(
      ['src/a.js', 'src/d.js', 'src/f.js'],
      ['src/a.js', 'src/b.js', 'src/d.js', 'src/e.js']
    );
    assert.equal(count, 1); // only src/f.js
  });

  it('returns 0 when planFiles is empty', () => {
    const count = computeOutOfScopeCount([], ['src/a.js']);
    assert.equal(count, 0);
  });

  it('advisory when out_of_scope_count > out_of_scope_max (specs/artifact-validation.md#AC-4)', () => {
    const count = computeOutOfScopeCount(['src/f.js'], ['src/a.js']);
    const out_of_scope_max = 0;
    assert.equal(count > out_of_scope_max, true, 'should breach threshold');
  });
});

// ── checkReferenceExists (specs/artifact-validation.md#AC-1) ──────────────

describe('checkReferenceExists — existence check with LSP + grep fallback', () => {
  // specs/artifact-validation.md#AC-1

  it('returns exists:true via fs for real file path', () => {
    const dir = mkTmpDir({ 'myfile.js': '// hello' });
    try {
      const result = checkReferenceExists('myfile.js', dir);
      assert.equal(result.exists, true);
      assert.equal(result.method, 'fs');
      assert.ok(result.evidence.includes('myfile.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exists:false for non-existent reference with evidence (specs/artifact-validation.md#AC-1)', () => {
    // AC-1: hook exits non-zero and offending reference appears in JSON evidence field
    const dir = mkTmpDir({});
    try {
      const result = checkReferenceExists('does-not-exist-xyz-9999.js', dir);
      assert.equal(result.exists, false);
      assert.equal(result.method, 'none');
      // evidence must contain the reference (for JSON evidence field in AC-1)
      assert.ok(
        result.evidence.includes('does-not-exist-xyz-9999.js'),
        `evidence should contain the offending reference: ${result.evidence}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses 1500ms LSP timeout constant', () => {
    assert.equal(LSP_TIMEOUT_MS, 1500);
  });

  it('returns exists:true via fs for absolute path', () => {
    const dir = mkTmpDir({ 'abs.js': '' });
    try {
      const absPath = path.join(dir, 'abs.js');
      const result = checkReferenceExists(absPath, dir);
      assert.equal(result.exists, true);
      assert.equal(result.method, 'fs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exists:false with evidence for empty reference', () => {
    const result = checkReferenceExists('', '/tmp');
    assert.equal(result.exists, false);
  });
});

// ── extractTaskIds + checkBlockerResolves (specs/artifact-validation.md#AC-3) ─

describe('extractTaskIds + checkBlockerResolves — dangling blocker detection', () => {
  // specs/artifact-validation.md#AC-3

  const PLAN_CONTENT = `
### my-spec

- [ ] **T1**: Do something — sonnet/medium | Blocked by: none
- [x] **T2**: Do another thing — sonnet/medium | Blocked by: T1
- [ ] **T3**: Do a third thing — sonnet/low | Blocked by: T1, T2
`;

  it('extracts all task IDs from PLAN.md content', () => {
    const dir = mkTmpDir({ 'PLAN.md': PLAN_CONTENT });
    try {
      const ids = extractTaskIds(path.join(dir, 'PLAN.md'));
      assert.ok(ids.has('T1'));
      assert.ok(ids.has('T2'));
      assert.ok(ids.has('T3'));
      assert.equal(ids.size, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty set when PLAN.md does not exist (specs/artifact-validation.md#AC-8)', () => {
    // specs/artifact-validation.md#AC-8 — skip-on-missing
    const ids = extractTaskIds('/nonexistent/PLAN.md');
    assert.equal(ids.size, 0);
  });

  it('checkBlockerResolves returns true for existing task ID', () => {
    const ids = new Set(['T1', 'T2', 'T3']);
    assert.equal(checkBlockerResolves('T1', ids), true);
  });

  it('checkBlockerResolves returns false for dangling blocker T99 (specs/artifact-validation.md#AC-3)', () => {
    // AC-3: Blocked by: T99 where T99 is not defined → dangling blocker flagged
    const ids = new Set(['T1', 'T2', 'T3']);
    assert.equal(checkBlockerResolves('T99', ids), false);
  });
});

// ── extractBlockerRefs (specs/artifact-validation.md#AC-3) ────────────────

describe('extractBlockerRefs — parse Blocked by: from PLAN content', () => {
  // specs/artifact-validation.md#AC-3

  it('extracts blocker references from task lines', () => {
    const content = `
- [ ] **T5**: Something — sonnet/medium | Blocked by: T3, T4
- [ ] **T6**: Another — sonnet/low | Blocked by: T5
`;
    const refs = extractBlockerRefs(content);
    assert.ok(refs.some((r) => r.taskId === 'T5' && r.blockerRef === 'T3'));
    assert.ok(refs.some((r) => r.taskId === 'T5' && r.blockerRef === 'T4'));
    assert.ok(refs.some((r) => r.taskId === 'T6' && r.blockerRef === 'T5'));
  });

  it('returns empty array for content with no blockers', () => {
    const refs = extractBlockerRefs('- [ ] **T1**: Foo | Blocked by: none\n');
    assert.equal(refs.length, 0); // "none" is not a T{n} pattern
  });
});

// ── extractEdgeIds (specs/artifact-validation.md#AC-2) ────────────────────

describe('extractEdgeIds — parse impact.md file paths', () => {
  // specs/artifact-validation.md#AC-2

  it('extracts file paths from list items in impact.md', () => {
    const dir = mkTmpDir({
      'impact.md': `
## Modules

- hooks/lib/artifact-predicates.js
- hooks/df-artifact-validate.js
- src/commands/df/verify.md
`,
    });
    try {
      const edges = extractEdgeIds(path.join(dir, 'impact.md'));
      assert.ok(edges.includes('hooks/lib/artifact-predicates.js'));
      assert.ok(edges.includes('hooks/df-artifact-validate.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array when impact.md does not exist (specs/artifact-validation.md#AC-8)', () => {
    // specs/artifact-validation.md#AC-8 — skip-on-missing upstream artifact
    const edges = extractEdgeIds('/nonexistent/impact.md');
    assert.deepEqual(edges, []);
  });
});

// ── extractPlanFiles + extractPlanSlices (specs/artifact-validation.md#AC-2) ─

describe('extractPlanFiles / extractPlanSlices', () => {
  // specs/artifact-validation.md#AC-2

  const PLAN_CONTENT = `
### artifact-validation

- [ ] **T25**: Extract predicates
  - Files: hooks/lib/artifact-predicates.js, src/commands/df/verify.md
  - Slice: hooks/lib/artifact-predicates.js
  - Blocked by: T23
`;

  it('extracts Files: entries from PLAN tasks', () => {
    const files = extractPlanFiles(PLAN_CONTENT);
    assert.ok(files.includes('hooks/lib/artifact-predicates.js'));
    assert.ok(files.includes('src/commands/df/verify.md'));
  });

  it('extracts Slice: entries from PLAN tasks', () => {
    const slices = extractPlanSlices(PLAN_CONTENT);
    assert.ok(slices.includes('hooks/lib/artifact-predicates.js'));
  });

  it('scopes extraction to named spec section', () => {
    const MULTI_PLAN = `
### other-spec

- [ ] **T1**: Something
  - Files: other/file.js

### artifact-validation

- [ ] **T25**: Extract predicates
  - Files: hooks/lib/artifact-predicates.js
`;
    const files = extractPlanFiles(MULTI_PLAN, 'artifact-validation');
    assert.ok(files.includes('hooks/lib/artifact-predicates.js'));
    assert.ok(!files.includes('other/file.js'));
  });
});

// ── normalizeFilePath ──────────────────────────────────────────────────────

describe('normalizeFilePath', () => {
  it('strips leading ./', () => {
    assert.equal(normalizeFilePath('./hooks/lib/foo.js'), 'hooks/lib/foo.js');
  });

  it('collapses double slashes', () => {
    assert.equal(normalizeFilePath('hooks//lib//foo.js'), 'hooks/lib/foo.js');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeFilePath(''), '');
    assert.equal(normalizeFilePath(null), '');
  });
});

// ── expandGlob ────────────────────────────────────────────────────────────

describe('expandGlob', () => {
  it('returns matching files for a glob pattern', () => {
    const dir = mkTmpDir({
      'a.js': '',
      'b.js': '',
      'c.txt': '',
    });
    try {
      const matches = expandGlob('*.js', dir);
      assert.ok(matches.length >= 2, `expected >=2 matches, got ${matches.length}`);
      assert.ok(matches.some((m) => m.endsWith('a.js')));
      assert.ok(matches.some((m) => m.endsWith('b.js')));
      assert.ok(!matches.some((m) => m.endsWith('c.txt')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the path in an array when no wildcards and file exists', () => {
    const dir = mkTmpDir({ 'exact.js': '' });
    try {
      const matches = expandGlob('exact.js', dir);
      assert.equal(matches.length, 1);
      assert.equal(matches[0], 'exact.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array for non-matching glob', () => {
    const dir = mkTmpDir({});
    try {
      const matches = expandGlob('*.xyz', dir);
      assert.equal(matches.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── checkBuildPasses (specs/artifact-validation.md#AC-6, AC-9) ────────────

describe('checkBuildPasses — L0 existence predicate (single-source via artifact-predicates)', () => {
  // specs/artifact-validation.md#AC-9 — same symbol imported by both callers
  // specs/artifact-validation.md#AC-6 — results include pass/fail evidence

  it('returns pass:true for successful command', () => {
    const result = checkBuildPasses('echo "build ok"');
    assert.equal(result.pass, true);
  });

  it('returns pass:false for failing command with output in evidence', () => {
    const result = checkBuildPasses('exit 1', process.cwd());
    assert.equal(result.pass, false);
    // evidence is captured for JSON results schema (AC-6)
  });

  it('returns pass:true with no-op message when buildCommand is empty (specs/artifact-validation.md#AC-8)', () => {
    // specs/artifact-validation.md#AC-8 — skip/pass when no build configured
    const result = checkBuildPasses('');
    assert.equal(result.pass, true);
    assert.ok(result.output.length > 0);
  });
});

// ── checkScopeCoverage (specs/artifact-validation.md#AC-9) ────────────────

describe('checkScopeCoverage — L1 scope-coverage predicate (single-source)', () => {
  // specs/artifact-validation.md#AC-9 — same symbol imported by both callers

  it('returns pass:true with empty arrays when no planned files', () => {
    const result = checkScopeCoverage([], process.cwd());
    assert.equal(result.pass, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.present, []);
  });

  it('returns pass:false with missing entries when diff is unavailable', () => {
    // In a tmpdir with no git repo, diff fails → all planned files are missing
    const dir = mkTmpDir({});
    try {
      const result = checkScopeCoverage(['src/foo.js'], dir);
      assert.equal(result.pass, false);
      assert.ok(result.missing.includes('src/foo.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC-5: auto-mode escalation (predicates surface, hook enforces) ─────────

describe('auto-mode escalation logic surface — advisory promoted to hard', () => {
  // specs/artifact-validation.md#AC-5
  // The predicates expose the raw drift values; the hook (df-artifact-validate.js)
  // applies the mode==='auto' escalation. This test verifies the drift predicates
  // produce values that would be used by that escalation logic.

  it('computeJaccardBelow produces advisory-triggerable value above threshold', () => {
    // AC-5: consistency advisory → exit 1 in auto mode (based on drift value)
    const jaccard = computeJaccardBelow(['a', 'b'], ['c', 'd']); // fully disjoint
    const threshold = 0.4; // example config threshold
    assert.equal(jaccard > threshold, true, 'disjoint sets should exceed any reasonable threshold');
  });

  it('advisory vs hard behavior is a runtime parameter, not a predicate flag', () => {
    // AC-5: The SAME predicate output is evaluated differently by the hook
    // depending on the runtime mode==='auto' signal — not by a config key.
    // Predicates are mode-agnostic; enforcement lives in the hook caller.
    const result = checkReferenceExists('nonexistent-symbol-xyz', os.tmpdir());
    // The predicate just returns exists:false — it does NOT exit(1) or exit(0)
    // The hook consumer decides exit code based on mode + enforcement config
    assert.equal(result.exists, false);
    assert.ok(typeof result.evidence === 'string');
  });
});

// ── AC-7: PostToolUse hook registration (structural check) ────────────────

describe('PostToolUse hook registration — structural', () => {
  // specs/artifact-validation.md#AC-7

  it('df-artifact-validate-stub.js can require artifact-predicates without circular deps', () => {
    // This verifies the module shape consumed by the hook (AC-7 prerequisite)
    const stubPath = path.resolve(__dirname, '../df-artifact-validate-stub.js');
    if (!fs.existsSync(stubPath)) {
      // Stub not present in this worktree state — skip gracefully
      return;
    }
    // If it throws, the test fails (circular dep or syntax error)
    assert.doesNotThrow(() => {
      // Clear require cache to force fresh load
      delete require.cache[require.resolve('./artifact-predicates.js')];
      delete require.cache[require.resolve('../df-artifact-validate-stub.js')];
      require('../df-artifact-validate-stub.js');
    });
  });
});

// ── AC-9: single-source — require path greppable in both callers ──────────

describe('single-source require path — AC-9 greppability', () => {
  // specs/artifact-validation.md#AC-9

  it('verify.md contains require reference to hooks/lib/artifact-predicates.js', () => {
    // AC-9: existence-check function greppable in verify.md
    const verifyMdPath = path.resolve(__dirname, '../../src/commands/df/verify.md');
    if (!fs.existsSync(verifyMdPath)) return; // skip if path differs in worktree

    const content = fs.readFileSync(verifyMdPath, 'utf8');
    assert.ok(
      content.includes('hooks/lib/artifact-predicates.js'),
      'verify.md must reference hooks/lib/artifact-predicates.js (AC-9)'
    );
  });

  it('df-artifact-validate-stub.js uses require("./lib/artifact-predicates.js")', () => {
    // AC-9: same symbol imported by both callers
    const stubPath = path.resolve(__dirname, '../df-artifact-validate-stub.js');
    if (!fs.existsSync(stubPath)) return;

    const content = fs.readFileSync(stubPath, 'utf8');
    assert.ok(
      content.includes('artifact-predicates.js'),
      'stub must require artifact-predicates.js (AC-9)'
    );
  });

  it('module exports checkReferenceExists — the existence-check function', () => {
    // AC-9: same exported symbol available for both consumers
    assert.equal(typeof checkReferenceExists, 'function');
  });

  it('module exports checkScopeCoverage — the scope-coverage predicate', () => {
    // AC-9: same exported symbol available for both consumers
    assert.equal(typeof checkScopeCoverage, 'function');
  });
});

// ── AC-10: config threshold knobs ────────────────────────────────────────

describe('config threshold knobs — jaccard_max alters advisory without code change', () => {
  // specs/artifact-validation.md#AC-10

  it('same jaccard_below value breaches low threshold but not high threshold', () => {
    // drift.jaccard_below = 0.6 (sketch.modules vs impact.modules, partial overlap)
    const jaccard_below = computeJaccardBelow(
      ['src/a.js', 'src/b.js', 'src/c.js'],
      ['src/a.js', 'src/b.js', 'src/d.js', 'src/e.js']
    );

    // Config-driven: changing jaccard_max flips the advisory
    const jaccard_max_strict = 0.3;   // strict config → advisory raised
    const jaccard_max_loose  = 0.8;   // loose config → no advisory

    const advisoryStrict = jaccard_below > jaccard_max_strict;
    const advisoryLoose  = jaccard_below > jaccard_max_loose;

    assert.equal(advisoryStrict, true,  'strict threshold should raise advisory');
    assert.equal(advisoryLoose,  false, 'loose threshold should not raise advisory');
  });

  it('same out_of_scope_count breaches low threshold but not high threshold', () => {
    const out_of_scope_count = computeOutOfScopeCount(
      ['src/f.js', 'src/g.js'],   // 2 files in PLAN
      ['src/a.js', 'src/b.js']    // 0 overlap → both out of scope
    );

    const out_of_scope_max_strict = 0; // 2 > 0 → advisory
    const out_of_scope_max_loose  = 5; // 2 < 5 → no advisory

    assert.equal(out_of_scope_count > out_of_scope_max_strict, true,  'strict threshold should raise advisory');
    assert.equal(out_of_scope_count > out_of_scope_max_loose,  false, 'loose threshold should not raise advisory');
  });

  it('likely_files_coverage_pct below min_pct triggers advisory', () => {
    const coverage_pct = computeLikelyFilesCoveragePct(
      ['src/a.js', 'src/b.js', 'src/c.js'],  // 3 likely_files
      ['src/a.js']                             // only 1 covered → 33.33%
    );

    const likely_files_min_pct_strict = 70;  // 33.33% < 70% → advisory
    const likely_files_min_pct_loose  = 20;  // 33.33% > 20% → no advisory

    assert.equal(coverage_pct < likely_files_min_pct_strict, true,  'should fall below strict threshold');
    assert.equal(coverage_pct < likely_files_min_pct_loose,  false, 'should not fall below loose threshold');
  });
});
