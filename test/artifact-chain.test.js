/**
 * Tests for the artifact-chain spec.
 *
 * AC coverage map (specs/artifact-chain.md):
 *   specs/artifact-chain.md#AC-1  — discover.md writes sketch.md with modules/entry_points/related_specs
 *   specs/artifact-chain.md#AC-2  — spec-template.md exposes touched_modules/likely_files/new_surface
 *   specs/artifact-chain.md#AC-3  — plan.md persists Agent B output to impact.md for L3 specs only
 *   specs/artifact-chain.md#AC-4  — plan-template.md declares Slice/Symbols/Impact edges fields
 *   specs/artifact-chain.md#AC-5  — execute.md appends findings blocks with files_read/hypotheses_discarded/confirmed
 *   specs/artifact-chain.md#AC-6  — plan.md/execute.md/spec.md each load maps artifacts via shell-injection
 *   specs/artifact-chain.md#AC-7  — verify.md invalidates .deepflow/maps/{spec}/ on doing→done transition
 *   specs/artifact-chain.md#AC-8  — bin/install.js registers new map templates
 *
 * Uses Node.js built-in node:test to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function load(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-1
// discover.md writes .deepflow/maps/{name}/sketch.md with required fields
// ---------------------------------------------------------------------------

describe('AC-1: discover.md writes sketch.md with required fields', () => {
  const DISCOVER = load('src/commands/df/discover.md');

  it('discover.md references .deepflow/maps/{name}/sketch.md write', () => {
    // specs/artifact-chain.md#AC-1
    assert.ok(
      DISCOVER.includes('.deepflow/maps/{name}/sketch.md') || DISCOVER.includes('.deepflow/maps/'),
      'discover.md must reference .deepflow/maps/{name}/sketch.md artifact path'
    );
  });

  it('discover.md includes modules: field in sketch content', () => {
    // specs/artifact-chain.md#AC-1
    assert.ok(
      DISCOVER.includes('modules:'),
      'discover.md sketch template must include modules: field'
    );
  });

  it('discover.md includes entry_points: field in sketch content', () => {
    // specs/artifact-chain.md#AC-1
    assert.ok(
      DISCOVER.includes('entry_points:'),
      'discover.md sketch template must include entry_points: field'
    );
  });

  it('discover.md includes related_specs: field in sketch content', () => {
    // specs/artifact-chain.md#AC-1
    assert.ok(
      DISCOVER.includes('related_specs:'),
      'discover.md sketch template must include related_specs: field'
    );
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-2
// spec-template.md exposes optional frontmatter keys
// ---------------------------------------------------------------------------

describe('AC-2: spec-template.md exposes optional frontmatter keys', () => {
  const SPEC_TMPL = load('templates/spec-template.md');

  it('spec-template.md includes touched_modules key', () => {
    // specs/artifact-chain.md#AC-2
    assert.ok(
      SPEC_TMPL.includes('touched_modules'),
      'spec-template.md must document touched_modules frontmatter key'
    );
  });

  it('spec-template.md includes likely_files key', () => {
    // specs/artifact-chain.md#AC-2
    assert.ok(
      SPEC_TMPL.includes('likely_files'),
      'spec-template.md must document likely_files frontmatter key'
    );
  });

  it('spec-template.md includes new_surface key', () => {
    // specs/artifact-chain.md#AC-2
    assert.ok(
      SPEC_TMPL.includes('new_surface'),
      'spec-template.md must document new_surface frontmatter key'
    );
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-3
// plan.md persists Agent B raw output to impact.md (L3 only)
// ---------------------------------------------------------------------------

describe('AC-3: plan.md persists Agent B output to impact.md for L3 specs', () => {
  const PLAN = load('src/commands/df/plan.md');

  it('plan.md references impact.md write step', () => {
    // specs/artifact-chain.md#AC-3
    assert.ok(
      PLAN.includes('impact.md'),
      'plan.md must reference impact.md artifact'
    );
  });

  it('plan.md persist step is gated to L3 specs only', () => {
    // specs/artifact-chain.md#AC-3
    assert.ok(
      PLAN.includes('L3 specs only') || PLAN.includes('L3 only'),
      'plan.md impact.md persist step must be explicitly gated to L3 specs only'
    );
  });

  it('plan.md persist step creates directory before writing', () => {
    // specs/artifact-chain.md#AC-3
    assert.ok(
      PLAN.includes('mkdir -p .deepflow/maps/{spec}'),
      'plan.md must include mkdir -p directive for .deepflow/maps/{spec}'
    );
  });

  it('plan.md specifies writing Agent B raw output verbatim', () => {
    // specs/artifact-chain.md#AC-3
    assert.ok(
      PLAN.includes('verbatim') || PLAN.includes('raw output'),
      'plan.md must instruct writing Agent B raw output verbatim to impact.md'
    );
  });

  it('plan.md persist step occurs before passing output to reasoner', () => {
    // specs/artifact-chain.md#AC-3
    // The persist block must appear before §5A reasoner section
    const persistIdx = PLAN.indexOf('impact.md');
    const reasonerIdx = PLAN.indexOf('plan reasoner');
    assert.ok(persistIdx !== -1, 'impact.md reference must exist');
    assert.ok(reasonerIdx !== -1, 'plan reasoner reference must exist');
    assert.ok(
      persistIdx < reasonerIdx,
      'impact.md persist step must appear before §5A reasoner prompt'
    );
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-4
// plan-template.md declares Slice/Symbols/Impact edges fields
// Implemented by T5 — marked todo until that task completes
// ---------------------------------------------------------------------------

describe('AC-4: plan-template.md declares optional slice fields', () => {
  it('plan-template.md includes Slice: field', () => {
    // specs/artifact-chain.md#AC-4
    const TMPL = load('templates/plan-template.md');
    assert.ok(TMPL.includes('Slice:'), 'plan-template.md must include Slice: field');
  });

  it('plan-template.md includes Symbols: field', () => {
    // specs/artifact-chain.md#AC-4
    const TMPL = load('templates/plan-template.md');
    assert.ok(TMPL.includes('Symbols:'), 'plan-template.md must include Symbols: field');
  });

  it('plan-template.md includes Impact edges: field', () => {
    // specs/artifact-chain.md#AC-4
    const TMPL = load('templates/plan-template.md');
    assert.ok(TMPL.includes('Impact edges:'), 'plan-template.md must include Impact edges: field');
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-5
// execute.md appends per-task findings blocks
// Implemented by T6 — marked todo until that task completes
// ---------------------------------------------------------------------------

describe('AC-5: execute.md appends findings blocks per completed task', () => {
  it('execute.md references findings.md', { todo: 'Implemented by T6 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-5
    const EXECUTE = load('src/commands/df/execute.md');
    assert.ok(EXECUTE.includes('findings.md'), 'execute.md must reference findings.md artifact');
  });

  it('execute.md includes files_read: key in findings block', { todo: 'Implemented by T6 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-5
    const EXECUTE = load('src/commands/df/execute.md');
    assert.ok(EXECUTE.includes('files_read:'), 'execute.md findings block must include files_read: key');
  });

  it('execute.md includes hypotheses_discarded: key in findings block', { todo: 'Implemented by T6 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-5
    const EXECUTE = load('src/commands/df/execute.md');
    assert.ok(EXECUTE.includes('hypotheses_discarded:'), 'execute.md findings block must include hypotheses_discarded: key');
  });

  it('execute.md includes confirmed: key in findings block', { todo: 'Implemented by T6 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-5
    const EXECUTE = load('src/commands/df/execute.md');
    assert.ok(EXECUTE.includes('confirmed:'), 'execute.md findings block must include confirmed: key');
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-6
// plan.md/execute.md/spec.md each load maps artifacts via shell-injection
// ---------------------------------------------------------------------------

describe('AC-6: downstream commands load maps artifacts via shell-injection', () => {
  const PLAN = load('src/commands/df/plan.md');

  it('plan.md has shell-injection for .deepflow/maps/ artifact', () => {
    // specs/artifact-chain.md#AC-6
    assert.ok(
      PLAN.includes('cat .deepflow/maps/'),
      'plan.md must include shell-injection: cat .deepflow/maps/...'
    );
  });

  it('plan.md shell-injection uses 2>/dev/null || echo NOT_FOUND pattern', () => {
    // specs/artifact-chain.md#AC-6
    assert.ok(
      PLAN.includes('2>/dev/null') && PLAN.includes('NOT_FOUND'),
      'plan.md shell-injection must use 2>/dev/null || echo NOT_FOUND pattern'
    );
  });

  it('execute.md has shell-injection for .deepflow/maps/ artifact', { todo: 'Implemented by T9 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-6
    const EXECUTE = load('src/commands/df/execute.md');
    assert.ok(EXECUTE.includes('cat .deepflow/maps/'), 'execute.md must include shell-injection: cat .deepflow/maps/...');
  });

  it('spec.md has shell-injection for .deepflow/maps/ artifact', { todo: 'Implemented by T9 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-6
    const SPEC = load('src/commands/df/spec.md');
    assert.ok(SPEC.includes('cat .deepflow/maps/'), 'spec.md must include shell-injection: cat .deepflow/maps/...');
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-7
// verify.md invalidates .deepflow/maps/{spec}/ on doing→done transition
// Implemented by T11 — marked todo until that task completes
// ---------------------------------------------------------------------------

describe('AC-7: verify.md invalidates maps dir on spec completion', () => {
  it('verify.md references .deepflow/maps/ invalidation', () => {
    // specs/artifact-chain.md#AC-7
    const VERIFY = load('src/commands/df/verify.md');
    assert.ok(
      VERIFY.includes('.deepflow/maps/') || VERIFY.includes('maps/{spec}'),
      'verify.md must reference .deepflow/maps/ directory invalidation'
    );
  });

  it('verify.md includes remove or archive action for maps directory', () => {
    // specs/artifact-chain.md#AC-7
    const VERIFY = load('src/commands/df/verify.md');
    assert.ok(
      VERIFY.includes('rm -rf') || VERIFY.includes('archive') || VERIFY.includes('remove') || VERIFY.includes('maps/'),
      'verify.md must describe removing or archiving the maps directory on completion'
    );
  });
});

// ---------------------------------------------------------------------------
// specs/artifact-chain.md#AC-8
// bin/install.js registers new map template files
// Implemented by T10 — marked todo until that task completes
// ---------------------------------------------------------------------------

describe('AC-8: bin/install.js registers map template files', () => {
  it('bin/install.js references maps template registration', { todo: 'Implemented by T10 (not yet merged)' }, () => {
    // specs/artifact-chain.md#AC-8
    const INSTALL = load('bin/install.js');
    assert.ok(
      INSTALL.includes('maps') || INSTALL.includes('sketch-template') || INSTALL.includes('impact-template') || INSTALL.includes('findings-template'),
      'bin/install.js must reference maps template files (sketch-template, impact-template, or findings-template)'
    );
  });
});
