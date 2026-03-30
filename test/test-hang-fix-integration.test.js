const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, 'hooks');
const LIB_DIR = path.join(HOOKS_DIR, 'lib');

// Hooks that should use readStdinIfMain (excludes df-dashboard-push.js which uses sync readFileSync)
const HOOKS_USING_STDIN_HELPER = [
  'df-command-usage.js',
  'df-execution-history.js',
  'df-explore-protocol.js',
  'df-invariant-check.js',
  'df-snapshot-guard.js',
  'df-statusline.js',
  'df-subagent-registry.js',
  'df-tool-usage-spike.js',
  'df-tool-usage.js',
  'df-worktree-guard.js',
];

describe('Test Hang Fix - Integration Tests', () => {

  // AC-1: grep -rn 'process\.stdin\.on' hooks/df-*.js returns zero matches
  describe('AC-1: No bare process.stdin.on in hook files', () => {
    it('should have zero matches for process.stdin.on in hooks/df-*.js (excluding test files)', () => {
      // The spec says: grep -rn 'process\.stdin\.on' hooks/df-*.js returns zero matches
      // We exclude .test.js files since those may reference the pattern in assertions/comments
      let output = '';
      try {
        output = execSync(
          `grep -rn 'process\\.stdin\\.on' hooks/df-*.js | grep -v '\\.test\\.js:'`,
          { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
      } catch (err) {
        // grep exits 1 when no matches — that is the success case
        if (err.status === 1) {
          output = '';
        } else {
          throw err;
        }
      }
      assert.strictEqual(output.trim(), '', 'Expected no process.stdin.on matches in hook implementation files, but found:\n' + output);
    });
  });

  // AC-2: hooks/lib/hook-stdin.js exists and exports readStdinIfMain
  describe('AC-2: hook-stdin.js helper exists and exports readStdinIfMain', () => {
    it('should exist at hooks/lib/hook-stdin.js', () => {
      const helperPath = path.join(LIB_DIR, 'hook-stdin.js');
      assert.ok(fs.existsSync(helperPath), 'hooks/lib/hook-stdin.js does not exist');
    });

    it('should export readStdinIfMain as a function', () => {
      const helperPath = path.join(LIB_DIR, 'hook-stdin.js');
      const mod = require(helperPath);
      assert.ok(typeof mod.readStdinIfMain === 'function',
        `Expected readStdinIfMain to be a function, got ${typeof mod.readStdinIfMain}`);
    });
  });

  // AC-3: node --test hooks/df-invariant-check.test.js completes in <5s
  describe('AC-3: df-invariant-check test completes in <5s', () => {
    it('should finish within 5 seconds without hanging', () => {
      const start = Date.now();
      try {
        execSync('node --test hooks/df-invariant-check.test.js', {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        // If it timed out, err.killed will be true
        if (err.killed) {
          assert.fail('Test hung — killed after 5s timeout');
        }
        // If tests ran but some failed, that's a different concern;
        // the key AC is "completes in <5s" (no hang).
        // We still check the elapsed time.
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `Test took ${elapsed}ms, expected <5000ms`);
    });
  });

  // AC-4: All existing hook tests pass (node --test hooks/*.test.js exits 0)
  describe('AC-4: All hook tests pass', () => {
    it('should exit 0 when running node --test hooks/*.test.js', () => {
      // Use execFileSync with shell to expand the glob
      try {
        execSync('node --test hooks/*.test.js', {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        if (err.killed) {
          assert.fail('Hook tests hung — killed after 30s timeout');
        }
        const output = (err.stdout || '') + '\n' + (err.stderr || '');
        assert.fail('Hook tests failed with exit code ' + err.status + ':\n' + output.slice(-2000));
      }
    });
  });

  // AC-5: node -e "require('./hooks/df-invariant-check.js')" exits immediately (no hang)
  describe('AC-5: Requiring df-invariant-check.js exits immediately', () => {
    it('should exit within 3 seconds when required as a module', () => {
      const start = Date.now();
      try {
        execSync(
          `node -e "require('./hooks/df-invariant-check.js')"`,
          {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
      } catch (err) {
        if (err.killed) {
          assert.fail('Process hung — killed after 3s timeout');
        }
        // Non-zero exit for other reasons is acceptable for this AC;
        // the criterion is "exits immediately (no hang)"
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 3000, `Process took ${elapsed}ms, expected <3000ms (no hang)`);
    });
  });

  // AC-6: Each of the 11 hooks calls readStdinIfMain instead of inline stdin code
  //        (df-dashboard-push.js excluded — uses sync readFileSync)
  describe('AC-6: Each hook uses readStdinIfMain', () => {
    for (const hookFile of HOOKS_USING_STDIN_HELPER) {
      it(`${hookFile} should reference readStdinIfMain`, () => {
        const filePath = path.join(HOOKS_DIR, hookFile);
        if (!fs.existsSync(filePath)) {
          // If the file doesn't exist, it may have been renamed or is not part of the 11.
          // Skip gracefully with a note.
          assert.fail(`${hookFile} does not exist at ${filePath}`);
          return;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(
          content.includes('readStdinIfMain'),
          `${hookFile} does not call readStdinIfMain`
        );
      });
    }

    it('df-dashboard-push.js should NOT use readStdinIfMain (uses readFileSync)', () => {
      const filePath = path.join(HOOKS_DIR, 'df-dashboard-push.js');
      if (!fs.existsSync(filePath)) {
        // File might not exist in this worktree, skip
        return;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        !content.includes('readStdinIfMain'),
        'df-dashboard-push.js should not use readStdinIfMain — it uses sync readFileSync'
      );
    });
  });

  // Bonus: lint-no-bare-stdin.js exits 0 (clean)
  describe('Lint guard: lint-no-bare-stdin.js exits clean', () => {
    it('should exit 0 indicating no violations', () => {
      const lintPath = path.join(LIB_DIR, 'lint-no-bare-stdin.js');
      if (!fs.existsSync(lintPath)) {
        assert.fail('hooks/lib/lint-no-bare-stdin.js does not exist');
        return;
      }
      try {
        execSync(`node ${lintPath}`, {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        if (err.killed) {
          assert.fail('Lint script hung');
        }
        const output = (err.stdout || '') + '\n' + (err.stderr || '');
        assert.fail('Lint script found violations (exit ' + err.status + '):\n' + output);
      }
    });
  });
});
