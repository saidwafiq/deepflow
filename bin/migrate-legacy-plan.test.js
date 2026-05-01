'use strict';
/**
 * Tests for bin/migrate-legacy-plan.js
 *
 * specs/deprecate-plan-auto.md#AC-5 — migrator converts a canonical legacy
 * doing-{spec}.md into a curated `## Tasks (curated)` section end-to-end
 * without manual edits.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLegacyTasks,
  renderCuratedTask,
  buildCuratedSection,
} = require('./migrate-legacy-plan');

const CANONICAL_LEGACY = `# Plan — example

> Spec: specs/doing-example.md
> Layer: L3

## Spec Gaps

- some gap

## Tasks

- [ ] **T1**: Create the foo module (REQ-1)
  - Files: \`src/foo.js\`, \`src/foo.test.js\`
  - ACs: AC-1
  - Steps:
    1. Create src/foo.js with the module skeleton
    2. Add a smoke test in src/foo.test.js
  - Model: sonnet
  - Effort: low
  - Blocked by: none

- [ ] **T2** [P]: Update README (REQ-2)
  - Files: \`README.md\`
  - ACs: AC-2
  - Steps:
    1. Add a "Foo" section to README.md
  - Model: haiku
  - Effort: low

- [ ] **T3**: Wire foo into bar (REQ-1, REQ-2)
  - Files: \`src/bar.js\`
  - ACs: AC-1, AC-2
  - Steps:
    1. Import foo in src/bar.js
    2. Replace the inline implementation with foo's API
  - Model: sonnet
  - Effort: medium
  - Blocked by: T1, T2

## Notes

trailing notes section
`;

describe('parseLegacyTasks', () => {
  test('parses three-task canonical legacy plan end-to-end', () => {
    const tasks = parseLegacyTasks(CANONICAL_LEGACY);
    assert.equal(tasks.length, 3);

    assert.equal(tasks[0].id, 'T1');
    assert.equal(tasks[0].title, 'Create the foo module');
    assert.deepEqual(tasks[0].reqRefs, ['REQ-1']);
    assert.deepEqual(tasks[0].files, ['src/foo.js', 'src/foo.test.js']);
    assert.deepEqual(tasks[0].acs, ['AC-1']);
    assert.equal(tasks[0].steps.length, 2);
    assert.deepEqual(tasks[0].blockedBy, []);
    assert.equal(tasks[0].parallel, false);

    assert.equal(tasks[1].id, 'T2');
    assert.equal(tasks[1].parallel, true);
    assert.deepEqual(tasks[1].blockedBy, []);

    assert.equal(tasks[2].id, 'T3');
    assert.deepEqual(tasks[2].blockedBy, ['T1', 'T2']);
    assert.deepEqual(tasks[2].acs, ['AC-1', 'AC-2']);
  });

  test('returns [] when ## Tasks section is absent', () => {
    assert.deepEqual(parseLegacyTasks('# Plan\n\n## Notes\n\n- x'), []);
  });

  test('parses correctly when ## Tasks is the last section (no trailing ## block)', () => {
    const trailing = `# Plan\n\n## Tasks\n\n- [ ] **T1**: solo (REQ-1)\n  - Files: \`a.js\`\n  - ACs: AC-1\n  - Steps:\n    1. do it\n  - Model: sonnet\n`;
    const tasks = parseLegacyTasks(trailing);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T1');
    assert.equal(tasks[0].steps.length, 1);
  });

  test('handles steps containing literal hyphens and quoted asterisks', () => {
    // Regression: an earlier version used invalid \\z and matched literal "z"
    // mid-string, truncating step bodies that contained "START-zone" etc.
    const tricky = `## Tasks\n\n- [ ] **T1**: Add lint guidance (REQ-1)\n  - Files: \`x.md\`\n  - ACs: AC-1\n  - Steps:\n    1. Insert START-zone block with text containing -- '*.ts' '*.tsx' patterns\n    2. Verify output\n  - Model: sonnet\n  - Effort: low\n`;
    const tasks = parseLegacyTasks(tricky);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].steps.length, 2);
    assert.match(tasks[0].steps[0], /START-zone/);
  });
});

describe('renderCuratedTask + buildCuratedSection', () => {
  test('renders T2 (parallel, no blockers) with [P] marker', () => {
    const tasks = parseLegacyTasks(CANONICAL_LEGACY);
    const rendered = renderCuratedTask(tasks[1]);
    assert.match(rendered, /### T2: Update README/);
    assert.match(rendered, /\*\*Parallel:\*\* \[P\]/);
    assert.doesNotMatch(rendered, /Blocked by:/);
  });

  test('renders T3 (blocked) with explicit Blocked by edge', () => {
    const tasks = parseLegacyTasks(CANONICAL_LEGACY);
    const rendered = renderCuratedTask(tasks[2]);
    assert.match(rendered, /Blocked by: T1, T2/);
  });

  test('every rendered task includes the CONTEXT_INSUFFICIENT escape clause', () => {
    const tasks = parseLegacyTasks(CANONICAL_LEGACY);
    for (const t of tasks) {
      const rendered = renderCuratedTask(t);
      assert.match(rendered, /CONTEXT_INSUFFICIENT/);
      assert.match(rendered, /do not use Read\/Grep\/Glob/);
    }
  });

  test('buildCuratedSection emits the canonical header', () => {
    const tasks = parseLegacyTasks(CANONICAL_LEGACY);
    const section = buildCuratedSection(tasks, 'example');
    assert.match(section, /^## Tasks \(curated\)/);
    assert.match(section, /Migrated from legacy/);
  });
});
