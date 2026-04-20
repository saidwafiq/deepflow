/**
 * Tests for bin/prompt-compose.js — agent-prompt template resolver.
 *
 * Coverage (AC-1, AC-2, AC-3, AC-4, AC-6, AC-8):
 *   - happy render: all tokens present → stdout contains rendered text, exit 0
 *   - missing-token error: stderr names the token, exit 1
 *   - --help output: documents {{TOKEN}} grammar and "missing = error" rule
 *   - stdin context via "-": JSON piped on fd 0 renders correctly
 *   - standard-task fixture regression: byte-identical round-trip (AC-1, AC-2, AC-6)
 *   - standard-task collapsed: empty optional blocks leave no blank-line residue (AC-2)
 *
 * Uses Node's built-in node:test to avoid dependencies. Because
 * templates/agent-prompts/<name>.md is not yet populated (T9 lands the first
 * real template), the CLI tests install a scratch template into the real
 * templates/agent-prompts/ directory under a test-only name and delete it on
 * teardown. This exercises the resolveTemplatePath() behavior end-to-end.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, 'prompt-compose.js');
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates', 'agent-prompts');
const TEST_TEMPLATE_NAME = '_prompt_compose_test_fixture';
const TEST_TEMPLATE_PATH = path.join(TEMPLATES_DIR, TEST_TEMPLATE_NAME + '.md');

const TEMPLATE_BODY =
  'START\n' +
  '{{TASK_ID}}: {{DESCRIPTION}}\n' +
  '{{OPTIONAL_BLOCK}}END\n';

const { parseArgv, render, HELP_TEXT } = require('./prompt-compose.js');

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input: opts.input,
  });
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions
// ---------------------------------------------------------------------------

describe('parseArgv', () => {
  test('parses --template and --context as space-separated', () => {
    const a = parseArgv(['--template', 'standard-task', '--context', 'ctx.json']);
    assert.equal(a.template, 'standard-task');
    assert.equal(a.context, 'ctx.json');
    assert.equal(a.help, false);
  });

  test('parses --flag=value form', () => {
    const a = parseArgv(['--template=foo', '--context=-']);
    assert.equal(a.template, 'foo');
    assert.equal(a.context, '-');
  });

  test('recognizes -h and --help', () => {
    assert.equal(parseArgv(['-h']).help, true);
    assert.equal(parseArgv(['--help']).help, true);
  });

  test('throws on unknown flag', () => {
    assert.throws(() => parseArgv(['--bogus', 'x']), /unknown flag/);
  });
});

describe('render', () => {
  test('substitutes all present tokens', () => {
    const out = render('{{A}}-{{B}}', { A: 'x', B: 'y' });
    assert.equal(out, 'x-y');
  });

  test('empty-string value renders as empty (conditional-empty idiom)', () => {
    const out = render('pre{{BLOCK}}post', { BLOCK: '' });
    assert.equal(out, 'prepost');
  });

  test('throws on missing token', () => {
    assert.throws(() => render('{{MISSING}}', {}), /missing token: MISSING/);
  });

  test('only matches uppercase snake tokens', () => {
    // Lowercase tokens are passed through untouched.
    const out = render('{{lower}} {{UPPER}}', { UPPER: 'x' });
    assert.equal(out, '{{lower}} x');
  });
});

// ---------------------------------------------------------------------------
// CLI tests — spawn the real script
// ---------------------------------------------------------------------------

describe('cli', () => {
  before(() => {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    fs.writeFileSync(TEST_TEMPLATE_PATH, TEMPLATE_BODY);
  });

  after(() => {
    try { fs.unlinkSync(TEST_TEMPLATE_PATH); } catch (_) { /* already gone */ }
  });

  test('happy render via --context file → stdout + exit 0 (AC-3)', () => {
    const ctxPath = path.join(TEMPLATES_DIR, '_prompt_compose_test_ctx.json');
    fs.writeFileSync(ctxPath, JSON.stringify({
      TASK_ID: 'T1',
      DESCRIPTION: 'hello',
      OPTIONAL_BLOCK: '',
    }));
    try {
      const r = runCli(['--template', TEST_TEMPLATE_NAME, '--context', ctxPath]);
      assert.equal(r.status, 0, 'stderr: ' + r.stderr);
      assert.equal(r.stdout, 'START\nT1: hello\nEND\n');
    } finally {
      fs.unlinkSync(ctxPath);
    }
  });

  test('missing token → exit 1 + stderr names token (AC-4)', () => {
    const ctxPath = path.join(TEMPLATES_DIR, '_prompt_compose_test_ctx.json');
    // DESCRIPTION intentionally omitted.
    fs.writeFileSync(ctxPath, JSON.stringify({ TASK_ID: 'T1', OPTIONAL_BLOCK: '' }));
    try {
      const r = runCli(['--template', TEST_TEMPLATE_NAME, '--context', ctxPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /missing token: DESCRIPTION/);
      assert.equal(r.stdout, '');
    } finally {
      fs.unlinkSync(ctxPath);
    }
  });

  test('--help output documents placeholder grammar (AC-8)', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\{\{TOKEN\}\}/);
    assert.match(r.stdout, /missing = error/);
    // Sanity: module-exported HELP_TEXT is what the CLI prints.
    assert.ok(r.stdout.startsWith(HELP_TEXT));
  });

  test('stdin context via "-"', () => {
    const input = JSON.stringify({
      TASK_ID: 'T9',
      DESCRIPTION: 'from-stdin',
      OPTIONAL_BLOCK: 'MID\n',
    });
    const r = runCli(['--template', TEST_TEMPLATE_NAME, '--context', '-'], { input });
    assert.equal(r.status, 0, 'stderr: ' + r.stderr);
    assert.equal(r.stdout, 'START\nT9: from-stdin\nMID\nEND\n');
  });

  test('missing --template flag → exit 1', () => {
    const r = runCli(['--context', '-'], { input: '{}' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--template is required/);
  });

  test('non-existent template file → exit 1', () => {
    const r = runCli(['--template', '_does_not_exist_xyz', '--context', '-'], { input: '{}' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read template/);
  });

  test('invalid JSON context → exit 1', () => {
    const r = runCli(['--template', TEST_TEMPLATE_NAME, '--context', '-'], {
      input: 'not json',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid JSON context/);
  });
});

// ---------------------------------------------------------------------------
// standard-task fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('standard-task fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'standard-task.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'standard-task.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'standard-task.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });

  test('collapsed optional blocks leave no blank-line residue (AC-2)', () => {
    const ctx = {
      TASK_ID: 'T1',
      DESCRIPTION: 'minimal task',
      FILES: 'src/x.ts',
      SPEC: 'specs/doing-x.md',
      ACS: 'AC-1',
      REVERTED_BLOCK: '',
      SPIKE_BLOCK: '',
      DOMAIN_MODEL_BLOCK: '',
      EXISTING_TYPES_BLOCK: '',
      TASK_BODY: 'steps here',
    };
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'standard-task.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    // No two consecutive newlines between START line and Success criteria line.
    // i.e. collapsed placeholder sites don't leave empty lines between siblings.
    assert.ok(!actual.includes('\n\nSuccess criteria:'),
      'blank line before "Success criteria:" — REVERTED_BLOCK/SPIKE_BLOCK residue');
    assert.ok(!actual.includes('\n\n--- MIDDLE'),
      'blank line before "--- MIDDLE" — DOMAIN_MODEL_BLOCK/EXISTING_TYPES_BLOCK residue');
  });
});

// ---------------------------------------------------------------------------
// integration fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('integration fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'integration.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'integration.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'integration.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });
});

// ---------------------------------------------------------------------------
// bootstrap fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('bootstrap fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'bootstrap.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'bootstrap.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'bootstrap.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });
});

// ---------------------------------------------------------------------------
// wave-test fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('wave-test fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'wave-test.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'wave-test.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'wave-test.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });
});

// ---------------------------------------------------------------------------
// spike fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('spike fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'spike.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'spike.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'spike.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });
});

// ---------------------------------------------------------------------------
// optimize fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('optimize fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'optimize.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'optimize.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'optimize.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });
});

// ---------------------------------------------------------------------------
// optimize-probe fixture regression (AC-1, AC-2, AC-6)
// ---------------------------------------------------------------------------

describe('optimize-probe fixture regression', () => {
  const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-compose');
  const CTX_PATH = path.join(FIXTURES_DIR, 'optimize-probe.context.json');
  const EXPECTED_PATH = path.join(FIXTURES_DIR, 'optimize-probe.expected.txt');

  test('byte-identical round-trip against committed fixture (AC-1, AC-6)', () => {
    const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));
    const templatePath = path.join(REPO_ROOT, 'templates', 'agent-prompts', 'optimize-probe.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
    const { render: renderFn } = require('./prompt-compose.js');
    const actual = renderFn(template, ctx);
    assert.strictEqual(actual, expected);
  });
});
