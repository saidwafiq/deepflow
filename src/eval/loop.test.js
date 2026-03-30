'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  compareMetric,
  formatSecondaries,
  extractSkillName,
  createEvalWorktree,
  removeEvalWorktree,
  runGuardCheck,
} = require('./loop.js');

// --- Helper: create a temporary git repo with initial commit ---

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  execSync('git add -A && git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupRepo(dir) {
  // Remove any worktrees first to avoid git lock issues
  try {
    execSync('git worktree prune', { cwd: dir, stdio: 'pipe' });
  } catch (_) { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- compareMetric ---

describe('compareMetric', () => {
  describe('higher-is-better metrics (e.g. cache_ratio)', () => {
    it('reports improved when current > baseline', () => {
      const result = compareMetric('cache_ratio', 50, 75);
      assert.strictEqual(result.improved, true);
      assert.strictEqual(result.delta, 50); // (75-50)/50 * 100 = 50%
    });

    it('reports not improved when current < baseline', () => {
      const result = compareMetric('cache_ratio', 80, 60);
      assert.strictEqual(result.improved, false);
      assert.strictEqual(result.delta, -25); // (60-80)/80 * 100 = -25%
    });

    it('reports not improved when values are equal', () => {
      const result = compareMetric('cache_ratio', 50, 50);
      assert.strictEqual(result.improved, false);
      assert.strictEqual(result.delta, 0);
    });
  });

  describe('lower-is-better metrics (total_tokens, wall_time, context_burn)', () => {
    it('reports improved when current < baseline for total_tokens', () => {
      const result = compareMetric('total_tokens', 1000, 800);
      assert.strictEqual(result.improved, true);
      assert.strictEqual(result.delta, -20); // (800-1000)/1000 * 100 = -20%
    });

    it('reports improved when current < baseline for wall_time', () => {
      const result = compareMetric('wall_time', 60, 45);
      assert.strictEqual(result.improved, true);
      assert.strictEqual(result.delta, -25);
    });

    it('reports improved when current < baseline for context_burn', () => {
      const result = compareMetric('context_burn', 200, 150);
      assert.strictEqual(result.improved, true);
      assert.strictEqual(result.delta, -25);
    });

    it('reports not improved when current > baseline for total_tokens', () => {
      const result = compareMetric('total_tokens', 1000, 1200);
      assert.strictEqual(result.improved, false);
      assert.strictEqual(result.delta, 20);
    });

    it('reports not improved when values are equal for lower-is-better', () => {
      const result = compareMetric('total_tokens', 500, 500);
      assert.strictEqual(result.improved, false);
      assert.strictEqual(result.delta, 0);
    });
  });

  describe('zero baseline edge cases', () => {
    it('returns delta=0 when both baseline and current are zero', () => {
      const result = compareMetric('cache_ratio', 0, 0);
      assert.strictEqual(result.delta, 0);
      assert.strictEqual(result.improved, false);
    });

    it('returns delta=100 when baseline is zero and current is nonzero (higher-is-better)', () => {
      const result = compareMetric('cache_ratio', 0, 50);
      assert.strictEqual(result.delta, 100);
      assert.strictEqual(result.improved, true);
    });

    it('returns delta=100 when baseline is zero and current is nonzero (lower-is-better)', () => {
      const result = compareMetric('total_tokens', 0, 50);
      assert.strictEqual(result.delta, 100);
      // For lower-is-better, current(50) > baseline(0) => not improved
      assert.strictEqual(result.improved, false);
    });
  });

  describe('delta rounding', () => {
    it('rounds delta to two decimal places', () => {
      // (7 - 3) / 3 * 100 = 133.33333...
      const result = compareMetric('cache_ratio', 3, 7);
      assert.strictEqual(result.delta, 133.33);
    });
  });
});

// --- formatSecondaries ---

describe('formatSecondaries', () => {
  it('formats secondary metric names and values', () => {
    const metrics = { cache_ratio: 0.85, total_tokens: 1200, wall_time: 45 };
    const result = formatSecondaries(metrics, 'cache_ratio', ['total_tokens', 'wall_time']);
    assert.strictEqual(result, 'total_tokens=1200 wall_time=45');
  });

  it('excludes the target metric from secondaries', () => {
    const metrics = { cache_ratio: 0.85, total_tokens: 1200 };
    const result = formatSecondaries(metrics, 'cache_ratio', ['cache_ratio', 'total_tokens']);
    assert.strictEqual(result, 'total_tokens=1200');
  });

  it('returns empty string when secondaryMetrics is empty', () => {
    const metrics = { cache_ratio: 0.85 };
    const result = formatSecondaries(metrics, 'cache_ratio', []);
    assert.strictEqual(result, '');
  });

  it('returns empty string when secondaryMetrics is null/undefined', () => {
    const metrics = { cache_ratio: 0.85 };
    assert.strictEqual(formatSecondaries(metrics, 'cache_ratio', null), '');
    assert.strictEqual(formatSecondaries(metrics, 'cache_ratio', undefined), '');
  });

  it('skips metrics not present in metrics object', () => {
    const metrics = { cache_ratio: 0.85 };
    const result = formatSecondaries(metrics, 'cache_ratio', ['total_tokens', 'wall_time']);
    assert.strictEqual(result, '');
  });

  it('includes only metrics present in the metrics object', () => {
    const metrics = { cache_ratio: 0.85, total_tokens: 1200 };
    const result = formatSecondaries(metrics, 'cache_ratio', ['total_tokens', 'missing_metric']);
    assert.strictEqual(result, 'total_tokens=1200');
  });
});

// --- extractSkillName ---

describe('extractSkillName', () => {
  it('extracts skill name from path containing SKILL.md', () => {
    assert.strictEqual(extractSkillName('skills/atomic-commits/SKILL.md'), 'atomic-commits');
  });

  it('falls back to filename without extension', () => {
    assert.strictEqual(extractSkillName('some/path/my-skill.md'), 'my-skill');
  });

  it('handles Windows-style backslashes', () => {
    assert.strictEqual(extractSkillName('skills\\browse-fetch\\SKILL.md'), 'browse-fetch');
  });
});

// --- createEvalWorktree / removeEvalWorktree ---

describe('createEvalWorktree', () => {
  let repoDir;

  before(() => {
    repoDir = createTempRepo();
  });

  after(() => {
    cleanupRepo(repoDir);
  });

  it('creates a worktree directory and returns branch and path', () => {
    const { branch, worktreePath } = createEvalWorktree(repoDir, 'test-skill');

    assert.ok(branch.startsWith('eval/test-skill/'), `branch should start with eval/test-skill/, got: ${branch}`);
    assert.ok(fs.existsSync(worktreePath), 'worktree directory should exist');

    // Verify it is a valid git worktree (has .git file)
    const gitFile = path.join(worktreePath, '.git');
    assert.ok(fs.existsSync(gitFile), 'worktree should have .git file/dir');

    // Verify the README from initial commit is present
    const readme = path.join(worktreePath, 'README.md');
    assert.ok(fs.existsSync(readme), 'worktree should contain files from HEAD');

    // Cleanup worktree
    removeEvalWorktree(repoDir, worktreePath);
  });
});

describe('removeEvalWorktree', () => {
  let repoDir;

  before(() => {
    repoDir = createTempRepo();
  });

  after(() => {
    cleanupRepo(repoDir);
  });

  it('removes an existing worktree', () => {
    const { worktreePath } = createEvalWorktree(repoDir, 'remove-test');

    assert.ok(fs.existsSync(worktreePath), 'worktree should exist before removal');

    removeEvalWorktree(repoDir, worktreePath);

    assert.ok(!fs.existsSync(worktreePath), 'worktree directory should be removed');
  });

  it('does not throw when removing a non-existent worktree', () => {
    const fakePath = path.join(os.tmpdir(), 'nonexistent-worktree-12345');
    assert.doesNotThrow(() => {
      removeEvalWorktree(repoDir, fakePath);
    });
  });
});

// --- Security: execFileSync usage (shell injection prevention) ---

describe('security: execFileSync prevents shell injection in worktree functions', () => {
  // Verify that the source code uses execFileSync (not execSync) for git worktree commands.
  // This is the core behavioral guarantee of the security-hardening-wave2 T2 change.

  const loopSrc = fs.readFileSync(path.join(__dirname, 'loop.js'), 'utf8');

  it('createEvalWorktree uses execFileSync, not execSync, for git worktree add', () => {
    // Extract the createEvalWorktree function body
    const fnMatch = loopSrc.match(/function createEvalWorktree\b[\s\S]*?^}/m);
    assert.ok(fnMatch, 'should find createEvalWorktree function in source');
    const fnBody = fnMatch[0];

    assert.ok(
      fnBody.includes('execFileSync'),
      'createEvalWorktree should use execFileSync'
    );
    assert.ok(
      !fnBody.includes('execSync('),
      'createEvalWorktree should NOT use execSync (shell-based)'
    );
  });

  it('removeEvalWorktree uses execFileSync, not execSync, for git worktree remove', () => {
    const fnMatch = loopSrc.match(/function removeEvalWorktree\b[\s\S]*?^}/m);
    assert.ok(fnMatch, 'should find removeEvalWorktree function in source');
    const fnBody = fnMatch[0];

    assert.ok(
      fnBody.includes('execFileSync'),
      'removeEvalWorktree should use execFileSync'
    );
    assert.ok(
      !fnBody.includes('execSync('),
      'removeEvalWorktree should NOT use execSync (shell-based)'
    );
  });

  it('execFileSync is called with array arguments (not string interpolation)', () => {
    // Verify the pattern: execFileSync('git', [...], ...)
    // The array form prevents shell metacharacter interpretation
    const arrayCallPattern = /execFileSync\(\s*'git'\s*,\s*\[/g;
    const matches = loopSrc.match(arrayCallPattern);
    assert.ok(matches, 'should find execFileSync calls with array args');
    assert.ok(matches.length >= 2, `expected at least 2 execFileSync array calls, found ${matches.length}`);
  });
});

describe('createEvalWorktree: shell metacharacters in skill name are safe', () => {
  let repoDir;

  before(() => {
    repoDir = createTempRepo();
  });

  after(() => {
    cleanupRepo(repoDir);
  });

  it('skill names with semicolons cause git error, not shell injection', () => {
    // With execSync, 'skill;touch /tmp/pwned' would execute the touch command.
    // With execFileSync, it is passed as a literal arg to git, which rejects
    // the invalid branch name. The key: no side-effect file is created.
    const markerFile = path.join(os.tmpdir(), `injection-marker-${Date.now()}`);
    const maliciousName = `skill;touch ${markerFile}`;

    assert.throws(
      () => createEvalWorktree(repoDir, maliciousName),
      /Command failed/,
      'git should reject the invalid branch name'
    );

    // Crucially: the touch command was NOT executed by a shell
    assert.ok(
      !fs.existsSync(markerFile),
      'shell injection side-effect should not exist — execFileSync does not interpret semicolons'
    );
  });

  it('skill names with $() cause git error, not command substitution', () => {
    const markerFile = path.join(os.tmpdir(), `injection-marker-subst-${Date.now()}`);
    const maliciousName = `skill$(touch ${markerFile})`;

    assert.throws(
      () => createEvalWorktree(repoDir, maliciousName),
      /Command failed/,
      'git should reject the invalid branch name'
    );

    assert.ok(
      !fs.existsSync(markerFile),
      'command substitution should not execute — execFileSync does not expand $()'
    );
  });

  it('skill names with backticks cause git error, not command substitution', () => {
    const markerFile = path.join(os.tmpdir(), `injection-marker-bt-${Date.now()}`);
    const maliciousName = 'skill`touch ' + markerFile + '`';

    assert.throws(
      () => createEvalWorktree(repoDir, maliciousName),
      /Command failed/,
      'git should reject the invalid branch name'
    );

    assert.ok(
      !fs.existsSync(markerFile),
      'backtick command substitution should not execute'
    );
  });

  it('valid skill names with hyphens and dots work correctly', () => {
    // Ensure the function still works with normal skill names after the change
    const { branch, worktreePath } = createEvalWorktree(repoDir, 'my-skill.v2');

    assert.ok(branch.startsWith('eval/my-skill.v2/'));
    assert.ok(fs.existsSync(worktreePath));

    removeEvalWorktree(repoDir, worktreePath);
  });
});

describe('removeEvalWorktree: shell metacharacters in path are safe', () => {
  let repoDir;

  before(() => {
    repoDir = createTempRepo();
  });

  after(() => {
    cleanupRepo(repoDir);
  });

  it('does not throw for path with shell metacharacters when worktree missing', () => {
    // With execSync, this path could cause shell injection.
    // With execFileSync, it is safely passed as a literal argument.
    const fakePath = path.join(os.tmpdir(), 'fake;rm -rf /');
    assert.doesNotThrow(() => {
      removeEvalWorktree(repoDir, fakePath);
    });
  });

  it('path with $() does not trigger command substitution', () => {
    const markerFile = path.join(os.tmpdir(), `remove-injection-${Date.now()}`);
    const fakePath = `$(touch ${markerFile})`;

    assert.doesNotThrow(() => {
      removeEvalWorktree(repoDir, fakePath);
    });

    assert.ok(
      !fs.existsSync(markerFile),
      'command substitution in path should not execute'
    );
  });
});

// --- runGuardCheck ---

describe('runGuardCheck', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when build and test commands succeed', () => {
    const result = runGuardCheck(tempDir, {
      build_command: 'echo "build ok"',
      test_command: 'echo "test ok"',
    });
    assert.strictEqual(result.passed, true);
    assert.ok(result.output.includes('test ok'));
  });

  it('fails when build command fails', () => {
    const result = runGuardCheck(tempDir, {
      build_command: 'exit 1',
      test_command: 'echo "test ok"',
    });
    assert.strictEqual(result.passed, false);
  });

  it('fails when test command fails', () => {
    const result = runGuardCheck(tempDir, {
      build_command: 'echo "build ok"',
      test_command: 'exit 1',
    });
    assert.strictEqual(result.passed, false);
  });

  it('passes with no guard commands configured', () => {
    const result = runGuardCheck(tempDir, {});
    assert.strictEqual(result.passed, true);
    assert.ok(result.output.includes('no guard commands configured'));
  });

  it('passes with only build_command configured', () => {
    const result = runGuardCheck(tempDir, {
      build_command: 'echo "build only"',
    });
    assert.strictEqual(result.passed, true);
  });

  it('passes with only test_command configured', () => {
    const result = runGuardCheck(tempDir, {
      test_command: 'echo "test only"',
    });
    assert.strictEqual(result.passed, true);
  });

  it('returns error output on failure', () => {
    const result = runGuardCheck(tempDir, {
      test_command: 'echo "some error" >&2 && exit 1',
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.output.includes('some error'));
  });
});
