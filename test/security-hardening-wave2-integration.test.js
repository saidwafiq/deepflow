'use strict';

/**
 * Integration tests for Security Hardening Wave 2
 *
 * Verifies each acceptance criterion from the spec through public interfaces
 * and file-level grep assertions (black-box approach).
 *
 * Uses node:test framework following existing project conventions.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// AC-1: grep -rn 'execSync' src/eval/loop.js src/eval/git-memory.js returns zero matches
// ---------------------------------------------------------------------------

describe('AC-1: No execSync in loop.js or git-memory.js', () => {
  const filesToCheck = ['src/eval/loop.js', 'src/eval/git-memory.js'];

  for (const file of filesToCheck) {
    test(`${file} contains zero occurrences of bare execSync`, () => {
      const content = readFile(file);
      const lines = content.split('\n');
      const offending = lines.filter((line) => {
        // Skip comments
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
        // Match execSync but NOT execFileSync
        return /\bexecSync\b/.test(line) && !/\bexecFileSync\b/.test(line);
      });
      assert.equal(
        offending.length,
        0,
        `${file} must not contain execSync. Found on lines: ${offending.map((l) => l.trim()).join('; ')}`
      );
    });
  }

  test('grep -rn execSync on both files returns zero matches (simulated)', () => {
    // Use execFileSync to run grep and expect exit code 1 (no matches)
    let matchCount = 0;
    for (const file of filesToCheck) {
      try {
        execFileSync('grep', ['-cn', 'execSync', path.join(ROOT, file)], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
        // grep found matches — count them, but we also need to exclude execFileSync
        const content = readFile(file);
        const bareExecSync = (content.match(/\bexecSync\b/g) || []).length;
        const execFileOccurrences = (content.match(/\bexecFileSync\b/g) || []).length;
        // All occurrences of "execSync" should be part of "execFileSync"
        matchCount += bareExecSync - execFileOccurrences;
      } catch (err) {
        // grep returns exit code 1 when no match — that is the expected outcome
        if (err.status === 1) continue;
        throw err;
      }
    }
    assert.equal(matchCount, 0, 'No bare execSync should exist in loop.js or git-memory.js');
  });
});

// ---------------------------------------------------------------------------
// AC-2: grep -c 'execFileSync|spawnSync' src/eval/loop.js >= 2
// ---------------------------------------------------------------------------

describe('AC-2: loop.js has >= 2 execFileSync/spawnSync calls (worktree add + remove)', () => {
  test('loop.js contains at least 2 occurrences of execFileSync or spawnSync', () => {
    const content = readFile('src/eval/loop.js');
    const matches = content.match(/\b(execFileSync|spawnSync)\b/g) || [];
    assert.ok(
      matches.length >= 2,
      `Expected >= 2 execFileSync/spawnSync occurrences in loop.js, found ${matches.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: grep -c 'execFileSync|spawnSync' src/eval/git-memory.js >= 5
// ---------------------------------------------------------------------------

describe('AC-3: git-memory.js has >= 5 execFileSync/spawnSync calls', () => {
  test('git-memory.js contains at least 5 occurrences of execFileSync or spawnSync', () => {
    const content = readFile('src/eval/git-memory.js');
    const matches = content.match(/\b(execFileSync|spawnSync)\b/g) || [];
    assert.ok(
      matches.length >= 5,
      `Expected >= 5 execFileSync/spawnSync occurrences in git-memory.js, found ${matches.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: execute.md OPTIMIZE init reads metric_command from config.yaml, not PLAN.md
// ---------------------------------------------------------------------------

describe('AC-4: execute.md reads metric_command from config.yaml', () => {
  test('grep "metric_command.*config" matches in execute.md', () => {
    const content = readFile('src/commands/df/execute.md');
    assert.ok(
      /metric_command.*config/i.test(content),
      'execute.md must reference metric_command in relation to config'
    );
  });

  test('OPTIMIZE section reads from config.yaml, not PLAN.md for metric_command', () => {
    const content = readFile('src/commands/df/execute.md');
    assert.ok(
      content.includes('config.yaml'),
      'execute.md must reference config.yaml for metric_command resolution'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5: execute.md contains error/refusal when config.yaml lacks metric_command
// ---------------------------------------------------------------------------

describe('AC-5: execute.md has error/refusal for missing metric_command', () => {
  test('execute.md contains an error message for missing metric_command', () => {
    const content = readFile('src/commands/df/execute.md');
    // Should contain some form of error/refusal message about metric_command
    const hasError = /ERROR.*metric_command/i.test(content) ||
                     /metric_command.*not\s+(defined|found|configured)/i.test(content) ||
                     /refuse.*metric_command/i.test(content) ||
                     /missing.*metric_command/i.test(content);
    assert.ok(
      hasError,
      'execute.md must contain an error/refusal message when metric_command is missing from config.yaml'
    );
  });

  test('error message references config.yaml as fix location', () => {
    const content = readFile('src/commands/df/execute.md');
    assert.ok(
      content.includes('config.yaml'),
      'Error message must reference config.yaml'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-6: invariant hook has a config.yaml guard check function
// ---------------------------------------------------------------------------

describe('AC-6: invariant hook has config.yaml guard check', () => {
  test('grep matches config.yaml or CONFIG_GUARD or config_guard in hook source', () => {
    const content = readFile('hooks/df-invariant-check.js');
    const hasConfigGuard = /config\.yaml|CONFIG.GUARD|config_guard/i.test(content);
    assert.ok(
      hasConfigGuard,
      'hooks/df-invariant-check.js must contain a config.yaml guard check function'
    );
  });

  test('checkConfigYamlGuard is exported from the invariant hook', () => {
    const hook = require(path.join(ROOT, 'hooks', 'df-invariant-check.js'));
    assert.ok(
      typeof hook.checkConfigYamlGuard === 'function',
      'checkConfigYamlGuard must be exported as a function'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7: Invariant hook test covers config.yaml creation and modification
//        in worktree context (behavioral test through checkConfigYamlGuard)
// ---------------------------------------------------------------------------

describe('AC-7: checkConfigYamlGuard covers config.yaml in worktree context', () => {
  const { checkConfigYamlGuard } = require(path.join(ROOT, 'hooks', 'df-invariant-check.js'));

  function makeFiles(...paths) {
    return paths.map((p) => ({ file: p, chunks: [] }));
  }

  test('detects config.yaml creation in .deepflow/', () => {
    const files = makeFiles('.deepflow/config.yaml');
    const violations = checkConfigYamlGuard(files, '', 'implementation');
    assert.ok(violations.length >= 1, 'Should detect config.yaml creation/modification');
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
  });

  test('detects config.yaml modification in a worktree sub-path', () => {
    const worktreePath = '.claude/worktrees/agent-abc123/.deepflow/config.yaml';
    const files = makeFiles(worktreePath);
    const violations = checkConfigYamlGuard(files, '', 'implementation');
    assert.ok(violations.length >= 1, 'Should detect config.yaml in worktree path');
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
    assert.equal(violations[0].file, worktreePath);
  });

  test('detects config.yml variant in worktree context', () => {
    const files = makeFiles('.claude/worktrees/agent-xyz/.deepflow/config.yml');
    const violations = checkConfigYamlGuard(files, '', 'implementation');
    assert.ok(violations.length >= 1, 'Should detect config.yml in worktree path');
    assert.equal(violations[0].tag, 'CONFIG_GUARD');
  });

  test('returns no violations for unrelated files', () => {
    const files = makeFiles(
      'src/index.js',
      'package.json',
      '.deepflow/decisions.md'
    );
    const violations = checkConfigYamlGuard(files, '', 'implementation');
    assert.equal(violations.length, 0);
  });

  test('handles empty file list', () => {
    const violations = checkConfigYamlGuard([], '', 'implementation');
    assert.equal(violations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// AC-8: All existing tests pass (node --test hooks/df-invariant-check.test.js exits 0)
// ---------------------------------------------------------------------------

describe('AC-8: Existing invariant-check tests pass', () => {
  test('node --test hooks/df-invariant-check.test.js exits 0', () => {
    const result = execFileSync(
      process.execPath,
      ['--test', path.join(ROOT, 'hooks', 'df-invariant-check.test.js')],
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    // If we get here, the command exited with code 0
    assert.ok(true, 'hooks/df-invariant-check.test.js passed');
  });
});

// ---------------------------------------------------------------------------
// AC-9: runGuardCheck in loop.js still uses shell execution for build/test commands
// ---------------------------------------------------------------------------

describe('AC-9: runGuardCheck still uses shell execution for build/test commands', () => {
  const {
    runGuardCheck,
  } = require(path.join(ROOT, 'src', 'eval', 'loop.js'));

  test('runGuardCheck executes shell commands successfully (echo)', () => {
    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac9-guard-'));
    try {
      const result = runGuardCheck(tempDir, {
        build_command: 'echo "build-ok"',
        test_command: 'echo "test-ok"',
      });
      assert.equal(result.passed, true, 'Guard check with shell echo commands should pass');
      assert.ok(
        result.output.includes('test-ok'),
        'Shell command output should be captured'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('runGuardCheck supports shell features (pipes, redirects)', () => {
    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac9-shell-'));
    try {
      // Shell features like && and echo with redirect only work with shell execution
      const result = runGuardCheck(tempDir, {
        build_command: 'echo "hello" && echo "world"',
        test_command: 'echo "pass" | cat',
      });
      assert.equal(result.passed, true, 'Guard check with shell pipes/chaining should pass');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('runGuardCheck correctly reports failure from shell commands', () => {
    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac9-fail-'));
    try {
      const result = runGuardCheck(tempDir, {
        build_command: 'exit 1',
        test_command: 'echo "ok"',
      });
      assert.equal(result.passed, false, 'Guard check should fail when build_command fails');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: Behavioral verification of exported interfaces
// ---------------------------------------------------------------------------

describe('Cross-cutting: Exported interfaces are intact', () => {
  test('loop.js exports expected functions', () => {
    const loop = require(path.join(ROOT, 'src', 'eval', 'loop.js'));
    const expectedExports = [
      'runEvalLoop', 'createEvalWorktree', 'removeEvalWorktree',
      'runGuardCheck', 'compareMetric', 'formatSecondaries', 'extractSkillName',
    ];
    for (const name of expectedExports) {
      assert.equal(typeof loop[name], 'function', `loop.js must export ${name} as a function`);
    }
  });

  test('git-memory.js exports expected functions', () => {
    const gm = require(path.join(ROOT, 'src', 'eval', 'git-memory.js'));
    const expectedExports = [
      'commitExperiment', 'revertExperiment', 'queryExperiments',
      'getExperimentHistory', 'formatCommitMessage', 'parseExperimentLine',
    ];
    for (const name of expectedExports) {
      assert.equal(typeof gm[name], 'function', `git-memory.js must export ${name} as a function`);
    }
  });

  test('invariant-check.js exports expected functions', () => {
    const hook = require(path.join(ROOT, 'hooks', 'df-invariant-check.js'));
    const expectedExports = [
      'checkInvariants', 'checkLspAvailability', 'detectLanguageServer',
      'isBinaryAvailable', 'formatOutput', 'formatViolation', 'parseDiff',
      'TAGS', 'checkMockCoveringGap', 'checkReqOnlyInTests', 'checkPhantoms',
      'checkScopeGaps', 'checkConfigYamlGuard',
    ];
    for (const name of expectedExports) {
      assert.ok(
        hook[name] !== undefined,
        `invariant-check.js must export ${name}`
      );
    }
  });
});
