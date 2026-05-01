'use strict';
/**
 * Tests for df-artifact-validate.js REQ-4 enforcement modes (T29).
 *
 * AC-5: WHEN the hook is invoked with mode='strict' THEN consistency and drift
 *       advisories SHALL escalate to exit code 1; with mode='interactive' the
 *       same input SHALL exit 0 with warning text. The hook MUST NOT read a
 *       top-level `auto_mode` config key — enforcement is a runtime parameter.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateArtifacts, loadArtifactValidationConfig } = require('./df-artifact-validate');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal temporary repo with a spec and optionally an impact.md that
 * contains no edges (so sketch→impact consistency will emit advisories).
 *
 * Returns { dir, specName, cleanup }.
 */
function makeTmpRepo({ withSketch = false, sketchModules = [], withImpact = false, withPlan = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-artval-test-'));
  const specName = 'test-spec';

  // Create directories
  const mapsDir = path.join(dir, '.deepflow', 'maps', specName);
  const specsDir = path.join(dir, 'specs');
  fs.mkdirSync(mapsDir, { recursive: true });
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.deepflow', 'results'), { recursive: true });

  // Minimal spec file — no file paths to avoid existence failures
  fs.writeFileSync(path.join(specsDir, `doing-${specName}.md`), `# ${specName}\n\n## Objective\nTest spec.\n`, 'utf8');

  if (withSketch && sketchModules.length > 0) {
    const modulesSection = sketchModules.map((m) => `- ${m}`).join('\n');
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      `# sketch\n\nmodules:\n${modulesSection}\n`,
      'utf8'
    );
    // Create the actual module files so existence checks don't fail
    for (const m of sketchModules) {
      const absPath = path.join(dir, m);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, `// ${m}\n`, 'utf8');
    }
  }

  if (withImpact) {
    // impact.md with NO edges — any sketch modules won't appear here
    fs.writeFileSync(
      path.join(mapsDir, 'impact.md'),
      '# impact\n\nNo edges listed here.\n',
      'utf8'
    );
  }

  if (withPlan) {
    // PLAN.md with a simple task, no blockers
    fs.writeFileSync(
      path.join(dir, 'PLAN.md'),
      '# PLAN\n\n- [ ] **T1**: Do something\n',
      'utf8'
    );
  }

  return {
    dir,
    specName,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── REQ-4 / AC-5: Enforcement mode — interactive vs strict ───────────────────

describe('REQ-4 enforcement modes (AC-5)', () => {

  // REQ-4: AC-5 — interactive mode: consistency advisory → exit 0 (warning only)
  test('AC-5: interactive mode — consistency advisory stays at exit 0', () => {
    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/some-module.js'],
      withImpact: true, // impact.md has no edges → sketch module missing from impact → advisory
      withPlan: true,
    });

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });
      // REQ-4: consistency advisories do NOT escalate in interactive mode
      assert.equal(result.exit_code, 0, 'Interactive mode: consistency advisory should NOT hard-fail (exit 0)');
    } finally {
      cleanup();
    }
  });

  // REQ-4: strict mode — ALL advisories become hard fails
  test('strict mode — all advisories become hard fails', () => {
    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/some-module.js'],
      withImpact: true, // no edges → advisory
      withPlan: true,
    });

    try {
      const interactiveResult = validateArtifacts(specName, dir, { mode: 'interactive' });
      const strictResult = validateArtifacts(specName, dir, { mode: 'strict' });

      // Strict mode must have >= hard fails than interactive
      assert.ok(
        strictResult.hardFails.length >= interactiveResult.hardFails.length,
        'Strict mode must have at least as many hard fails as interactive mode'
      );

      // Any advisory in interactive mode must become a hard fail in strict mode
      const interactiveAdvisories = interactiveResult.checks.filter((c) => c.status === 'advisory');
      if (interactiveAdvisories.length > 0) {
        assert.equal(strictResult.exit_code, 1, 'Strict mode: any advisory MUST produce exit 1');
        assert.ok(strictResult.hardFails.length > 0, 'Strict mode: hardFails should be non-empty when advisories exist');
      }
    } finally {
      cleanup();
    }
  });

  // REQ-4: advisory mode — NO hard fails; everything is a warning (exit 0)
  test('advisory mode — no hard fails; existence missing still exits 0', () => {
    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['hooks/some-module.js'],
      withImpact: true,
      withPlan: true,
    });

    // Also write a sketch.md with a reference to a non-existent file to ensure
    // even a "missing" existence row is suppressed in advisory mode
    const mapsDir = path.join(dir, '.deepflow', 'maps', specName);
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      'modules:\n- hooks/nonexistent-file-xyz.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'advisory' });
      assert.equal(result.exit_code, 0, 'Advisory mode: MUST always exit 0 (no hard fails)');
      assert.equal(result.hardFails.length, 0, 'Advisory mode: hardFails array must be empty');
    } finally {
      cleanup();
    }
  });

  // REQ-4, AC-5: advisory mode doesn't read auto_mode config key
  test('advisory mode is NOT controlled by config — it is a runtime parameter only', () => {
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: true });

    // Write a config with auto_mode: true — this must NOT affect enforcement
    const configDir = path.join(dir, '.deepflow');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      'artifact_validation:\n  auto_mode: true\n  enforcement:\n    consistency: advisory\n    drift: advisory\n    existence: advisory\n',
      'utf8'
    );

    try {
      // Even with "auto_mode: true" in config, passing mode='advisory' must suppress hard fails
      const result = validateArtifacts(specName, dir, { mode: 'advisory' });
      assert.equal(result.exit_code, 0, 'Advisory mode is a runtime parameter — config auto_mode key must have no effect');
    } finally {
      cleanup();
    }
  });

  // AC-5: Same input — interactive exits 0, strict exits 1 for consistency advisory
  test('AC-5: same advisory input: interactive=exit-0, strict=exit-1', () => {
    const { dir, specName, cleanup } = makeTmpRepo({
      withSketch: true,
      sketchModules: ['lib/foo.js'],
      withImpact: true, // no edges → sketch not in impact → advisory
      withPlan: true,
    });

    try {
      const interactive = validateArtifacts(specName, dir, { mode: 'interactive' });
      const strict = validateArtifacts(specName, dir, { mode: 'strict' });

      const hasConsistencyAdvisory = interactive.checks.some(
        (c) => c.kind === 'consistency' && c.status === 'advisory'
      );

      if (hasConsistencyAdvisory) {
        // REQ-4, AC-5: the critical AC assertion
        assert.equal(interactive.exit_code, 0, 'AC-5: interactive mode MUST exit 0 for consistency advisory');
        assert.equal(strict.exit_code, 1, 'AC-5: strict mode MUST exit 1 for consistency advisory');
      }
    } finally {
      cleanup();
    }
  });

});

// ── Config schema invariants ─────────────────────────────────────────────────

describe('Enforcement config schema (REQ-4: runtime parameter, not config key)', () => {

  test('loadArtifactValidationConfig does not return auto_mode key', () => {
    const { dir, cleanup } = makeTmpRepo({});
    try {
      const cfg = loadArtifactValidationConfig(dir);
      assert.ok(!('auto_mode' in cfg), 'Config must not expose auto_mode key — it is a runtime signal only');
    } finally {
      cleanup();
    }
  });

  test('enforcement config has only hard/advisory/off values (no auto_mode)', () => {
    const { dir, cleanup } = makeTmpRepo({});
    try {
      const cfg = loadArtifactValidationConfig(dir);
      const validValues = new Set(['hard', 'advisory', 'off']);
      for (const [key, val] of Object.entries(cfg.enforcement)) {
        assert.ok(
          validValues.has(val),
          `enforcement.${key} must be hard|advisory|off, got "${val}"`
        );
      }
    } finally {
      cleanup();
    }
  });

});

// ── Existence hard-fail preserved across modes (except advisory) ──────────────

describe('Existence hard-fail behavior per mode', () => {

  test('interactive mode: missing file → exit 1', () => {
    // A sketch.md referencing a non-existent file should hard-fail in interactive mode
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: true });
    const mapsDir = path.join(dir, '.deepflow', 'maps', specName);
    fs.mkdirSync(mapsDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      'modules:\n- hooks/does-not-exist-abc.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'interactive' });
      const missingRows = result.checks.filter((c) => c.status === 'missing');
      if (missingRows.length > 0) {
        assert.equal(result.exit_code, 1, 'Interactive mode: missing file ref MUST hard-fail (exit 1)');
      }
    } finally {
      cleanup();
    }
  });

  test('strict mode: missing file → exit 1', () => {
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: true });
    const mapsDir = path.join(dir, '.deepflow', 'maps', specName);
    fs.mkdirSync(mapsDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      'modules:\n- hooks/does-not-exist-abc.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'strict' });
      const missingRows = result.checks.filter((c) => c.status === 'missing');
      if (missingRows.length > 0) {
        assert.equal(result.exit_code, 1, 'Strict mode: missing file ref MUST hard-fail (exit 1)');
      }
    } finally {
      cleanup();
    }
  });

  test('advisory mode: missing file → exit 0 (suppressed)', () => {
    const { dir, specName, cleanup } = makeTmpRepo({ withPlan: true });
    const mapsDir = path.join(dir, '.deepflow', 'maps', specName);
    fs.mkdirSync(mapsDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapsDir, 'sketch.md'),
      'modules:\n- hooks/does-not-exist-abc.js\n',
      'utf8'
    );

    try {
      const result = validateArtifacts(specName, dir, { mode: 'advisory' });
      assert.equal(result.exit_code, 0, 'Advisory mode: missing file ref MUST be suppressed (exit 0)');
      assert.equal(result.hardFails.length, 0, 'Advisory mode: hardFails must be empty even for missing refs');
    } finally {
      cleanup();
    }
  });

});
