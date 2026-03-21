/**
 * Tests for hooks/df-snapshot-guard.js
 *
 * Tests the PostToolUse hook that blocks Write/Edit to files listed in
 * .deepflow/auto-snapshot.txt (ratchet baseline protection).
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_PATH = path.resolve(__dirname, 'df-snapshot-guard.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-snapshot-guard-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the snapshot guard hook as a child process with JSON piped to stdin.
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
 * Create .deepflow/auto-snapshot.txt in the given directory with the specified entries.
 */
function writeSnapshot(dir, entries) {
  const deepflowDir = path.join(dir, '.deepflow');
  fs.mkdirSync(deepflowDir, { recursive: true });
  fs.writeFileSync(path.join(deepflowDir, 'auto-snapshot.txt'), entries.join('\n'));
}

// ---------------------------------------------------------------------------
// 1. Pass-through cases (exit 0)
// ---------------------------------------------------------------------------

describe('df-snapshot-guard — pass-through (exit 0)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('exits 0 for non-Write/Edit tools (e.g. Read)', () => {
    writeSnapshot(tmpDir, ['src/app.js']);
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 for Bash tool', () => {
    writeSnapshot(tmpDir, ['src/app.js']);
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 when snapshot file does not exist', () => {
    // No .deepflow/auto-snapshot.txt created
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 when snapshot file is empty', () => {
    writeSnapshot(tmpDir, []);
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 when snapshot contains only comments and blank lines', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      '# This is a comment\n\n# Another comment\n  \n'
    );
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 when file_path does not match any snapshot entry', () => {
    writeSnapshot(tmpDir, ['bin/install.test.js', 'test/integration.test.js']);
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'src/new-file.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 when file_path is empty string', () => {
    writeSnapshot(tmpDir, ['test.js']);
    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '' },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 when tool_input is missing file_path', () => {
    writeSnapshot(tmpDir, ['test.js']);
    const result = runHook({
      tool_name: 'Write',
      tool_input: {},
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('exits 0 on invalid JSON input (fail open)', () => {
    // Send raw invalid JSON via child process
    try {
      execFileSync(process.execPath, [HOOK_PATH], {
        input: 'not valid json{{{',
        encoding: 'utf8',
        timeout: 5000,
      });
      // exit 0 — pass
    } catch (err) {
      assert.fail(`Hook should exit 0 on parse error but got exit code ${err.status}`);
    }
  });

  test('exits 0 when tool_name is missing', () => {
    writeSnapshot(tmpDir, ['test.js']);
    const result = runHook({
      tool_input: { file_path: path.join(tmpDir, 'test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Blocking cases (exit 1)
// ---------------------------------------------------------------------------

describe('df-snapshot-guard — blocks protected files (exit 1)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('blocks Write to a file listed in snapshot (absolute path)', () => {
    const protectedFile = path.join(tmpDir, 'bin', 'install.test.js');
    writeSnapshot(tmpDir, [protectedFile]);
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: protectedFile },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('df-snapshot-guard'));
    assert.ok(result.stderr.includes('Blocked'));
  });

  test('blocks Edit to a file listed in snapshot (absolute path)', () => {
    const protectedFile = path.join(tmpDir, 'test', 'integration.test.js');
    writeSnapshot(tmpDir, [protectedFile]);
    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: protectedFile },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('Blocked'));
  });

  test('blocks Write to a file listed as relative path in snapshot', () => {
    writeSnapshot(tmpDir, ['bin/install.test.js']);
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'bin', 'install.test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
  });

  test('blocks when file_path is relative and snapshot entry is relative', () => {
    writeSnapshot(tmpDir, ['test/foo.test.js']);
    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: 'test/foo.test.js' },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
  });

  test('blocks when file_path is absolute and snapshot entry is relative', () => {
    writeSnapshot(tmpDir, ['src/helper.test.js']);
    const absPath = path.join(tmpDir, 'src', 'helper.test.js');
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: absPath },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
  });

  test('blocks when file_path is relative and snapshot entry is absolute', () => {
    const absEntry = path.join(tmpDir, 'lib', 'core.test.js');
    writeSnapshot(tmpDir, [absEntry]);
    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: 'lib/core.test.js' },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
  });

  test('stderr message includes file path and ratchet explanation', () => {
    writeSnapshot(tmpDir, ['test/unit.test.js']);
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'unit.test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('ratchet baseline'));
    assert.ok(result.stderr.includes('auto-snapshot.txt'));
  });

  test('blocks only matching file among multiple snapshot entries', () => {
    writeSnapshot(tmpDir, [
      'test/a.test.js',
      'test/b.test.js',
      'test/c.test.js',
    ]);

    // Writing to b.test.js should be blocked
    const resultBlocked = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'b.test.js') },
      cwd: tmpDir,
    });
    assert.equal(resultBlocked.code, 1);

    // Writing to d.test.js should pass through
    const resultAllowed = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'd.test.js') },
      cwd: tmpDir,
    });
    assert.equal(resultAllowed.code, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge cases
// ---------------------------------------------------------------------------

describe('df-snapshot-guard — edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('snapshot with comment lines ignores comments', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      '# Header comment\ntest/real.test.js\n# Another comment\n'
    );
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'real.test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
  });

  test('snapshot entries with leading/trailing whitespace are trimmed', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      '  test/spaced.test.js  \n'
    );
    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'test', 'spaced.test.js') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 1);
  });

  test('uses process.cwd() when cwd is not in input', () => {
    // When cwd is not provided in JSON, hook falls back to process.cwd()
    // We can't easily control process.cwd() in the child, but we can verify
    // it doesn't crash — the snapshot won't exist in the child's cwd so exit 0
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/some/random/file.js' },
    });
    assert.equal(result.code, 0);
  });

  test('handles snapshot file with only one entry', () => {
    writeSnapshot(tmpDir, ['single.js']);
    const blocked = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'single.js') },
      cwd: tmpDir,
    });
    assert.equal(blocked.code, 1);

    const allowed = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'other.js') },
      cwd: tmpDir,
    });
    assert.equal(allowed.code, 0);
  });

  test('does not block similarly named but different files', () => {
    writeSnapshot(tmpDir, ['test/foo.test.js']);
    // foo.test.jsx is NOT the same as foo.test.js
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'foo.test.jsx') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });

  test('does not block a parent directory of a snapshot entry', () => {
    writeSnapshot(tmpDir, ['test/sub/deep.test.js']);
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'sub') },
      cwd: tmpDir,
    });
    assert.equal(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. install.js integration — snapshot guard hook registration
// ---------------------------------------------------------------------------

describe('install.js — snapshot guard hook registration', () => {
  const installSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'bin', 'install.js'),
    'utf8'
  );

  test('defines snapshotGuardCmd variable', () => {
    assert.ok(
      installSrc.includes('snapshotGuardCmd'),
      'install.js should define snapshotGuardCmd variable'
    );
  });

  test('snapshotGuardCmd references df-snapshot-guard.js', () => {
    assert.match(
      installSrc,
      /snapshotGuardCmd\s*=\s*`node.*df-snapshot-guard\.js/,
      'snapshotGuardCmd should reference df-snapshot-guard.js'
    );
  });

  test('pushes snapshot guard to PostToolUse hooks', () => {
    // Verify there is a .push() call that includes snapshotGuardCmd
    assert.match(
      installSrc,
      /PostToolUse\.push\(\{[\s\S]*?snapshotGuardCmd[\s\S]*?\}\)/,
      'install.js should push snapshotGuardCmd to PostToolUse'
    );
  });

  test('PostToolUse filter includes df-snapshot-guard removal', () => {
    // The filter should clean up existing snapshot guard hooks before re-adding
    assert.ok(
      installSrc.includes("df-snapshot-guard"),
      'PostToolUse filter should reference df-snapshot-guard for cleanup'
    );
  });

  test('uninstall toRemove includes df-snapshot-guard.js', () => {
    assert.ok(
      installSrc.includes("'hooks/df-snapshot-guard.js'"),
      'Uninstall toRemove should include hooks/df-snapshot-guard.js'
    );
  });

  test('uninstall PostToolUse filter removes df-snapshot-guard', () => {
    // Find the uninstall section's PostToolUse filter
    // It should include df-snapshot-guard in the filter pattern
    const uninstallSection = installSrc.slice(installSrc.indexOf('async function uninstall'));
    assert.ok(
      uninstallSection.includes('df-snapshot-guard'),
      'Uninstall PostToolUse filter should include df-snapshot-guard'
    );
  });

  test('PostToolUse cleanup removes snapshot guard and keeps custom hooks', () => {
    const postToolUse = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-tool-usage.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-snapshot-guard.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/my-custom-hook.js' }] },
    ];

    const filtered = postToolUse.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-tool-usage') &&
             !cmd.includes('df-execution-history') &&
             !cmd.includes('df-worktree-guard') &&
             !cmd.includes('df-snapshot-guard') &&
             !cmd.includes('df-invariant-check');
    });

    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].hooks[0].command.includes('my-custom-hook.js'));
  });

  test('filterSessionStart does NOT remove snapshot guard (it is PostToolUse only)', () => {
    // Reproduce the SessionStart filter logic — snapshot guard should not appear
    function filterSessionStart(hooks) {
      return hooks.filter(hook => {
        const cmd = hook.hooks?.[0]?.command || '';
        return !cmd.includes('df-check-update') &&
               !cmd.includes('df-consolidation-check') &&
               !cmd.includes('df-quota-logger');
      });
    }

    const hooks = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-snapshot-guard.js' }] },
    ];

    const filtered = filterSessionStart(hooks);
    assert.equal(filtered.length, 1, 'SessionStart filter should NOT remove snapshot guard hooks');
  });
});
