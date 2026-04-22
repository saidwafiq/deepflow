'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const HOOK_PATH = path.resolve(__dirname, 'df-implement-bash-search-guard.js');

/**
 * Run the hook as a subprocess, simulating how Claude Code invokes it.
 * @param {object} input  - PreToolUse payload object
 * @param {object} env    - Additional env vars (merged with process.env)
 * @returns {{ stdout: string, code: number }}
 */
function runHook(input, env = {}) {
  const json = JSON.stringify(input);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      cwd: os.tmpdir(),
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

function decision(stdout) {
  return parsed(stdout)?.hookSpecificOutput?.permissionDecision ?? null;
}

// ---------------------------------------------------------------------------
// 1. Matched search commands — df-implement agent → deny
// ---------------------------------------------------------------------------

describe('df-implement-bash-search-guard — deny when df-implement + search cmd', () => {
  const DF_IMPL_ENV = { DEEPFLOW_AGENT_ROLE: 'df-implement' };

  test('denies grep when active subagent is df-implement', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: "grep -rn 'foo' ." } },
      DF_IMPL_ENV,
    );
    assert.equal(decision(r.stdout), 'deny', 'expected deny for grep');
  });

  test('deny output has non-empty permissionDecisionReason', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'grep -r pattern src/' } },
      DF_IMPL_ENV,
    );
    const p = parsed(r.stdout);
    assert.ok(p?.hookSpecificOutput?.permissionDecisionReason?.length > 0);
  });

  test('denies rg (ripgrep) when active subagent is df-implement', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'rg --type js "pattern"' } },
      DF_IMPL_ENV,
    );
    assert.equal(decision(r.stdout), 'deny', 'expected deny for rg');
  });

  test('denies find -name when active subagent is df-implement', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'find . -name "*.js"' } },
      DF_IMPL_ENV,
    );
    assert.equal(decision(r.stdout), 'deny', 'expected deny for find -name');
  });

  test('denies ag (silver searcher) when active subagent is df-implement', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'ag "pattern" src/' } },
      DF_IMPL_ENV,
    );
    assert.equal(decision(r.stdout), 'deny', 'expected deny for ag');
  });

  test('denies grep after && prefix (subshell chaining)', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'cd /repo && grep -n "foo" file.js' } },
      DF_IMPL_ENV,
    );
    assert.equal(decision(r.stdout), 'deny', 'expected deny for chained grep');
  });
});

// ---------------------------------------------------------------------------
// 2. Near-miss commands — df-implement agent → allow (pass through)
// ---------------------------------------------------------------------------

describe('df-implement-bash-search-guard — near-miss pass-through when df-implement', () => {
  const DF_IMPL_ENV = { DEEPFLOW_AGENT_ROLE: 'df-implement' };

  test('allows "find" without -name (e.g. find . -type f)', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'find . -type f -newer package.json' } },
      DF_IMPL_ENV,
    );
    // find without -name should pass through
    assert.equal(r.stdout.trim(), '', 'expected empty stdout (pass-through)');
    assert.equal(r.code, 0);
  });

  test('allows npm test (not a search command)', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      DF_IMPL_ENV,
    );
    assert.equal(r.stdout.trim(), '', 'expected empty stdout (pass-through)');
  });

  test('allows git log (not a search command)', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'git log --oneline -5' } },
      DF_IMPL_ENV,
    );
    assert.equal(r.stdout.trim(), '', 'expected empty stdout (pass-through)');
  });

  test('allows non-Bash tools (Read)', () => {
    const r = runHook(
      { tool_name: 'Read', tool_input: { file_path: '/some/file.js' } },
      DF_IMPL_ENV,
    );
    assert.equal(r.stdout.trim(), '', 'expected empty stdout (pass-through)');
  });
});

// ---------------------------------------------------------------------------
// 3. Non-df-implement agent → all search commands pass through
// ---------------------------------------------------------------------------

describe('df-implement-bash-search-guard — pass-through for non-df-implement agents', () => {
  test('passes grep through when agent is df-test', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: "grep -rn 'foo' ." } },
      { DEEPFLOW_AGENT_ROLE: 'df-test' },
    );
    assert.equal(r.stdout.trim(), '', 'expected no deny for df-test');
    assert.equal(r.code, 0);
  });

  test('passes grep through when agent is df-spike', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'grep -r pattern .' } },
      { DEEPFLOW_AGENT_ROLE: 'df-spike' },
    );
    assert.equal(r.stdout.trim(), '', 'expected no deny for df-spike');
  });

  test('passes grep through when DEEPFLOW_AGENT_ROLE is not set (fail-open)', () => {
    const envWithoutRole = { ...process.env };
    delete envWithoutRole.DEEPFLOW_AGENT_ROLE;

    const json = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: "grep -rn 'foo' ." },
    });
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [HOOK_PATH], {
        input: json,
        cwd: os.tmpdir(),
        encoding: 'utf8',
        timeout: 5000,
        env: envWithoutRole,
      });
    } catch (err) {
      stdout = err.stdout || '';
    }
    assert.equal(stdout.trim(), '', 'expected fail-open (no deny) when env var absent');
  });

  test('passes rg through when agent is df-integration', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'rg "pattern" src/' } },
      { DEEPFLOW_AGENT_ROLE: 'df-integration' },
    );
    assert.equal(r.stdout.trim(), '', 'expected no deny for df-integration');
  });
});

// ---------------------------------------------------------------------------
// 4. Output format validation
// ---------------------------------------------------------------------------

describe('df-implement-bash-search-guard — output format', () => {
  const DF_IMPL_ENV = { DEEPFLOW_AGENT_ROLE: 'df-implement' };

  test('deny output is valid hookSpecificOutput JSON', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'grep foo bar.js' } },
      DF_IMPL_ENV,
    );
    const p = parsed(r.stdout);
    assert.ok(p?.hookSpecificOutput, 'missing hookSpecificOutput');
    assert.equal(p.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(p.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(typeof p.hookSpecificOutput.permissionDecisionReason === 'string');
    assert.ok(p.hookSpecificOutput.permissionDecisionReason.includes('Read'));
  });

  test('exits 0 on deny', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'grep foo bar.js' } },
      DF_IMPL_ENV,
    );
    assert.equal(r.code, 0);
  });

  test('exits 0 on pass-through', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      DF_IMPL_ENV,
    );
    assert.equal(r.code, 0);
  });
});
