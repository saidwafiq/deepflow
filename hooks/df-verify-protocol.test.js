/**
 * Tests for hooks/df-verify-protocol.js
 *
 * Covers AC-5 (AC checklist + build/test commands injected from spec + config),
 * AC-6 (fail-open: missing config.yaml, malformed stdin, missing/multi specs),
 * and AC-10 (dedup marker → no-op).
 *
 * Strategy:
 *   - Direct require() tests for pure-function behaviour and fs-fixture paths.
 *   - spawnSync for binary-level stdin/exit-code contracts.
 *   - os.tmpdir() for all fixture dirs (cleaned up in afterEach).
 *
 * Uses Node.js built-in node:test. No additional npm packages.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Load the hook module directly (readStdinIfMain won't block because this
// file is not require.main).
// ---------------------------------------------------------------------------
const HOOK_PATH = path.resolve(__dirname, 'df-verify-protocol.js');
const hook = require('./df-verify-protocol');

const {
  main,
  parsePromptMarkers,
  findActiveSpec,
  parseAcceptanceCriteria,
  parseConfigCommands,
  buildInjectionBlock,
  INJECTION_MARKER,
} = hook;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'df-verify-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run the hook binary via spawnSync with JSON on stdin.
 */
function runHook(input, { env } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: json,
    encoding: 'utf8',
    timeout: 10000,
    env: env || process.env,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

/**
 * Write a minimal doing-*.md spec into tmpDir/specs/.
 */
function writeFixtureSpec(tmpDir, name, acLines) {
  const specsDir = path.join(tmpDir, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const content = [
    `# ${name}`,
    '',
    '## Acceptance Criteria',
    '',
    ...acLines,
    '',
  ].join('\n');
  const specPath = path.join(specsDir, `doing-${name}.md`);
  fs.writeFileSync(specPath, content);
  return specPath;
}

/**
 * Write a .deepflow/config.yaml into tmpDir with given build/test commands.
 */
function writeFixtureConfig(tmpDir, { build, test: testCmd } = {}) {
  const dfDir = path.join(tmpDir, '.deepflow');
  fs.mkdirSync(dfDir, { recursive: true });
  const lines = [
    'quality:',
  ];
  if (build) lines.push(`  build_command: ${build}`);
  if (testCmd) lines.push(`  test_command: ${testCmd}`);
  fs.writeFileSync(path.join(dfDir, 'config.yaml'), lines.join('\n'));
}

// ---------------------------------------------------------------------------
// 1. Fixture spec + config.yaml → both appear in updated prompt (AC-5, AC-6)
// ---------------------------------------------------------------------------

describe('AC-5/AC-6: Spec ACs + config commands injected', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-verify-ac5-');
    writeFixtureSpec(tmpDir, 'my-feature', [
      '- AC-1: system builds cleanly',
      '- AC-2: all tests pass',
      '- AC-3: no regressions',
    ]);
    writeFixtureConfig(tmpDir, { build: 'npm run build', test: 'npm test' });
  });

  afterEach(() => rmrf(tmpDir));

  test('AC checklist appears in updated prompt', () => {
    const prompt = '/df:verify — check my-feature spec AC-1 AC-2';
    const result = main({
      tool_name: 'Agent',
      tool_input: { prompt },
      cwd: tmpDir,
    });
    assert.ok(result !== null, 'main() must inject when spec + config exist');
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      updatedPrompt.includes('AC-1: system builds cleanly'),
      'AC-1 bullet must appear in updated prompt'
    );
    assert.ok(
      updatedPrompt.includes('AC-2: all tests pass'),
      'AC-2 bullet must appear in updated prompt'
    );
    assert.ok(
      updatedPrompt.includes('AC-3: no regressions'),
      'AC-3 bullet must appear in updated prompt'
    );
  });

  test('build_command appears in updated prompt', () => {
    const prompt = '/df:verify — check my-feature spec';
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.ok(result !== null);
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      updatedPrompt.includes('npm run build'),
      'build_command must appear in updated prompt'
    );
  });

  test('test_command appears in updated prompt', () => {
    const prompt = '/df:verify — check my-feature spec';
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.ok(result !== null);
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(updatedPrompt.includes('npm test'), 'test_command must appear in updated prompt');
  });

  test('injection marker is present in output', () => {
    const prompt = '/df:verify spec AC-1';
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.ok(result !== null);
    assert.ok(result.hookSpecificOutput.updatedInput.prompt.includes(INJECTION_MARKER));
  });

  test('spawn: full injection via stdin round-trip exits 0 with JSON output', () => {
    const prompt = '/df:verify — my-feature AC-1';
    const { stdout, status } = runHook({
      tool_name: 'Agent',
      tool_input: { prompt },
      cwd: tmpDir,
    });
    assert.equal(status, 0);
    assert.ok(stdout.trim().length > 0, 'stdout should contain JSON result');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.hookSpecificOutput.updatedInput.prompt.includes('npm run build'));
  });
});

// ---------------------------------------------------------------------------
// 2. Missing config.yaml → fail-open (AC-6)
// ---------------------------------------------------------------------------

describe('AC-6: Missing config.yaml → fail-open', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-verify-noconfig-');
    writeFixtureSpec(tmpDir, 'no-config-feature', ['- AC-1: does something']);
    // Intentionally do NOT call writeFixtureConfig
  });

  afterEach(() => rmrf(tmpDir));

  test('missing config.yaml → no commands block, but AC checklist still injected', () => {
    const prompt = '/df:verify — no-config-feature AC-1';
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    // The hook should still produce a result (spec exists, has ACs), just no commands.
    assert.ok(result !== null, 'Should still inject AC checklist when config is missing');
    const updatedPrompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      updatedPrompt.includes('AC-1: does something'),
      'AC checklist should still be present even without config.yaml'
    );
    // Commands block must NOT appear since build/test are null.
    assert.ok(
      !updatedPrompt.includes('Project commands:'),
      'No commands block should appear when config.yaml is missing'
    );
  });

  test('parseConfigCommands returns null values for missing config.yaml', () => {
    const { build, test: testCmd } = parseConfigCommands(tmpDir);
    assert.equal(build, null, 'build should be null when config.yaml is absent');
    assert.equal(testCmd, null, 'test should be null when config.yaml is absent');
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed stdin → exit 0, empty output (AC-6)
// ---------------------------------------------------------------------------

describe('AC-6: Fail-open on malformed stdin', () => {
  test('malformed JSON → exit 0 with empty stdout', () => {
    const { stdout, status } = runHook('not-valid-json{{{{');
    assert.equal(status, 0, 'Hook must exit 0 on malformed JSON');
    assert.equal(stdout.trim(), '', 'stdout must be empty on malformed JSON');
  });

  test('empty string stdin → exit 0 with empty stdout', () => {
    const { stdout, status } = runHook('');
    assert.equal(status, 0, 'Hook must exit 0 on empty stdin');
    assert.equal(stdout.trim(), '', 'stdout must be empty on empty stdin');
  });

  test('wrong tool_name → no output (pass-through, exit 0)', () => {
    const { stdout, status } = runHook({
      tool_name: 'Read',
      tool_input: { prompt: '/df:verify something AC-1' },
      cwd: os.tmpdir(),
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });

  test('null tool_input → exit 0 with empty stdout', () => {
    const { stdout, status } = runHook({
      tool_name: 'Agent',
      tool_input: null,
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// 4. Dedup marker present → no-op (AC-10)
// ---------------------------------------------------------------------------

describe('AC-10: Dedup guard — marker already present → no-op', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-verify-dedup-');
    writeFixtureSpec(tmpDir, 'dedup-feature', ['- AC-1: check something']);
    writeFixtureConfig(tmpDir, { build: 'make build', test: 'make test' });
  });

  afterEach(() => rmrf(tmpDir));

  test('main() returns null when injection marker already in prompt', () => {
    const prompt = `/df:verify — dedup-feature AC-1\n\n${INJECTION_MARKER}`;
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.equal(result, null, 'main() must return null when dedup marker is already present');
  });

  test('spawn: stdout empty when dedup marker present', () => {
    const prompt = `/df:verify — dedup-feature AC-1\n\n${INJECTION_MARKER}`;
    const { stdout, status } = runHook({
      tool_name: 'Agent',
      tool_input: { prompt },
      cwd: tmpDir,
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'stdout must be empty when marker already present');
  });
});

// ---------------------------------------------------------------------------
// 5. Zero or multiple doing-*.md → fail-open, empty output (AC-6)
// ---------------------------------------------------------------------------

describe('AC-6: Zero or multiple doing-*.md → fail-open', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-verify-specs-');
  });

  afterEach(() => rmrf(tmpDir));

  test('zero doing-*.md files → main() returns null', () => {
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    // No doing-*.md written
    const prompt = '/df:verify something AC-1';
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.equal(result, null, 'main() must return null when no doing-*.md exists');
  });

  test('zero doing-*.md → spawn stdout empty', () => {
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const { stdout, status } = runHook({
      tool_name: 'Agent',
      tool_input: { prompt: '/df:verify AC-1' },
      cwd: tmpDir,
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });

  test('multiple doing-*.md files → main() returns null (ambiguous spec)', () => {
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'doing-alpha.md'), '# alpha\n## Acceptance Criteria\n- AC-1: foo\n');
    fs.writeFileSync(path.join(specsDir, 'doing-beta.md'), '# beta\n## Acceptance Criteria\n- AC-1: bar\n');
    const prompt = '/df:verify AC-1';
    const result = main({ tool_name: 'Agent', tool_input: { prompt }, cwd: tmpDir });
    assert.equal(result, null, 'main() must return null when multiple doing-*.md files exist');
  });

  test('multiple doing-*.md → spawn stdout empty', () => {
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'doing-alpha.md'), '# alpha\n## Acceptance Criteria\n- AC-1: foo\n');
    fs.writeFileSync(path.join(specsDir, 'doing-beta.md'), '# beta\n## Acceptance Criteria\n- AC-1: bar\n');
    const { stdout, status } = runHook({
      tool_name: 'Agent',
      tool_input: { prompt: '/df:verify AC-1' },
      cwd: tmpDir,
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '');
  });

  test('findActiveSpec returns null when specs dir does not exist', () => {
    // No specs/ dir at all
    const result = findActiveSpec(tmpDir);
    assert.equal(result, null, 'findActiveSpec must return null when specs/ does not exist');
  });
});

// ---------------------------------------------------------------------------
// 6. parseAcceptanceCriteria — unit-level sanity
// ---------------------------------------------------------------------------

describe('parseAcceptanceCriteria unit tests', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('df-verify-ac-parse-');
  });

  afterEach(() => rmrf(tmpDir));

  test('extracts bullet AC lines from spec', () => {
    const specPath = writeFixtureSpec(tmpDir, 'parse-test', [
      '- AC-1: first criterion',
      '- AC-2: second criterion',
    ]);
    const { acs, slug } = parseAcceptanceCriteria(specPath);
    assert.ok(acs.some((l) => l.includes('AC-1')), 'AC-1 should be extracted');
    assert.ok(acs.some((l) => l.includes('AC-2')), 'AC-2 should be extracted');
    assert.equal(slug, 'parse-test');
  });

  test('returns empty acs array for non-existent file', () => {
    const { acs } = parseAcceptanceCriteria('/does/not/exist.md');
    assert.deepEqual(acs, []);
  });

  test('returns empty acs when spec has no Acceptance Criteria section', () => {
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const specPath = path.join(specsDir, 'doing-no-ac.md');
    fs.writeFileSync(specPath, '# no-ac\n\nJust a description, no ACs.\n');
    const { acs } = parseAcceptanceCriteria(specPath);
    assert.deepEqual(acs, []);
  });
});

// ---------------------------------------------------------------------------
// 7. buildInjectionBlock — unit-level sanity
// ---------------------------------------------------------------------------

describe('buildInjectionBlock unit tests', () => {
  test('contains INJECTION_MARKER', () => {
    const block = buildInjectionBlock({ slug: 'test', acs: ['- AC-1: foo'], build: null, test: null });
    assert.ok(block.includes(INJECTION_MARKER));
  });

  test('includes build and test commands when provided', () => {
    const block = buildInjectionBlock({
      slug: 'test',
      acs: ['- AC-1: foo'],
      build: 'npm run build',
      test: 'npm test',
    });
    assert.ok(block.includes('npm run build'));
    assert.ok(block.includes('npm test'));
  });

  test('omits Project commands section when build and test are both null', () => {
    const block = buildInjectionBlock({ slug: 'test', acs: ['- AC-1: foo'], build: null, test: null });
    assert.ok(!block.includes('Project commands:'));
  });
});
