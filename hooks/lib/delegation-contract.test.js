/**
 * Tests for hooks/lib/delegation-contract.js
 *
 * Covers:
 *   - extractBlocks: regex-based fenced-YAML block extraction
 *   - parseSimpleYaml: zero-dep flat key→value|string[] parser
 *   - loadContract: end-to-end parse from a markdown string
 *   - validatePrompt: forbidden-input and required-input enforcement
 *   - findDelegationMd: resolution order (exercised via path logic, not fs)
 *
 * Uses Node.js built-in node:test. No external dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  findDelegationMd,
  extractBlocks,
  parseSimpleYaml,
  loadContract,
  validatePrompt,
} = require('./delegation-contract');

// ---------------------------------------------------------------------------
// Fixture markdown — two agents with full contract fields
// ---------------------------------------------------------------------------

const FIXTURE_MD = `
# DELEGATION.md

## Router vs Interpreter

Orchestrators pass verbatim artifacts or delegate to \`reasoner\`.

## df-spike

\`\`\`yaml
allowed-inputs:
  - hypothesis
  - spec-path
forbidden-inputs:
  - implementation details
  - paraphrased objectives
required-output-schema:
  - "status: passed|failed|inconclusive"
  - "confidence: high|medium|low"
\`\`\`

## df-implement

\`\`\`yaml
allowed-inputs:
  - task-description:
  - acceptance-criteria:
forbidden-inputs:
  - orchestrator summary
  - paraphrased context
required-output-schema:
  - "files-modified: array"
\`\`\`
`;

// ---------------------------------------------------------------------------
// extractBlocks
// ---------------------------------------------------------------------------

describe('extractBlocks', () => {
  test('returns one block per ## heading with a yaml fence', () => {
    const blocks = extractBlocks(FIXTURE_MD);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].agent, 'df-spike');
    assert.equal(blocks[1].agent, 'df-implement');
  });

  test('block raw contains the YAML content', () => {
    const [spike] = extractBlocks(FIXTURE_MD);
    assert.ok(spike.raw.includes('allowed-inputs'));
    assert.ok(spike.raw.includes('hypothesis'));
  });

  test('sections without yaml fence are ignored', () => {
    const md = `## Router vs Interpreter\n\nsome prose\n\n## df-spike\n\n\`\`\`yaml\nallowed-inputs:\n  - x\nforbidden-inputs:\n  - y\nrequired-output-schema:\n  - z\n\`\`\`\n`;
    const blocks = extractBlocks(md);
    // Only df-spike has a yaml fence
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].agent, 'df-spike');
  });

  test('returns empty array for empty string', () => {
    assert.deepEqual(extractBlocks(''), []);
  });

  test('returns empty array for non-string input', () => {
    assert.deepEqual(extractBlocks(null), []);
    assert.deepEqual(extractBlocks(undefined), []);
  });

  test('resets lastIndex so consecutive calls produce same result', () => {
    const a = extractBlocks(FIXTURE_MD);
    const b = extractBlocks(FIXTURE_MD);
    assert.equal(a.length, b.length);
    assert.equal(a[0].agent, b[0].agent);
  });
});

// ---------------------------------------------------------------------------
// parseSimpleYaml
// ---------------------------------------------------------------------------

describe('parseSimpleYaml', () => {
  test('parses array values under a key', () => {
    const raw = `allowed-inputs:\n  - hypothesis\n  - spec-path\n`;
    const out = parseSimpleYaml(raw);
    assert.deepEqual(out['allowed-inputs'], ['hypothesis', 'spec-path']);
  });

  test('parses scalar value', () => {
    const raw = `name: df-spike\n`;
    const out = parseSimpleYaml(raw);
    assert.equal(out['name'], 'df-spike');
  });

  test('parses inline array syntax', () => {
    const raw = `tags: [alpha, beta, gamma]\n`;
    const out = parseSimpleYaml(raw);
    assert.deepEqual(out['tags'], ['alpha', 'beta', 'gamma']);
  });

  test('skips blank lines and comments', () => {
    const raw = `# comment\n\nallowed-inputs:\n  # inner comment\n  - item\n`;
    const out = parseSimpleYaml(raw);
    assert.deepEqual(out['allowed-inputs'], ['item']);
  });

  test('handles multiple keys', () => {
    const raw = `allowed-inputs:\n  - a\nforbidden-inputs:\n  - b\nrequired-output-schema:\n  - c\n`;
    const out = parseSimpleYaml(raw);
    assert.deepEqual(out['allowed-inputs'], ['a']);
    assert.deepEqual(out['forbidden-inputs'], ['b']);
    assert.deepEqual(out['required-output-schema'], ['c']);
  });

  test('returns empty object for empty input', () => {
    assert.deepEqual(parseSimpleYaml(''), {});
    assert.deepEqual(parseSimpleYaml(null), {});
  });
});

// ---------------------------------------------------------------------------
// loadContract
// ---------------------------------------------------------------------------

describe('loadContract', () => {
  let tmpFile;

  test('loads a two-agent contract from a temp file', () => {
    tmpFile = path.join(os.tmpdir(), `delegation-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, FIXTURE_MD, 'utf8');
    const map = loadContract(tmpFile);
    assert.equal(map.size, 2);
    assert.ok(map.has('df-spike'));
    assert.ok(map.has('df-implement'));
    fs.unlinkSync(tmpFile);
  });

  test('each entry has allowedInputs, forbiddenInputs, requiredOutputSchema arrays', () => {
    tmpFile = path.join(os.tmpdir(), `delegation-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, FIXTURE_MD, 'utf8');
    const map = loadContract(tmpFile);
    const spike = map.get('df-spike');
    assert.ok(Array.isArray(spike.allowedInputs));
    assert.ok(Array.isArray(spike.forbiddenInputs));
    assert.ok(Array.isArray(spike.requiredOutputSchema));
    assert.ok(spike.allowedInputs.includes('hypothesis'));
    assert.ok(spike.forbiddenInputs.includes('implementation details'));
    fs.unlinkSync(tmpFile);
  });

  test('returns empty Map for non-existent file (fail-open)', () => {
    const map = loadContract('/nonexistent/path/DELEGATION.md');
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
  });

  test('returns empty Map for malformed markdown (fail-open)', () => {
    tmpFile = path.join(os.tmpdir(), `delegation-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# no fenced blocks here\njust prose', 'utf8');
    const map = loadContract(tmpFile);
    assert.equal(map.size, 0);
    fs.unlinkSync(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// validatePrompt
// ---------------------------------------------------------------------------

describe('validatePrompt', () => {
  let contractMap;

  // Build a minimal in-memory contract map for validation tests
  const buildMap = () => {
    const m = new Map();
    m.set('df-spike', {
      allowedInputs: ['hypothesis', 'spec-path'],
      forbiddenInputs: ['implementation details', 'paraphrased objectives'],
      requiredOutputSchema: ['status: passed|failed|inconclusive'],
    });
    m.set('df-implement', {
      allowedInputs: ['task-description:', 'acceptance-criteria:'],
      forbiddenInputs: ['orchestrator summary'],
      requiredOutputSchema: ['files-modified: array'],
    });
    return m;
  };

  test('returns ok:true for a clean prompt (no violations)', () => {
    contractMap = buildMap();
    const result = validatePrompt('df-spike', 'hypothesis: do X\nspec-path: specs/foo.md', contractMap);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  test('returns violation when forbidden pattern appears in prompt', () => {
    contractMap = buildMap();
    const result = validatePrompt('df-spike', 'Please add implementation details here', contractMap);
    assert.equal(result.ok, false);
    const rules = result.violations.map(v => v.rule);
    assert.ok(rules.some(r => r.includes('forbidden-input:implementation details')));
  });

  test('forbidden check is case-insensitive', () => {
    contractMap = buildMap();
    const result = validatePrompt('df-spike', 'PARAPHRASED OBJECTIVES are bad', contractMap);
    assert.equal(result.ok, false);
    assert.ok(result.violations[0].rule.includes('paraphrased objectives'));
  });

  test('returns violation when required field marker is missing', () => {
    contractMap = buildMap();
    // df-implement requires "task-description:" and "acceptance-criteria:" in prompt
    const result = validatePrompt('df-implement', 'just a description without the colon field', contractMap);
    assert.equal(result.ok, false);
    const rules = result.violations.map(v => v.rule);
    assert.ok(rules.some(r => r.includes('required-input:task-description:')));
    assert.ok(rules.some(r => r.includes('required-input:acceptance-criteria:')));
  });

  test('passes when all required field markers are present', () => {
    contractMap = buildMap();
    const prompt = 'task-description: do the thing\nacceptance-criteria: it works';
    const result = validatePrompt('df-implement', prompt, contractMap);
    assert.equal(result.ok, true);
  });

  test('returns ok:true for unknown agent (not in contract)', () => {
    contractMap = buildMap();
    const result = validatePrompt('df-unknown', 'anything goes', contractMap);
    assert.equal(result.ok, true);
  });

  test('returns ok:true when contractMap is null (fail-open)', () => {
    const result = validatePrompt('df-spike', 'some prompt', null);
    assert.equal(result.ok, true);
  });

  test('returns ok:true when contractMap is empty Map', () => {
    const result = validatePrompt('df-spike', 'some prompt', new Map());
    assert.equal(result.ok, true);
  });

  test('violation detail mentions the agent name', () => {
    contractMap = buildMap();
    const result = validatePrompt('df-spike', 'implementation details go here', contractMap);
    assert.ok(result.violations[0].detail.includes('df-spike'));
  });

  test('multiple violations accumulate in the array', () => {
    contractMap = buildMap();
    // Both forbidden patterns appear in the prompt, and no required field markers
    const prompt = 'implementation details and paraphrased objectives here';
    const result = validatePrompt('df-spike', prompt, contractMap);
    assert.equal(result.ok, false);
    assert.ok(result.violations.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// findDelegationMd (path logic only — no real fs traversal)
// ---------------------------------------------------------------------------

describe('findDelegationMd', () => {
  test('returns null when no DELEGATION.md found', () => {
    // Use a guaranteed nonexistent temp cwd
    const result = findDelegationMd('/nonexistent/cwd/xyz123');
    assert.equal(result, null);
  });

  test('returns a string path when DELEGATION.md exists in cwd', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-delegation-test-'));
    const agentsDir = path.join(tmpDir, 'src', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const mdPath = path.join(agentsDir, 'DELEGATION.md');
    fs.writeFileSync(mdPath, '# DELEGATION\n', 'utf8');

    const result = findDelegationMd(tmpDir);
    assert.equal(result, mdPath);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
