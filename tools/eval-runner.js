#!/usr/bin/env node
/**
 * eval-runner.js — evaluate a deepflow harness against the corpus.
 *
 * For each task in the corpus (or just one via --task):
 *   1. Extract corpus/{slug}/baseline.tar.gz into a workdir
 *   2. Install the harness into workdir/.claude/ (commands, skills) and
 *      copy hooks into ~/.claude/hooks/ (or use a session-scoped path)
 *   3. Copy corpus/{slug}/spec.md → workdir/specs/doing-{slug}.md
 *   4. Spawn `claude -p --dangerously-skip-permissions "/df:execute"`
 *      from workdir, capturing trace
 *   5. After Claude exits, compute reward via reward_spec.json:
 *      - run build command, capture exit code
 *      - run lint command, capture
 *      - run test commands, parse pass/fail counts
 *      - run df-ac-coverage scan on the diff for AC coverage %
 *   6. Write result.json + diff.patch + trace.txt to
 *      {out}/{run-id}/evals/{slug}/
 *
 * This is the substrate for Meta-Harness (Mode B):
 *   Evaluate(harness, model, task) → result.json
 *
 * Usage:
 *   node tools/eval-runner.js \
 *     --harness PATH    \  # default: this repo (auto-detect)
 *     --corpus PATH     \  # default: ~/meta-harness/corpus
 *     --out PATH        \  # default: ~/meta-harness/runs
 *     [--task SLUG]     \  # default: all canonical specs in corpus/index.yaml
 *     [--canonical-only] \ # filter to canonical: true
 *     [--run-id ID]     \  # default: ISO timestamp
 *     [--timeout SEC]   \  # default: 1800 (30 min per task)
 *     [--dry-run]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, execSync, spawn } = require('node:child_process');

const DEFAULT_HARNESS = path.resolve(__dirname, '..');
const DEFAULT_CORPUS = path.join(os.homedir(), 'meta-harness', 'corpus');
const DEFAULT_OUT = path.join(os.homedir(), 'meta-harness', 'runs');
const DEFAULT_TIMEOUT = 1800; // 30 minutes per task

function parseArgs() {
  const args = {
    harness: DEFAULT_HARNESS,
    corpus: DEFAULT_CORPUS,
    out: DEFAULT_OUT,
    task: null,
    canonicalOnly: false,
    runId: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
    timeout: DEFAULT_TIMEOUT,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') args.harness = argv[++i];
    else if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--task') args.task = argv[++i];
    else if (a === '--canonical-only') args.canonicalOnly = true;
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/eval-runner.js [--harness PATH] [--corpus PATH] [--out PATH] [--task SLUG] [--canonical-only] [--run-id ID] [--timeout SEC] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

// Tiny YAML parser for index.yaml: extracts each `- id: ...` entry's fields.
// Not a general-purpose YAML parser — only handles the index format we emit.
function parseCorpusIndex(yamlPath) {
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const specs = [];
  let current = null;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const idMatch = line.match(/^  - id:\s*(.+)$/);
    if (idMatch) {
      if (current) specs.push(current);
      current = { id: idMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const fieldMatch = line.match(/^    (\w+):\s*(.+)$/);
    if (fieldMatch) {
      let val = fieldMatch[2].trim();
      // strip surrounding quotes
      if (/^".*"$/.test(val)) val = val.slice(1, -1);
      if (val === 'true') current[fieldMatch[1]] = true;
      else if (val === 'false') current[fieldMatch[1]] = false;
      else if (/^\d+$/.test(val)) current[fieldMatch[1]] = parseInt(val, 10);
      else current[fieldMatch[1]] = val;
    }
  }
  if (current) specs.push(current);
  return specs;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function installHarness(harness, workdir) {
  // Project-level install: workdir/.claude/{commands,skills}/
  const claudeDir = path.join(workdir, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'commands', 'df'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });

  copyDir(path.join(harness, 'src', 'commands', 'df'), path.join(claudeDir, 'commands', 'df'));
  copyDir(path.join(harness, 'src', 'skills'), path.join(claudeDir, 'skills'));

  // Templates (used by /df:spec and /df:discover)
  if (fs.existsSync(path.join(harness, 'templates'))) {
    copyDir(path.join(harness, 'templates'), path.join(claudeDir, 'templates'));
  }

  // Settings: enable LSP, permissions for build/test
  fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
    env: { ENABLE_LSP_TOOL: '1' },
    permissions: {
      allow: [
        'Edit', 'Write', 'Read', 'Glob', 'Grep',
        'Bash(git *)', 'Bash(go *)', 'Bash(npm *)', 'Bash(pnpm *)',
        'Bash(make *)', 'Bash(node *)', 'Bash(python *)', 'Bash(pytest *)',
        'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
        'Bash(find *)', 'Bash(grep *)', 'Bash(sed *)', 'Bash(awk *)',
      ],
    },
  }, null, 2));
}

function spawnClaude(workdir, prompt, timeoutSec, tracePath) {
  return new Promise((resolve) => {
    const traceStream = fs.createWriteStream(tracePath, { flags: 'w' });
    const startedAt = Date.now();

    const child = spawn('claude', [
      '-p', prompt,
      '--dangerously-skip-permissions',
    ], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdoutBuf += s;
      traceStream.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrBuf += s;
      traceStream.write(`[stderr] ${s}`);
    });

    const timer = setTimeout(() => {
      traceStream.write(`\n[eval-runner] TIMEOUT after ${timeoutSec}s — killing claude process\n`);
      child.kill('SIGKILL');
    }, timeoutSec * 1000);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      traceStream.end();
      resolve({
        exit_code: code,
        signal,
        wall_seconds: Math.round((Date.now() - startedAt) / 1000),
        stdout_bytes: stdoutBuf.length,
        stderr_bytes: stderrBuf.length,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      traceStream.write(`\n[eval-runner] spawn error: ${err.message}\n`);
      traceStream.end();
      resolve({
        exit_code: -1,
        error: err.message,
        wall_seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    });
  });
}

function runCmd(cwd, command, timeoutSec = 600) {
  try {
    const out = execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutSec * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, stdout: out, stderr: '' };
  } catch (err) {
    return {
      exit: err.status ?? -1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      signal: err.signal,
    };
  }
}

function computeReward(workdir, rewardSpec) {
  const result = {
    build_passed: null,
    lint_passed: null,
    tests_passed: null,
    tests_failed_count: null,
    ac_coverage_pct: null,
    notes: [],
  };

  if (rewardSpec.build) {
    const r = runCmd(workdir, rewardSpec.build, 600);
    result.build_passed = r.exit === 0;
    if (!result.build_passed) result.notes.push(`build: ${r.stderr.split('\n').slice(-5).join(' | ')}`);
  }
  if (rewardSpec.lint) {
    const r = runCmd(workdir, rewardSpec.lint, 300);
    result.lint_passed = r.exit === 0;
  }
  if (rewardSpec.test_go) {
    const r = runCmd(workdir, `go test -count=1 ${rewardSpec.test_go}`, 1200);
    result.tests_passed = r.exit === 0;
    if (r.stdout) {
      const failMatch = r.stdout.match(/(\d+)\s+failed/i);
      result.tests_failed_count = failMatch ? parseInt(failMatch[1], 10) : (r.exit === 0 ? 0 : -1);
    }
  }
  if (rewardSpec.test_ts) {
    const r = runCmd(workdir, rewardSpec.test_ts, 1200);
    result.tests_passed = (result.tests_passed === false ? false : r.exit === 0);
  }
  if (rewardSpec.test_py) {
    const r = runCmd(workdir, rewardSpec.test_py, 600);
    result.tests_passed = (result.tests_passed === false ? false : r.exit === 0);
  }
  // ac_coverage_pct: defer to a follow-up tool — needs spec + diff cross-ref.

  // Doc-only specs (no tests, only docs in diff) get a binary build-only signal.
  if (!rewardSpec.build && !rewardSpec.lint && !rewardSpec.test_go && !rewardSpec.test_ts && !rewardSpec.test_py) {
    result.notes.push('doc-only spec: no executable reward, only diff inspection');
  }

  return result;
}

function gitDiffStat(workdir, baselineSha) {
  try {
    const stat = execFileSync('git', ['-C', workdir, 'diff', '--shortstat', `${baselineSha}..HEAD`], { encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['-C', workdir, 'diff', '--name-only', `${baselineSha}..HEAD`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    return { stat, files_changed: files.length, files };
  } catch (_) {
    return { stat: '', files_changed: 0, files: [] };
  }
}

async function evalTask(spec, args) {
  const slug = spec.id;
  const specCorpusDir = path.join(args.corpus, slug);
  const tarball = path.join(specCorpusDir, 'baseline.tar.gz');
  const rewardSpecPath = path.join(specCorpusDir, 'reward_spec.json');

  if (!fs.existsSync(tarball)) {
    return { slug, status: 'corpus_missing', reason: `${tarball} not found` };
  }

  const rewardSpec = JSON.parse(fs.readFileSync(rewardSpecPath, 'utf8'));
  const evalDir = path.join(args.out, args.runId, 'evals', slug);
  const workdir = path.join(evalDir, 'workdir');

  fs.mkdirSync(workdir, { recursive: true });

  // 1. Extract baseline
  execSync(`tar -xzf "${tarball}" -C "${workdir}"`, { stdio: ['ignore', 'ignore', 'pipe'] });

  // 2. Init a git repo so /df:execute can use git ops; commit baseline as initial state
  if (!fs.existsSync(path.join(workdir, '.git'))) {
    execSync('git init -q', { cwd: workdir });
    execSync('git config user.email eval@meta-harness.local', { cwd: workdir });
    execSync('git config user.name "eval-runner"', { cwd: workdir });
    execSync('git config commit.gpgsign false', { cwd: workdir });
    execSync('git add -A', { cwd: workdir });
    execSync(`git commit -q -m "baseline: corpus/${slug}"`, { cwd: workdir });
    // Ensure branch is named "main" (git init may default to "master")
    try { execSync('git branch -m main', { cwd: workdir, stdio: ['ignore', 'ignore', 'pipe'] }); } catch (_) {}
  }

  // 3. Install harness
  installHarness(args.harness, workdir);

  // 4. Place spec.md as doing-{slug}.md so /df:execute picks it up
  fs.mkdirSync(path.join(workdir, 'specs'), { recursive: true });
  fs.copyFileSync(
    path.join(specCorpusDir, 'spec.md'),
    path.join(workdir, 'specs', `doing-${slug}.md`)
  );

  // 5. Snapshot baseline ratchet
  fs.mkdirSync(path.join(workdir, '.deepflow'), { recursive: true });
  execSync(
    `git ls-files | grep -E '\\.(test|spec)\\.[^/]+$|^test_|_test\\.[^/]+$|^tests/|__tests__/' > .deepflow/auto-snapshot.txt || true`,
    { cwd: workdir, shell: '/bin/bash' }
  );

  // 6. Spawn claude
  const startedAt = new Date().toISOString();
  const tracePath = path.join(evalDir, 'trace.txt');
  const prompt = `/df:execute doing-${slug}`;
  const spawnResult = await spawnClaude(workdir, prompt, args.timeout, tracePath);

  // 7. Capture diff
  const diff = gitDiffStat(workdir, 'HEAD~0'); // diff against baseline commit
  // Actually we want diff against the baseline commit, not HEAD itself. Re-query:
  // Since the baseline commit is HEAD before claude ran, after claude commits the tasks,
  // HEAD has moved. We need the initial commit sha.
  let initialSha = null;
  try {
    initialSha = execFileSync('git', ['-C', workdir, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) {
    initialSha = null;
  }
  const realDiff = initialSha ? gitDiffStat(workdir, initialSha) : diff;

  // Write diff patch
  if (initialSha) {
    try {
      execSync(`git -C "${workdir}" diff ${initialSha}..HEAD > "${path.join(evalDir, 'diff.patch')}"`, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_) {}
  }

  // 8. Compute reward
  const reward = computeReward(workdir, rewardSpec.reward);

  // 9. Write result.json
  const result = {
    slug,
    run_id: args.runId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    wall_seconds: spawnResult.wall_seconds,
    exit_code: spawnResult.exit_code,
    signal: spawnResult.signal || null,
    error: spawnResult.error || null,
    stdout_bytes: spawnResult.stdout_bytes || 0,
    stderr_bytes: spawnResult.stderr_bytes || 0,
    files_changed: realDiff.files_changed,
    diff_stat: realDiff.stat,
    reward,
    harness_path: args.harness,
    timeout_seconds: args.timeout,
  };
  fs.writeFileSync(path.join(evalDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');

  return { slug, status: 'ok', result };
}

async function main() {
  const args = parseArgs();

  const indexPath = path.join(args.corpus, 'index.yaml');
  if (!fs.existsSync(indexPath)) {
    console.error(`✗ Corpus index not found: ${indexPath}`);
    console.error(`  Run: node tools/build-corpus.js`);
    process.exit(1);
  }

  let specs = parseCorpusIndex(indexPath);
  if (args.task) specs = specs.filter(s => s.id === args.task);
  else if (args.canonicalOnly) specs = specs.filter(s => s.canonical === true);

  if (specs.length === 0) {
    console.error(`✗ No specs to evaluate (task=${args.task}, canonical-only=${args.canonicalOnly}).`);
    process.exit(1);
  }

  console.log(`Run ID: ${args.runId}`);
  console.log(`Harness: ${args.harness}`);
  console.log(`Specs to evaluate: ${specs.length}`);
  if (args.dryRun) {
    console.log(`\n[dry-run] would evaluate:`);
    for (const s of specs) console.log(`  ${s.id} (${s.domain || 'unknown'})`);
    process.exit(0);
  }

  fs.mkdirSync(path.join(args.out, args.runId, 'evals'), { recursive: true });

  const summaries = [];
  for (const spec of specs) {
    console.log(`\n── ${spec.id} (${spec.domain || '?'}) ──`);
    const t0 = Date.now();
    try {
      const r = await evalTask(spec, args);
      if (r.status === 'ok') {
        const rew = r.result.reward;
        const passes = [];
        if (rew.build_passed === true) passes.push('build');
        if (rew.lint_passed === true) passes.push('lint');
        if (rew.tests_passed === true) passes.push('tests');
        const fails = [];
        if (rew.build_passed === false) fails.push('build');
        if (rew.lint_passed === false) fails.push('lint');
        if (rew.tests_passed === false) fails.push('tests');
        console.log(`  ✓ ${r.result.wall_seconds}s exit=${r.result.exit_code} files=${r.result.files_changed} pass=[${passes.join(',')}] fail=[${fails.join(',')}]`);
        summaries.push({ slug: spec.id, ...r.result });
      } else {
        console.log(`  ✗ ${r.status}: ${r.reason}`);
        summaries.push({ slug: spec.id, status: r.status, reason: r.reason });
      }
    } catch (e) {
      console.log(`  ✗ unexpected error: ${e.message}`);
      summaries.push({ slug: spec.id, status: 'error', error: e.message, wall_seconds: Math.round((Date.now() - t0) / 1000) });
    }
  }

  // Write scoreboard
  const scoreboard = {
    run_id: args.runId,
    harness: args.harness,
    started_at: summaries[0]?.started_at || null,
    completed_at: new Date().toISOString(),
    n_specs: specs.length,
    results: summaries,
  };
  const scoreboardPath = path.join(args.out, args.runId, 'scoreboard.json');
  fs.writeFileSync(scoreboardPath, JSON.stringify(scoreboard, null, 2) + '\n');
  console.log(`\nScoreboard: ${scoreboardPath}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('eval-runner failed:', e);
    process.exit(1);
  });
}

module.exports = { parseCorpusIndex, installHarness, computeReward };
