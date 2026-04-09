/**
 * Tests for df-explore-protocol.js — PreToolUse hook
 *
 * Two-phase behavior coverage:
 *   Phase 1: spawn `claude --print` to gather LSP symbols
 *   Phase 2: inject LSP block + static template into prompt
 *
 * All tests control Phase 1 via a fake `claude` binary written to a temp
 * bin directory that is prepended to PATH. This avoids network calls and
 * real subprocess timeouts.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOOK_PATH = path.resolve(__dirname, 'df-explore-protocol.js');
const PROTOCOL_CONTENT =
  '# Explore Agent Pattern\n\nReturn ONLY:\n- filepath:startLine-endLine -- why relevant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a fake `claude` shell script to binDir that outputs the given stdout
 * and exits with exitCode (default 0).
 */
function writeFakeClaude(binDir, { stdout = '', exitCode = 0, sleepSeconds = 0 } = {}) {
  const scriptPath = path.join(binDir, 'claude');
  const body = [
    '#!/bin/sh',
    sleepSeconds > 0 ? `sleep ${sleepSeconds}` : '',
    `cat <<'HEREDOC'`,
    stdout,
    'HEREDOC',
    `exit ${exitCode}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
}

/**
 * Create a temp project directory with an optional explore-protocol.md template
 * and optional .deepflow/config.yaml.
 */
function createTempProject({ withTemplate = true, configYaml = null } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-explore-test-'));
  if (withTemplate) {
    const templatesDir = path.join(tmpDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'explore-protocol.md'), PROTOCOL_CONTENT);
  }
  if (configYaml) {
    const dfDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(dfDir, { recursive: true });
    fs.writeFileSync(path.join(dfDir, 'config.yaml'), configYaml);
  }
  return tmpDir;
}

/**
 * Run the hook as a child process with JSON piped to stdin.
 * binDir is prepended to PATH so the fake `claude` binary is found first.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { cwd, home, binDir } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env };
  if (home) env.HOME = home;
  if (binDir) {
    env.PATH = `${binDir}:${process.env.PATH}`;
  }
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: json,
      encoding: 'utf8',
      timeout: 10000,
      env,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('df-explore-protocol hook', () => {
  let tmpDir;
  let binDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-explore-bin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // AC-1: Phase 1 subprocess uses LSP-only prompt
  // -------------------------------------------------------------------------
  test('AC-1: Phase 1 subprocess receives LSP-only prompt mentioning documentSymbol', () => {
    // Fake claude captures its args to stdout so we can inspect the prompt
    const captureScript = path.join(binDir, 'claude');
    fs.writeFileSync(
      captureScript,
      [
        '#!/bin/sh',
        // Write the prompt arg (second arg after --print) to a temp file
        `echo "$2" > /tmp/df-explore-captured-prompt.txt`,
        // Return empty array so Phase 1 falls back gracefully
        'echo "[]"',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 }
    );

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: database config' },
      cwd: tmpDir,
    };

    const { code } = runHook(input, { binDir });
    assert.equal(code, 0);

    // The captured prompt file was written by the fake claude
    const capturedPrompt = fs.readFileSync('/tmp/df-explore-captured-prompt.txt', 'utf8').trim();
    assert.ok(
      capturedPrompt.includes('documentSymbol'),
      `Expected prompt to mention documentSymbol, got: ${capturedPrompt}`
    );
    assert.ok(
      capturedPrompt.includes('LSP ONLY'),
      `Expected prompt to start with LSP ONLY, got: ${capturedPrompt}`
    );
    assert.ok(
      capturedPrompt.includes('Find: database config'),
      `Expected prompt to include original query`
    );
  });

  // -------------------------------------------------------------------------
  // AC-2: Phase 1 hit injects [LSP Phase -- locations found] section
  // -------------------------------------------------------------------------
  test('AC-2: Phase 1 hit injects [LSP Phase -- locations found] section into prompt', () => {
    const symbols = [
      { name: 'dbConfig', kind: 'Variable', line: 10, filepath: '/project/src/config.ts' },
      { name: 'connectDB', kind: 'Function', line: 25, filepath: '/project/src/db.ts' },
    ];
    writeFakeClaude(binDir, { stdout: JSON.stringify(symbols) });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: database config' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const result = JSON.parse(stdout);
    const prompt = result.hookSpecificOutput.updatedInput.prompt;

    assert.ok(
      prompt.includes('[LSP Phase -- locations found]'),
      'Expected [LSP Phase -- locations found] section'
    );
    assert.ok(
      prompt.includes('Search Protocol (auto-injected'),
      'Expected Search Protocol section'
    );
    assert.ok(prompt.includes(PROTOCOL_CONTENT.slice(0, 30)), 'Expected protocol content');
  });

  // -------------------------------------------------------------------------
  // AC-3: Reader-phase entries in filepath:line format
  // -------------------------------------------------------------------------
  test('AC-3: LSP locations are formatted as filepath:line -- symbolName (symbolKind)', () => {
    const symbols = [
      { name: 'myFunc', kind: 'Function', line: 42, filepath: '/project/src/utils.ts' },
    ];
    writeFakeClaude(binDir, { stdout: JSON.stringify(symbols) });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: utility functions' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes('/project/src/utils.ts:42 -- myFunc (Function)'),
      `Expected filepath:line format, prompt: ${prompt}`
    );
  });

  // -------------------------------------------------------------------------
  // AC-5: Subprocess failure → fallback to static template injection
  // -------------------------------------------------------------------------
  test('AC-5: subprocess failure falls back to static template injection', () => {
    writeFakeClaude(binDir, { stdout: '', exitCode: 1 });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: routes' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const result = JSON.parse(stdout);
    const prompt = result.hookSpecificOutput.updatedInput.prompt;

    // Should inject protocol but NOT the LSP phase block
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Expected protocol injection');
    assert.ok(
      !prompt.includes('[LSP Phase -- locations found]'),
      'Must NOT include LSP phase block on failure'
    );
    assert.ok(prompt.includes('Find: routes'), 'Original prompt preserved');
  });

  // -------------------------------------------------------------------------
  // AC-6: No template + subprocess failure → exit 0 with no output
  // -------------------------------------------------------------------------
  test('AC-6: no template and subprocess failure exits 0 with no output', () => {
    const emptyDir = createTempProject({ withTemplate: false });
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'df-explore-home-'));
    writeFakeClaude(binDir, { stdout: '', exitCode: 1 });

    try {
      const input = {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
        cwd: emptyDir,
      };

      const { stdout, code } = runHook(input, { binDir, home: fakeHome });
      assert.equal(code, 0);
      assert.equal(stdout, '', 'Expected empty stdout when no template and subprocess fails');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // AC-7: Path filtering removes node_modules, .claude/worktrees, dist paths
  // -------------------------------------------------------------------------
  test('AC-7: noise paths filtered out — node_modules, .claude/worktrees, dist, .git', () => {
    const symbols = [
      { name: 'good', kind: 'Function', line: 1, filepath: '/project/src/good.ts' },
      {
        name: 'badNodeModules',
        kind: 'Function',
        line: 1,
        filepath: '/project/node_modules/lib/index.js',
      },
      {
        name: 'badWorktree',
        kind: 'Function',
        line: 1,
        filepath: '/project/.claude/worktrees/branch/file.ts',
      },
      { name: 'badDist', kind: 'Function', line: 1, filepath: '/project/dist/bundle.js' },
      { name: 'badGit', kind: 'Function', line: 1, filepath: '/project/.git/hooks/pre-commit' },
    ];
    writeFakeClaude(binDir, { stdout: JSON.stringify(symbols) });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: functions' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes('/project/src/good.ts'), 'Good path should be present');
    assert.ok(!prompt.includes('node_modules'), 'node_modules should be filtered');
    assert.ok(!prompt.includes('.claude/worktrees'), '.claude/worktrees should be filtered');
    assert.ok(!prompt.includes('/dist/bundle'), 'dist should be filtered');
    assert.ok(!prompt.includes('.git/hooks'), '.git should be filtered');
  });

  // -------------------------------------------------------------------------
  // AC-7 edge: all symbols filtered → falls back to static template (no LSP block)
  // -------------------------------------------------------------------------
  test('AC-7: all symbols filtered → falls back to static template (no LSP block)', () => {
    const symbols = [
      {
        name: 'badNodeModules',
        kind: 'Function',
        line: 1,
        filepath: '/project/node_modules/lib/index.js',
      },
    ];
    writeFakeClaude(binDir, { stdout: JSON.stringify(symbols) });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: functions' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      !prompt.includes('[LSP Phase -- locations found]'),
      'Should not inject LSP block when all paths filtered'
    );
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Should still inject protocol');
  });

  // -------------------------------------------------------------------------
  // AC-8: Deduplication guard prevents double-injection
  // -------------------------------------------------------------------------
  test('AC-8: dedup guard — skips injection if Search Protocol already present', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt:
          'Find: config\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\nalready here',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);
    // Dedup guard should fire — no output (hook returns without modification)
    assert.equal(stdout, '', 'Expected no output when dedup guard fires');
  });

  test('AC-8: dedup guard — skips injection if LSP Phase already present', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt: 'Find: config\n\n## [LSP Phase -- locations found]\n\n/some/file.ts:10 -- foo (Fn)',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);
    assert.equal(stdout, '', 'Expected no output when LSP Phase marker already present');
  });

  // -------------------------------------------------------------------------
  // AC-9: Config timeout override read from .deepflow/config.yaml
  // -------------------------------------------------------------------------
  test('AC-9: config timeout override — reads explore_lsp_timeout_ms from config.yaml', () => {
    // Create project with a very short timeout (100ms) and a slow fake claude (sleep 2s)
    // The hook should time out and fall back (exit status non-zero from spawnSync timeout)
    const projectWithConfig = createTempProject({
      configYaml: 'explore_lsp_timeout_ms: 100\n',
    });

    // This fake claude sleeps 2 seconds — will time out with 100ms config
    writeFakeClaude(binDir, {
      stdout: JSON.stringify([
        { name: 'sym', kind: 'Fn', line: 1, filepath: '/project/src/file.ts' },
      ]),
      sleepSeconds: 2,
    });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: symbols' },
      cwd: projectWithConfig,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    // Should have fallen back to static template (timeout = Phase 1 miss)
    const result = JSON.parse(stdout);
    const prompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Should inject static protocol');
    assert.ok(
      !prompt.includes('[LSP Phase -- locations found]'),
      'Should NOT have LSP block (timed out)'
    );

    fs.rmSync(projectWithConfig, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // AC-10: Exit 0 on malformed JSON input
  // -------------------------------------------------------------------------
  test('AC-10: exits 0 on malformed JSON stdin', () => {
    const { code, stdout } = runHook('not valid json {{ }}', { binDir });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  // AC-10: missing tool_input field
  test('AC-10: exits 0 when tool_input is missing', () => {
    const input = {
      tool_name: 'Agent',
      // tool_input deliberately omitted
      cwd: tmpDir,
    };

    const { code } = runHook(input, { binDir });
    assert.equal(code, 0);
  });

  // AC-10: subprocess crash (SIGKILL simulation via exit 137)
  test('AC-10: exits 0 when Phase 1 subprocess crashes (exit 2)', () => {
    writeFakeClaude(binDir, { stdout: '', exitCode: 2 });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
      cwd: tmpDir,
    };

    const { code } = runHook(input, { binDir });
    assert.equal(code, 0);
  });

  // AC-10: subprocess returns malformed JSON
  test('AC-10: exits 0 when Phase 1 returns malformed JSON', () => {
    writeFakeClaude(binDir, { stdout: 'not json at all {{{' });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
      cwd: tmpDir,
    };

    const { code, stdout } = runHook(input, { binDir });
    assert.equal(code, 0);
    // Should fall back to static protocol
    const result = JSON.parse(stdout);
    assert.ok(
      result.hookSpecificOutput.updatedInput.prompt.includes('Search Protocol (auto-injected')
    );
  });

  // -------------------------------------------------------------------------
  // AC-12: All original tool_input fields preserved in updatedInput
  // -------------------------------------------------------------------------
  test('AC-12: all original tool_input fields preserved after Phase 1 hit', () => {
    const symbols = [{ name: 'sym', kind: 'Class', line: 5, filepath: '/project/src/api.ts' }];
    writeFakeClaude(binDir, { stdout: JSON.stringify(symbols) });

    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt: 'Find: API routes',
        model: 'haiku',
        description: 'search for API routes',
        run_in_background: false,
        custom_field: 'custom_value',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const updated = JSON.parse(stdout).hookSpecificOutput.updatedInput;
    assert.equal(updated.subagent_type, 'Explore');
    assert.equal(updated.model, 'haiku');
    assert.equal(updated.description, 'search for API routes');
    assert.equal(updated.run_in_background, false);
    assert.equal(updated.custom_field, 'custom_value');
    // Prompt is modified (has injection) but still contains original text
    assert.ok(updated.prompt.includes('Find: API routes'));
  });

  test('AC-12: all original tool_input fields preserved after Phase 1 fallback', () => {
    writeFakeClaude(binDir, { stdout: '', exitCode: 1 });

    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt: 'Find: something',
        model: 'sonnet',
        extra: 'value',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const updated = JSON.parse(stdout).hookSpecificOutput.updatedInput;
    assert.equal(updated.model, 'sonnet');
    assert.equal(updated.extra, 'value');
    assert.equal(updated.subagent_type, 'Explore');
  });

  // -------------------------------------------------------------------------
  // Existing behavior: non-Explore/non-Agent pass-through
  // -------------------------------------------------------------------------
  test('ignores non-Agent tool calls', () => {
    const input = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  test('ignores non-Explore agent calls', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reasoner', prompt: 'Analyze this code' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  test('handles case-insensitive subagent_type (EXPLORE)', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'EXPLORE', prompt: 'Find: test utilities' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const result = JSON.parse(stdout);
    assert.ok(result.hookSpecificOutput.updatedInput.prompt.includes('Search Protocol'));
  });

  // -------------------------------------------------------------------------
  // Phase 1 markdown fence stripping
  // -------------------------------------------------------------------------
  test('strips markdown json fences from Phase 1 subprocess output', () => {
    const symbols = [{ name: 'myFn', kind: 'Function', line: 7, filepath: '/project/src/util.ts' }];
    const fencedOutput = '```json\n' + JSON.stringify(symbols) + '\n```';
    writeFakeClaude(binDir, { stdout: fencedOutput });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: utilities' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes('/project/src/util.ts:7 -- myFn (Function)'),
      'Should parse symbols from fenced JSON output'
    );
  });

  // -------------------------------------------------------------------------
  // Phase 1 empty array → static fallback
  // -------------------------------------------------------------------------
  test('Phase 1 empty array falls back to static template injection', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: nothing here' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Should inject static protocol');
    assert.ok(!prompt.includes('[LSP Phase -- locations found]'), 'No LSP block for empty results');
  });

  // -------------------------------------------------------------------------
  // permissionDecision is always 'allow'
  // -------------------------------------------------------------------------
  test('hookSpecificOutput has permissionDecision allow', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'allow');
    assert.equal(out.hookEventName, 'PreToolUse');
  });

  // -------------------------------------------------------------------------
  // Missing prompt field — should inject into empty string base
  // -------------------------------------------------------------------------
  test('handles missing prompt field gracefully', () => {
    writeFakeClaude(binDir, { stdout: '[]' });

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input, { binDir });
    assert.equal(code, 0);

    const updated = JSON.parse(stdout).hookSpecificOutput.updatedInput;
    assert.ok(updated.prompt.includes('Search Protocol'));
  });
});
