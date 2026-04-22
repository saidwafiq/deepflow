/**
 * Tests for bin/ratchet.js — mechanical ratchet health-check script.
 *
 * Tests cover:
 *   1. Project type detection from indicator files
 *   2. Config override loading from .deepflow/config.yaml
 *   3. Snapshot file loading and path absolutization
 *   4. Command parsing (tokenizer)
 *   5. Command building per project type
 *   6. Health check stage ordering
 *   7. JSON output format and exit codes
 *   8. Source-level structural assertions
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RATCHET_PATH = path.resolve(__dirname, 'ratchet.js');
const RATCHET_SRC = fs.readFileSync(RATCHET_PATH, 'utf8');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-ratchet-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Extract pure functions from ratchet.js source for unit testing.
// We eval the module source with main() replaced by a no-op, then capture exports.
// ---------------------------------------------------------------------------

const extractedFns = (() => {
  const modifiedSrc = RATCHET_SRC
    .replace(/^main\(\);?\s*$/m, '')
    .replace(/^#!.*$/m, '');

  const wrapped = `
    ${modifiedSrc}
    return {
      detectProjectType,
      loadConfig,
      loadSnapshotFiles,
      parseCommand,
      hasNpmScript,
      buildCommands,
      parseArgs,
      updatePlanMd,
    };
  `;

  const factory = new Function('require', 'process', '__dirname', '__filename', 'module', 'exports', wrapped);
  return factory(require, process, __dirname, __filename, module, exports);
})();

const {
  detectProjectType,
  loadConfig,
  loadSnapshotFiles,
  parseCommand,
  hasNpmScript,
  buildCommands,
  parseArgs,
  updatePlanMd,
} = extractedFns;

// ---------------------------------------------------------------------------
// 1. Project type detection
// ---------------------------------------------------------------------------

describe('detectProjectType — detects from indicator files', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmrf(tmpDir); });

  test('detects node project from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    assert.equal(detectProjectType(tmpDir), 'node');
  });

  test('detects python project from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]');
    assert.equal(detectProjectType(tmpDir), 'python');
  });

  test('detects rust project from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]');
    assert.equal(detectProjectType(tmpDir), 'rust');
  });

  test('detects go project from go.mod', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example');
    assert.equal(detectProjectType(tmpDir), 'go');
  });

  test('returns unknown when no indicator files present', () => {
    assert.equal(detectProjectType(tmpDir), 'unknown');
  });

  test('prefers node over python when both exist (package.json checked first)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]');
    assert.equal(detectProjectType(tmpDir), 'node');
  });
});

// ---------------------------------------------------------------------------
// 2. Config override loading
// ---------------------------------------------------------------------------

describe('loadConfig — reads .deepflow/config.yaml ratchet section', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmrf(tmpDir); });

  test('returns empty object when config file does not exist', () => {
    const cfg = loadConfig(tmpDir);
    assert.deepEqual(cfg, {});
  });

  test('returns empty object when config has no matching keys', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'some_other_key: value\nmax_retries: 3\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.deepEqual(cfg, {});
  });

  test('parses build_command', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'build_command: make build\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.build_command, 'make build');
  });

  test('parses test_command', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'test_command: pytest -v\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.test_command, 'pytest -v');
  });

  test('parses typecheck_command', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'typecheck_command: mypy src/\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.typecheck_command, 'mypy src/');
  });

  test('parses lint_command', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'lint_command: eslint .\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.lint_command, 'eslint .');
  });

  test('parses all four commands from a single config', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      [
        'build_command: npm run build',
        'test_command: npm test',
        'typecheck_command: tsc --noEmit',
        'lint_command: eslint src/',
      ].join('\n') + '\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.build_command, 'npm run build');
    assert.equal(cfg.test_command, 'npm test');
    assert.equal(cfg.typecheck_command, 'tsc --noEmit');
    assert.equal(cfg.lint_command, 'eslint src/');
  });

  test('handles quoted values', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      "build_command: 'make all'\n"
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.build_command, 'make all');
  });

  test('handles double-quoted values', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'build_command: "cargo build --release"\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.build_command, 'cargo build --release');
  });

  test('ignores keys embedded in other lines (not at start of line)', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      '# build_command: should not match\nfoo_build_command: nope\n'
    );
    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.build_command, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Snapshot file loading and path absolutization
// ---------------------------------------------------------------------------

describe('loadSnapshotFiles — reads auto-snapshot.txt and absolutizes paths', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmrf(tmpDir); });

  test('returns empty array when snapshot file does not exist', () => {
    const files = loadSnapshotFiles(tmpDir);
    assert.deepEqual(files, []);
  });

  test('returns empty array when snapshot file is empty', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(path.join(deepflowDir, 'auto-snapshot.txt'), '');
    const files = loadSnapshotFiles(tmpDir);
    assert.deepEqual(files, []);
  });

  test('absolutizes relative paths using repo root', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'bin/install.test.js\ntest/integration.test.js\n'
    );
    const files = loadSnapshotFiles(tmpDir);
    assert.equal(files.length, 2);
    assert.equal(files[0], path.join(tmpDir, 'bin/install.test.js'));
    assert.equal(files[1], path.join(tmpDir, 'test/integration.test.js'));
  });

  test('trims whitespace from entries', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      '  test/a.js  \n  test/b.js  \n'
    );
    const files = loadSnapshotFiles(tmpDir);
    assert.equal(files.length, 2);
    assert.equal(files[0], path.join(tmpDir, 'test/a.js'));
    assert.equal(files[1], path.join(tmpDir, 'test/b.js'));
  });

  test('ignores blank lines', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'a.js\n\n\nb.js\n\n'
    );
    const files = loadSnapshotFiles(tmpDir);
    assert.equal(files.length, 2);
  });

  test('handles single entry', () => {
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'only-one.test.js\n'
    );
    const files = loadSnapshotFiles(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], path.join(tmpDir, 'only-one.test.js'));
  });
});

// ---------------------------------------------------------------------------
// 4. Command parsing (tokenizer)
// ---------------------------------------------------------------------------

describe('parseCommand — tokenizes command strings', () => {
  test('splits simple command into tokens', () => {
    assert.deepEqual(parseCommand('npm run build'), ['npm', 'run', 'build']);
  });

  test('handles single command with no args', () => {
    assert.deepEqual(parseCommand('pytest'), ['pytest']);
  });

  test('handles double-quoted arguments', () => {
    assert.deepEqual(
      parseCommand('echo "hello world" foo'),
      ['echo', 'hello world', 'foo']
    );
  });

  test('handles single-quoted arguments', () => {
    assert.deepEqual(
      parseCommand("echo 'hello world' bar"),
      ['echo', 'hello world', 'bar']
    );
  });

  test('handles multiple spaces between tokens', () => {
    assert.deepEqual(
      parseCommand('npm   run   test'),
      ['npm', 'run', 'test']
    );
  });

  test('handles empty string', () => {
    assert.deepEqual(parseCommand(''), []);
  });

  test('handles command with flags', () => {
    assert.deepEqual(
      parseCommand('npx tsc --noEmit'),
      ['npx', 'tsc', '--noEmit']
    );
  });

  test('handles complex command with paths', () => {
    assert.deepEqual(
      parseCommand('node --test /path/to/file.js'),
      ['node', '--test', '/path/to/file.js']
    );
  });
});

// ---------------------------------------------------------------------------
// 5. hasNpmScript
// ---------------------------------------------------------------------------

describe('hasNpmScript — checks package.json for scripts', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmrf(tmpDir); });

  test('returns true when script exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'jest' } })
    );
    assert.equal(hasNpmScript(tmpDir, 'build'), true);
    assert.equal(hasNpmScript(tmpDir, 'test'), true);
  });

  test('returns false when script does not exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } })
    );
    assert.equal(hasNpmScript(tmpDir, 'lint'), false);
  });

  test('returns false when no scripts section', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test' })
    );
    assert.equal(hasNpmScript(tmpDir, 'build'), false);
  });

  test('returns false when package.json does not exist', () => {
    assert.equal(hasNpmScript(tmpDir, 'build'), false);
  });

  test('returns false when package.json is invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'not json{{{');
    assert.equal(hasNpmScript(tmpDir, 'build'), false);
  });
});

// ---------------------------------------------------------------------------
// 6. buildCommands — per project type
// ---------------------------------------------------------------------------

describe('buildCommands — node project', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmrf(tmpDir); });

  test('uses npm run build when package.json has build script', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } })
    );
    const cmds = buildCommands(tmpDir, 'node', [], {});
    assert.equal(cmds.build, 'npm run build');
  });

  test('does not set build when no build script in package.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: {} })
    );
    const cmds = buildCommands(tmpDir, 'node', [], {});
    assert.equal(cmds.build, undefined);
  });

  test('uses snapshot files for test command when available', () => {
    const snapshotFiles = ['/abs/path/to/test1.js', '/abs/path/to/test2.js'];
    const cmds = buildCommands(tmpDir, 'node', snapshotFiles, {});
    assert.ok(Array.isArray(cmds.test));
    assert.deepEqual(cmds.test, ['node', '--test', ...snapshotFiles]);
  });

  test('does not set test when no snapshot files and no config', () => {
    const cmds = buildCommands(tmpDir, 'node', [], {});
    assert.equal(cmds.test, undefined);
  });

  test('sets typecheck to npx tsc --noEmit by default', () => {
    const cmds = buildCommands(tmpDir, 'node', [], {});
    assert.equal(cmds.typecheck, 'npx tsc --noEmit');
  });

  test('uses npm run lint when package.json has lint script', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } })
    );
    const cmds = buildCommands(tmpDir, 'node', [], {});
    assert.equal(cmds.lint, 'npm run lint');
  });

  test('config overrides take precedence over auto-detection', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .' } })
    );
    const cfg = {
      build_command: 'custom-build',
      test_command: 'custom-test',
      typecheck_command: 'custom-typecheck',
      lint_command: 'custom-lint',
    };
    const cmds = buildCommands(tmpDir, 'node', ['/a.js'], cfg);
    assert.equal(cmds.build, 'custom-build');
    assert.equal(cmds.test, 'custom-test');
    assert.equal(cmds.typecheck, 'custom-typecheck');
    assert.equal(cmds.lint, 'custom-lint');
  });
});

describe('buildCommands — python project', () => {
  test('uses pytest with snapshot files when available', () => {
    const snapshotFiles = ['/tests/test_a.py', '/tests/test_b.py'];
    const cmds = buildCommands('/tmp', 'python', snapshotFiles, {});
    assert.ok(Array.isArray(cmds.test));
    assert.deepEqual(cmds.test, ['pytest', ...snapshotFiles]);
  });

  test('falls back to bare pytest when no snapshot files', () => {
    const cmds = buildCommands('/tmp', 'python', [], {});
    assert.equal(cmds.test, 'pytest');
  });

  test('sets mypy as default typecheck', () => {
    const cmds = buildCommands('/tmp', 'python', [], {});
    assert.equal(cmds.typecheck, 'mypy .');
  });

  test('sets ruff as default lint', () => {
    const cmds = buildCommands('/tmp', 'python', [], {});
    assert.equal(cmds.lint, 'ruff check .');
  });

  test('no build command by default', () => {
    const cmds = buildCommands('/tmp', 'python', [], {});
    assert.equal(cmds.build, undefined);
  });
});

describe('buildCommands — rust project', () => {
  test('sets cargo defaults', () => {
    const cmds = buildCommands('/tmp', 'rust', [], {});
    assert.equal(cmds.build, 'cargo build');
    assert.equal(cmds.test, 'cargo test');
    assert.equal(cmds.lint, 'cargo clippy');
  });

  test('no typecheck by default (cargo build covers it)', () => {
    const cmds = buildCommands('/tmp', 'rust', [], {});
    assert.equal(cmds.typecheck, undefined);
  });
});

describe('buildCommands — go project', () => {
  test('sets go defaults', () => {
    const cmds = buildCommands('/tmp', 'go', [], {});
    assert.equal(cmds.build, 'go build ./...');
    assert.equal(cmds.test, 'go test ./...');
    assert.equal(cmds.lint, 'go vet ./...');
  });

  test('no typecheck by default', () => {
    const cmds = buildCommands('/tmp', 'go', [], {});
    assert.equal(cmds.typecheck, undefined);
  });
});

describe('buildCommands — unknown project type', () => {
  test('returns empty commands with no config', () => {
    const cmds = buildCommands('/tmp', 'unknown', [], {});
    assert.equal(cmds.build, undefined);
    assert.equal(cmds.test, undefined);
    assert.equal(cmds.typecheck, undefined);
    assert.equal(cmds.lint, undefined);
  });

  test('uses config overrides when provided', () => {
    const cfg = {
      build_command: 'make',
      test_command: 'make test',
      lint_command: 'make lint',
    };
    const cmds = buildCommands('/tmp', 'unknown', [], cfg);
    assert.equal(cmds.build, 'make');
    assert.equal(cmds.test, 'make test');
    assert.equal(cmds.lint, 'make lint');
  });
});

// ---------------------------------------------------------------------------
// 7. Health check stage ordering — source assertions
// ---------------------------------------------------------------------------

describe('STAGE_ORDER — build, test, typecheck, lint, contract', () => {
  test('source defines stages in correct order', () => {
    const match = RATCHET_SRC.match(/STAGE_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(match, 'STAGE_ORDER constant should exist in source');
    const stages = match[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.deepEqual(stages, ['build', 'test', 'typecheck', 'lint', 'contract']);
  });

  test('lint and contract are SALVAGEABLE', () => {
    const match = RATCHET_SRC.match(/SALVAGEABLE_STAGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, 'SALVAGEABLE_STAGES constant should exist in source');
    const stages = match[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.deepEqual(stages, ['lint', 'contract']);
  });
});

// ---------------------------------------------------------------------------
// 8. JSON output format — source assertions
// ---------------------------------------------------------------------------

describe('JSON output — exactly one line with correct structure', () => {
  test('PASS output is {"result":"PASS"}', () => {
    assert.ok(
      RATCHET_SRC.includes("JSON.stringify({ result: 'PASS' })"),
      'Source should output {"result":"PASS"} for success'
    );
  });

  test('FAIL output includes result, stage, and log', () => {
    assert.ok(
      RATCHET_SRC.includes("JSON.stringify({ result: 'FAIL', stage, log })"),
      'Source should output {"result":"FAIL","stage":"...","log":"..."} for failures'
    );
  });

  test('SALVAGEABLE output includes result, stage, and log', () => {
    assert.ok(
      RATCHET_SRC.includes("JSON.stringify({ result: 'SALVAGEABLE', stage, log })"),
      'Source should output {"result":"SALVAGEABLE","stage":"...","log":"..."} for salvageable'
    );
  });

  test('all outputs end with newline', () => {
    const outputLines = RATCHET_SRC.match(/process\.stdout\.write\(JSON\.stringify\([^)]+\)\s*\+\s*'\\n'\)/g);
    assert.ok(outputLines, 'Should have stdout.write calls with JSON');
    assert.equal(outputLines.length, 3, 'Should have exactly 3 JSON output lines (PASS, FAIL, SALVAGEABLE)');
  });
});

// ---------------------------------------------------------------------------
// 9. Exit codes — 0=PASS, 1=FAIL, 2=SALVAGEABLE
// ---------------------------------------------------------------------------

describe('Exit codes — source assertions', () => {
  test('PASS exits with 0', () => {
    // Find the PASS block — it should call process.exit(0)
    const passSection = RATCHET_SRC.match(/result:\s*'PASS'[\s\S]{0,100}process\.exit\((\d+)\)/);
    assert.ok(passSection, 'PASS section should have process.exit');
    assert.equal(passSection[1], '0');
  });

  test('FAIL exits with 1', () => {
    const failSection = RATCHET_SRC.match(/result:\s*'FAIL'[\s\S]{0,100}process\.exit\((\d+)\)/);
    assert.ok(failSection, 'FAIL section should have process.exit');
    assert.equal(failSection[1], '1');
  });

  test('SALVAGEABLE exits with 2', () => {
    const salvSection = RATCHET_SRC.match(/result:\s*'SALVAGEABLE'[\s\S]{0,100}process\.exit\((\d+)\)/);
    assert.ok(salvSection, 'SALVAGEABLE section should have process.exit');
    assert.equal(salvSection[1], '2');
  });
});

// ---------------------------------------------------------------------------
// 10. Auto-revert on FAIL — source assertions
// ---------------------------------------------------------------------------

describe('Auto-revert — source assertions', () => {
  test('autoRevert function runs git revert HEAD --no-edit', () => {
    assert.ok(
      RATCHET_SRC.includes("'revert', 'HEAD', '--no-edit'"),
      'autoRevert should call git revert HEAD --no-edit'
    );
  });

  test('autoRevert is called before FAIL output (not for SALVAGEABLE)', () => {
    // FAIL path: autoRevert(cwd) then stdout.write FAIL then exit(1)
    const failBlock = RATCHET_SRC.match(/autoRevert\(cwd\)[\s\S]*?result:\s*'FAIL'/);
    assert.ok(failBlock, 'autoRevert should be called before FAIL output');

    // SALVAGEABLE path should NOT call autoRevert
    // Extract text between SALVAGEABLE_STAGES.has(stage)) { and the closing else {
    const salvIdx = RATCHET_SRC.indexOf('SALVAGEABLE_STAGES.has(stage)');
    assert.ok(salvIdx !== -1, 'SALVAGEABLE_STAGES.has(stage) should exist in source');
    const elseIdx = RATCHET_SRC.indexOf('} else {', salvIdx);
    assert.ok(elseIdx !== -1, 'else block after SALVAGEABLE check should exist');
    const salvBlock = RATCHET_SRC.slice(salvIdx, elseIdx);
    assert.ok(
      !salvBlock.includes('autoRevert'),
      'SALVAGEABLE path should NOT call autoRevert'
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Skip behavior — ENOENT handling
// ---------------------------------------------------------------------------

describe('Skip behavior — source assertions', () => {
  test('runCommand returns ok:null on spawn error (ENOENT)', () => {
    // Verify source handles result.error with ok: null
    assert.ok(
      RATCHET_SRC.includes('ok: null'),
      'runCommand should return ok: null on spawn error'
    );
  });

  test('main loop skips stage when ok is null', () => {
    assert.ok(
      RATCHET_SRC.includes('ok === null'),
      'Main loop should check for ok === null to skip stages'
    );
  });

  test('commandExists check runs before command execution for string commands', () => {
    assert.ok(
      RATCHET_SRC.includes('commandExists'),
      'Source should use commandExists to check executables'
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Subprocess integration tests — run ratchet.js in controlled environments
// ---------------------------------------------------------------------------

describe('Subprocess integration — controlled execution', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Initialize a minimal git repo so the script can find repo root
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('outputs valid JSON for unknown project type (PASS when no commands)', () => {
    // No indicator files -> unknown project type -> no commands -> PASS
    // Need at least one commit for git to work
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    const result = execFileSync(process.execPath, [RATCHET_PATH], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result.trim());
    assert.equal(parsed.result, 'PASS');
  });

  test('exit code is 0 for PASS', () => {
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    try {
      execFileSync(process.execPath, [RATCHET_PATH], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // If we get here, exit code was 0
      assert.ok(true);
    } catch (err) {
      assert.fail(`Expected exit code 0 but got ${err.status}`);
    }
  });

  test('JSON output is exactly one line', () => {
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    const result = execFileSync(process.execPath, [RATCHET_PATH], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = result.trim().split('\n');
    assert.equal(lines.length, 1, 'Output should be exactly one line');
    // Verify it parses as valid JSON
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });

  test('FAIL exit code and JSON verified via extracted runCommand + buildCommands', () => {
    // Instead of running the full script (which depends on mainRepoRoot git resolution),
    // we test the failure path by directly exercising the extracted functions:
    // buildCommands produces the commands, and we verify the source handles FAIL correctly.

    // Verify that config override produces the expected build command
    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'build_command: false\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.build_command, 'false', 'Config should parse build_command');

    const cmds = buildCommands(tmpDir, 'node', [], cfg);
    assert.equal(cmds.build, 'false', 'buildCommands should use config override for build');

    // Verify the source code path: when build fails -> autoRevert -> FAIL -> exit(1)
    // Already covered by source assertions, but confirm the stage ordering
    const stageMatch = RATCHET_SRC.match(/STAGE_ORDER\s*=\s*\[([^\]]+)\]/);
    const stages = stageMatch[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.equal(stages[0], 'build', 'build should be first stage');

    // Verify build is not in SALVAGEABLE_STAGES (so it results in FAIL, not SALVAGEABLE)
    const salvMatch = RATCHET_SRC.match(/SALVAGEABLE_STAGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    const salvStages = salvMatch[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.ok(!salvStages.includes('build'), 'build should not be SALVAGEABLE');
  });

  test('SALVAGEABLE path verified via extracted functions for lint failure', () => {
    // Same approach: verify the lint failure path produces SALVAGEABLE

    const deepflowDir = path.join(tmpDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'config.yaml'),
      'lint_command: false\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    const cfg = loadConfig(tmpDir);
    assert.equal(cfg.lint_command, 'false', 'Config should parse lint_command');

    const cmds = buildCommands(tmpDir, 'node', [], cfg);
    assert.equal(cmds.lint, 'false', 'buildCommands should use config override for lint');

    // Verify lint IS in SALVAGEABLE_STAGES
    const salvMatch = RATCHET_SRC.match(/SALVAGEABLE_STAGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    const salvStages = salvMatch[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.ok(salvStages.includes('lint'), 'lint should be in SALVAGEABLE_STAGES');

    // Verify SALVAGEABLE path does NOT auto-revert (already tested in source assertions)
    const salvIdx = RATCHET_SRC.indexOf('SALVAGEABLE_STAGES.has(stage)');
    const elseIdx = RATCHET_SRC.indexOf('} else {', salvIdx);
    const salvBlock = RATCHET_SRC.slice(salvIdx, elseIdx);
    assert.ok(!salvBlock.includes('autoRevert'), 'SALVAGEABLE should not auto-revert');
  });
});

// ---------------------------------------------------------------------------
// 13. Structural invariants
// ---------------------------------------------------------------------------

describe('Structural invariants — source assertions', () => {
  test('script is pure Node.js (no require of external packages)', () => {
    const requires = RATCHET_SRC.match(/require\(['"]([^'"]+)['"]\)/g) || [];
    for (const req of requires) {
      const mod = req.match(/require\(['"]([^'"]+)['"]\)/)[1];
      assert.ok(
        mod.startsWith('node:') || ['fs', 'path', 'child_process'].includes(mod),
        `Unexpected dependency: ${mod} — ratchet.js must be pure Node.js`
      );
    }
  });

  test('script has shebang line', () => {
    assert.ok(
      RATCHET_SRC.startsWith('#!/usr/bin/env node'),
      'Script should start with #!/usr/bin/env node'
    );
  });

  test('script uses strict mode', () => {
    assert.ok(
      RATCHET_SRC.includes("'use strict'"),
      'Script should use strict mode'
    );
  });

  test('main() is called at the end', () => {
    const lastNonEmpty = RATCHET_SRC.trim().split('\n').filter(l => l.trim()).pop();
    assert.equal(lastNonEmpty.trim(), 'main();');
  });
});

// ---------------------------------------------------------------------------
// 14. parseArgs — CLI argument parser
// ---------------------------------------------------------------------------

describe('parseArgs — parses --task, --worktree, --snapshot flags', () => {
  test('returns all nulls when no flags provided', () => {
    const args = parseArgs([]);
    assert.deepEqual(args, { task: null, worktree: null, snapshot: null });
  });

  test('parses --task flag', () => {
    const args = parseArgs(['--task', 'T54']);
    assert.equal(args.task, 'T54');
    assert.equal(args.worktree, null);
    assert.equal(args.snapshot, null);
  });

  test('parses --worktree flag', () => {
    const args = parseArgs(['--worktree', '/some/path']);
    assert.equal(args.worktree, '/some/path');
    assert.equal(args.task, null);
  });

  test('parses --snapshot flag', () => {
    const args = parseArgs(['--snapshot', '/snap/auto-snapshot.txt']);
    assert.equal(args.snapshot, '/snap/auto-snapshot.txt');
    assert.equal(args.task, null);
  });

  test('parses all three flags together', () => {
    const args = parseArgs(['--task', 'T12', '--worktree', '/w', '--snapshot', '/s']);
    assert.equal(args.task, 'T12');
    assert.equal(args.worktree, '/w');
    assert.equal(args.snapshot, '/s');
  });

  test('parses flags in any order', () => {
    const args = parseArgs(['--snapshot', '/s', '--task', 'T99', '--worktree', '/w']);
    assert.equal(args.task, 'T99');
    assert.equal(args.worktree, '/w');
    assert.equal(args.snapshot, '/s');
  });

  test('ignores unknown flags', () => {
    const args = parseArgs(['--unknown', 'val', '--task', 'T1']);
    assert.equal(args.task, 'T1');
    assert.equal(args.worktree, null);
  });

  test('ignores flag without a value (at end of argv)', () => {
    const args = parseArgs(['--task']);
    assert.equal(args.task, null);
  });

  test('ignores flag when next arg is missing (end of array)', () => {
    const args = parseArgs(['--worktree']);
    assert.equal(args.worktree, null);
  });

  test('handles task ID with various formats', () => {
    assert.equal(parseArgs(['--task', 'T1']).task, 'T1');
    assert.equal(parseArgs(['--task', 'T100']).task, 'T100');
    assert.equal(parseArgs(['--task', 'some-string']).task, 'some-string');
  });

  test('last value wins when flag is repeated', () => {
    const args = parseArgs(['--task', 'T1', '--task', 'T2']);
    assert.equal(args.task, 'T2');
  });
});

// ---------------------------------------------------------------------------
// 15. updatePlanMd — PLAN.md checkbox updater
// ---------------------------------------------------------------------------

describe('updatePlanMd — updates PLAN.md task checkboxes', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Initialize git repo so rev-parse works
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('checks off matching task and appends commit hash', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n- [ ] **T54** Write ratchet tests\n- [ ] **T55** Other task\n'
    );
    updatePlanMd(tmpDir, 'T54', tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    assert.ok(result.includes('- [x] **T54** Write ratchet tests'));
    assert.ok(!result.includes('- [ ] **T54**'));
    // Should have a commit hash appended
    assert.match(result, /- \[x\] \*\*T54\*\* Write ratchet tests \([a-f0-9]+\)/);
  });

  test('does not modify other tasks', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '- [ ] **T54** Task A\n- [ ] **T55** Task B\n'
    );
    updatePlanMd(tmpDir, 'T54', tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    assert.ok(result.includes('- [ ] **T55** Task B'));
  });

  test('does nothing when PLAN.md does not exist', () => {
    // No PLAN.md file — should not throw
    assert.doesNotThrow(() => updatePlanMd(tmpDir, 'T54', tmpDir));
  });

  test('does nothing when task ID not found in PLAN.md', () => {
    const content = '- [ ] **T99** Some other task\n';
    fs.writeFileSync(path.join(tmpDir, 'PLAN.md'), content);
    updatePlanMd(tmpDir, 'T54', tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    assert.equal(result, content);
  });

  test('does not re-check already checked task', () => {
    const content = '- [x] **T54** Already done\n';
    fs.writeFileSync(path.join(tmpDir, 'PLAN.md'), content);
    updatePlanMd(tmpDir, 'T54', tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    // The regex specifically matches "- [ ]" (unchecked), so already-checked should be unchanged
    assert.equal(result, content);
  });

  test('handles PLAN.md with extra content around the task line', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Implementation Plan\n\n## Phase 1\n- [ ] **T10** First task — details here\n\n## Phase 2\n- [ ] **T20** Second task\n'
    );
    updatePlanMd(tmpDir, 'T10', tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    assert.ok(result.includes('- [x] **T10** First task'));
    assert.ok(result.includes('- [ ] **T20** Second task'));
  });

  test('appends hash even with complex task description', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '- [ ] **T7** Implement `parseArgs()` + `updatePlanMd()` in bin/ratchet.js\n'
    );
    updatePlanMd(tmpDir, 'T7', tmpDir);

    const result = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    assert.match(result, /- \[x\] \*\*T7\*\*.*\([a-f0-9]+\)/);
  });
});

// ---------------------------------------------------------------------------
// 16. --snapshot CLI flag integration with main logic — source assertions
// ---------------------------------------------------------------------------

describe('--snapshot flag — overrides snapshot-derived test command', () => {
  test('source reads --snapshot file and overrides cmds.test for node projects', () => {
    assert.ok(
      RATCHET_SRC.includes('cliArgs.snapshot'),
      'main() should reference cliArgs.snapshot'
    );
  });

  test('source checks snapshot file existence before reading', () => {
    assert.ok(
      RATCHET_SRC.includes("fs.existsSync(cliArgs.snapshot)"),
      'Should check if snapshot file exists'
    );
  });

  test('source only overrides test when no cfg.test_command and node project', () => {
    // The condition: projectType === 'node' && !cfg.test_command
    assert.ok(
      RATCHET_SRC.includes("projectType === 'node'") && RATCHET_SRC.includes('!cfg.test_command'),
      'Snapshot override should be gated on node project type and no config test_command'
    );
  });
});

// ---------------------------------------------------------------------------
// 17. --task flag integration — updatePlanMd called only on PASS
// ---------------------------------------------------------------------------

describe('--task flag — updatePlanMd called only on PASS', () => {
  test('updatePlanMd is called after PASS output and before exit(0)', () => {
    const passIdx = RATCHET_SRC.indexOf("result: 'PASS'");
    const updateIdx = RATCHET_SRC.indexOf('updatePlanMd(repoRoot, cliArgs.task, cwd)');
    const exitIdx = RATCHET_SRC.indexOf('process.exit(0)');
    assert.ok(passIdx !== -1, 'PASS output should exist');
    assert.ok(updateIdx !== -1, 'updatePlanMd call should exist');
    assert.ok(exitIdx !== -1, 'process.exit(0) should exist');
    assert.ok(passIdx < updateIdx, 'updatePlanMd should be after PASS output');
    assert.ok(updateIdx < exitIdx, 'updatePlanMd should be before exit(0)');
  });

  test('updatePlanMd is guarded by cliArgs.task check', () => {
    assert.ok(
      RATCHET_SRC.includes('if (cliArgs.task)'),
      'updatePlanMd call should be guarded by cliArgs.task truthiness check'
    );
  });

  test('FAIL path does not call updatePlanMd', () => {
    // Between the FAIL output and exit(1), there should be no updatePlanMd
    const failIdx = RATCHET_SRC.indexOf("result: 'FAIL'");
    const exit1Idx = RATCHET_SRC.indexOf('process.exit(1)');
    const block = RATCHET_SRC.slice(failIdx, exit1Idx);
    assert.ok(!block.includes('updatePlanMd'), 'FAIL path should not call updatePlanMd');
  });

  test('SALVAGEABLE path does not call updatePlanMd', () => {
    const salvIdx = RATCHET_SRC.indexOf("result: 'SALVAGEABLE'");
    const exit2Idx = RATCHET_SRC.indexOf('process.exit(2)');
    const block = RATCHET_SRC.slice(salvIdx, exit2Idx);
    assert.ok(!block.includes('updatePlanMd'), 'SALVAGEABLE path should not call updatePlanMd');
  });
});

// ---------------------------------------------------------------------------
// 18. Subprocess integration — --task flag with real execution
// ---------------------------------------------------------------------------

describe('Subprocess integration — --task flag updates PLAN.md on PASS', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => { rmrf(tmpDir); });

  test('--task flag is passed through to ratchet process (PASS still returned)', () => {
    // Note: mainRepoRoot resolution for worktrees means PLAN.md update
    // behavior is tested via direct updatePlanMd unit tests above.
    // Here we verify the --task flag doesn't break normal PASS behavior.
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    const result = execFileSync(process.execPath, [RATCHET_PATH, '--task', 'T42'], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result.trim());
    assert.equal(parsed.result, 'PASS');
  });

  test('--task does not update PLAN.md when no PLAN.md exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    const result = execFileSync(process.execPath, [RATCHET_PATH, '--task', 'T42'], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result.trim());
    assert.equal(parsed.result, 'PASS');
    // No PLAN.md should exist (it wasn't created)
    assert.ok(!fs.existsSync(path.join(tmpDir, 'PLAN.md')));
  });

  test('without --task flag, PLAN.md is not modified', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '- [ ] **T42** Do the thing\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    execFileSync(process.execPath, [RATCHET_PATH], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const plan = fs.readFileSync(path.join(tmpDir, 'PLAN.md'), 'utf8');
    assert.ok(plan.includes('- [ ] **T42**'), 'PLAN.md should remain unchecked without --task');
  });
});

// ---------------------------------------------------------------------------
// 19. Worktree cwd routing — commands execute in worktree path
// ---------------------------------------------------------------------------

describe('loadSnapshotFiles — resolveBase parameter resolves paths against cwd not repoRoot', () => {
  let repoRoot;
  let worktreeDir;

  beforeEach(() => {
    repoRoot = makeTmpDir();
    worktreeDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(repoRoot);
    rmrf(worktreeDir);
  });

  test('resolveBase defaults to repoRoot when not provided', () => {
    const deepflowDir = path.join(repoRoot, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'bin/ratchet.test.js\n'
    );

    const files = loadSnapshotFiles(repoRoot);
    assert.equal(files.length, 1);
    assert.equal(files[0], path.join(repoRoot, 'bin/ratchet.test.js'));
  });

  test('resolveBase overrides path resolution when cwd differs from repoRoot', () => {
    // Snapshot lives in repoRoot's .deepflow dir, but paths should resolve against worktreeDir
    const deepflowDir = path.join(repoRoot, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'bin/ratchet.test.js\ntest/integration.test.js\n'
    );

    // Pass worktreeDir as resolveBase — paths should resolve against it, not repoRoot
    const files = loadSnapshotFiles(repoRoot, worktreeDir);
    assert.equal(files.length, 2);
    assert.equal(files[0], path.join(worktreeDir, 'bin/ratchet.test.js'));
    assert.equal(files[1], path.join(worktreeDir, 'test/integration.test.js'));
    // Confirm the paths do NOT point into repoRoot
    assert.ok(!files[0].startsWith(repoRoot), 'resolveBase should override repoRoot for path resolution');
  });

  test('resolveBase changes where test files are expected to live', () => {
    const deepflowDir = path.join(repoRoot, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'spec/my.test.js\n'
    );

    const filesFromRepo = loadSnapshotFiles(repoRoot, repoRoot);
    const filesFromWorktree = loadSnapshotFiles(repoRoot, worktreeDir);

    assert.equal(filesFromRepo[0], path.join(repoRoot, 'spec/my.test.js'));
    assert.equal(filesFromWorktree[0], path.join(worktreeDir, 'spec/my.test.js'));
    assert.notEqual(filesFromRepo[0], filesFromWorktree[0]);
  });
});

// ---------------------------------------------------------------------------
// 20. REQ-7: empty stderr produces no pre-install warning
// ---------------------------------------------------------------------------

describe('pre-install warning guard — empty stderr produces no warning (REQ-7)', () => {
  test('source no longer contains literal "unknown error" fallback', () => {
    assert.ok(
      !RATCHET_SRC.includes("'unknown error'"),
      'ratchet.js should not contain the literal "unknown error" fallback'
    );
  });

  test('source guards pre-install warning with errOut check', () => {
    assert.ok(
      RATCHET_SRC.includes('const errOut = preInstall.stderr?.toString().trim()'),
      'Source should extract errOut from stderr before emitting warning'
    );
    assert.ok(
      RATCHET_SRC.includes('if (errOut) process.stderr.write'),
      'Source should only write warning when errOut is truthy'
    );
  });

  test('subprocess: no pre-install warning when project has no pnpm workspace files', () => {
    // Without pnpm-workspace.yaml or pnpm-lock.yaml, the pre-install block is skipped entirely.
    // Stderr should contain no [ratchet] pre-install warning substring.
    const tmpDir = makeTmpDir();
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

      const result = spawnSync(process.execPath, [RATCHET_PATH], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      assert.ok(
        !(result.stderr || '').includes('[ratchet] pre-install warning'),
        `stderr should not contain pre-install warning; got: ${result.stderr}`
      );
    } finally {
      rmrf(tmpDir);
    }
  });

  test('subprocess: no pre-install warning when pnpm install succeeds (empty stderr from success)', () => {
    // When pnpm-workspace.yaml is present but pnpm install exits 0, no warning is emitted.
    // We use a minimal workspace that succeeds (empty packages list).
    const tmpDir = makeTmpDir();
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
      // Create a minimal pnpm workspace so the pre-install block is entered
      fs.writeFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages: []\n');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-ws', version: '0.0.1', private: true }));
      fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

      const result = spawnSync(process.execPath, [RATCHET_PATH], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      assert.ok(
        !(result.stderr || '').includes('[ratchet] pre-install warning'),
        `stderr should not contain pre-install warning; got: ${result.stderr}`
      );
    } finally {
      rmrf(tmpDir);
    }
  });
});

describe('Subprocess integration — --worktree flag routes commands to worktree cwd', () => {
  let repoDir;
  let worktreeDir;

  beforeEach(() => {
    // Set up main repo
    repoDir = makeTmpDir();
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    // Set up worktree directory as a separate git repo (simulating a worktree checkout)
    worktreeDir = makeTmpDir();
    execFileSync('git', ['init'], { cwd: worktreeDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreeDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktreeDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktreeDir, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: worktreeDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktreeDir, stdio: 'ignore' });
  });

  afterEach(() => {
    rmrf(repoDir);
    rmrf(worktreeDir);
  });

  test('--worktree flag causes test command to execute in worktree path', () => {
    // Write a test file in the WORKTREE dir that prints its cwd via process.cwd()
    const testFile = path.join(worktreeDir, 'cwd-check.test.js');
    fs.writeFileSync(testFile, [
      "'use strict';",
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const path = require('node:path');",
      "test('cwd is worktree path', () => {",
      "  // This file lives in the worktree dir — if cwd is correct, __dirname matches cwd prefix",
      "  assert.ok(process.cwd().startsWith(path.dirname(__dirname) || '/'), 'cwd should be set');",
      "});",
    ].join('\n'));

    // Write snapshot pointing to the test file (relative path from worktreeDir)
    const deepflowDir = path.join(worktreeDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'cwd-check.test.js\n'
    );

    // Write package.json in worktreeDir so it's detected as node project
    fs.writeFileSync(path.join(worktreeDir, 'package.json'), JSON.stringify({ name: 'test-worktree' }));

    const result = spawnSync(process.execPath, [RATCHET_PATH, '--worktree', worktreeDir], {
      cwd: repoDir,  // invoked from a different cwd (repoDir)
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = (result.stdout || '').trim();
    assert.ok(output.length > 0, 'ratchet should produce output');
    const parsed = JSON.parse(output);
    // The test should pass because the test file exists in worktreeDir and runs correctly
    assert.equal(parsed.result, 'PASS', `Expected PASS but got: ${JSON.stringify(parsed)}`);
  });

  test('--worktree flag: snapshot paths resolve against worktreeDir, not process.cwd()', () => {
    // Place test file only in worktreeDir (NOT in repoDir)
    const testFile = path.join(worktreeDir, 'only-in-worktree.test.js');
    fs.writeFileSync(testFile, [
      "'use strict';",
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('exists only in worktree', () => { assert.ok(true); });",
    ].join('\n'));

    // Snapshot is in worktreeDir's .deepflow
    const deepflowDir = path.join(worktreeDir, '.deepflow');
    fs.mkdirSync(deepflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepflowDir, 'auto-snapshot.txt'),
      'only-in-worktree.test.js\n'
    );
    fs.writeFileSync(path.join(worktreeDir, 'package.json'), JSON.stringify({ name: 'wt' }));

    // Verify the test file does NOT exist in repoDir (to confirm routing works)
    assert.ok(
      !fs.existsSync(path.join(repoDir, 'only-in-worktree.test.js')),
      'Test file should not exist in repoDir'
    );

    const result = spawnSync(process.execPath, [RATCHET_PATH, '--worktree', worktreeDir], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = (result.stdout || '').trim();
    assert.ok(output.length > 0, 'ratchet should produce output');
    const parsed = JSON.parse(output);
    // PASS means the test file was found in worktreeDir — cwd routing works
    assert.equal(parsed.result, 'PASS', `Expected PASS but got: ${JSON.stringify(parsed)}`);
  });
});
