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
const fs = require('fs');
const path = require('path');
const os = require('os');

const { computeLayer, validateSpec, extractSection, parseFrontmatter } = require('./df-spec-lint');

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
    '- [ ] **AC-1** REQ-1 works',
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
// validateSpec — Acceptance Criteria AC-N format enforcement
// ---------------------------------------------------------------------------

describe('validateSpec AC-N format enforcement', () => {
  test('bare "- [ ]" line without **AC-N** identifier causes hard failure', () => {
    const specWithBareAC = [
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
    const result = validateSpec(specWithBareAC);
    const acErrors = result.hard.filter((m) => m.includes('AC-N'));
    assert.ok(acErrors.length > 0, 'should hard-fail when AC checkbox lacks **AC-N** identifier');
  });

  test('AC line with **AC-N** identifier passes without hard error', () => {
    const result = validateSpec(fullSpec());
    const acErrors = result.hard.filter((m) => m.includes('AC-N'));
    assert.equal(acErrors.length, 0, 'should not hard-fail when AC checkbox has **AC-N** identifier');
  });

  test('bare "- [ ]" line hard error message references the offending line', () => {
    const specWithBareAC = [
      '## Objective',
      'Build the thing',
      '',
      '## Requirements',
      '- REQ-1: Do something',
      '',
      '## Acceptance Criteria',
      '- [ ] bare item without identifier',
    ].join('\n');
    const result = validateSpec(specWithBareAC);
    const acErrors = result.hard.filter((m) => m.includes('AC-N'));
    assert.ok(
      acErrors.some((m) => m.includes('bare item without identifier')),
      'hard error message should include the offending line text'
    );
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

// ---------------------------------------------------------------------------
// parseFrontmatter — direct unit tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('parses key-value pairs and returns body without frontmatter', () => {
    const content = [
      '---',
      'derives-from: done-auth',
      'name: spec-lineage',
      '---',
      '',
      '## Objective',
      'Build it',
    ].join('\n');
    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter['derives-from'], 'done-auth');
    assert.equal(frontmatter['name'], 'spec-lineage');
    assert.ok(body.includes('## Objective'));
    assert.ok(body.includes('Build it'));
  });

  test('returns empty frontmatter and full body when no --- opener', () => {
    const content = '## Objective\nBuild it\n';
    const { frontmatter, body } = parseFrontmatter(content);
    assert.deepEqual(frontmatter, {});
    assert.equal(body, content);
  });

  test('returns empty frontmatter when opening --- exists but no closing ---', () => {
    const content = '---\nderives-from: done-auth\n## Objective\nBuild it\n';
    const { frontmatter, body } = parseFrontmatter(content);
    assert.deepEqual(frontmatter, {});
    assert.equal(body, content);
  });

  test('handles empty frontmatter block (--- immediately followed by ---)', () => {
    const content = ['---', '---', '', '## Objective', 'Build it'].join('\n');
    const { frontmatter, body } = parseFrontmatter(content);
    assert.deepEqual(frontmatter, {});
    assert.ok(body.includes('## Objective'));
  });

  test('trims whitespace from keys and values', () => {
    const content = [
      '---',
      '  derives-from  :   done-auth  ',
      '---',
      '',
      '## Objective',
      'Build it',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter['derives-from'], 'done-auth');
  });

  test('handles empty string input', () => {
    const { frontmatter, body } = parseFrontmatter('');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, '');
  });

  test('body does not include frontmatter delimiters', () => {
    const content = withFrontmatter('## Objective\nBuild it', {
      'derives-from': 'done-auth',
    });
    const { body } = parseFrontmatter(content);
    // Body should not start with ---
    assert.ok(!body.trimStart().startsWith('---'));
  });

  test('handles value containing colons', () => {
    const content = [
      '---',
      'description: a spec: with colons: inside',
      '---',
      '',
      'body',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter['description'], 'a spec: with colons: inside');
  });
});

// ---------------------------------------------------------------------------
// derives-from validation in validateSpec
// ---------------------------------------------------------------------------

describe('derives-from validation', () => {
  test('spec without derives-from produces no derives-from advisory', () => {
    const content = fullSpec();
    const result = validateSpec(content);
    const derivesAdvisory = result.advisory.filter((m) => m.includes('derives-from'));
    assert.equal(derivesAdvisory.length, 0);
  });

  test('derives-from with no specsDir skips reference check (no warning)', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'nonexistent-spec',
    });
    // No specsDir passed — cannot verify, should not warn
    const result = validateSpec(content);
    const derivesAdvisory = result.advisory.filter((m) => m.includes('derives-from'));
    assert.equal(derivesAdvisory.length, 0);
  });

  test('derives-from referencing missing spec emits advisory warning, not hard error', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'nonexistent-spec',
    });
    // Use a real directory that won't contain spec files
    const tmpDir = path.join(__dirname, '..', 'templates');
    const result = validateSpec(content, { specsDir: tmpDir });
    // Should be advisory, not hard
    const derivesHard = result.hard.filter((m) => m.includes('derives-from'));
    assert.equal(derivesHard.length, 0, 'missing derives-from reference must not be a hard error');
    const derivesAdvisory = result.advisory.filter((m) => m.includes('derives-from'));
    assert.ok(derivesAdvisory.length > 0, 'should emit advisory warning for missing reference');
  });

  test('advisory message includes the referenced spec name', () => {
    const content = withFrontmatter(fullSpec(), {
      'derives-from': 'phantom-spec',
    });
    const tmpDir = path.join(__dirname, '..', 'templates');
    const result = validateSpec(content, { specsDir: tmpDir });
    const derivesAdvisory = result.advisory.filter((m) => m.includes('derives-from'));
    assert.ok(
      derivesAdvisory.some((m) => m.includes('phantom-spec')),
      'advisory should mention the referenced spec name'
    );
  });

  test('derives-from referencing existing spec file produces no advisory', () => {
    // Create a temp specs dir with a matching file
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spec-lint-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'done-auth.md'), '## Objective\nAuth\n');
      const content = withFrontmatter(fullSpec(), {
        'derives-from': 'done-auth',
      });
      const result = validateSpec(content, { specsDir: tmpDir });
      const derivesAdvisory = result.advisory.filter((m) => m.includes('derives-from'));
      assert.equal(derivesAdvisory.length, 0, 'should not warn when reference exists');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('derives-from resolves done- prefixed files', () => {
    // Reference "auth" but file is "done-auth.md" — should resolve
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spec-lint-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'done-auth.md'), '## Objective\nAuth\n');
      const content = withFrontmatter(fullSpec(), {
        'derives-from': 'auth',
      });
      const result = validateSpec(content, { specsDir: tmpDir });
      const derivesAdvisory = result.advisory.filter((m) => m.includes('derives-from'));
      assert.equal(derivesAdvisory.length, 0, 'should resolve done- prefixed file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('spec layer and hard errors are unaffected by derives-from presence', () => {
    const withDerives = withFrontmatter(fullSpec(), { 'derives-from': 'done-auth' });
    const without = fullSpec();
    const resultWith = validateSpec(withDerives);
    const resultWithout = validateSpec(without);
    assert.equal(resultWith.layer, resultWithout.layer);
    assert.deepEqual(resultWith.hard, resultWithout.hard);
  });
});

// ---------------------------------------------------------------------------
// validateSpec — spec filename stem validation
// ---------------------------------------------------------------------------

describe('validateSpec stem validation', () => {
  test('valid plain name passes', () => {
    const result = validateSpec(fullSpec(), { filename: 'my-spec.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 0);
  });

  test('valid name with numbers passes', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec-v2-fix.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 0);
  });

  test('single character name passes', () => {
    const result = validateSpec(fullSpec(), { filename: 'a.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 0);
  });

  test('doing- prefix is stripped before validation', () => {
    const result = validateSpec(fullSpec(), { filename: 'doing-my-spec.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 0);
  });

  test('done- prefix is stripped before validation', () => {
    const result = validateSpec(fullSpec(), { filename: 'done-my-spec.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 0);
  });

  test('filename with dollar sign is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec-$bad.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with backtick is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec-`bad.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with pipe character is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec|bad.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with semicolon is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec;bad.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with ampersand is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec&bad.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with space is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec bad.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with path traversal (..) is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: '..evil.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with leading hyphen is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: '-leading.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('filename with trailing hyphen is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: 'trailing-.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('empty stem (only prefix) is rejected as hard failure', () => {
    // A filename of just "doing-.md" strips to empty string
    const result = validateSpec(fullSpec(), { filename: 'doing-.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('empty filename stem (.md only) is rejected as hard failure', () => {
    const result = validateSpec(fullSpec(), { filename: '.md' });
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 1);
  });

  test('stem validation failure is in hard array, not advisory', () => {
    const result = validateSpec(fullSpec(), { filename: 'spec$bad.md' });
    const hardErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    const advisoryErrors = result.advisory.filter((m) => m.includes('unsafe characters'));
    assert.equal(hardErrors.length, 1);
    assert.equal(advisoryErrors.length, 0);
  });

  test('no filename passed (null) skips stem validation', () => {
    // No filename option — stem check should not run
    const result = validateSpec(fullSpec());
    const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
    assert.equal(stemErrors.length, 0);
  });

  test('all existing repo spec names pass validation', () => {
    const existingNames = [
      'done-dashboard-model-cost-fixes.md',
      'done-orchestrator-v2.md',
      'done-plan-cleanup.md',
      'done-plan-fanout.md',
      'done-quality-gates.md',
    ];
    for (const filename of existingNames) {
      const result = validateSpec(fullSpec(), { filename });
      const stemErrors = result.hard.filter((m) => m.includes('unsafe characters'));
      assert.equal(stemErrors.length, 0, `Expected ${filename} to pass but got stem errors`);
    }
  });
});
