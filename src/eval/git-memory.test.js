'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  commitExperiment,
  revertExperiment,
  queryExperiments,
  getExperimentHistory,
  formatCommitMessage,
  parseExperimentLine,
} = require('./git-memory.js');

/**
 * Creates a temporary git repo with an initial commit.
 * Returns the directory path.
 */
function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-memory-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Initial commit so we have a HEAD
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  execSync('git add -A && git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Unit tests for pure functions ---

describe('formatCommitMessage', () => {
  it('formats a complete experiment commit message', () => {
    const msg = formatCommitMessage({
      skillName: 'browse-fetch',
      hypothesis: 'reduce timeout to 5s',
      target: 'latency',
      value: '4.2s',
      delta: '-16',
      status: 'pass',
      secondaries: 'accuracy=98%',
    });
    assert.strictEqual(
      msg,
      'experiment(browse-fetch): reduce timeout to 5s | latency=4.2s delta=-16% pass | accuracy=98%'
    );
  });

  it('handles missing secondaries as empty string', () => {
    const msg = formatCommitMessage({
      skillName: 'skill-a',
      hypothesis: 'test hyp',
      target: 'speed',
      value: '10',
      delta: '+5',
      status: 'fail',
      secondaries: undefined,
    });
    assert.ok(msg.endsWith('| '), `Expected message to end with "| " but got: ${msg}`);
  });

  it('handles numeric value and delta', () => {
    const msg = formatCommitMessage({
      skillName: 'x',
      hypothesis: 'h',
      target: 't',
      value: 42,
      delta: -3.5,
      status: 'pass',
      secondaries: null,
    });
    assert.ok(msg.includes('t=42'));
    assert.ok(msg.includes('delta=-3.5%'));
  });
});

describe('parseExperimentLine', () => {
  it('parses a well-formed experiment subject', () => {
    const subject = 'experiment(browse-fetch): reduce timeout | latency=4.2s delta=-16% pass | accuracy=98%';
    const result = parseExperimentLine('abc123', subject);
    assert.deepStrictEqual(result, {
      hash: 'abc123',
      skillName: 'browse-fetch',
      hypothesis: 'reduce timeout',
      target: 'latency',
      value: '4.2s',
      delta: -16,
      status: 'pass',
      secondaries: 'accuracy=98%',
    });
  });

  it('returns null for non-experiment commits', () => {
    assert.strictEqual(parseExperimentLine('abc', 'feat(core): add feature'), null);
    assert.strictEqual(parseExperimentLine('abc', 'random text'), null);
  });

  it('returns null for malformed metrics section', () => {
    const subject = 'experiment(x): hyp | bad-metrics | sec';
    assert.strictEqual(parseExperimentLine('abc', subject), null);
  });

  it('parses positive delta', () => {
    const subject = 'experiment(s): h | metric=100 delta=+12.5% pass | ';
    const result = parseExperimentLine('def', subject);
    assert.strictEqual(result.delta, 12.5);
  });

  it('handles empty secondaries', () => {
    const subject = 'experiment(s): h | m=1 delta=0% inconclusive | ';
    const result = parseExperimentLine('ghi', subject);
    assert.strictEqual(result.secondaries, '');
    assert.strictEqual(result.status, 'inconclusive');
  });
});

// --- Integration tests with temp git repos ---

describe('commitExperiment', () => {
  let cwd;

  before(() => {
    cwd = createTempRepo();
  });

  after(() => {
    cleanupRepo(cwd);
  });

  it('creates a commit with correctly formatted message (AC-10)', () => {
    // Create a file change to commit
    fs.writeFileSync(path.join(cwd, 'experiment1.txt'), 'trial 1\n');

    const hash = commitExperiment({
      cwd,
      skillName: 'browse-fetch',
      hypothesis: 'reduce timeout to 5s',
      target: 'latency',
      value: '4.2s',
      delta: '-16',
      status: 'pass',
      secondaries: 'accuracy=98%',
    });

    assert.ok(typeof hash === 'string');
    assert.ok(hash.length >= 7, `Hash should be at least 7 chars, got: ${hash}`);

    // Verify commit message format
    const subject = execSync('git log -1 --format=%s', { cwd, stdio: 'pipe' }).toString().trim();
    assert.strictEqual(
      subject,
      'experiment(browse-fetch): reduce timeout to 5s | latency=4.2s delta=-16% pass | accuracy=98%'
    );
  });

  it('stages all changes before committing', () => {
    // Create an untracked file — commitExperiment should stage it
    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'new file\n');

    commitExperiment({
      cwd,
      skillName: 'test-skill',
      hypothesis: 'auto-stage',
      target: 'coverage',
      value: '80',
      delta: '+2',
      status: 'pass',
      secondaries: '',
    });

    // The file should be in the commit
    const files = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd, stdio: 'pipe' })
      .toString().trim();
    assert.ok(files.includes('untracked.txt'));
  });
});

describe('revertExperiment (AC-7)', () => {
  let cwd;

  before(() => {
    cwd = createTempRepo();
  });

  after(() => {
    cleanupRepo(cwd);
  });

  it('uses git revert (not reset) — preserves experiment commit in history', () => {
    // Make an experiment commit
    fs.writeFileSync(path.join(cwd, 'exp.txt'), 'experiment data\n');
    commitExperiment({
      cwd,
      skillName: 'skill-a',
      hypothesis: 'bad idea',
      target: 'speed',
      value: '10',
      delta: '-5',
      status: 'fail',
      secondaries: '',
    });

    const experimentSubject = execSync('git log -1 --format=%s', { cwd, stdio: 'pipe' }).toString().trim();

    // Revert
    const revertHash = revertExperiment({ cwd });
    assert.ok(typeof revertHash === 'string');

    // Verify revert commit message contains "Revert"
    const revertSubject = execSync('git log -1 --format=%s', { cwd, stdio: 'pipe' }).toString().trim();
    assert.ok(revertSubject.startsWith('Revert'), `Expected revert commit to start with "Revert", got: ${revertSubject}`);

    // The original experiment commit should still be in the log (not erased)
    const fullLog = execSync('git log --format=%s', { cwd, stdio: 'pipe' }).toString();
    assert.ok(fullLog.includes(experimentSubject), 'Original experiment commit should remain in history after revert');
  });

  it('reverted file content matches pre-experiment state', () => {
    // Write a file, commit as experiment, then revert
    fs.writeFileSync(path.join(cwd, 'state.txt'), 'before\n');
    execSync('git add -A && git commit -m "baseline"', { cwd, stdio: 'pipe' });

    fs.writeFileSync(path.join(cwd, 'state.txt'), 'after experiment\n');
    commitExperiment({
      cwd,
      skillName: 's',
      hypothesis: 'h',
      target: 't',
      value: '1',
      delta: '0',
      status: 'fail',
      secondaries: '',
    });

    revertExperiment({ cwd });

    const content = fs.readFileSync(path.join(cwd, 'state.txt'), 'utf-8');
    assert.strictEqual(content, 'before\n');
  });
});

describe('queryExperiments', () => {
  let cwd;

  before(() => {
    cwd = createTempRepo();

    // Create multiple experiment commits for different skills
    fs.writeFileSync(path.join(cwd, 'a.txt'), '1');
    commitExperiment({
      cwd, skillName: 'skill-a', hypothesis: 'hyp-a1',
      target: 'speed', value: '100', delta: '+10', status: 'pass', secondaries: 'mem=50MB',
    });

    fs.writeFileSync(path.join(cwd, 'b.txt'), '2');
    commitExperiment({
      cwd, skillName: 'skill-b', hypothesis: 'hyp-b1',
      target: 'accuracy', value: '95', delta: '-2', status: 'fail', secondaries: '',
    });

    fs.writeFileSync(path.join(cwd, 'c.txt'), '3');
    commitExperiment({
      cwd, skillName: 'skill-a', hypothesis: 'hyp-a2',
      target: 'speed', value: '120', delta: '+20', status: 'pass', secondaries: '',
    });
  });

  after(() => {
    cleanupRepo(cwd);
  });

  it('returns all experiments when no skillName filter', () => {
    const results = queryExperiments({ cwd });
    assert.strictEqual(results.length, 3);
  });

  it('filters by skillName', () => {
    const results = queryExperiments({ cwd, skillName: 'skill-a' });
    assert.strictEqual(results.length, 2);
    for (const r of results) {
      assert.strictEqual(r.skillName, 'skill-a');
    }
  });

  it('returns empty array for unknown skill', () => {
    const results = queryExperiments({ cwd, skillName: 'nonexistent' });
    assert.deepStrictEqual(results, []);
  });

  it('parses commit messages into structured objects with correct fields', () => {
    const results = queryExperiments({ cwd, skillName: 'skill-a' });
    // git log returns newest first
    const newest = results[0];
    assert.strictEqual(newest.hypothesis, 'hyp-a2');
    assert.strictEqual(newest.target, 'speed');
    assert.strictEqual(newest.value, '120');
    assert.strictEqual(newest.delta, 20);
    assert.strictEqual(newest.status, 'pass');
  });

  it('returns empty array in repo with no experiment commits', () => {
    const emptyRepo = createTempRepo();
    try {
      const results = queryExperiments({ cwd: emptyRepo, skillName: 'anything' });
      assert.deepStrictEqual(results, []);
    } finally {
      cleanupRepo(emptyRepo);
    }
  });
});

describe('getExperimentHistory', () => {
  let cwd;

  before(() => {
    cwd = createTempRepo();

    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(cwd, `file${i}.txt`), `${i}`);
      commitExperiment({
        cwd, skillName: 'perf', hypothesis: `trial-${i}`,
        target: 'throughput', value: `${i * 100}`, delta: `+${i}`,
        status: i % 2 === 0 ? 'fail' : 'pass', secondaries: '',
      });
    }
  });

  after(() => {
    cleanupRepo(cwd);
  });

  it('returns formatted multi-line string', () => {
    const history = getExperimentHistory({ cwd, skillName: 'perf' });
    const lines = history.split('\n');
    assert.strictEqual(lines.length, 5);
    // Each line should contain the skill name and hash
    for (const line of lines) {
      assert.ok(line.includes('perf:'), `Line should contain "perf:": ${line}`);
      assert.ok(line.startsWith('['), `Line should start with "[": ${line}`);
    }
  });

  it('respects maxEntries', () => {
    const history = getExperimentHistory({ cwd, skillName: 'perf', maxEntries: 2 });
    const lines = history.split('\n');
    assert.strictEqual(lines.length, 2);
  });

  it('defaults maxEntries to 20', () => {
    // We have 5 experiments, all should appear (5 < 20)
    const history = getExperimentHistory({ cwd, skillName: 'perf' });
    const lines = history.split('\n');
    assert.strictEqual(lines.length, 5);
  });

  it('returns "(no experiment history)" when no experiments match', () => {
    const history = getExperimentHistory({ cwd, skillName: 'nonexistent' });
    assert.strictEqual(history, '(no experiment history)');
  });

  it('returns "(no experiment history)" for empty repo', () => {
    const emptyRepo = createTempRepo();
    try {
      const history = getExperimentHistory({ cwd: emptyRepo });
      assert.strictEqual(history, '(no experiment history)');
    } finally {
      cleanupRepo(emptyRepo);
    }
  });
});

describe('round-trip: commit → query → verify', () => {
  let cwd;

  before(() => {
    cwd = createTempRepo();
  });

  after(() => {
    cleanupRepo(cwd);
  });

  it('parsed fields match original input', () => {
    const input = {
      skillName: 'round-trip-skill',
      hypothesis: 'cache improves latency',
      target: 'p99',
      value: '42ms',
      delta: '-33',
      status: 'pass',
      secondaries: 'p50=12ms cpu=65%',
    };

    fs.writeFileSync(path.join(cwd, 'rt.txt'), 'round-trip test\n');
    const commitHash = commitExperiment({ cwd, ...input });

    const experiments = queryExperiments({ cwd, skillName: 'round-trip-skill' });
    assert.strictEqual(experiments.length, 1);

    const parsed = experiments[0];
    assert.strictEqual(parsed.skillName, input.skillName);
    assert.strictEqual(parsed.hypothesis, input.hypothesis);
    assert.strictEqual(parsed.target, input.target);
    assert.strictEqual(parsed.value, input.value);
    assert.strictEqual(parsed.delta, parseFloat(input.delta));
    assert.strictEqual(parsed.status, input.status);
    assert.strictEqual(parsed.secondaries, input.secondaries);
    // Hash from commit should match hash from query (full vs short may differ, but short should be prefix)
    assert.ok(
      parsed.hash.startsWith(commitHash) || commitHash.startsWith(parsed.hash.slice(0, 7)),
      `Hashes should be related: commit=${commitHash}, query=${parsed.hash}`
    );
  });

  it('round-trip with numeric delta preserves sign', () => {
    fs.writeFileSync(path.join(cwd, 'rt2.txt'), 'test\n');
    commitExperiment({
      cwd,
      skillName: 'sign-test',
      hypothesis: 'negative delta',
      target: 'errors',
      value: '3',
      delta: '-50',
      status: 'pass',
      secondaries: '',
    });

    const [result] = queryExperiments({ cwd, skillName: 'sign-test' });
    assert.strictEqual(result.delta, -50);
  });
});
