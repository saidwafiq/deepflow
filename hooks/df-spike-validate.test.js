/**
 * Tests for hooks/df-spike-validate.js
 *
 * Validates the PostToolUse hook that enforces REQ-5 frontmatter schema on
 * experiment result files under .deepflow/experiments/*.md.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const {
  isExperimentMd,
  isCarvedOut,
  extractFrontmatter,
  parseSimpleYaml,
  extractFilenameStatus,
  validateSchema,
  VALID_STATUS,
  REQUIRED_KEYS,
} = require('./df-spike-validate');

const HOOK_PATH = path.resolve(__dirname, 'df-spike-validate.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-spike-validate-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the hook as a child process with JSON piped to stdin.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { cwd } = {}) {
  const json = JSON.stringify(input);
  try {
    const stdout = execFileSync(
      process.execPath,
      [HOOK_PATH],
      {
        input: json,
        cwd: cwd || os.tmpdir(),
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? 1,
    };
  }
}

/**
 * Build a minimal valid experiment file content for testing.
 */
function makeValidExperiment({
  hypothesis = 'Testing the foo behavior under load',
  inputs_hash = 'sha256:abc123def456',
  command = 'npm test -- --testPathPattern=foo',
  exit_code = 0,
  status = 'pass',
  assertions = [
    { metric: 'response_time_ms', expected: '<200', observed: '150', pass: true },
  ],
  suggested_patches,
} = {}) {
  let frontmatter = [
    `hypothesis: "${hypothesis}"`,
    `inputs_hash: "${inputs_hash}"`,
    `command: "${command}"`,
    `exit_code: ${exit_code}`,
    `assertions:`,
    ...assertions.map((a) => [
      `  - metric: "${a.metric}"`,
      `    expected: "${a.expected}"`,
      `    observed: "${a.observed}"`,
      `    pass: ${a.pass}`,
    ].join('\n')),
    `status: "${status}"`,
  ];

  if (suggested_patches) {
    frontmatter.push('suggested_patches:');
    for (const p of suggested_patches) {
      frontmatter.push(`  - target: "${p.target}"`);
      frontmatter.push(`    op: "${p.op}"`);
      frontmatter.push(`    value: "${p.value}"`);
    }
  }

  return `---\n${frontmatter.join('\n')}\n---\n\n## Hypothesis\n\nTest content.`;
}

/**
 * Write an experiment file in a tmp experiments dir.
 * Returns the absolute path to the written file.
 */
function writeExperimentFile(tmpDir, filename, content) {
  const experimentsDir = path.join(tmpDir, '.deepflow', 'experiments');
  fs.mkdirSync(experimentsDir, { recursive: true });
  const filePath = path.join(experimentsDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Unit tests: isExperimentMd
// ---------------------------------------------------------------------------

describe('isExperimentMd', () => {
  test('matches .deepflow/experiments/<name>.md', () => {
    assert.ok(isExperimentMd('.deepflow/experiments/topic--hyp--pass.md'));
    assert.ok(isExperimentMd('/abs/path/.deepflow/experiments/foo.md'));
  });

  test('does not match non-experiment paths', () => {
    assert.ok(!isExperimentMd('some/other/path.md'));
    assert.ok(!isExperimentMd('.deepflow/results/foo.md'));
    assert.ok(!isExperimentMd('.deepflow/experiments/foo.txt'));
  });

  test('matches nested absolute paths', () => {
    assert.ok(isExperimentMd('/Users/dev/project/.deepflow/experiments/test--hyp--fail.md'));
  });
});

// ---------------------------------------------------------------------------
// Unit tests: isCarvedOut
// ---------------------------------------------------------------------------

describe('isCarvedOut', () => {
  test('exempts *--active.md files', () => {
    assert.ok(isCarvedOut('.deepflow/experiments/topic--hyp--active.md'));
    assert.ok(isCarvedOut('/abs/.deepflow/experiments/foo--active.md'));
  });

  test('does not exempt regular result files', () => {
    assert.ok(!isCarvedOut('.deepflow/experiments/topic--hyp--pass.md'));
    assert.ok(!isCarvedOut('.deepflow/experiments/topic--hyp--fail.md'));
  });
});

// ---------------------------------------------------------------------------
// Unit tests: extractFrontmatter
// ---------------------------------------------------------------------------

describe('extractFrontmatter', () => {
  test('extracts content between first --- delimiters', () => {
    const content = '---\nkey: value\n---\n\nBody text.';
    assert.equal(extractFrontmatter(content), 'key: value');
  });

  test('returns null when no frontmatter block', () => {
    assert.equal(extractFrontmatter('# Just a heading\n\nNo frontmatter.'), null);
    assert.equal(extractFrontmatter(''), null);
  });

  test('handles multi-line frontmatter', () => {
    const content = '---\na: 1\nb: 2\n---\n\nBody.';
    const fm = extractFrontmatter(content);
    assert.ok(fm.includes('a: 1'));
    assert.ok(fm.includes('b: 2'));
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseSimpleYaml
// ---------------------------------------------------------------------------

describe('parseSimpleYaml', () => {
  test('parses simple scalar keys', () => {
    const fm = parseSimpleYaml('hypothesis: "foo bar"\nexit_code: 0\nstatus: pass');
    assert.equal(fm.hypothesis, 'foo bar');
    assert.equal(fm.exit_code, 0);
    assert.equal(fm.status, 'pass');
  });

  test('parses block sequences with mapping items', () => {
    const yaml = [
      'assertions:',
      '  - metric: "p99"',
      '    expected: "<200"',
      '    observed: "150"',
      '    pass: true',
    ].join('\n');
    const fm = parseSimpleYaml(yaml);
    assert.ok(Array.isArray(fm.assertions));
    assert.equal(fm.assertions.length, 1);
    assert.equal(fm.assertions[0].metric, 'p99');
    assert.equal(fm.assertions[0].pass, true);
  });

  test('parses multiple assertion items', () => {
    const yaml = [
      'assertions:',
      '  - metric: "latency"',
      '    expected: "<100"',
      '    observed: "80"',
      '    pass: true',
      '  - metric: "throughput"',
      '    expected: ">1000"',
      '    observed: "1200"',
      '    pass: true',
    ].join('\n');
    const fm = parseSimpleYaml(yaml);
    assert.equal(fm.assertions.length, 2);
    assert.equal(fm.assertions[1].metric, 'throughput');
  });

  test('parses suggested_patches with block sequence', () => {
    const yaml = [
      'suggested_patches:',
      '  - target: "src/foo.js"',
      '    op: "replace"',
      '    value: "new content"',
    ].join('\n');
    const fm = parseSimpleYaml(yaml);
    assert.ok(Array.isArray(fm.suggested_patches));
    assert.equal(fm.suggested_patches[0].target, 'src/foo.js');
    assert.equal(fm.suggested_patches[0].op, 'replace');
  });

  test('coerces integers correctly', () => {
    const fm = parseSimpleYaml('exit_code: 1');
    assert.equal(fm.exit_code, 1);
    assert.equal(typeof fm.exit_code, 'number');
  });

  test('skips comment lines', () => {
    const yaml = '# a comment\nhypothesis: "test"\n# another comment';
    const fm = parseSimpleYaml(yaml);
    assert.equal(fm.hypothesis, 'test');
    assert.ok(!('# a comment' in fm));
  });
});

// ---------------------------------------------------------------------------
// Unit tests: extractFilenameStatus
// ---------------------------------------------------------------------------

describe('extractFilenameStatus', () => {
  test('extracts last segment after double-dash', () => {
    assert.equal(extractFilenameStatus('topic--hyp-slug--pass.md'), 'pass');
    assert.equal(extractFilenameStatus('topic--hyp--fail.md'), 'fail');
    assert.equal(extractFilenameStatus('/abs/.deepflow/experiments/foo--bar--inconclusive.md'), 'inconclusive');
  });

  test('returns null for filenames without double-dash', () => {
    assert.equal(extractFilenameStatus('simple.md'), null);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: validateSchema — passing cases
// ---------------------------------------------------------------------------

describe('validateSchema — valid inputs', () => {
  test('passes with all required keys and valid values', () => {
    const fm = {
      hypothesis: 'Test hypothesis',
      inputs_hash: 'sha256:abc123',
      command: 'npm test',
      exit_code: 0,
      assertions: [{ metric: 'm', expected: 'e', observed: 'o', pass: true }],
      status: 'pass',
    };
    // Should not throw or call process.exit
    assert.doesNotThrow(() => validateSchema(fm, 'topic--hyp--pass.md'));
  });

  test('passes with status: fail', () => {
    const fm = {
      hypothesis: 'Test failure',
      inputs_hash: 'sha256:xyz',
      command: 'node run.js',
      exit_code: 1,
      assertions: [{ metric: 'x', expected: 'y', observed: 'z', pass: false }],
      status: 'fail',
    };
    assert.doesNotThrow(() => validateSchema(fm, 'topic--hyp--fail.md'));
  });

  test('passes with status: inconclusive', () => {
    const fm = {
      hypothesis: 'Inconclusive test',
      inputs_hash: 'sha256:def',
      command: 'bash run.sh',
      exit_code: 0,
      assertions: [{ metric: 'a', expected: 'b', observed: 'c', pass: true }],
      status: 'inconclusive',
    };
    assert.doesNotThrow(() => validateSchema(fm, 'topic--hyp--inconclusive.md'));
  });

  test('passes with valid suggested_patches array', () => {
    const fm = {
      hypothesis: 'Test with patches',
      inputs_hash: 'sha256:abc',
      command: 'npm test',
      exit_code: 0,
      assertions: [{ metric: 'm', expected: 'e', observed: 'o', pass: true }],
      status: 'pass',
      suggested_patches: [
        { target: 'src/foo.js', op: 'replace', value: 'new content' },
      ],
    };
    assert.doesNotThrow(() => validateSchema(fm, 'topic--hyp--pass.md'));
  });

  test('passes with empty assertions array (no violations for empty)', () => {
    const fm = {
      hypothesis: 'Minimal test',
      inputs_hash: 'sha256:abc',
      command: 'echo ok',
      exit_code: 0,
      assertions: [],
      status: 'pass',
    };
    assert.doesNotThrow(() => validateSchema(fm, 'topic--hyp--pass.md'));
  });

  test('passes when filename has no double-dash (no cross-check)', () => {
    const fm = {
      hypothesis: 'Test',
      inputs_hash: 'sha256:abc',
      command: 'echo',
      exit_code: 0,
      assertions: [],
      status: 'pass',
    };
    assert.doesNotThrow(() => validateSchema(fm, 'simple.md'));
  });
});

// ---------------------------------------------------------------------------
// Integration tests: hook as child process — pass-through cases
// ---------------------------------------------------------------------------

describe('hook — pass-through (exit 0)', () => {
  let tmpDir;

  test('passes through non-Write/Edit tool events', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: '/some/path.md' } });
    assert.equal(result.code, 0);
  });

  test('passes through Write to non-experiment paths', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/project/src/foo.md' },
    });
    assert.equal(result.code, 0);
  });

  test('passes through Write to *--active.md (carve-out)', () => {
    tmpDir = makeTmpDir();
    const filePath = writeExperimentFile(tmpDir, 'topic--hyp--active.md', '# In progress');
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: tmpDir },
      { cwd: tmpDir }
    );
    rmrf(tmpDir);
    assert.equal(result.code, 0);
  });

  test('passes through Write to experiment file without frontmatter', () => {
    tmpDir = makeTmpDir();
    const filePath = writeExperimentFile(tmpDir, 'topic--hyp--pass.md', '# No frontmatter here');
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: tmpDir },
      { cwd: tmpDir }
    );
    rmrf(tmpDir);
    assert.equal(result.code, 0);
  });

  test('passes through when file does not exist yet (new file being written)', () => {
    tmpDir = makeTmpDir();
    const experimentsDir = path.join(tmpDir, '.deepflow', 'experiments');
    fs.mkdirSync(experimentsDir, { recursive: true });
    const filePath = path.join(experimentsDir, 'topic--hyp--pass.md');
    // Do NOT create the file — simulate a new file write
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: tmpDir },
      { cwd: tmpDir }
    );
    rmrf(tmpDir);
    assert.equal(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: hook as child process — schema violation cases (exit 2)
// ---------------------------------------------------------------------------

describe('hook — schema violations (exit 2)', () => {
  let tmpDir;

  function runHookWithExperiment(filename, content) {
    tmpDir = makeTmpDir();
    const filePath = writeExperimentFile(tmpDir, filename, content);
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: tmpDir },
      { cwd: tmpDir }
    );
    rmrf(tmpDir);
    return result;
  }

  test('AC-5: rejects when hypothesis key is missing', () => {
    const content = [
      '---',
      'inputs_hash: "sha256:abc"',
      'command: "npm test"',
      'exit_code: 0',
      'assertions: []',
      'status: "pass"',
      '---',
      '## Body',
    ].join('\n');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.hook, 'df-spike-validate');
    assert.equal(err.error_code, 'missing_required_key');
    assert.equal(err.offending_key, 'hypothesis');
  });

  test('AC-5: rejects when inputs_hash key is missing', () => {
    const content = [
      '---',
      'hypothesis: "Test"',
      'command: "npm test"',
      'exit_code: 0',
      'assertions: []',
      'status: "pass"',
      '---',
    ].join('\n');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.offending_key, 'inputs_hash');
  });

  test('AC-5: rejects when status key is missing', () => {
    const content = [
      '---',
      'hypothesis: "Test"',
      'inputs_hash: "sha256:abc"',
      'command: "npm test"',
      'exit_code: 0',
      'assertions: []',
      '---',
    ].join('\n');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.offending_key, 'status');
  });

  test('AC-5: rejects invalid status value', () => {
    const content = makeValidExperiment({ status: 'archived' });
    // filename says pass, but status is archived (invalid enum)
    const result = runHookWithExperiment('topic--hyp--pass.md', content.replace('status: "pass"', 'status: "archived"'));
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.error_code, 'invalid_status');
    assert.equal(err.offending_key, 'status');
  });

  test('AC-5: rejects filename status mismatch', () => {
    // File content says status: pass, but filename says --fail.md
    const content = makeValidExperiment({ status: 'pass' });
    const result = runHookWithExperiment('topic--hyp--fail.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.error_code, 'status_mismatch');
    assert.equal(err.offending_key, 'status');
  });

  test('AC-5: rejects non-integer exit_code', () => {
    const content = makeValidExperiment({}).replace('exit_code: 0', 'exit_code: "zero"');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.offending_key, 'exit_code');
  });

  test('AC-5: rejects assertions that are not an array', () => {
    const content = [
      '---',
      'hypothesis: "Test"',
      'inputs_hash: "sha256:abc"',
      'command: "npm test"',
      'exit_code: 0',
      'assertions: "not-an-array"',
      'status: "pass"',
      '---',
    ].join('\n');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.offending_key, 'assertions');
  });

  test('AC-5: rejects assertion item missing pass field', () => {
    const content = [
      '---',
      'hypothesis: "Test"',
      'inputs_hash: "sha256:abc"',
      'command: "npm test"',
      'exit_code: 0',
      'assertions:',
      '  - metric: "m"',
      '    expected: "e"',
      '    observed: "o"',
      '    # pass key missing',
      'status: "pass"',
      '---',
    ].join('\n');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.offending_key, 'assertions');
  });

  test('AC-5: rejects suggested_patches item missing target', () => {
    const content = [
      '---',
      'hypothesis: "Test"',
      'inputs_hash: "sha256:abc"',
      'command: "npm test"',
      'exit_code: 0',
      'assertions: []',
      'status: "pass"',
      'suggested_patches:',
      '  - op: "replace"',
      '    value: "new"',
      '---',
    ].join('\n');
    const result = runHookWithExperiment('topic--hyp--pass.md', content);
    assert.equal(result.code, 2);
    const err = JSON.parse(result.stderr.trim());
    assert.equal(err.offending_key, 'suggested_patches');
    assert.equal(err.error_code, 'missing_patch_key');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: hook as child process — valid experiment passes (exit 0)
// ---------------------------------------------------------------------------

describe('hook — valid experiment files pass (exit 0)', () => {
  let tmpDir;

  function runHookWithExperiment(filename, content) {
    tmpDir = makeTmpDir();
    const filePath = writeExperimentFile(tmpDir, filename, content);
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: tmpDir },
      { cwd: tmpDir }
    );
    rmrf(tmpDir);
    return result;
  }

  test('AC-5: accepts fully valid experiment with status: pass', () => {
    const content = makeValidExperiment({ status: 'pass' });
    const result = runHookWithExperiment('topic--hypothesis-slug--pass.md', content);
    assert.equal(result.code, 0);
  });

  test('AC-5: accepts valid experiment with status: fail', () => {
    const content = makeValidExperiment({
      status: 'fail',
      exit_code: 1,
      assertions: [{ metric: 'foo', expected: '>10', observed: '5', pass: false }],
    });
    const result = runHookWithExperiment('topic--hypothesis-slug--fail.md', content);
    assert.equal(result.code, 0);
  });

  test('AC-5: accepts valid experiment with status: inconclusive', () => {
    const content = makeValidExperiment({ status: 'inconclusive' });
    // The makeValidExperiment sets status: pass in frontmatter, override it
    const corrected = content.replace('status: "pass"', 'status: "inconclusive"');
    const result = runHookWithExperiment('topic--hypothesis-slug--inconclusive.md', corrected);
    assert.equal(result.code, 0);
  });

  test('AC-5: accepts valid experiment with suggested_patches', () => {
    const content = makeValidExperiment({
      status: 'pass',
      suggested_patches: [{ target: 'src/foo.js', op: 'replace', value: 'new' }],
    });
    const result = runHookWithExperiment('topic--hypothesis-slug--pass.md', content);
    assert.equal(result.code, 0);
  });

  test('AC-5: accepts Edit tool (not just Write)', () => {
    tmpDir = makeTmpDir();
    const content = makeValidExperiment({ status: 'pass' });
    const filePath = writeExperimentFile(tmpDir, 'topic--hyp--pass.md', content);
    const result = runHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath }, cwd: tmpDir },
      { cwd: tmpDir }
    );
    rmrf(tmpDir);
    assert.equal(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: VALID_STATUS and REQUIRED_KEYS exports
// ---------------------------------------------------------------------------

describe('exports', () => {
  test('VALID_STATUS contains exactly {pass, fail, inconclusive}', () => {
    assert.ok(VALID_STATUS.has('pass'));
    assert.ok(VALID_STATUS.has('fail'));
    assert.ok(VALID_STATUS.has('inconclusive'));
    assert.equal(VALID_STATUS.size, 3);
  });

  test('REQUIRED_KEYS contains all REQ-5 required keys', () => {
    const expected = ['hypothesis', 'inputs_hash', 'command', 'exit_code', 'assertions', 'status'];
    for (const key of expected) {
      assert.ok(REQUIRED_KEYS.includes(key), `Missing required key: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test: real experiment file (spike-gate--inputs-hash-stability--pass.md)
// ---------------------------------------------------------------------------

describe('hook — real experiment file validates cleanly', () => {
  test('AC-5: existing inputs-hash-stability spike result passes validation', () => {
    // The real experiment file in this worktree or main repo
    const candidates = [
      path.resolve(__dirname, '..', '.deepflow', 'experiments', 'spike-gate--inputs-hash-stability--pass.md'),
      path.resolve('/Users/saidsalles/apps/agentSkills/deepflow/.deepflow/experiments/spike-gate--inputs-hash-stability--pass.md'),
    ];
    let realFilePath = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { realFilePath = c; break; }
    }
    if (!realFilePath) {
      // Skip if file not found in either location
      return;
    }

    const content = fs.readFileSync(realFilePath, 'utf8');
    const fmRaw = extractFrontmatter(content);
    assert.ok(fmRaw !== null, 'Real experiment file should have frontmatter');
    const fm = parseSimpleYaml(fmRaw);
    // Should parse without error and pass schema validation
    assert.doesNotThrow(() => validateSchema(fm, realFilePath));
  });
});
