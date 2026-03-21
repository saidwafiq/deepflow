/**
 * Integration tests for ratchet-hardening spec.
 *
 * Covers ALL acceptance criteria (AC-1 through AC-6) via public interfaces:
 *   - bin/ratchet.js: run as child process, check JSON stdout + exit codes
 *   - hooks/df-snapshot-guard.js: pipe JSON to stdin, check exit code + stderr
 *   - src/commands/df/execute.md: read file, assert required content patterns
 *
 * NOTE on FAIL/SALVAGEABLE subprocess tests:
 *   ratchet.js resolves the "main repo root" via git --git-common-dir and walks
 *   up two parent directories. This means config/snapshot files must be placed
 *   at the resolved mainRepoRoot, which does NOT match the temp dir's own
 *   .deepflow/ in isolated test environments. PASS tests work because unknown
 *   project type with no commands defaults to PASS. For FAIL/SALVAGEABLE
 *   behaviors, we verify through source-level structural assertions (checking
 *   the script file contains the right code patterns) as supplementary coverage.
 *
 * Uses Node.js built-in node:test (CommonJS) to match project conventions.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RATCHET_PATH = path.join(ROOT, 'bin', 'ratchet.js');
const RATCHET_SRC = fs.readFileSync(RATCHET_PATH, 'utf8');
const HOOK_PATH = path.join(ROOT, 'hooks', 'df-snapshot-guard.js');
const EXECUTE_PATH = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-ratchet-integ-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'dummy.txt'), 'init');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

/** Run bin/ratchet.js as a child process. Returns { stdout, stderr, code }. */
function runRatchet(cwd) {
  const result = spawnSync(process.execPath, [RATCHET_PATH], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status,
  };
}

/** Run hooks/df-snapshot-guard.js with JSON piped to stdin. Returns { stdout, stderr, code }. */
function runGuardHook(input) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status,
  };
}

/** Write .deepflow/auto-snapshot.txt in dir with given entries. */
function writeSnapshot(dir, entries) {
  const deepflowDir = path.join(dir, '.deepflow');
  fs.mkdirSync(deepflowDir, { recursive: true });
  fs.writeFileSync(path.join(deepflowDir, 'auto-snapshot.txt'), entries.join('\n') + '\n');
}

function readExecute() {
  return fs.readFileSync(EXECUTE_PATH, 'utf8');
}

function getSection55(content) {
  const match = content.match(/### 5\.5\. RATCHET CHECK[\s\S]*?(?=###\s)/);
  return match ? match[0] : null;
}

function getSection56(content) {
  const match = content.match(/### 5\.6\. WAVE TEST AGENT[\s\S]*?(?=###\s)/);
  return match ? match[0] : null;
}

function getWaveTestPrompt(content) {
  const match = content.match(/\*\*Wave Test\*\*[\s\S]*?(?=\*\*(?:Spike|Optimize Task|Final Test)\*\*|###\s)/);
  return match ? match[0] : null;
}

// ===========================================================================
// AC-1: bin/ratchet.js runs health checks in order, outputs exactly one JSON
//        line {result, stage?, log?}, auto-reverts on FAIL
// ===========================================================================

describe('AC-1: bin/ratchet.js JSON output and exit codes (subprocess)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
  });

  afterEach(() => { rmrf(tmpDir); });

  it('outputs exactly one JSON line to stdout on PASS', () => {
    const { stdout, code } = runRatchet(tmpDir);
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    assert.equal(lines.length, 1, 'Should output exactly one line');
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.result, 'PASS');
    assert.equal(code, 0);
  });

  it('JSON output has correct shape for PASS — only { result: "PASS" }', () => {
    const { stdout } = runRatchet(tmpDir);
    const parsed = JSON.parse(stdout.trim());
    assert.deepEqual(Object.keys(parsed), ['result']);
    assert.equal(parsed.result, 'PASS');
  });

  it('exit code 0 for PASS', () => {
    const { code } = runRatchet(tmpDir);
    assert.equal(code, 0);
  });

  it('PASS for node project with no failing stages', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }));
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'node project'], { cwd: tmpDir, stdio: 'ignore' });

    const { stdout, code } = runRatchet(tmpDir);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.result, 'PASS');
    assert.equal(code, 0);
  });
});

describe('AC-1: bin/ratchet.js FAIL/SALVAGEABLE paths (source-level verification)', () => {
  // NOTE: Full subprocess testing of FAIL/SALVAGEABLE requires the ratchet script
  // to resolve mainRepoRoot correctly, which only works in production worktree
  // contexts. These tests verify the code paths exist through source analysis.

  it('FAIL JSON output includes result, stage, and log fields', () => {
    assert.ok(
      RATCHET_SRC.includes("JSON.stringify({ result: 'FAIL', stage, log })"),
      'Source must output {"result":"FAIL","stage":"...","log":"..."}'
    );
  });

  it('FAIL exits with code 1', () => {
    const failSection = RATCHET_SRC.match(/result:\s*'FAIL'[\s\S]{0,100}process\.exit\((\d+)\)/);
    assert.ok(failSection, 'FAIL section must have process.exit');
    assert.equal(failSection[1], '1');
  });

  it('SALVAGEABLE JSON output includes result, stage, and log fields', () => {
    assert.ok(
      RATCHET_SRC.includes("JSON.stringify({ result: 'SALVAGEABLE', stage, log })"),
      'Source must output {"result":"SALVAGEABLE","stage":"...","log":"..."}'
    );
  });

  it('SALVAGEABLE exits with code 2', () => {
    const salvSection = RATCHET_SRC.match(/result:\s*'SALVAGEABLE'[\s\S]{0,100}process\.exit\((\d+)\)/);
    assert.ok(salvSection, 'SALVAGEABLE section must have process.exit');
    assert.equal(salvSection[1], '2');
  });

  it('auto-reverts HEAD on FAIL (calls git revert HEAD --no-edit)', () => {
    assert.ok(
      RATCHET_SRC.includes("'revert', 'HEAD', '--no-edit'"),
      'Source must call git revert HEAD --no-edit on FAIL'
    );
    // Verify autoRevert is called before FAIL output, not for SALVAGEABLE
    const failBlock = RATCHET_SRC.match(/autoRevert\(cwd\)[\s\S]*?result:\s*'FAIL'/);
    assert.ok(failBlock, 'autoRevert must be called before FAIL output');
  });

  it('does NOT auto-revert on SALVAGEABLE', () => {
    const salvIdx = RATCHET_SRC.indexOf('SALVAGEABLE_STAGES.has(stage)');
    assert.ok(salvIdx !== -1, 'SALVAGEABLE_STAGES check should exist');
    const elseIdx = RATCHET_SRC.indexOf('} else {', salvIdx);
    assert.ok(elseIdx !== -1, 'else block after SALVAGEABLE check should exist');
    const salvBlock = RATCHET_SRC.slice(salvIdx, elseIdx);
    assert.ok(
      !salvBlock.includes('autoRevert'),
      'SALVAGEABLE path must NOT call autoRevert'
    );
  });

  it('health checks run in order: build, test, typecheck, lint', () => {
    const match = RATCHET_SRC.match(/STAGE_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(match, 'STAGE_ORDER constant must exist');
    const stages = match[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.deepEqual(stages, ['build', 'test', 'typecheck', 'lint']);
  });

  it('only lint stage is SALVAGEABLE (others produce FAIL)', () => {
    const match = RATCHET_SRC.match(/SALVAGEABLE_STAGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, 'SALVAGEABLE_STAGES constant must exist');
    const stages = match[1].replace(/['"]/g, '').split(',').map(s => s.trim());
    assert.deepEqual(stages, ['lint']);
  });

  it('all JSON outputs end with newline (exactly one line)', () => {
    const outputLines = RATCHET_SRC.match(/process\.stdout\.write\(JSON\.stringify\([^)]+\)\s*\+\s*'\\n'\)/g);
    assert.ok(outputLines, 'Should have stdout.write calls with JSON');
    assert.equal(outputLines.length, 3, 'Should have exactly 3 JSON output lines (PASS, FAIL, SALVAGEABLE)');
  });
});

// ===========================================================================
// AC-2: Ratchet script constructs test command using xargs from
//        auto-snapshot.txt — no test-discovery flags or globs
// ===========================================================================

describe('AC-2: bin/ratchet.js uses snapshot files for test command (source verification)', () => {
  it('loads snapshot files from .deepflow/auto-snapshot.txt', () => {
    assert.ok(
      RATCHET_SRC.includes('auto-snapshot.txt'),
      'Source must reference auto-snapshot.txt'
    );
  });

  it('node test command uses snapshot files as direct arguments (no discovery flags)', () => {
    // The buildCommands function for node projects should construct
    // ['node', '--test', ...snapshotFiles] — not use globs or discovery
    assert.ok(
      RATCHET_SRC.includes("'node', '--test', ...snapshotFiles"),
      'Node test command must use snapshot files as direct arguments to node --test'
    );
  });

  it('python test command uses snapshot files as direct arguments', () => {
    assert.ok(
      RATCHET_SRC.includes("'pytest', ...snapshotFiles"),
      'Python test command must use snapshot files as direct arguments to pytest'
    );
  });

  it('skips test stage when no snapshot files and no config override', () => {
    const tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
    try {
      // Node project with no snapshot, no test script, no config => test skipped => PASS
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }));
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'no tests'], { cwd: tmpDir, stdio: 'ignore' });

      const { stdout, code } = runRatchet(tmpDir);
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.result, 'PASS');
      assert.equal(code, 0);
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ===========================================================================
// AC-3: PostToolUse hook blocks Write/Edit to snapshot-listed files
//        with exit 1 and explanatory message
// ===========================================================================

describe('AC-3: df-snapshot-guard.js blocks Write/Edit to snapshot-listed files', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => { rmrf(tmpDir); });

  it('exit 1 with stderr message when Write targets a snapshot-listed file', () => {
    writeSnapshot(tmpDir, ['test/integration.test.js']);
    const { code, stderr } = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'integration.test.js') },
      cwd: tmpDir,
    });
    assert.equal(code, 1);
    assert.ok(stderr.length > 0, 'Should produce an explanatory stderr message');
    assert.ok(stderr.includes('Blocked') || stderr.includes('blocked'), 'Message should indicate blocking');
  });

  it('exit 1 with stderr message when Edit targets a snapshot-listed file', () => {
    writeSnapshot(tmpDir, ['bin/install.test.js']);
    const { code, stderr } = runGuardHook({
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'bin', 'install.test.js') },
      cwd: tmpDir,
    });
    assert.equal(code, 1);
    assert.ok(stderr.length > 0, 'Should produce an explanatory stderr message');
  });

  it('exit 0 for non-Write/Edit tools (Read)', () => {
    writeSnapshot(tmpDir, ['test/foo.test.js']);
    const { code } = runGuardHook({
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmpDir, 'test', 'foo.test.js') },
      cwd: tmpDir,
    });
    assert.equal(code, 0);
  });

  it('exit 0 when file is not in snapshot', () => {
    writeSnapshot(tmpDir, ['test/old.test.js']);
    const { code } = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'new.test.js') },
      cwd: tmpDir,
    });
    assert.equal(code, 0);
  });

  it('exit 0 when snapshot file is missing', () => {
    const { code } = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'any.test.js') },
      cwd: tmpDir,
    });
    assert.equal(code, 0);
  });

  it('exit 0 on invalid JSON input (fail-open)', () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: 'not-json{{{',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0);
  });

  it('stderr message is explanatory — includes ratchet/snapshot context', () => {
    writeSnapshot(tmpDir, ['src/core.test.js']);
    const { stderr } = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'src', 'core.test.js') },
      cwd: tmpDir,
    });
    assert.ok(
      stderr.includes('auto-snapshot') || stderr.includes('ratchet') || stderr.includes('snapshot'),
      'Stderr should explain the blocking is due to ratchet/snapshot protection'
    );
  });

  it('handles relative snapshot entries matching absolute file_path', () => {
    writeSnapshot(tmpDir, ['test/rel.test.js']);
    const { code } = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'rel.test.js') },
      cwd: tmpDir,
    });
    assert.equal(code, 1);
  });

  it('blocks multiple snapshot entries — only matching files blocked', () => {
    writeSnapshot(tmpDir, ['test/a.test.js', 'test/b.test.js', 'test/c.test.js']);

    const blocked = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'b.test.js') },
      cwd: tmpDir,
    });
    assert.equal(blocked.code, 1, 'Matching file should be blocked');

    const allowed = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'd.test.js') },
      cwd: tmpDir,
    });
    assert.equal(allowed.code, 0, 'Non-matching file should pass through');
  });
});

// ===========================================================================
// AC-4: execute.md section 5.5 replaced with node bin/ratchet.js call,
//        contains zero raw test output parsing, includes prohibitions
// ===========================================================================

describe('AC-4: execute.md section 5.5 uses node bin/ratchet.js, no raw test parsing, has prohibitions', () => {
  const content = readExecute();
  const section55 = getSection55(content);

  it('execute.md exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PATH), 'execute.md must exist');
  });

  it('section 5.5 RATCHET CHECK exists', () => {
    assert.ok(section55, 'Section 5.5 "RATCHET CHECK" must exist');
  });

  it('section 5.5 invokes node bin/ratchet.js', () => {
    assert.ok(
      section55.includes('node bin/ratchet.js'),
      'Section 5.5 must call node bin/ratchet.js'
    );
  });

  it('section 5.5 does NOT contain raw test output parsing (no npm test, no npm run build inline)', () => {
    assert.ok(
      !section55.includes('npm test'),
      'Section 5.5 must not contain inline npm test'
    );
    assert.ok(
      !section55.includes('npm run build'),
      'Section 5.5 must not contain inline npm run build'
    );
    assert.ok(
      !section55.includes('| Build |'),
      'Section 5.5 must not contain inline health check table'
    );
  });

  it('section 5.5 prohibits reinterpretation of test failures', () => {
    assert.ok(
      section55.includes('reinterpret') || section55.includes('MUST NOT inspect'),
      'Section 5.5 must prohibit reinterpretation of test failures'
    );
  });

  it('section 5.5 prohibits git stash', () => {
    assert.ok(
      section55.includes('git stash'),
      'Section 5.5 must prohibit git stash'
    );
  });

  it('section 5.5 prohibits git checkout', () => {
    assert.ok(
      section55.includes('git checkout'),
      'Section 5.5 must prohibit git checkout'
    );
  });

  it('section 5.5 prohibits inline test edits', () => {
    assert.ok(
      section55.includes('inline edit') || section55.includes('No inline edits to pre-existing test files'),
      'Section 5.5 must prohibit inline edits to pre-existing test files'
    );
  });
});

// ===========================================================================
// AC-5: Wave test agent prompt includes full snapshot file list +
//        existing test function names + dedup instruction
// ===========================================================================

describe('AC-5: Wave test agent prompt includes snapshot files, test names, dedup instruction', () => {
  const content = readExecute();
  const section56 = getSection56(content);
  const wavePrompt = getWaveTestPrompt(content);

  it('section 5.6 WAVE TEST AGENT exists', () => {
    assert.ok(section56, 'Section 5.6 "WAVE TEST AGENT" must exist');
  });

  it('section 5.6 reads auto-snapshot.txt and stores as SNAPSHOT_FILES', () => {
    assert.ok(
      section56.includes('auto-snapshot.txt') && section56.includes('SNAPSHOT_FILES'),
      'Section 5.6 must read auto-snapshot.txt and produce SNAPSHOT_FILES'
    );
  });

  it('section 5.6 extracts existing test function names via grep', () => {
    assert.ok(
      section56.includes('EXISTING_TEST_NAMES') && section56.includes('grep'),
      'Section 5.6 must grep for existing test function names'
    );
  });

  it('Wave Test prompt exists', () => {
    assert.ok(wavePrompt, 'Wave Test prompt must exist in section 6');
  });

  it('Wave Test prompt contains {SNAPSHOT_FILES} placeholder', () => {
    assert.ok(
      wavePrompt.includes('{SNAPSHOT_FILES}'),
      'Wave Test prompt must contain {SNAPSHOT_FILES}'
    );
  });

  it('Wave Test prompt contains {EXISTING_TEST_NAMES} placeholder', () => {
    assert.ok(
      wavePrompt.includes('{EXISTING_TEST_NAMES}'),
      'Wave Test prompt must contain {EXISTING_TEST_NAMES}'
    );
  });

  it('Wave Test prompt contains dedup instruction (Do not duplicate tests)', () => {
    assert.ok(
      wavePrompt.includes('Do not duplicate tests') || wavePrompt.includes('do NOT duplicate'),
      'Wave Test prompt must contain dedup instruction'
    );
  });

  it('Wave Test prompt lists "Pre-existing test files" section', () => {
    assert.ok(
      wavePrompt.includes('Pre-existing test files'),
      'Wave Test prompt must have "Pre-existing test files" section'
    );
  });

  it('Wave Test prompt lists "Existing test function names" section', () => {
    assert.ok(
      wavePrompt.includes('Existing test function names'),
      'Wave Test prompt must have "Existing test function names" section'
    );
  });
});

// ===========================================================================
// AC-6: execute.md states pre-existing test failures always revert and
//        updating snapshot tests requires separate PLAN.md task
// ===========================================================================

describe('AC-6: execute.md broken-tests policy — revert + separate PLAN.md task', () => {
  const content = readExecute();
  const section55 = getSection55(content);

  it('section 5.5 contains broken-tests policy', () => {
    assert.ok(
      section55.includes('Broken-tests policy') || section55.includes('broken-tests policy'),
      'Section 5.5 must contain a broken-tests policy'
    );
  });

  it('states pre-existing test failures always revert (FAIL means revert)', () => {
    assert.ok(
      section55.includes('FAIL means revert') || section55.includes('always revert'),
      'Policy must state that pre-existing test failures always revert'
    );
  });

  it('states updating snapshot tests requires separate dedicated task in PLAN.md', () => {
    assert.ok(
      section55.includes('separate dedicated task in PLAN.md') ||
      section55.includes('separate PLAN.md task'),
      'Policy must require separate PLAN.md task for updating snapshot tests'
    );
  });

  it('states updates are never inline during execution', () => {
    assert.ok(
      section55.includes('never inline during execution') ||
      section55.includes('never inline'),
      'Policy must forbid inline updates during execution'
    );
  });
});

// ===========================================================================
// Cross-AC integration: ratchet + snapshot guard use the same snapshot file
// ===========================================================================

describe('Cross-AC: ratchet + snapshot guard use same .deepflow/auto-snapshot.txt', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmrf(tmpDir); });

  it('guard blocks writes to same files that ratchet reads from auto-snapshot.txt', () => {
    // Create a snapshot listing test files
    writeSnapshot(tmpDir, ['test/guarded.test.js', 'test/safe.test.js']);

    // Guard should block writes to snapshot-listed files
    const blocked = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'guarded.test.js') },
      cwd: tmpDir,
    });
    assert.equal(blocked.code, 1, 'Guard should block writes to snapshot-listed file');

    // Guard should allow writes to non-snapshot files
    const allowed = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'new.test.js') },
      cwd: tmpDir,
    });
    assert.equal(allowed.code, 0, 'Guard should allow writes to non-snapshot files');
  });

  it('ratchet source reads from .deepflow/auto-snapshot.txt (same path as guard)', () => {
    // Verify both components read from the same file path
    const guardSrc = fs.readFileSync(HOOK_PATH, 'utf8');
    assert.ok(
      RATCHET_SRC.includes('auto-snapshot.txt'),
      'Ratchet must read from auto-snapshot.txt'
    );
    assert.ok(
      guardSrc.includes('auto-snapshot.txt'),
      'Guard must read from auto-snapshot.txt'
    );
  });

  it('no snapshot means no test command for ratchet and no blocking for guard', () => {
    // No .deepflow/auto-snapshot.txt at all

    // Guard allows all writes
    const allowed = runGuardHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, 'test', 'any.test.js') },
      cwd: tmpDir,
    });
    assert.equal(allowed.code, 0, 'Guard should pass through when no snapshot exists');

    // Ratchet passes (no test command constructed)
    initGitRepo(tmpDir);
    const { stdout, code } = runRatchet(tmpDir);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.result, 'PASS');
    assert.equal(code, 0);
  });
});
