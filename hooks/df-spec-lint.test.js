/**
 * Tests for hooks/df-spec-lint.js
 *
 * Validates that computeLayer, validateSpec, and extractSection correctly
 * handle YAML frontmatter (including derives-from fields) without
 * misinterpreting frontmatter lines as section headers.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeLayer, validateSpec, extractSection } = require('./df-spec-lint');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal L0 spec (just Objective) */
function minimalSpec(objective = 'Build the thing') {
  return `## Objective\n${objective}\n`;
}

/** Full L3 spec with all required sections */
function fullSpec() {
  return [
    '## Objective',
    'Build the thing',
    '',
    '## Requirements',
    '- REQ-1: Do something',
    '',
    '## Constraints',
    'Must be fast',
    '',
    '## Out of Scope',
    'Not doing X',
    '',
    '## Acceptance Criteria',
    '- [ ] REQ-1 works',
    '',
    '## Technical Notes',
    'Use module Y',
  ].join('\n');
}

/** Wrap content with YAML frontmatter */
function withFrontmatter(body, fields = {}) {
  const yamlLines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return ['---', ...yamlLines, '---', '', body].join('\n');
}

// ---------------------------------------------------------------------------
// computeLayer — frontmatter handling
// ---------------------------------------------------------------------------

describe('computeLayer', () => {
  test('returns L0 for spec with only Objective', () => {
    assert.equal(computeLayer(minimalSpec()), 0);
  });

  test('returns L0 when frontmatter with derives-from precedes Objective', () => {
    const content = withFrontmatter(minimalSpec(), {
      'derives-from': 'done-auth',
    });
    assert.equal(computeLayer(content), 0);
  });

  test('returns L3 for full spec with derives-from frontmatter', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
      name: 'spec-lineage',
    });
    assert.equal(computeLayer(content), 3);
  });

  test('frontmatter --- lines are not counted as section headers', () => {
    // If --- were mistaken for headers, layer computation would break.
    // Verify that a spec with frontmatter computes same layer as without.
    const bare = fullSpec();
    const wrapped = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
    });
    assert.equal(computeLayer(bare), computeLayer(wrapped));
  });

  test('derives-from value is not mistaken for a section name', () => {
    // derives-from: done-auth — should not create a phantom header
    const content = withFrontmatter(minimalSpec(), {
      'derives-from': 'done-auth',
    });
    // Still L0, not some higher layer from phantom headers
    assert.equal(computeLayer(content), 0);
  });

  test('returns -1 when frontmatter exists but no Objective section', () => {
    const content = withFrontmatter('Just some text, no headings.', {
      'derives-from': 'done-auth',
    });
    assert.equal(computeLayer(content), -1);
  });
});

// ---------------------------------------------------------------------------
// validateSpec — frontmatter handling
// ---------------------------------------------------------------------------

describe('validateSpec with frontmatter', () => {
  test('full spec with derives-from frontmatter produces no hard errors', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
    });
    const result = validateSpec(content);
    assert.deepEqual(result.hard, []);
  });

  test('layer is correctly reported when frontmatter is present', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
    });
    const result = validateSpec(content);
    assert.equal(result.layer, 3);
  });

  test('L0 spec with frontmatter reports missing sections as advisory only', () => {
    const content = withFrontmatter(minimalSpec(), {
      'derives-from': 'done-auth',
    });
    const result = validateSpec(content);
    // L0 only requires Objective — everything else is advisory
    assert.deepEqual(result.hard, []);
    assert.ok(result.advisory.length > 0, 'should have advisory warnings for missing sections');
  });

  test('frontmatter --- delimiters do not appear in hard or advisory messages', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
    });
    const result = validateSpec(content);
    const allMessages = [...result.hard, ...result.advisory];
    for (const msg of allMessages) {
      assert.ok(!msg.includes('---'), `Unexpected --- in message: ${msg}`);
    }
  });
});

// ---------------------------------------------------------------------------
// extractSection — frontmatter handling
// ---------------------------------------------------------------------------

describe('extractSection with frontmatter', () => {
  test('extracts Objective section when frontmatter is present', () => {
    const content = withFrontmatter(minimalSpec('Build the thing'), {
      'derives-from': 'done-auth',
    });
    const section = extractSection(content, 'Objective');
    assert.ok(section !== null, 'Objective section should be found');
    assert.ok(section.includes('Build the thing'));
  });

  test('extracts Requirements section with frontmatter', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
    });
    const section = extractSection(content, 'Requirements');
    assert.ok(section !== null);
    assert.ok(section.includes('REQ-1'));
  });

  test('frontmatter content does not leak into extracted sections', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth',
      description: 'A spec about things',
    });
    const objective = extractSection(content, 'Objective');
    assert.ok(objective !== null);
    assert.ok(!objective.includes('derives-from'));
    assert.ok(!objective.includes('done-auth'));
    assert.ok(!objective.includes('description'));
  });

  test('returns null for non-existent section even with frontmatter', () => {
    const content = withFrontmatter(minimalSpec(), {
      'derives-from': 'done-auth',
    });
    const section = extractSection(content, 'Nonexistent');
    assert.equal(section, null);
  });

  test('extracts section using alias when frontmatter is present', () => {
    const content = withFrontmatter(
      '## Goal\nDo the thing\n\n## Requirements\n- REQ-1: stuff\n',
      { 'derives-from': 'done-auth' }
    );
    // 'goal' is an alias for 'Objective'
    const section = extractSection(content, 'Objective');
    assert.ok(section !== null, 'Should find section via alias "Goal"');
    assert.ok(section.includes('Do the thing'));
  });
});

// ---------------------------------------------------------------------------
// Edge cases — frontmatter-like patterns inside body
// ---------------------------------------------------------------------------

describe('frontmatter edge cases', () => {
  test('--- inside spec body (e.g. horizontal rule) does not break computeLayer', () => {
    const content = [
      '---',
      'derives-from: done-auth',
      '---',
      '',
      '## Objective',
      'Build it',
      '',
      '---',
      '',
      '## Requirements',
      '- REQ-1: Something',
    ].join('\n');
    // Should at least be L1 (has Objective + Requirements)
    assert.ok(computeLayer(content) >= 1);
  });

  test('multiple derives-from fields in frontmatter do not affect layer', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'done-auth, done-payments',
    });
    assert.equal(computeLayer(content), 3);
  });
});
