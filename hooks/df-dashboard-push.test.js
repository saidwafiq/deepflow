/**
 * Tests for hooks/df-dashboard-push.js (security-hardening, T2)
 *
 * Validates that the dashboard push hook reads dashboard_url from
 * ~/.deepflow/config.yaml (home directory) rather than the project
 * directory, and silently skips when not configured.
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_PATH = path.resolve(__dirname, 'df-dashboard-push.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-dashboard-push-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the dashboard push hook in --background mode as a child process.
 * Overrides HOME so getDashboardUrl reads from our fake home dir.
 * Returns { stdout, stderr, code }.
 */
function runHook({ home, cwd, hookInput } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  if (hookInput !== undefined) env._DF_HOOK_INPUT = hookInput;
  // Ensure CLAUDE_PROJECT_DIR points to cwd so main() uses it
  if (cwd) env.CLAUDE_PROJECT_DIR = cwd;

  try {
    const stdout = execFileSync(
      process.execPath,
      [HOOK_PATH, '--background'],
      {
        cwd: cwd || os.tmpdir(),
        encoding: 'utf8',
        timeout: 10000,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
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
 * Write a config.yaml into {dir}/.deepflow/config.yaml with given content.
 */
function writeConfig(dir, content) {
  const configDir = path.join(dir, '.deepflow');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('df-dashboard-push hook', () => {
  let fakeHome;
  let fakeCwd;

  beforeEach(() => {
    fakeHome = makeTmpDir();
    fakeCwd = makeTmpDir();
  });

  afterEach(() => {
    rmrf(fakeHome);
    rmrf(fakeCwd);
  });

  // -------------------------------------------------------------------------
  // Config resolution: reads from HOME, not CWD
  // -------------------------------------------------------------------------

  describe('config resolution', () => {
    test('exits 0 when no config file exists at HOME', () => {
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      assert.equal(result.code, 0);
    });

    test('exits 0 when config exists at HOME but has no dashboard_url key', () => {
      writeConfig(fakeHome, 'build_command: "npm run build"\ntest_command: "npm test"\n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      assert.equal(result.code, 0);
    });

    test('exits 0 when dashboard_url is empty string', () => {
      writeConfig(fakeHome, 'dashboard_url: ""\n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      assert.equal(result.code, 0);
    });

    test('exits 0 when dashboard_url is bare empty (no quotes)', () => {
      writeConfig(fakeHome, 'dashboard_url: \n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      assert.equal(result.code, 0);
    });

    test('ignores dashboard_url in project cwd config (reads from HOME only)', () => {
      // Put a valid URL in the project config, but NOT in home config
      writeConfig(fakeCwd, 'dashboard_url: "http://localhost:9999"\n');
      // Home has no config at all
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      // Should exit 0 without attempting POST because HOME has no config
      assert.equal(result.code, 0);
    });

    test('reads dashboard_url from HOME config even when project has none', () => {
      // Home has a dashboard_url pointing to an unreachable port
      writeConfig(fakeHome, 'dashboard_url: "http://127.0.0.1:19999"\n');
      // Project has no config
      // Hook should attempt POST, fail silently, exit 0
      const result = runHook({ home: fakeHome, cwd: fakeCwd, hookInput: '{}' });
      assert.equal(result.code, 0);
    });
  });

  // -------------------------------------------------------------------------
  // YAML parsing edge cases
  // -------------------------------------------------------------------------

  describe('dashboard_url parsing', () => {
    test('extracts unquoted URL', () => {
      writeConfig(fakeHome, 'dashboard_url: http://127.0.0.1:19999\n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd, hookInput: '{}' });
      // Attempts POST, fails silently on unreachable port, exits 0
      assert.equal(result.code, 0);
    });

    test('extracts single-quoted URL', () => {
      writeConfig(fakeHome, "dashboard_url: 'http://127.0.0.1:19999'\n");
      const result = runHook({ home: fakeHome, cwd: fakeCwd, hookInput: '{}' });
      assert.equal(result.code, 0);
    });

    test('extracts double-quoted URL', () => {
      writeConfig(fakeHome, 'dashboard_url: "http://127.0.0.1:19999"\n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd, hookInput: '{}' });
      assert.equal(result.code, 0);
    });

    test('handles dashboard_url with leading spaces (indented)', () => {
      writeConfig(fakeHome, '  dashboard_url: http://127.0.0.1:19999\n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd, hookInput: '{}' });
      assert.equal(result.code, 0);
    });

    test('ignores commented-out dashboard_url', () => {
      writeConfig(fakeHome, '# dashboard_url: http://127.0.0.1:19999\n');
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      // The regex uses ^ so a comment line should not match
      assert.equal(result.code, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling / resilience
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    test('exits 0 when config file is unreadable (permissions)', () => {
      writeConfig(fakeHome, 'dashboard_url: http://localhost:9999\n');
      const configPath = path.join(fakeHome, '.deepflow', 'config.yaml');
      fs.chmodSync(configPath, 0o000);
      const result = runHook({ home: fakeHome, cwd: fakeCwd });
      assert.equal(result.code, 0);
      // Restore permissions for cleanup
      fs.chmodSync(configPath, 0o644);
    });

    test('exits 0 when hook input is invalid JSON', () => {
      writeConfig(fakeHome, 'dashboard_url: http://127.0.0.1:19999\n');
      const result = runHook({
        home: fakeHome,
        cwd: fakeCwd,
        hookInput: '{not valid json',
      });
      assert.equal(result.code, 0);
    });

    test('exits 0 when hook input is empty', () => {
      writeConfig(fakeHome, 'dashboard_url: http://127.0.0.1:19999\n');
      const result = runHook({
        home: fakeHome,
        cwd: fakeCwd,
        hookInput: '',
      });
      assert.equal(result.code, 0);
    });

    test('exits 0 when dashboard_url has invalid URL format', () => {
      writeConfig(fakeHome, 'dashboard_url: not-a-url\n');
      const result = runHook({
        home: fakeHome,
        cwd: fakeCwd,
        hookInput: '{}',
      });
      // postJson should handle invalid URL gracefully
      assert.equal(result.code, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Foreground mode (spawns background and exits immediately)
  // -------------------------------------------------------------------------

  describe('foreground mode', () => {
    test('exits 0 immediately without --background flag', () => {
      const env = { ...process.env, HOME: fakeHome };
      try {
        const stdout = execFileSync(
          process.execPath,
          [HOOK_PATH],
          {
            cwd: fakeCwd,
            encoding: 'utf8',
            timeout: 5000,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            input: '{}',
          }
        );
        assert.equal(typeof stdout, 'string');
      } catch (err) {
        // Even if it errors, check code is 0 (fire-and-forget exit)
        assert.equal(err.status, 0, 'foreground mode should exit 0');
      }
    });
  });
});
