/**
 * Tests for df-explore-protocol.js — PreToolUse hook
 *
 * Two-phase behavior coverage:
 *   Phase 1: inline regex extraction from source files in cwd
 *   Phase 2: inject symbol locations + static template into prompt
 *
 * AC coverage for agent-delegation-contract spec (T3 lib module):
 *   specs/agent-delegation-contract.md#AC-1
 *   specs/agent-delegation-contract.md#AC-2
 *   specs/agent-delegation-contract.md#AC-3
 *   specs/agent-delegation-contract.md#AC-4
 *   specs/agent-delegation-contract.md#AC-5
 *   specs/agent-delegation-contract.md#AC-6
 *   specs/agent-delegation-contract.md#AC-7
 *   specs/agent-delegation-contract.md#AC-8
 *   specs/agent-delegation-contract.md#AC-9
 *   specs/agent-delegation-contract.md#AC-10
 *
 * All tests control Phase 1 by writing fixture source files to a tmpDir,
 * then passing that tmpDir as cwd. No subprocess, no fake `claude` binary.
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
  '# Explore Agent Pattern\n\nReturn ONLY:\n- filepath:startLine-endLine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Write a fixture source file into tmpDir/src/ with the given content.
 * Returns the absolute path of the written file.
 */
function writeFixtureFile(tmpDir, filename, content) {
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const filepath = path.join(srcDir, filename);
  fs.writeFileSync(filepath, content);
  return filepath;
}

/**
 * Run the hook as a child process with JSON piped to stdin.
 * Returns { stdout, stderr, code }.
 */
function runHook(input, { cwd, home } = {}) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const env = { ...process.env };
  if (home) env.HOME = home;
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

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // AC-1: Phase 1 uses inline regex extraction — no subprocess required
  // -------------------------------------------------------------------------
  test('AC-1: Phase 1 uses inline regex extraction without requiring a claude binary', () => {
    // Write a fixture file with a function whose name matches the query substring
    writeFixtureFile(tmpDir, 'index.js', 'function databaseConfig() { return {}; }\n');

    // Query is just the symbol name so it substring-matches the symbol "databaseConfig"
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'databaseConfig' },
      cwd: tmpDir,
    };

    // Run without any PATH manipulation — no fake claude binary needed
    const { code, stdout } = runHook(input);
    assert.equal(code, 0);

    // Phase 1 should have found the symbol; LSP block injected
    const result = JSON.parse(stdout);
    const prompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes('[LSP Phase -- locations found]'),
      'Expected [LSP Phase -- locations found] section from regex extraction'
    );
  });

  // -------------------------------------------------------------------------
  // AC-2: Phase 1 hit injects [LSP Phase -- locations found] section
  // -------------------------------------------------------------------------
  test('AC-2: Phase 1 hit injects [LSP Phase -- locations found] section into prompt', () => {
    // Write fixture files whose symbol names contain the query substring "connect"
    writeFixtureFile(tmpDir, 'config.ts', 'export function dbConnect() { return {}; }\n');
    writeFixtureFile(tmpDir, 'db.ts', 'export async function connectDB() {}\n');

    // Query "connect" matches both symbols by substring
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'connect' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
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
    // Write a fixture file whose symbol name contains "myFunc" (matches query substring)
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const filepath = path.join(srcDir, 'utils.ts');
    // Place the function at line 1
    fs.writeFileSync(filepath, 'export function myFunc() {}\n');

    // Query "myFunc" matches the symbol name by substring
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'myFunc' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes(`${filepath}:1 -- myFunc (function)`),
      `Expected filepath:line format, prompt: ${prompt}`
    );
  });

  // -------------------------------------------------------------------------
  // AC-5: No matching symbols → fallback to static template injection
  // -------------------------------------------------------------------------
  test('AC-5: no matching symbols falls back to static template injection', () => {
    // Write a fixture file whose symbol/path do NOT match the query "xyzRouteHandler"
    writeFixtureFile(tmpDir, 'unrelated.js', 'function completelyDifferent() {}\n');

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'xyzRouteHandler' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const result = JSON.parse(stdout);
    const prompt = result.hookSpecificOutput.updatedInput.prompt;

    // Should inject protocol but NOT the LSP phase block
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Expected protocol injection');
    assert.ok(
      !prompt.includes('[LSP Phase -- locations found]'),
      'Must NOT include LSP phase block when no symbols match'
    );
    assert.ok(prompt.includes('xyzRouteHandler'), 'Original prompt preserved');
  });

  // -------------------------------------------------------------------------
  // AC-6: No template + no matching symbols → exit 0 with no output
  // -------------------------------------------------------------------------
  test('AC-6: no template and no matching symbols exits 0 with no output', () => {
    const emptyDir = createTempProject({ withTemplate: false });
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'df-explore-home-'));

    try {
      const input = {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
        cwd: emptyDir,
      };

      const { stdout, code } = runHook(input, { home: fakeHome });
      assert.equal(code, 0);
      assert.equal(stdout, '', 'Expected empty stdout when no template and no symbols match');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // AC-7: Path filtering removes node_modules, .claude/worktrees, dist paths
  // -------------------------------------------------------------------------
  test('AC-7: noise paths filtered out — node_modules, .claude/worktrees, dist, .git', () => {
    // Write a good source file with a symbol name that IS the query
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const goodFile = path.join(srcDir, 'main.ts');
    fs.writeFileSync(goodFile, 'export function targetSymbol() {}\n');

    // Write noise files that also declare targetSymbol but live in noise paths
    const nodeModDir = path.join(tmpDir, 'node_modules', 'lib');
    fs.mkdirSync(nodeModDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModDir, 'index.js'), 'function targetSymbol() {}\n');

    const worktreeDir = path.join(tmpDir, '.claude', 'worktrees', 'branch');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'file.ts'), 'function targetSymbol() {}\n');

    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'bundle.js'), 'function targetSymbol() {}\n');

    const gitDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'pre-commit'), 'function targetSymbol() {}\n');

    const input = {
      // Query "targetSymbol" substring-matches the symbol name in all files,
      // but only the good file should survive the noise-path filter
      tool_input: { subagent_type: 'Explore', prompt: 'targetSymbol' },
      tool_name: 'Agent',
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes(goodFile), 'Good path should be present');
    assert.ok(!prompt.includes('node_modules'), 'node_modules should be filtered');
    assert.ok(!prompt.includes('.claude/worktrees'), '.claude/worktrees should be filtered');
    assert.ok(!prompt.includes('/dist/'), 'dist should be filtered');
    assert.ok(!prompt.includes('.git/hooks'), '.git should be filtered');
  });

  // -------------------------------------------------------------------------
  // AC-7 edge: all symbols in noise paths → falls back to static template (no LSP block)
  // -------------------------------------------------------------------------
  test('AC-7: all symbols filtered → falls back to static template (no LSP block)', () => {
    // Write only a noise file that would match the query but lives in node_modules
    const nodeModDir = path.join(tmpDir, 'node_modules', 'lib');
    fs.mkdirSync(nodeModDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModDir, 'index.js'), 'function badNodeModules() {}\n');

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: functions' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
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
    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt:
          'Find: config\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\nalready here',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);
    // Dedup guard should fire — no output (hook returns without modification)
    assert.equal(stdout, '', 'Expected no output when dedup guard fires');
  });

  test('AC-8: dedup guard — skips injection if LSP Phase already present', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        prompt: 'Find: config\n\n## [LSP Phase -- locations found]\n\n/some/file.ts:10 -- foo (Fn)',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'Expected no output when LSP Phase marker already present');
  });

  // -------------------------------------------------------------------------
  // AC-9: No subprocess means timeout config has no effect — static fallback still works
  // -------------------------------------------------------------------------
  test('AC-9: config with explore_lsp_timeout_ms is ignored — regex extraction always runs inline', () => {
    // Create project with a very short timeout config (no longer relevant, but must not crash)
    const projectWithConfig = createTempProject({
      configYaml: 'explore_lsp_timeout_ms: 100\n',
    });

    // No matching symbols in the project directory
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: symbols' },
      cwd: projectWithConfig,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    // Should fall back to static template since no matching symbols
    const result = JSON.parse(stdout);
    const prompt = result.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Should inject static protocol');
    assert.ok(
      !prompt.includes('[LSP Phase -- locations found]'),
      'Should NOT have LSP block (no matching symbols)'
    );

    fs.rmSync(projectWithConfig, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // AC-10: Exit 0 on malformed JSON input
  // -------------------------------------------------------------------------
  test('AC-10: exits 0 on malformed JSON stdin', () => {
    const { code, stdout } = runHook('not valid json {{ }}');
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

    const { code } = runHook(input);
    assert.equal(code, 0);
  });

  // AC-10: filesystem error (cwd that does not exist)
  test('AC-10: exits 0 when cwd does not exist (filesystem error)', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
      cwd: '/nonexistent/path/that/does/not/exist',
    };

    const { code } = runHook(input);
    assert.equal(code, 0);
  });

  // AC-10: no source files in cwd → fallback to static protocol
  test('AC-10: exits 0 and falls back to static protocol when cwd has no matching source files', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
      cwd: tmpDir,
    };

    const { code, stdout } = runHook(input);
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
    // Write a fixture whose symbol name contains "ApiRoutes" — matches query by substring
    writeFixtureFile(tmpDir, 'api.ts', 'export class ApiRoutes {}\n');

    const input = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'Explore',
        // Query "ApiRoutes" substring-matches the class name
        prompt: 'ApiRoutes',
        model: 'haiku',
        description: 'search for API routes',
        run_in_background: false,
        custom_field: 'custom_value',
      },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const updated = JSON.parse(stdout).hookSpecificOutput.updatedInput;
    assert.equal(updated.subagent_type, 'Explore');
    assert.equal(updated.model, 'haiku');
    assert.equal(updated.description, 'search for API routes');
    assert.equal(updated.run_in_background, false);
    assert.equal(updated.custom_field, 'custom_value');
    // Prompt is modified (has injection) but still contains original text
    assert.ok(updated.prompt.includes('ApiRoutes'));
  });

  test('AC-12: all original tool_input fields preserved after Phase 1 fallback', () => {
    // No matching files → fallback path
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

    const { stdout, code } = runHook(input);
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

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  test('ignores non-Explore agent calls', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reasoner', prompt: 'Analyze this code' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  test('handles case-insensitive subagent_type (EXPLORE)', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'EXPLORE', prompt: 'Find: test utilities' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const result = JSON.parse(stdout);
    assert.ok(result.hookSpecificOutput.updatedInput.prompt.includes('Search Protocol'));
  });

  // -------------------------------------------------------------------------
  // AC-15: Phase 1 filters symbols by substring match on symbol name OR file path
  // -------------------------------------------------------------------------
  test('AC-15: Phase 1 includes symbols matching query in name or filepath', () => {
    // File path contains "database" — all functions in it should be included
    writeFixtureFile(tmpDir, 'database.ts', 'export function connect() {}\nexport function close() {}\n');
    // File name does not match, but symbol name "databaseHelper" contains "database"
    writeFixtureFile(tmpDir, 'utils.ts', 'export function databaseHelper() {}\nexport function unrelated() {}\n');

    // Query "database" matches filepath of database.ts and symbol name databaseHelper
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'database' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes('[LSP Phase -- locations found]'), 'Should have LSP block');
    // databaseHelper matches by symbol name substring
    assert.ok(prompt.includes('databaseHelper'), 'Symbol matching query by name should be included');
    // connect/close match because their file path includes "database"
    assert.ok(prompt.includes('connect'), 'Symbol in matching filepath should be included');
    // unrelated in utils.ts should not be included (path has "utils", not "database"; name "unrelated" doesn't match)
    assert.ok(!prompt.includes('unrelated'), 'Unrelated symbol in non-matching file excluded');
  });

  // -------------------------------------------------------------------------
  // Phase 1 no matching symbols → static fallback
  // -------------------------------------------------------------------------
  test('Phase 1 no matching symbols falls back to static template injection', () => {
    // Write a file with a symbol that does NOT match the query
    writeFixtureFile(tmpDir, 'unrelated.js', 'function completelyDifferent() {}\n');

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: nothing here' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const prompt = JSON.parse(stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes('Search Protocol (auto-injected'), 'Should inject static protocol');
    assert.ok(!prompt.includes('[LSP Phase -- locations found]'), 'No LSP block for empty results');
  });

  // -------------------------------------------------------------------------
  // permissionDecision is always 'allow'
  // -------------------------------------------------------------------------
  test('hookSpecificOutput has permissionDecision allow', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find: something' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'allow');
    assert.equal(out.hookEventName, 'PreToolUse');
  });

  // -------------------------------------------------------------------------
  // Missing prompt field — should inject into empty string base
  // -------------------------------------------------------------------------
  test('handles missing prompt field gracefully', () => {
    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' },
      cwd: tmpDir,
    };

    const { stdout, code } = runHook(input);
    assert.equal(code, 0);

    const updated = JSON.parse(stdout).hookSpecificOutput.updatedInput;
    assert.ok(updated.prompt.includes('Search Protocol'));
  });
});
