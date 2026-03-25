'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadHypothesis, parseHypothesesFile } = require('./hypothesis.js');

// --- parseHypothesesFile ---

describe('parseHypothesesFile', () => {
  it('parses ordered list items (1. ...)', () => {
    const content = '1. First hypothesis\n2. Second hypothesis\n3. Third one\n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, [
      'First hypothesis',
      'Second hypothesis',
      'Third one',
    ]);
  });

  it('parses unordered list items with dashes (- ...)', () => {
    const content = '- Dash one\n- Dash two\n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, ['Dash one', 'Dash two']);
  });

  it('parses unordered list items with asterisks (* ...)', () => {
    const content = '* Star one\n* Star two\n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, ['Star one', 'Star two']);
  });

  it('handles mixed ordered and unordered items', () => {
    const content = '1. Ordered first\n- Dash second\n* Star third\n2. Ordered fourth\n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, [
      'Ordered first',
      'Dash second',
      'Star third',
      'Ordered fourth',
    ]);
  });

  it('returns empty array for empty content', () => {
    assert.deepStrictEqual(parseHypothesesFile(''), []);
  });

  it('returns empty array when content has no list items', () => {
    const content = '# Hypotheses\n\nSome paragraph text.\nAnother line.\n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, []);
  });

  it('ignores non-list lines interspersed with list items', () => {
    const content = '# Title\n\n1. Real item\nNot a list item\n- Another real item\n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, ['Real item', 'Another real item']);
  });

  it('trims whitespace from parsed items', () => {
    const content = '1.   Lots of spaces   \n-   Also spaced   \n';
    const result = parseHypothesesFile(content);
    assert.deepStrictEqual(result, ['Lots of spaces', 'Also spaced']);
  });
});

// --- loadHypothesis ---

describe('loadHypothesis', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypothesis-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns flag when provided (AC-11)', () => {
    const result = loadHypothesis({ flag: 'my hypothesis', benchDir: tmpDir });
    assert.strictEqual(result, 'my hypothesis');
  });

  it('trims the flag value', () => {
    const result = loadHypothesis({ flag: '  padded  ', benchDir: tmpDir });
    assert.strictEqual(result, 'padded');
  });

  it('reads hypotheses.md when no flag is provided', () => {
    const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-read-'));
    fs.writeFileSync(
      path.join(benchDir, 'hypotheses.md'),
      '1. First from file\n2. Second from file\n'
    );
    const result = loadHypothesis({ benchDir });
    assert.strictEqual(result, 'First from file');
    fs.rmSync(benchDir, { recursive: true, force: true });
  });

  it('ignores empty-string flag and falls back to file', () => {
    const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-empty-'));
    fs.writeFileSync(
      path.join(benchDir, 'hypotheses.md'),
      '- Fallback hypothesis\n'
    );
    const result = loadHypothesis({ flag: '', benchDir });
    assert.strictEqual(result, 'Fallback hypothesis');
    fs.rmSync(benchDir, { recursive: true, force: true });
  });

  it('ignores whitespace-only flag and falls back to file', () => {
    const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-ws-'));
    fs.writeFileSync(
      path.join(benchDir, 'hypotheses.md'),
      '- WS fallback\n'
    );
    const result = loadHypothesis({ flag: '   ', benchDir });
    assert.strictEqual(result, 'WS fallback');
    fs.rmSync(benchDir, { recursive: true, force: true });
  });

  it('throws when neither flag nor file available', () => {
    const missingDir = path.join(tmpDir, 'nonexistent');
    assert.throws(
      () => loadHypothesis({ benchDir: missingDir }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No --hypothesis flag provided'));
        assert.ok(err.message.includes('hypotheses.md'));
        return true;
      }
    );
  });

  it('throws when file exists but contains no list items', () => {
    const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-nolist-'));
    fs.writeFileSync(
      path.join(benchDir, 'hypotheses.md'),
      '# Just a heading\n\nSome text but no list items.\n'
    );
    assert.throws(
      () => loadHypothesis({ benchDir }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No hypotheses found'));
        return true;
      }
    );
    fs.rmSync(benchDir, { recursive: true, force: true });
  });

  it('throws when file is empty', () => {
    const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-empty-file-'));
    fs.writeFileSync(path.join(benchDir, 'hypotheses.md'), '');
    assert.throws(
      () => loadHypothesis({ benchDir }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No hypotheses found'));
        return true;
      }
    );
    fs.rmSync(benchDir, { recursive: true, force: true });
  });
});
