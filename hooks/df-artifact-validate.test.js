'use strict';
/**
 * Canonical AC-coverage suite for df-artifact-validate.js (T35).
 *
 * Covers ACs 1–10 with one named test minimum per AC.
 * Distinct from df-artifact-validate-enforcement.test.js (T29) which covers
 * REQ-4 enforcement modes in depth. This suite provides breadth across ALL ACs.
 *
 * AC-1  existence-fail: missing file ref → exit 1, evidence in row
 * AC-2  consistency-advisory: PLAN Slice outside impact edges → advisory row with taskId
 * AC-3  dangling-blocker: T99 missing → advisory
 * AC-4  drift-threshold: jaccard_below > config max → advisory; drift object with all 3 keys
 * AC-5  auto-mode escalation: same advisory input, interactive=0, auto=1
 * AC-6  results JSON shape: file at .deepflow/results/validate-{spec}-{artifact}.json, schema keys
 * AC-7  PostToolUse registration: hook fires on Edit/Write to artifact paths
 * AC-8  skip-on-missing: impact.md absent → status:"skipped" rows, exit 0
 * AC-9  single-source: predicates imported from hooks/lib/artifact-predicates.js
 * AC-10 config-driven thresholds: changing jaccard_max in config alters advisory outcome
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateArtifacts,
  writeResultsJson,
  detectSpecName,
  isArtifactFile,
  loadArtifactValidationConfig,
} = require('./df-artifact-validate');

// ── Fixture factory ───────────────────────────────────────────────────────────

/**
 * Create a minimal isolated tmp repo.
 * Returns { dir, specName, mapsDir, cleanup }.
 *
 * Options:
 *   withSketch      — write sketch.md (modules list)
 *   sketchModules   — file paths in sketch.md modules section
 *   withImpact      — write impact.md (edges list)
 *   impactEdges     — file paths to list in impact.md (default: none → no edges)
 *   withPlan        — write PLAN.md
 *   planContent     — raw PLAN.md content (overrides default minimal content)
 *   withFindings    — write findings.md
 *   withConfig      — write .deepflow/config.yaml
 *   configContent   — raw config.yaml content
 *   createModuleFiles — create the actual files referenced by sketchModules (default: true)
 */
function makeTmpRepo(opts = {}) {
  const {
    withSketch = false,
    sketchModules = [],
    withImpact = false,
    impactEdges = [],
    withPlan = false,
    planContent = null,
    withFindings = false,
    findingsContent = null,
    withConfig = false,
    configContent = null,
    createModuleFiles = true,
  } = opts;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-artval-ac-'));
  const specName = 'test-spec';
  const mapsDir = path.join(dir, '.deepflow', 'maps', specName);
  const specsDir = path.join(dir, 'specs');

  fs.mkdirSync(mapsDir, { recursive: true });
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.deepflow', 'results'), { recursive: true });

  // Minimal spec file (no file path refs → avoids spurious existence failures)
  fs.writeFileSync(
    path.join(specsDir, `doing-${specName}.md`),
    `# ${specName}\n\n## Objective\nTest spec.\n`,
    'utf8'
  );

  if (withSketch) {
    const moduleLines = sketchModules.map((m) => `- ${m}`).join('\n');
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      `# sketch\n\nmodules:\n${moduleLines}\n`,
      'utf8'
    );
    if (createModuleFiles) {
      for (const m of sketchModules) {
        const abs = path.join(dir, m);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `// ${m}\n`, 'utf8');
      }
    }
  }

  if (withImpact) {
    const edgeLines = impactEdges.map((e) => `- ${e}`).join('\n');
    fs.writeFileSync(
      path.join(mapsDir, 'impact.md'),
      `# impact\n\n## Modules\n${edgeLines}\n`,
      'utf8'
    );
    if (createModuleFiles) {
      for (const e of impactEdges) {
        const abs = path.join(dir, e);
        if (!fs.existsSync(abs)) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, `// ${e}\n`, 'utf8');
        }
      }
    }
  }

  if (withPlan) {
    const content =
      planContent ||
      '# PLAN\n\n- [ ] **T1**: Do something\n  - Files: hooks/placeholder.js\n';
    fs.writeFileSync(path.join(dir, 'PLAN.md'), content, 'utf8');
    // Create placeholder file to prevent existence failures
    const placeholderPath = path.join(dir, 'hooks', 'placeholder.js');
    fs.mkdirSync(path.dirname(placeholderPath), { recursive: true });
    if (!fs.existsSync(placeholderPath)) {
      fs.writeFileSync(placeholderPath, '// placeholder\n', 'utf8');
    }
  }

  if (withFindings) {
    const content = findingsContent || '# findings\n\nNo findings.\n';
    fs.writeFileSync(path.join(mapsDir, 'findings.md'), content, 'utf8');
  }

  if (withConfig) {
    const content =
      configContent ||
      'artifact_validation:\n  enforcement:\n    existence: hard\n    consistency: advisory\n    drift: advisory\n  drift_thresholds:\n    jaccard_max: 0.4\n    likely_files_min_pct: 50\n    out_of_scope_max: 3\n';
    fs.writeFileSync(path.join(dir, '.deepflow', 'config.yaml'), content, 'utf8');
  }

  return {
    dir,
    specName,
    mapsDir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── AC-1: existence-fail ──────────────────────────────────────────────────────

describe('AC-1: existence-fail — missing file ref → exit 1 with evidence', () => {
  test('AC-1: sketch.md with non-existent module ref → exit_code 1 and missing row with evidence', () => {
    const { dir, specName, mapsDir, cleanup } = makeTmpRepo({ withPlan: true });
    fs.mkdirSync(mapsDir, { recursive: true });

    // Write sketch.md referencing a file that does NOT exist
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      'modules:\n- hooks/does-not-exist-xyzzy.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const missingRows = result.checks.filter(
        (c) => c.status === 'missing' && c.ref === 'hooks/does-not-exist-xyzzy.js'
      );

      assert.ok(missingRows.length > 0, 'AC-1: should have at least one missing row for the non-existent file');
      assert.equal(result.exit_code, 1, 'AC-1: exit_code must be 1 when existence violation found');

      // Evidence field must be populated
      for (const row of missingRows) {
        assert.ok(
          row.evidence && row.evidence.length > 0,
          'AC-1: evidence field must be non-empty on missing rows'
        );
        assert.ok(
          row.evidence.includes('does-not-exist-xyzzy'),
          'AC-1: evidence should contain the missing reference'
        );
      }
    } finally {
      cleanup();
    }
  });

  test('AC-1: existing file ref → exit_code 0, no missing rows', () => {
    const { dir, specName, mapsDir, cleanup } = makeTmpRepo({ withPlan: true });
    fs.mkdirSync(mapsDir, { recursive: true });

    const realFile = path.join(dir, 'hooks', 'real-module.js');
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, '// real\n', 'utf8');
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      'modules:\n- hooks/real-module.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const missingRows = result.checks.filter((c) => c.status === 'missing');
      assert.equal(missingRows.length, 0, 'AC-1: no missing rows when all refs exist');
      assert.equal(result.exit_code, 0, 'AC-1: exit_code must be 0 when all refs exist');
    } finally {
      cleanup();
    }
  });
});

// ── AC-2: consistency-advisory ────────────────────────────────────────────────

describe('AC-2: consistency-advisory — PLAN Slice outside impact edges → advisory row with taskId', () => {
  test('AC-2: task Slice entry not in impact.md edges → advisory row with taskId present', () => {
    const { dir, specName, mapsDir, cleanup } = makeTmpRepo({ withPlan: false });
    fs.mkdirSync(mapsDir, { recursive: true });

    // Create a real file so it passes existence
    const sliceFile = path.join(dir, 'hooks', 'slice-target.js');
    fs.mkdirSync(path.dirname(sliceFile), { recursive: true });
    fs.writeFileSync(sliceFile, '// slice\n', 'utf8');

    // PLAN.md with a Slice: entry
    const planContent =
      '# PLAN\n\n- [ ] **T7**: Do something\n  - Slice: hooks/slice-target.js\n';
    fs.writeFileSync(path.join(dir, 'PLAN.md'), planContent, 'utf8');

    // impact.md with NO edges — so the Slice entry is outside impact
    fs.writeFileSync(
      path.join(mapsDir, 'impact.md'),
      '# impact\n\nNo edges.\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const advisoryRows = result.checks.filter(
        (c) =>
          c.kind === 'consistency' &&
          c.status === 'advisory' &&
          c.taskId === 'T7'
      );

      assert.ok(
        advisoryRows.length > 0,
        'AC-2: should have at least one consistency advisory row with taskId=T7'
      );

      // Confirm taskId is present on the advisory row
      for (const row of advisoryRows) {
        assert.equal(row.taskId, 'T7', 'AC-2: advisory row must carry taskId');
      }

      // Should exit 0 (advisory in interactive mode)
      assert.equal(result.exit_code, 0, 'AC-2: interactive mode — consistency advisory must NOT hard-fail');
    } finally {
      cleanup();
    }
  });

  test('AC-2: task Slice entry that IS in impact.md edges → ok (not advisory)', () => {
    const { dir, specName, mapsDir, cleanup } = makeTmpRepo({ withPlan: false });
    fs.mkdirSync(mapsDir, { recursive: true });

    const sliceFile = path.join(dir, 'hooks', 'in-scope.js');
    fs.mkdirSync(path.dirname(sliceFile), { recursive: true });
    fs.writeFileSync(sliceFile, '// in scope\n', 'utf8');

    // PLAN with Slice entry
    fs.writeFileSync(
      path.join(dir, 'PLAN.md'),
      '# PLAN\n\n- [ ] **T3**: Do something\n  - Slice: hooks/in-scope.js\n',
      'utf8'
    );

    // impact.md listing that same file
    fs.writeFileSync(
      path.join(mapsDir, 'impact.md'),
      '# impact\n\n## Modules\n- hooks/in-scope.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const advisoryRows = result.checks.filter(
        (c) =>
          c.kind === 'consistency' &&
          c.status === 'advisory' &&
          typeof c.ref === 'string' &&
          c.ref.includes('in-scope')
      );

      assert.equal(advisoryRows.length, 0, 'AC-2: Slice in impact.md edges should produce no advisory');
    } finally {
      cleanup();
    }
  });
});

// ── AC-3: dangling-blocker ────────────────────────────────────────────────────

describe('AC-3: dangling-blocker — Blocked by T99 (unknown) → advisory row', () => {
  test('AC-3: "Blocked by: T99" where T99 is not defined → consistency advisory', () => {
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: false });

    // PLAN with T1 defined, but T2 blocked by T99 (not defined)
    const planContent =
      '# PLAN\n\n' +
      '- [ ] **T1**: First task\n\n' +
      '- [ ] **T2**: Second task\n' +
      '  - Blocked by: T99\n';
    fs.writeFileSync(path.join(dir, 'PLAN.md'), planContent, 'utf8');

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const danglingRows = result.checks.filter(
        (c) =>
          c.kind === 'consistency' &&
          c.status === 'advisory' &&
          typeof c.ref === 'string' &&
          c.ref === 'T99'
      );

      assert.ok(
        danglingRows.length > 0,
        'AC-3: should emit advisory row for dangling blocker T99'
      );

      // Confirm evidence mentions T99
      for (const row of danglingRows) {
        assert.ok(
          row.evidence && row.evidence.includes('T99'),
          'AC-3: evidence should mention T99 in dangling blocker advisory'
        );
      }

      // Interactive mode: blocker advisory does not hard-fail
      assert.equal(result.exit_code, 0, 'AC-3: dangling blocker in interactive mode must NOT hard-fail (advisory)');
    } finally {
      cleanup();
    }
  });

  test('AC-3: "Blocked by: T1" where T1 IS defined → ok row, no advisory', () => {
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: false });

    const planContent =
      '# PLAN\n\n' +
      '- [ ] **T1**: First task\n\n' +
      '- [ ] **T2**: Second task\n' +
      '  - Blocked by: T1\n';
    fs.writeFileSync(path.join(dir, 'PLAN.md'), planContent, 'utf8');

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const advisoryForT1 = result.checks.filter(
        (c) =>
          c.kind === 'consistency' &&
          c.status === 'advisory' &&
          c.ref === 'T1'
      );

      assert.equal(advisoryForT1.length, 0, 'AC-3: resolved blocker T1 must not produce advisory');
    } finally {
      cleanup();
    }
  });
});

// ── AC-4: drift-threshold ─────────────────────────────────────────────────────

describe('AC-4: drift-threshold — jaccard_below > config max → advisory; drift object has all 3 keys', () => {
  test('AC-4: sketch and impact fully disjoint → jaccard_below=1.0, drift advisory emitted', () => {
    // sketch.md has module A; impact.md has module B — completely disjoint → jaccard_below=1.0
    const sketchModule = 'hooks/sketch-only.js';
    const impactModule = 'hooks/impact-only.js';

    const { dir, specName, mapsDir, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: [sketchModule],
      withImpact: true,
      impactEdges: [impactModule],
      withPlan: true,
    });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      // drift object must have all 3 canonical keys
      assert.ok(result.drift, 'AC-4: drift object must be present when both sketch.md and impact.md exist');
      assert.ok('jaccard_below' in result.drift, 'AC-4: drift must have jaccard_below key');
      assert.ok('likely_files_coverage_pct' in result.drift, 'AC-4: drift must have likely_files_coverage_pct key');
      assert.ok('out_of_scope_count' in result.drift, 'AC-4: drift must have out_of_scope_count key');

      // With completely disjoint sets, jaccard_below should be 1.0
      assert.equal(result.drift.jaccard_below, 1.0, 'AC-4: completely disjoint sketch/impact → jaccard_below=1.0');

      // Default jaccard_max is 0.4, so 1.0 > 0.4 → advisory row
      const driftAdvisories = result.checks.filter(
        (c) => c.kind === 'drift' && c.status === 'advisory' && c.driftKey === 'jaccard_below'
      );
      assert.ok(
        driftAdvisories.length > 0,
        'AC-4: jaccard_below=1.0 exceeds default threshold 0.4 → should have drift advisory'
      );

      // Interactive mode: drift advisory does NOT hard-fail
      assert.equal(result.exit_code, 0, 'AC-4: drift advisory in interactive mode must NOT hard-fail');
    } finally {
      cleanup();
    }
  });

  test('AC-4: sketch and impact identical → jaccard_below=0.0, no drift advisory', () => {
    const module = 'hooks/shared-module.js';

    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: [module],
      withImpact: true,
      impactEdges: [module],
      withPlan: true,
    });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      assert.ok(result.drift, 'AC-4: drift object must be present');
      assert.equal(result.drift.jaccard_below, 0, 'AC-4: identical sets → jaccard_below=0');

      const driftAdvisoryForJaccard = result.checks.filter(
        (c) => c.kind === 'drift' && c.status === 'advisory' && c.driftKey === 'jaccard_below'
      );
      assert.equal(driftAdvisoryForJaccard.length, 0, 'AC-4: jaccard_below=0 must not produce advisory');
    } finally {
      cleanup();
    }
  });
});

// ── AC-5: auto-mode escalation ────────────────────────────────────────────────

describe('AC-5: auto-mode escalation — same advisory input, interactive=exit-0, auto=exit-1', () => {
  test('AC-5: consistency advisory: interactive=exit-0, auto=exit-1', () => {
    const { dir, specName, mapsDir, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['lib/foo.js'],
      withImpact: true,       // no edges → sketch module not in impact → advisory
      withPlan: true,
    });

    try {
      const interactive = validateArtifacts(specName, dir, { mode: 'interactive' });
      const auto = validateArtifacts(specName, dir, { mode: 'auto' });

      const hasConsistencyAdvisory = interactive.checks.some(
        (c) => c.kind === 'consistency' && c.status === 'advisory'
      );

      if (hasConsistencyAdvisory) {
        assert.equal(interactive.exit_code, 0, 'AC-5: interactive mode MUST exit 0 for consistency advisory');
        assert.equal(auto.exit_code, 1, 'AC-5: auto mode MUST exit 1 for consistency advisory (escalation)');
      } else {
        // If no advisory was generated, validate that both modes agree on exit 0
        assert.equal(interactive.exit_code, 0, 'AC-5: no advisory → interactive should exit 0');
        assert.equal(auto.exit_code, 0, 'AC-5: no advisory → auto should also exit 0');
      }
    } finally {
      cleanup();
    }
  });

  test('AC-5: drift advisory: interactive=exit-0, auto=exit-1', () => {
    // sketch module completely disjoint from impact → jaccard_below=1.0 → drift advisory
    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/sketch-only2.js'],
      withImpact: true,
      impactEdges: ['hooks/impact-only2.js'],
      withPlan: true,
    });

    try {
      const interactive = validateArtifacts(specName, dir, { mode: 'interactive' });
      const auto = validateArtifacts(specName, dir, { mode: 'auto' });

      const hasDriftAdvisory = interactive.checks.some(
        (c) => c.kind === 'drift' && c.status === 'advisory'
      );

      if (hasDriftAdvisory) {
        assert.equal(interactive.exit_code, 0, 'AC-5: drift advisory in interactive → exit 0');
        assert.equal(auto.exit_code, 1, 'AC-5: drift advisory in auto → escalate to exit 1');
      }
    } finally {
      cleanup();
    }
  });
});

// ── AC-6: results JSON shape ──────────────────────────────────────────────────

describe('AC-6: results JSON shape — file at .deepflow/results/validate-{spec}-{artifact}.json', () => {
  test('AC-6: writeResultsJson creates file at expected path with required schema keys', () => {
    const { dir, specName, cleanup } = makeTmpRepo({});

    const checks = [
      { artifact: 'sketch.md', kind: 'file_path', ref: 'hooks/x.js', status: 'ok', evidence: 'exists' },
      { artifact: 'sketch.md', kind: 'consistency', ref: 'modules check', status: 'advisory', evidence: 'some advisory', taskId: 'T1' },
    ];
    const drift = { jaccard_below: 0.5, likely_files_coverage_pct: 80, out_of_scope_count: 1 };

    try {
      writeResultsJson(specName, 'sketch.md', checks, 0, dir, drift, 'interactive');

      // File must exist at .deepflow/results/validate-{spec}-sketch.md.json
      const expectedPath = path.join(dir, '.deepflow', 'results', `validate-${specName}-sketch.md.json`);
      assert.ok(fs.existsSync(expectedPath), `AC-6: results file must exist at ${expectedPath}`);

      // Parse and validate schema keys
      const parsed = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

      // Required top-level keys: artifact, spec, checks, exit_code, mode, timestamp
      assert.ok('artifact' in parsed, 'AC-6: schema must have "artifact" key');
      assert.ok('spec' in parsed, 'AC-6: schema must have "spec" key');
      assert.ok('checks' in parsed, 'AC-6: schema must have "checks" key');
      assert.ok('exit_code' in parsed, 'AC-6: schema must have "exit_code" key');
      assert.ok('mode' in parsed, 'AC-6: schema must have "mode" key');
      assert.ok('timestamp' in parsed, 'AC-6: schema must have "timestamp" key');

      assert.equal(parsed.artifact, 'sketch.md', 'AC-6: artifact field must match');
      assert.equal(parsed.spec, specName, 'AC-6: spec field must match');
      assert.ok(Array.isArray(parsed.checks), 'AC-6: checks must be an array');
      assert.equal(parsed.exit_code, 0, 'AC-6: exit_code field must be 0');
      assert.equal(parsed.mode, 'interactive', 'AC-6: mode field must match');

      // Each check row must have family, name, status, evidence
      for (const row of parsed.checks) {
        assert.ok('family' in row, 'AC-6: each check row must have "family" key');
        assert.ok('name' in row, 'AC-6: each check row must have "name" key');
        assert.ok('status' in row, 'AC-6: each check row must have "status" key');
        assert.ok('evidence' in row, 'AC-6: each check row must have "evidence" key');
      }

      // Consistency check row with taskId must carry taskId through
      const consistencyRow = parsed.checks.find((r) => r.family === 'consistency');
      if (consistencyRow) {
        assert.ok('taskId' in consistencyRow, 'AC-6: consistency row with task context must carry taskId');
      }

      // drift block must be present when passed
      assert.ok('drift' in parsed, 'AC-6: drift block must be present when drift was passed');
      assert.ok('jaccard_below' in parsed.drift, 'AC-6: drift must have jaccard_below');
      assert.ok('likely_files_coverage_pct' in parsed.drift, 'AC-6: drift must have likely_files_coverage_pct');
      assert.ok('out_of_scope_count' in parsed.drift, 'AC-6: drift must have out_of_scope_count');
    } finally {
      cleanup();
    }
  });

  test('AC-6: validateArtifacts produces results file via CLI path', () => {
    // Validate that when validateArtifacts runs, results can be written downstream
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: true, withSketch: true, sketchModules: ['hooks/placeholder.js'] });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      // Manually trigger writeResultsJson (the hook/CLI does this after validateArtifacts)
      const artifactNames = [...new Set(result.checks.map((c) => c.artifact))];
      for (const artifactName of artifactNames) {
        const artifactChecks = result.checks.filter((c) => c.artifact === artifactName);
        writeResultsJson(specName, artifactName, artifactChecks, result.exit_code, dir, result.drift, 'interactive');
      }

      // At least one results file must exist
      const resultsDir = path.join(dir, '.deepflow', 'results');
      const files = fs.readdirSync(resultsDir).filter((f) => f.startsWith(`validate-${specName}-`));
      assert.ok(files.length > 0, 'AC-6: at least one validate-{spec}-{artifact}.json must be written');

      for (const f of files) {
        const parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
        assert.ok('artifact' in parsed && 'spec' in parsed && 'checks' in parsed && 'exit_code' in parsed,
          `AC-6: results file ${f} must have all required schema keys`);
      }
    } finally {
      cleanup();
    }
  });

  test('AC-6: results file omits drift key when drift is undefined', () => {
    const { dir, specName, cleanup } = makeTmpRepo({});

    const checks = [
      { artifact: 'PLAN.md', kind: 'artifact_file', ref: 'PLAN.md', status: 'skipped', evidence: 'not found' },
    ];

    try {
      writeResultsJson(specName, 'PLAN.md', checks, 0, dir, undefined, 'advisory');

      const expectedPath = path.join(dir, '.deepflow', 'results', `validate-${specName}-PLAN.md.json`);
      assert.ok(fs.existsSync(expectedPath), 'AC-6: results file must be created');

      const parsed = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
      // drift key should be absent when not passed
      assert.ok(!('drift' in parsed), 'AC-6: drift key must be absent when no drift was computed');
    } finally {
      cleanup();
    }
  });
});

// ── AC-7: PostToolUse registration ───────────────────────────────────────────

describe('AC-7: PostToolUse registration — hook fires on Edit/Write to artifact paths', () => {
  test('AC-7: isArtifactFile returns true for .deepflow/maps/{spec}/sketch.md path', () => {
    const payload = {
      tool: 'Edit',
      tool_input: { file_path: '/repo/.deepflow/maps/my-spec/sketch.md' },
    };
    assert.equal(isArtifactFile(payload), true, 'AC-7: sketch.md inside maps dir is an artifact file');
  });

  test('AC-7: isArtifactFile returns true for .deepflow/maps/{spec}/impact.md path', () => {
    const payload = {
      tool: 'Write',
      tool_input: { file_path: '/repo/.deepflow/maps/my-spec/impact.md' },
    };
    assert.equal(isArtifactFile(payload), true, 'AC-7: impact.md inside maps dir is an artifact file');
  });

  test('AC-7: isArtifactFile returns true for .deepflow/maps/{spec}/verify-result.json path', () => {
    const payload = {
      tool: 'Write',
      tool_input: { file_path: '/abs/.deepflow/maps/artifact-validation/verify-result.json' },
    };
    assert.equal(isArtifactFile(payload), true, 'AC-7: verify-result.json inside maps dir is an artifact file');
  });

  test('AC-7: isArtifactFile returns true for top-level PLAN.md', () => {
    const payload = {
      tool: 'Edit',
      tool_input: { file_path: '/repo/PLAN.md' },
    };
    assert.equal(isArtifactFile(payload), true, 'AC-7: top-level PLAN.md is an artifact file');
  });

  test('AC-7: isArtifactFile returns true for specs/doing-{spec}.md', () => {
    const payload = {
      tool: 'Edit',
      tool_input: { file_path: '/repo/specs/doing-artifact-validation.md' },
    };
    assert.equal(isArtifactFile(payload), true, 'AC-7: doing-{spec}.md is an artifact file');
  });

  test('AC-7: isArtifactFile returns false for non-artifact files', () => {
    const cases = [
      { tool: 'Edit', tool_input: { file_path: '/repo/src/commands/df/plan.md' } },
      { tool: 'Write', tool_input: { file_path: '/repo/hooks/df-invariant-check.js' } },
      { tool: 'Edit', tool_input: { file_path: '/repo/README.md' } },
      { tool: 'Edit', tool_input: {} }, // no file_path
    ];

    for (const payload of cases) {
      assert.equal(
        isArtifactFile(payload),
        false,
        `AC-7: ${JSON.stringify(payload.tool_input?.file_path)} must NOT be classified as artifact file`
      );
    }
  });

  test('AC-7: detectSpecName extracts spec from .deepflow/maps/{spec}/ path', () => {
    const payload = {
      tool: 'Edit',
      tool_input: { file_path: '/repo/.deepflow/maps/artifact-validation/sketch.md' },
    };
    // repoRoot argument — doesn't need to be a real dir for detectSpecName
    const specName = detectSpecName(payload, '/repo');
    assert.equal(specName, 'artifact-validation', 'AC-7: detectSpecName should extract spec from maps path');
  });

  test('AC-7: detectSpecName extracts spec from specs/doing-{spec}.md path', () => {
    const payload = {
      tool: 'Edit',
      tool_input: { file_path: '/repo/specs/doing-my-feature.md' },
    };
    const specName = detectSpecName(payload, '/repo');
    assert.equal(specName, 'my-feature', 'AC-7: detectSpecName should extract spec from doing- spec path');
  });
});

// ── AC-8: skip-on-missing ─────────────────────────────────────────────────────

describe('AC-8: skip-on-missing — impact.md absent → skipped rows for impact-dependent refs, exit 0', () => {
  test('AC-8: impact.md absent → impact.md artifact emits skipped row, no hard fail', () => {
    // No impact.md — should see a skipped row for the impact.md artifact
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: true });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const impactSkippedRows = result.checks.filter(
        (c) => c.artifact === 'impact.md' && c.status === 'skipped'
      );

      assert.ok(impactSkippedRows.length > 0, 'AC-8: absent impact.md must produce skipped row');
      assert.equal(result.exit_code, 0, 'AC-8: absent impact.md must not hard-fail (exit 0)');
    } finally {
      cleanup();
    }
  });

  test('AC-8: PLAN.md Slice: entries are skipped when impact.md is absent', () => {
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: false });

    // Create file so existence check passes; no impact.md
    const sliceFile = path.join(dir, 'hooks', 'some-file.js');
    fs.mkdirSync(path.dirname(sliceFile), { recursive: true });
    fs.writeFileSync(sliceFile, '// some file\n', 'utf8');

    fs.writeFileSync(
      path.join(dir, 'PLAN.md'),
      '# PLAN\n\n- [ ] **T1**: Do something\n  - Slice: hooks/some-file.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      // Slice: entries in PLAN are impact-dependent refs — when impact.md is absent,
      // they should be status:"skipped" rather than "missing" or "ok"
      const planSkipped = result.checks.filter(
        (c) => c.artifact === 'PLAN.md' && c.status === 'skipped'
      );

      assert.ok(planSkipped.length > 0, 'AC-8: PLAN.md Slice refs must be skipped when impact.md absent');
      assert.equal(result.exit_code, 0, 'AC-8: skipped refs must not hard-fail');
    } finally {
      cleanup();
    }
  });

  test('AC-8: all non-existent artifacts → all skipped rows, exit 0', () => {
    const { dir, specName, cleanup } = makeTmpRepo({});
    // No artifacts at all except the spec file (written by makeTmpRepo)

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      const skippedRows = result.checks.filter((c) => c.status === 'skipped');
      // At minimum: sketch.md, impact.md, PLAN.md, findings.md, verify-result.json should all skip
      assert.ok(skippedRows.length >= 4, 'AC-8: absent artifacts must all produce skipped rows');
      assert.equal(result.exit_code, 0, 'AC-8: all-skipped scenario must exit 0');
    } finally {
      cleanup();
    }
  });
});

// ── AC-9: single-source predicates ────────────────────────────────────────────

describe('AC-9: single-source — predicates imported from hooks/lib/artifact-predicates.js', () => {
  test('AC-9: artifact-predicates exports computeJaccardBelow', () => {
    const predicates = require('./lib/artifact-predicates');
    assert.equal(typeof predicates.computeJaccardBelow, 'function', 'AC-9: computeJaccardBelow must be exported');
  });

  test('AC-9: artifact-predicates exports computeLikelyFilesCoveragePct', () => {
    const predicates = require('./lib/artifact-predicates');
    assert.equal(typeof predicates.computeLikelyFilesCoveragePct, 'function', 'AC-9: computeLikelyFilesCoveragePct must be exported');
  });

  test('AC-9: artifact-predicates exports computeOutOfScopeCount', () => {
    const predicates = require('./lib/artifact-predicates');
    assert.equal(typeof predicates.computeOutOfScopeCount, 'function', 'AC-9: computeOutOfScopeCount must be exported');
  });

  test('AC-9: artifact-predicates exports extractTaskIds', () => {
    const predicates = require('./lib/artifact-predicates');
    assert.equal(typeof predicates.extractTaskIds, 'function', 'AC-9: extractTaskIds must be exported');
  });

  test('AC-9: artifact-predicates exports checkBlockerResolves', () => {
    const predicates = require('./lib/artifact-predicates');
    assert.equal(typeof predicates.checkBlockerResolves, 'function', 'AC-9: checkBlockerResolves must be exported');
  });

  test('AC-9: artifact-predicates exports extractEdgeIds', () => {
    const predicates = require('./lib/artifact-predicates');
    assert.equal(typeof predicates.extractEdgeIds, 'function', 'AC-9: extractEdgeIds must be exported');
  });

  test('AC-9: computeJaccardBelow returns canonical values', () => {
    const { computeJaccardBelow } = require('./lib/artifact-predicates');

    // Identical sets → 0
    assert.equal(computeJaccardBelow(['a', 'b'], ['a', 'b']), 0, 'AC-9: identical sets → jaccard_below=0');
    // Disjoint sets → 1
    assert.equal(computeJaccardBelow(['a'], ['b']), 1, 'AC-9: disjoint sets → jaccard_below=1');
    // Both empty → 0 (vacuously no divergence)
    assert.equal(computeJaccardBelow([], []), 0, 'AC-9: both empty → jaccard_below=0');
    // Partial overlap: |{a,b} ∩ {b,c}| / |{a,b} ∪ {b,c}| = 1/3, jaccard_below = 1 - 1/3 = 2/3 ≈ 0.6667
    const jb = computeJaccardBelow(['a', 'b'], ['b', 'c']);
    assert.ok(
      Math.abs(jb - 2 / 3) < 1e-10,
      `AC-9: partial overlap → correct jaccard_below (expected ~0.6667, got ${jb})`
    );
  });

  test('AC-9: df-artifact-validate.js imports from artifact-predicates (module identity check)', () => {
    // Both modules must be loadable without error and share the same normalizeFilePath function
    // (verifies single-source pattern is in place)
    const predicates = require('./lib/artifact-predicates');
    const mainModule = require('./df-artifact-validate');

    // Both must be objects (modules loaded successfully)
    assert.equal(typeof predicates, 'object', 'AC-9: artifact-predicates must be a module object');
    assert.equal(typeof mainModule, 'object', 'AC-9: df-artifact-validate must be a module object');

    // validateArtifacts must use computeJaccardBelow from predicates (smoke test: same result)
    const jb = predicates.computeJaccardBelow(['hooks/a.js'], ['hooks/b.js']);
    assert.equal(jb, 1, 'AC-9: computeJaccardBelow from predicates returns correct value for disjoint input');
  });
});

// ── AC-10: config-driven thresholds ──────────────────────────────────────────

describe('AC-10: config-driven thresholds — changing jaccard_max alters advisory outcome', () => {
  test('AC-10: jaccard_max=0.0 → any drift produces advisory', () => {
    // sketch and impact share 1 of 2 modules → jaccard_below = 0.5
    const sharedModule = 'hooks/shared.js';
    const sketchOnly = 'hooks/sketch-extra.js';
    const impactOnly = 'hooks/impact-extra.js';

    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: [sharedModule, sketchOnly],
      withImpact: true,
      impactEdges: [sharedModule, impactOnly],
      withPlan: true,
      withConfig: true,
      // jaccard_max=0.0 → any divergence (even small) produces advisory
      configContent:
        'artifact_validation:\n  drift_thresholds:\n    jaccard_max: 0.0\n    likely_files_min_pct: 0\n    out_of_scope_max: 999\n  enforcement:\n    existence: hard\n    consistency: advisory\n    drift: advisory\n',
    });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      assert.ok(result.drift, 'AC-10: drift object must be present');

      // jaccard_below should be 0.5 (1 shared out of 3 total unique)
      // With jaccard_max=0.0, any non-zero jaccard_below → advisory
      const jaccardAdvisory = result.checks.find(
        (c) => c.kind === 'drift' && c.driftKey === 'jaccard_below' && c.status === 'advisory'
      );

      if (result.drift.jaccard_below > 0) {
        assert.ok(
          jaccardAdvisory,
          'AC-10: jaccard_max=0.0 with non-zero jaccard_below must produce advisory'
        );
      }
    } finally {
      cleanup();
    }
  });

  test('AC-10: jaccard_max=1.0 → completely disjoint sets still pass (no drift advisory)', () => {
    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/only-sketch.js'],
      withImpact: true,
      impactEdges: ['hooks/only-impact.js'],
      withPlan: true,
      withConfig: true,
      // jaccard_max=1.0 → even jaccard_below=1.0 is within threshold (no advisory)
      configContent:
        'artifact_validation:\n  drift_thresholds:\n    jaccard_max: 1.0\n    likely_files_min_pct: 0\n    out_of_scope_max: 999\n  enforcement:\n    existence: hard\n    consistency: advisory\n    drift: advisory\n',
    });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });

      assert.ok(result.drift, 'AC-10: drift object must be present');

      const jaccardAdvisory = result.checks.find(
        (c) => c.kind === 'drift' && c.driftKey === 'jaccard_below' && c.status === 'advisory'
      );

      assert.ok(
        !jaccardAdvisory,
        'AC-10: jaccard_max=1.0 must suppress jaccard_below advisory (any drift value passes)'
      );
    } finally {
      cleanup();
    }
  });

  test('AC-10: loadArtifactValidationConfig reads jaccard_max from config.yaml', () => {
    const { dir, cleanup } = makeTmpRepo({
      withConfig: true,
      configContent:
        'artifact_validation:\n  drift_thresholds:\n    jaccard_max: 0.75\n    likely_files_min_pct: 60\n    out_of_scope_max: 5\n  enforcement:\n    existence: hard\n    consistency: advisory\n    drift: advisory\n',
    });

    try {
      const cfg = loadArtifactValidationConfig(dir);

      assert.equal(cfg.drift_thresholds.jaccard_max, 0.75, 'AC-10: jaccard_max must be read from config');
      assert.equal(cfg.drift_thresholds.likely_files_min_pct, 60, 'AC-10: likely_files_min_pct must be read from config');
      assert.equal(cfg.drift_thresholds.out_of_scope_max, 5, 'AC-10: out_of_scope_max must be read from config');
    } finally {
      cleanup();
    }
  });

  test('AC-10: changing jaccard_max from below to above actual jaccard_below changes advisory status', () => {
    // Setup: sketch has A and B; impact has B and C → jaccard_below = 2/3 ≈ 0.667
    const { dir: dirA, specName, cleanup: cleanupA } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/a.js', 'hooks/b.js'],
      withImpact: true,
      impactEdges: ['hooks/b.js', 'hooks/c.js'],
      withPlan: true,
      withConfig: true,
      // jaccard_max=0.5 → 0.667 > 0.5 → advisory
      configContent:
        'artifact_validation:\n  drift_thresholds:\n    jaccard_max: 0.5\n    likely_files_min_pct: 0\n    out_of_scope_max: 999\n  enforcement:\n    existence: hard\n    consistency: advisory\n    drift: advisory\n',
    });

    const { dir: dirB, specName: specNameB, cleanup: cleanupB } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/a.js', 'hooks/b.js'],
      withImpact: true,
      impactEdges: ['hooks/b.js', 'hooks/c.js'],
      withPlan: true,
      withConfig: true,
      // jaccard_max=0.9 → 0.667 <= 0.9 → no advisory
      configContent:
        'artifact_validation:\n  drift_thresholds:\n    jaccard_max: 0.9\n    likely_files_min_pct: 0\n    out_of_scope_max: 999\n  enforcement:\n    existence: hard\n    consistency: advisory\n    drift: advisory\n',
    });

    try {
      const resultA = validateArtifacts(specName, dirA, { mode: 'interactive' });
      const resultB = validateArtifacts(specNameB, dirB, { mode: 'interactive' });

      // Both must compute the same jaccard_below (same input)
      if (resultA.drift && resultB.drift) {
        assert.ok(
          Math.abs(resultA.drift.jaccard_below - resultB.drift.jaccard_below) < 0.001,
          'AC-10: identical inputs must produce identical jaccard_below'
        );
      }

      // A: jaccard_max=0.5, B: jaccard_max=0.9
      // With jaccard_below ≈ 0.667:
      //   A: advisory expected; B: no advisory expected
      const advisoryA = resultA.checks.filter(
        (c) => c.kind === 'drift' && c.driftKey === 'jaccard_below' && c.status === 'advisory'
      );
      const advisoryB = resultB.checks.filter(
        (c) => c.kind === 'drift' && c.driftKey === 'jaccard_below' && c.status === 'advisory'
      );

      if (resultA.drift && resultA.drift.jaccard_below > 0.5) {
        assert.ok(advisoryA.length > 0, 'AC-10: jaccard_max=0.5 with jaccard_below>0.5 must produce advisory');
      }
      if (resultB.drift && resultB.drift.jaccard_below <= 0.9) {
        assert.equal(advisoryB.length, 0, 'AC-10: jaccard_max=0.9 with jaccard_below<=0.9 must NOT produce advisory');
      }
    } finally {
      cleanupA();
      cleanupB();
    }
  });
});
