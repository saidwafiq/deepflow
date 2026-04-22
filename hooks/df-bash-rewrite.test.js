'use strict';

const { test, describe, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// dispatch() unit tests (AC-1: template name resolution + tail-rewrite)
// ---------------------------------------------------------------------------

describe('dispatch() — module export', () => {
  const { dispatch } = require('./df-bash-rewrite');
  const { loadTemplates } = require('./lib/filter-dispatch');

  // Reset templates after each test so state does not bleed between suites.
  afterEach(() => loadTemplates([]));

  test('returns {filter: null, rewrite: unchanged} for unrecognised command', () => {
    const { filter, rewrite } = dispatch('echo hello');
    assert.equal(filter, null);
    assert.equal(rewrite, 'echo hello');
  });

  test('returns tail-rewrite for npm ci (no template registered)', () => {
    const { filter, rewrite } = dispatch('npm ci');
    assert.equal(filter, null);
    assert.ok(rewrite.endsWith('| tail -3'), `expected tail-3, got: ${rewrite}`);
    assert.ok(rewrite.startsWith('npm ci'));
  });

  test('returns tail-rewrite for git worktree add', () => {
    const { filter, rewrite } = dispatch('git worktree add -b df/spec .deepflow/worktrees/spec');
    assert.equal(filter, null);
    assert.ok(rewrite.endsWith('| tail -1'));
  });

  test('returns tail-rewrite for pnpm build', () => {
    const { filter, rewrite } = dispatch('pnpm build');
    assert.equal(filter, null);
    assert.ok(rewrite.endsWith('| tail -5'));
  });

  test('template match takes precedence over tail-rule', () => {
    // Register a fake template that matches npm ci
    const fakeFilter = { name: 'fake-npm-filter', match: (cmd) => /^npm ci/.test(cmd.trimStart()), apply: () => ({}) };
    loadTemplates([fakeFilter]);

    const { filter, rewrite } = dispatch('npm ci');
    assert.equal(filter, fakeFilter, 'should return the matched template object');
    assert.equal(filter.name, 'fake-npm-filter');
    // rewrite equals original cmd when a template handles it (no tail suffix)
    assert.equal(rewrite, 'npm ci');
  });

  test('returns correct template name for second registered template', () => {
    const t1 = { name: 'failures-only', match: (cmd) => /^npm test/.test(cmd.trimStart()), apply: () => ({}) };
    const t2 = { name: 'diff-stat-only', match: (cmd) => /^git diff/.test(cmd.trimStart()), apply: () => ({}) };
    loadTemplates([t1, t2]);

    const r1 = dispatch('npm test');
    assert.equal(r1.filter?.name, 'failures-only');

    const r2 = dispatch('git diff HEAD~3');
    assert.equal(r2.filter?.name, 'diff-stat-only');
  });

  test('returns no-match for protected-like command (caller guards PROTECTED)', () => {
    // dispatch() itself does NOT filter protected commands — the caller does.
    // Verify dispatch still returns a rewrite if the command happens to match a rule.
    const { filter, rewrite } = dispatch('git stash');
    assert.equal(filter, null);
    assert.ok(rewrite.endsWith('| tail -2'));
  });
});

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

// ---------------------------------------------------------------------------
// 3. Mute rules (REQ-1 and REQ-2)
// ---------------------------------------------------------------------------

describe('df-bash-rewrite — cat /tmp/t<N>-prompt mute (REQ-1)', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); makeDeepflowProject(tmp); });
  afterEach(() => rmrf(tmp));

  test('mutes cat /tmp/t1-prompt.txt', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cat /tmp/t1-prompt.txt' },
      cwd: tmp,
    });
    assert.equal(rewrittenCmd(r.stdout), ': # muted by df-bash-rewrite');
  });

  test('mutes cat /tmp/t12-prompt.txt', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cat /tmp/t12-prompt.txt' },
      cwd: tmp,
    });
    assert.equal(rewrittenCmd(r.stdout), ': # muted by df-bash-rewrite');
  });

  test('does NOT mute cat /tmp/other.txt (near-miss)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cat /tmp/other.txt' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });
});

describe('df-bash-rewrite — prompt-compose --help mute (REQ-2)', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmpDir(); makeDeepflowProject(tmp); });
  afterEach(() => rmrf(tmp));

  test('mutes node /path/to/prompt-compose.js --help', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node /path/to/prompt-compose.js --help' },
      cwd: tmp,
    });
    assert.equal(rewrittenCmd(r.stdout), ': # muted by df-bash-rewrite');
  });

  test('mutes node prompt-compose.js -h', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node prompt-compose.js -h' },
      cwd: tmp,
    });
    assert.equal(rewrittenCmd(r.stdout), ': # muted by df-bash-rewrite');
  });

  test('does NOT mute prompt-compose --template standard-task --context - (near-miss)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node prompt-compose.js --template standard-task --context -' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });

  test('PROTECTED list does NOT block prompt-compose --help (help rule fires)', () => {
    // The PROTECTED pattern is /prompt-compose(?!.*--help)/ so --help invocations
    // are NOT protected and the mute rule should fire.
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node ~/.claude/bin/prompt-compose.js --help' },
      cwd: tmp,
    });
    assert.equal(rewrittenCmd(r.stdout), ': # muted by df-bash-rewrite');
  });

  test('PROTECTED list still blocks normal prompt-compose invocation', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node ~/.claude/bin/prompt-compose.js --template standard-task --context -' },
      cwd: tmp,
    });
    assert.equal(r.stdout, '');
  });
});

// ---------------------------------------------------------------------------
// 4. Snapshot tests — full pipeline via dispatch() per archetype (AC-2, AC-3)
// ---------------------------------------------------------------------------
//
// These tests exercise the full rewrite pipeline: loadBuiltinTemplates() loads
// all 8 archetype filter objects into dispatch(); each fixture command is routed
// through dispatch() which returns the matched filter; filter.apply(raw) is
// called and the rendered output (header + '\n' + body + optional truncation
// marker) is validated against the schema regex:
//
//   ^# .+\n(.*\n)*(-- truncated \d+ lines --)?$
//
// The schema encodes: header line starts with "# "; zero-or-more body lines;
// optional trailing "-- truncated N lines --" line.

describe('snapshot pipeline — one fixture per archetype (AC-2, AC-3)', () => {
  const { dispatch: dispatchFn, loadTemplates: lt, loadBuiltinTemplates: lbt } =
    require('./lib/filter-dispatch');

  // Schema regex: header line + optional body lines + optional truncation marker
  const SCHEMA_RE = /^# .+\n(.*\n)*(-- truncated \d+ lines --)?\s*$/;

  /**
   * Render a FilteredOutput to the canonical schema string so the regex can
   * be matched against it.
   *
   * Format:
   *   # <header text>\n
   *   <body (may be multi-line)>\n
   *   -- truncated N lines --   (only when truncated is present)
   */
  function render(result) {
    let out = result.header + '\n';
    if (result.body) out += result.body + '\n';
    if (result.truncated) out += `-- truncated ${result.truncated.lines} lines --\n`;
    return out;
  }

  // Load all built-in templates before this suite runs.
  before(() => { lbt(); });
  // Re-load before each test because afterEach resets the registry.
  beforeEach(() => { lbt(); });
  // Reset after each test to avoid bleed into other suites.
  afterEach(() => { lt([]); });

  // ---------------------------------------------------------------------------
  // truncate-stable
  // ---------------------------------------------------------------------------
  test('truncate-stable: dispatch routes npm ci; rendered output matches schema', () => {
    const { filter } = dispatchFn('npm ci');
    assert.ok(filter, 'dispatch should match npm ci to a template');
    assert.equal(filter.name, 'truncate-stable');

    // 12 lines — exceeds KEEP_LINES=5 so truncation fires
    const raw = Array.from({ length: 12 }, (_, i) => `added ${i + 1} packages`).join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `truncate-stable schema mismatch:\n${rendered}`);
    assert.ok(result.truncated, 'truncation expected for 12-line input');
  });

  // ---------------------------------------------------------------------------
  // group-by-prefix
  // ---------------------------------------------------------------------------
  test('group-by-prefix: dispatch routes ls -la /path; rendered output matches schema', () => {
    const { filter } = dispatchFn('ls -la /usr/local/lib');
    assert.ok(filter, 'dispatch should match ls -la /path to a template');
    assert.equal(filter.name, 'group-by-prefix');

    const raw = [
      'lib/node_modules/express',
      'lib/node_modules/lodash',
      'lib/node_modules/react',
      'share/doc/node',
      'share/man/man1',
    ].join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `group-by-prefix schema mismatch:\n${rendered}`);
  });

  // ---------------------------------------------------------------------------
  // json-project
  // ---------------------------------------------------------------------------
  test('json-project: dispatch routes cat package.json; rendered output matches schema', () => {
    const { filter } = dispatchFn('cat package.json');
    assert.ok(filter, 'dispatch should match cat package.json to a template');
    assert.equal(filter.name, 'json-project');

    const pkg = JSON.stringify({
      name: 'deepflow',
      version: '0.9.0',
      scripts: { test: 'node --test', build: 'echo ok', lint: 'eslint .' },
      dependencies: { chalk: '^5.0.0' },
      devDependencies: { eslint: '^8.0.0' },
    }, null, 2);
    const result = filter.apply(pkg);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `json-project schema mismatch:\n${rendered}`);
    assert.ok(result.body.includes('deepflow'), 'name field present in body');
  });

  // ---------------------------------------------------------------------------
  // resolve-and-report
  // ---------------------------------------------------------------------------
  test('resolve-and-report: dispatch routes readlink -f; rendered output matches schema', () => {
    const { filter } = dispatchFn('readlink -f /var/lib/node');
    assert.ok(filter, 'dispatch should match readlink to a template');
    assert.equal(filter.name, 'resolve-and-report');

    const raw = [
      '/usr/local/lib/node',
      'readlink: /broken: too many levels of symbolic links',
      '/real/other/path',
    ].join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `resolve-and-report schema mismatch:\n${rendered}`);
    assert.ok(result.body.includes('too many levels'), 'error line surfaced');
  });

  // ---------------------------------------------------------------------------
  // failures-only
  // ---------------------------------------------------------------------------
  test('failures-only: dispatch routes node --test; rendered output matches schema', () => {
    const { filter } = dispatchFn('node --test hooks/df-bash-rewrite.test.js');
    assert.ok(filter, 'dispatch should match node --test to a template');
    assert.equal(filter.name, 'failures-only');

    const raw = [
      'TAP version 14',
      'ok 1 - passes',
      'ok 2 - also passes',
      'not ok 3 - dispatch returns wrong filter',
      '  Error: expected "diff-stat-only", got null',
      '    at Object.<anonymous> (test.js:55:5)',
      '# tests 3',
      '# pass  2',
      '# fail  1',
    ].join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `failures-only schema mismatch:\n${rendered}`);
    assert.ok(result.body.includes('not ok 3'), 'failure line present');
    assert.ok(!result.body.includes('ok 1 -'), 'passing lines suppressed');
  });

  // ---------------------------------------------------------------------------
  // head-tail-window
  // ---------------------------------------------------------------------------
  test('head-tail-window: dispatch routes git log --oneline; rendered output matches schema', () => {
    const { filter } = dispatchFn('git log --oneline');
    assert.ok(filter, 'dispatch should match git log --oneline to a template');
    assert.equal(filter.name, 'head-tail-window');

    // 20 commits — exceeds HEAD+TAIL window of 10
    const raw = Array.from({ length: 20 }, (_, i) =>
      `abc${String(i).padStart(4, '0')} commit message ${i + 1}`
    ).join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `head-tail-window schema mismatch:\n${rendered}`);
    assert.ok(result.truncated, 'truncation expected for 20-line log');
    // body contains the omitted-lines marker inline
    assert.ok(result.body.includes('-- 10 lines omitted --'), 'omission marker in body');
  });

  // ---------------------------------------------------------------------------
  // summarize-tree
  // ---------------------------------------------------------------------------
  test('summarize-tree: dispatch routes tree src/; rendered output matches schema', () => {
    const { filter } = dispatchFn('tree src/');
    assert.ok(filter, 'dispatch should match tree to a template');
    assert.equal(filter.name, 'summarize-tree');

    const raw = [
      'src',
      '├── commands',
      '│   ├── df-discover.md',
      '│   └── df-plan.md',
      '├── skills',
      '│   ├── atomic-commits',
      '│   └── browse-fetch',
      '└── agents',
      '    └── reasoner.md',
      '',
      '3 directories, 5 files',
    ].join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `summarize-tree schema mismatch:\n${rendered}`);
    assert.ok(result.body.includes('depth'), 'depth summary in body');
  });

  // ---------------------------------------------------------------------------
  // diff-stat-only
  // ---------------------------------------------------------------------------
  test('diff-stat-only: dispatch routes git diff HEAD~1; rendered output matches schema', () => {
    const { filter } = dispatchFn('git diff HEAD~1');
    assert.ok(filter, 'dispatch should match git diff to a template');
    assert.equal(filter.name, 'diff-stat-only');

    const raw = [
      'diff --git a/hooks/df-bash-rewrite.js b/hooks/df-bash-rewrite.js',
      'index 1a2b3c..4d5e6f 100644',
      '--- a/hooks/df-bash-rewrite.js',
      '+++ b/hooks/df-bash-rewrite.js',
      '@@ -1,10 +1,12 @@',
      '-old line',
      '+new line',
      ' context',
      ' hooks/df-bash-rewrite.js | 4 ++--',
      ' hooks/lib/filter-dispatch.js | 12 +++++++-----',
      ' 2 files changed, 10 insertions(+), 6 deletions(-)',
    ].join('\n');
    const result = filter.apply(raw);

    assert.ok(result.header.startsWith('# '), 'header starts with "# "');
    const rendered = render(result);
    assert.match(rendered, SCHEMA_RE, `diff-stat-only schema mismatch:\n${rendered}`);
    assert.ok(result.body.includes('2 files changed'), 'summary line present');
  });
});

// ---------------------------------------------------------------------------
// 4. AC-4 regression — protection-list pass-through and DF_BASH_REWRITE=0 disable
// ---------------------------------------------------------------------------
//
// These tests confirm that:
//   (a) Commands in the PROTECTED list always pass through unchanged, even when
//       filter templates are loaded and would otherwise match the command.
//   (b) DF_BASH_REWRITE=0 short-circuits the entire hook including the dispatch
//       path — no output even when a template would fire.
//
// Both invariants must hold regardless of which templates are registered, so
// the tests explicitly load templates before asserting the guard behaviour.

describe('AC-4 regression — protection-list and DF_BASH_REWRITE=0', () => {
  let tmp;
  const { loadTemplates, loadBuiltinTemplates, PROTECTED } = require('./lib/filter-dispatch');

  beforeEach(() => {
    tmp = makeTmpDir();
    makeDeepflowProject(tmp);
  });

  afterEach(() => {
    rmrf(tmp);
    // Reset template registry to avoid bleed into other suites.
    loadTemplates([]);
  });

  // ---- protection-list pass-through (unit level via dispatch + isProtected guard) ----

  test('PROTECTED list contains expected orchestrator patterns', () => {
    // Verify the exported PROTECTED array covers the core orchestrator scripts.
    const expectedPatterns = ['wave-runner', 'ratchet\\.js', 'ac-coverage', 'worktree-deps'];
    for (const expected of expectedPatterns) {
      const re = new RegExp(expected);
      assert.ok(
        PROTECTED.some(p => p.toString().includes(expected.replace('\\', '\\\\').split('\\.')[0])),
        `PROTECTED should include a regex matching "${expected}"`,
      );
    }
  });

  test('hook: wave-runner passes through unchanged even when templates are loaded (DF_BASH_REWRITE unset)', () => {
    // loadBuiltinTemplates() ensures at least truncate-stable is active so
    // dispatch() can return a filter for npm ci — but wave-runner must still
    // be blocked before dispatch is called.
    loadBuiltinTemplates();
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'node ~/.claude/bin/wave-runner.js --json --plan PLAN.md' }, cwd: tmp },
      { env: {} },
    );
    assert.equal(r.stdout, '', 'wave-runner must produce no output (pass-through)');
  });

  test('hook: ratchet.js passes through unchanged even when templates are loaded', () => {
    loadBuiltinTemplates();
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'node ~/.claude/bin/ratchet.js --worktree x' }, cwd: tmp },
      { env: {} },
    );
    assert.equal(r.stdout, '', 'ratchet.js must produce no output (pass-through)');
  });

  test('hook: ac-coverage passes through unchanged even when templates are loaded', () => {
    loadBuiltinTemplates();
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'node ~/.claude/bin/ac-coverage.js PLAN.md' }, cwd: tmp },
      { env: {} },
    );
    assert.equal(r.stdout, '', 'ac-coverage must produce no output (pass-through)');
  });

  test('hook: a fake template matching "node" does NOT override PROTECTED guard', () => {
    // Register a greedy template that matches any "node ..." command.
    // The PROTECTED guard in df-bash-rewrite.js runs before dispatch(), so
    // even this catch-all template must not rewrite protected commands.
    loadTemplates([
      { name: 'greedy-node', match: (cmd) => /^node\b/.test(cmd.trimStart()), apply: () => ({ header: '# greedy', body: '' }) },
    ]);
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'node ~/.claude/bin/wave-runner.js --plan PLAN.md' }, cwd: tmp },
      { env: {} },
    );
    assert.equal(r.stdout, '', 'PROTECTED guard must fire before dispatch even with a matching template registered');
  });

  // ---- DF_BASH_REWRITE=0 disables dispatch end-to-end ----

  test('hook: DF_BASH_REWRITE=0 produces no output for a template-matched command (npm ci)', () => {
    // npm ci matches the truncate-stable template when templates are loaded.
    // DF_BASH_REWRITE=0 must short-circuit before dispatch is reached.
    loadBuiltinTemplates();
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'npm ci' }, cwd: tmp },
      { env: { DF_BASH_REWRITE: '0' } },
    );
    assert.equal(r.stdout, '', 'DF_BASH_REWRITE=0 must suppress output for template-matched command');
  });

  test('hook: DF_BASH_REWRITE=0 produces no output for a tail-rule command (git stash)', () => {
    // git stash matches a RULES tail-rewrite. DF_BASH_REWRITE=0 must also block this path.
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'git stash' }, cwd: tmp },
      { env: { DF_BASH_REWRITE: '0' } },
    );
    assert.equal(r.stdout, '', 'DF_BASH_REWRITE=0 must suppress output for tail-rule command');
  });

  test('hook: DF_BASH_REWRITE=0 produces no output for git diff (diff-stat-only template)', () => {
    loadBuiltinTemplates();
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'git diff HEAD~1' }, cwd: tmp },
      { env: { DF_BASH_REWRITE: '0' } },
    );
    assert.equal(r.stdout, '', 'DF_BASH_REWRITE=0 must suppress output for diff-stat-only template match');
  });

  test('hook: DF_BASH_REWRITE=0 produces no output for node --test (failures-only template)', () => {
    loadBuiltinTemplates();
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'node --test hooks/df-bash-rewrite.test.js' }, cwd: tmp },
      { env: { DF_BASH_REWRITE: '0' } },
    );
    assert.equal(r.stdout, '', 'DF_BASH_REWRITE=0 must suppress output for failures-only template match');
  });
});
