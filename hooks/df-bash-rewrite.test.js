'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-bash-rewrite.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-bash-rewrite-test-'));
}
function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
function makeDeepflowProject(dir) {
  fs.mkdirSync(path.join(dir, '.deepflow'), { recursive: true });
}

function runHook(input, { cwd, env } = {}) {
  const json = JSON.stringify(input);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      cwd: cwd || os.tmpdir(),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
    return { stdout, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', code: err.status ?? 1 };
  }
}

function parsed(stdout) {
  if (!stdout.trim()) return null;
  return JSON.parse(stdout.trim());
}

function rewrittenCmd(stdout) {
  const p = parsed(stdout);
  return p?.hookSpecificOutput?.updatedInput?.command ?? null;
}

// ---------------------------------------------------------------------------
// 1. Pass-through: no rewrite
// ---------------------------------------------------------------------------

describe('df-bash-rewrite — pass-through (no output)', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); makeDeepflowProject(tmp); });
  afterEach(() => rmrf(tmp));

  test('skips non-Bash tools', () => {
    const r = runHook({ tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: tmp });
    assert.equal(r.stdout, '');
  });

  test('rewrites in non-deepflow projects (universal)', () => {
    const plain = makeTmpDir();
    try {
      const r = runHook({ tool_name: 'Bash', tool_input: { command: 'npm ci' }, cwd: plain });
      assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -3'));
    } finally { rmrf(plain); }
  });

  test('skips when DF_BASH_REWRITE=0 (opt-out)', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm ci' }, cwd: tmp },
      { env: { DF_BASH_REWRITE: '0' } },
    );
    assert.equal(r.stdout, '');
  });

  test('skips unknown commands', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo hello' }, cwd: tmp });
    assert.equal(r.stdout, '');
  });

  test('skips protected: wave-runner', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node ~/.claude/bin/wave-runner.js --json --plan PLAN.md' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('skips protected: ratchet.js', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node ~/.claude/bin/ratchet.js --worktree x' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('skips protected: worktree-deps', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node "${HOME}/.claude/bin/worktree-deps.js" --source . --worktree x' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('skips already-compressed commands (tail)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm ci 2>&1 | tail -3' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('skips already-compressed commands (head)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm install 2>&1 | head -10' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('skips heredoc commands', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cat <<EOF\nhello\nEOF' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('skips subshell assignment commands', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: '_ctx=$(node -e "process.stdout.write(\'0\')")' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });
});

// ---------------------------------------------------------------------------
// 2. Rewrites applied
// ---------------------------------------------------------------------------

describe('df-bash-rewrite — rewrites applied', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); makeDeepflowProject(tmp); });
  afterEach(() => rmrf(tmp));

  // git setup
  test('rewrites git worktree add → tail -1', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git worktree add -b df/spec .deepflow/worktrees/spec' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -1'));
  });

  test('rewrites git sparse-checkout set → tail -1', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git sparse-checkout set packages/shared' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -1'));
  });

  test('rewrites git checkout -b → tail -1', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout -b feature/new' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -1'));
  });

  test('rewrites git stash → tail -2', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git stash' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -2'));
  });

  // package managers
  test('rewrites npm ci → tail -3', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm ci' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -3'));
  });

  test('rewrites npm install → tail -3', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm install --prefer-offline' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -3'));
  });

  test('rewrites pnpm install → tail -3', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm install' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -3'));
  });

  test('rewrites yarn install → tail -3', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'yarn install' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -3'));
  });

  // builds
  test('rewrites npm run build → tail -5', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -5'));
  });

  test('rewrites pnpm build → tail -5', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm build' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -5'));
  });

  test('rewrites pnpm run build → tail -5', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm run build' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -5'));
  });

  test('rewrites yarn build → tail -5', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'yarn build' },
      cwd: tmp,
    });
    assert.ok(rewrittenCmd(r.stdout)?.endsWith('| tail -5'));
  });

  // output format
  test('output is valid hookSpecificOutput JSON', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm ci', description: 'install deps' },
      cwd: tmp,
    });
    const p = parsed(r.stdout);
    assert.ok(p?.hookSpecificOutput);
    assert.equal(p.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(p.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(p.hookSpecificOutput.updatedInput?.command);
  });

  test('preserves other tool_input fields (description)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm ci', description: 'install deps' },
      cwd: tmp,
    });
    const p = parsed(r.stdout);
    assert.equal(p.hookSpecificOutput.updatedInput.description, 'install deps');
  });

  test('rewritten command includes original command as prefix', () => {
    const cmd = 'git worktree add -b df/spec .deepflow/worktrees/spec';
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: tmp });
    assert.ok(rewrittenCmd(r.stdout)?.startsWith(cmd));
  });

  test('exits 0 always', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'npm ci' }, cwd: tmp });
    assert.equal(r.code, 0);
  });
});
