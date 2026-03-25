'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  parseSecondaries,
  surfaceCandidates,
  formatCandidates,
} = require('./metric-pivot.js');

const { commitExperiment, revertExperiment } = require('./git-memory.js');

/**
 * Creates a temporary git repo with an initial commit.
 */
function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-pivot-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  execSync('git add -A && git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- parseSecondaries ---

describe('parseSecondaries', () => {
  it('parses single key=value pair', () => {
    const result = parseSecondaries('accuracy=98%');
    assert.deepStrictEqual(result, { accuracy: '98%' });
  });

  it('parses multiple key=value pairs', () => {
    const result = parseSecondaries('accuracy=98% latency=4.2s mem=50MB');
    assert.deepStrictEqual(result, {
      accuracy: '98%',
      latency: '4.2s',
      mem: '50MB',
    });
  });

  it('returns empty object for null input', () => {
    assert.deepStrictEqual(parseSecondaries(null), {});
  });

  it('returns empty object for undefined input', () => {
    assert.deepStrictEqual(parseSecondaries(undefined), {});
  });

  it('returns empty object for empty string', () => {
    assert.deepStrictEqual(parseSecondaries(''), {});
  });

  it('skips tokens without equals sign', () => {
    const result = parseSecondaries('good=1 badtoken good2=2');
    assert.deepStrictEqual(result, { good: '1', good2: '2' });
  });

  it('handles values containing equals signs', () => {
    // token "key=a=b" => key="a=b" (first = is the split point)
    const result = parseSecondaries('formula=x=y+z');
    assert.deepStrictEqual(result, { formula: 'x=y+z' });
  });

  it('handles extra whitespace between tokens', () => {
    const result = parseSecondaries('  a=1   b=2  ');
    assert.deepStrictEqual(result, { a: '1', b: '2' });
  });

  it('skips tokens with empty key (e.g. "=value")', () => {
    const result = parseSecondaries('=nokey valid=yes');
    assert.deepStrictEqual(result, { valid: 'yes' });
  });
});

// --- surfaceCandidates (integration with temp git repo) ---

describe('surfaceCandidates', () => {
  describe('AC-14: finds reverted experiments with positive delta on new target', () => {
    let cwd;

    before(() => {
      cwd = createTempRepo();

      // Experiment 1: reverted, primary target=latency, positive delta
      fs.writeFileSync(path.join(cwd, 'e1.txt'), '1');
      commitExperiment({
        cwd, skillName: 'browse-fetch', hypothesis: 'cache responses',
        target: 'latency', value: '4.2s', delta: '+16', status: 'reverted',
        secondaries: 'accuracy=98%',
      });

      // Experiment 2: reverted, primary target=latency, negative delta => excluded
      fs.writeFileSync(path.join(cwd, 'e2.txt'), '2');
      commitExperiment({
        cwd, skillName: 'browse-fetch', hypothesis: 'bad cache',
        target: 'latency', value: '10s', delta: '-5', status: 'reverted',
        secondaries: '',
      });

      // Experiment 3: kept (pass), primary target=latency, positive delta => excluded (not reverted)
      fs.writeFileSync(path.join(cwd, 'e3.txt'), '3');
      commitExperiment({
        cwd, skillName: 'browse-fetch', hypothesis: 'kept experiment',
        target: 'latency', value: '3s', delta: '+20', status: 'pass',
        secondaries: '',
      });

      // Experiment 4: reverted, primary target=speed, but latency in secondaries
      fs.writeFileSync(path.join(cwd, 'e4.txt'), '4');
      commitExperiment({
        cwd, skillName: 'browse-fetch', hypothesis: 'speed tweak with latency side-effect',
        target: 'speed', value: '150', delta: '+10', status: 'reverted',
        secondaries: 'latency=3.1s mem=40MB',
      });
    });

    after(() => {
      cleanupRepo(cwd);
    });

    it('finds reverted experiment with positive delta on primary target', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'browse-fetch', newTarget: 'latency',
      });

      const primaryCandidate = candidates.find(c => c.candidateSource === 'primary');
      assert.ok(primaryCandidate, 'Should find a primary candidate');
      assert.strictEqual(primaryCandidate.hypothesis, 'cache responses');
      assert.strictEqual(primaryCandidate.candidateValue, '4.2s');
      assert.strictEqual(primaryCandidate.candidateDelta, 16);
    });

    it('excludes reverted experiments with negative delta on primary target', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'browse-fetch', newTarget: 'latency',
      });

      const badCache = candidates.find(c => c.hypothesis === 'bad cache');
      assert.strictEqual(badCache, undefined, 'Should not include negative delta experiment');
    });

    it('excludes non-reverted (kept) experiments', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'browse-fetch', newTarget: 'latency',
      });

      const kept = candidates.find(c => c.hypothesis === 'kept experiment');
      assert.strictEqual(kept, undefined, 'Should not include kept (pass) experiments');
    });

    it('finds candidates from secondary metrics', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'browse-fetch', newTarget: 'latency',
      });

      const secondaryCandidate = candidates.find(c => c.candidateSource === 'secondary');
      assert.ok(secondaryCandidate, 'Should find a secondary candidate');
      assert.strictEqual(secondaryCandidate.hypothesis, 'speed tweak with latency side-effect');
      assert.strictEqual(secondaryCandidate.candidateValue, '3.1s');
      assert.strictEqual(secondaryCandidate.candidateDelta, null, 'Secondary candidates have no delta');
    });

    it('returns empty array when no candidates match new target', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'browse-fetch', newTarget: 'nonexistent-metric',
      });
      assert.deepStrictEqual(candidates, []);
    });
  });

  describe('edge cases', () => {
    let cwd;

    before(() => {
      cwd = createTempRepo();
    });

    after(() => {
      cleanupRepo(cwd);
    });

    it('returns empty array when no experiments exist', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'no-experiments', newTarget: 'latency',
      });
      assert.deepStrictEqual(candidates, []);
    });

    it('returns empty array for unknown skill name', () => {
      // Add an experiment for a different skill
      fs.writeFileSync(path.join(cwd, 'other.txt'), 'other');
      commitExperiment({
        cwd, skillName: 'other-skill', hypothesis: 'h',
        target: 'metric', value: '1', delta: '+5', status: 'reverted',
        secondaries: '',
      });

      const candidates = surfaceCandidates({
        cwd, skillName: 'nonexistent-skill', newTarget: 'metric',
      });
      assert.deepStrictEqual(candidates, []);
    });
  });

  describe('reverted experiments with zero delta excluded', () => {
    let cwd;

    before(() => {
      cwd = createTempRepo();

      fs.writeFileSync(path.join(cwd, 'z.txt'), 'z');
      commitExperiment({
        cwd, skillName: 'zero-test', hypothesis: 'zero delta',
        target: 'metric', value: '50', delta: '0', status: 'reverted',
        secondaries: '',
      });
    });

    after(() => {
      cleanupRepo(cwd);
    });

    it('excludes reverted experiments with zero delta (not positive)', () => {
      const candidates = surfaceCandidates({
        cwd, skillName: 'zero-test', newTarget: 'metric',
      });
      assert.deepStrictEqual(candidates, [], 'Zero delta is not positive, should be excluded');
    });
  });
});

// --- formatCandidates ---

describe('formatCandidates', () => {
  it('returns "no candidates" message for empty list', () => {
    const result = formatCandidates([], 'latency');
    assert.strictEqual(result, 'No reverted experiments found with positive delta on target="latency".');
  });

  it('formats candidate with primary delta', () => {
    const candidates = [{
      hash: 'abc1234',
      skillName: 'browse-fetch',
      hypothesis: 'cache responses',
      target: 'latency',
      value: '4.2s',
      delta: 16,
      status: 'reverted',
      secondaries: 'accuracy=98%',
      candidateValue: '4.2s',
      candidateDelta: 16,
      candidateSource: 'primary',
    }];

    const result = formatCandidates(candidates, 'latency');

    assert.ok(result.includes('Reverted experiments with positive signal on "latency"'));
    assert.ok(result.includes('[abc1234] browse-fetch: cache responses'));
    assert.ok(result.includes('delta=+16% (primary)'));
    assert.ok(result.includes('original target: latency=4.2s delta=16%'));
  });

  it('formats candidate from secondary (no delta)', () => {
    const candidates = [{
      hash: 'def5678',
      skillName: 'browse-fetch',
      hypothesis: 'speed tweak',
      target: 'speed',
      value: '150',
      delta: 10,
      status: 'reverted',
      secondaries: 'latency=3.1s',
      candidateValue: '3.1s',
      candidateDelta: null,
      candidateSource: 'secondary',
    }];

    const result = formatCandidates(candidates, 'latency');

    assert.ok(result.includes('[def5678] browse-fetch: speed tweak'));
    assert.ok(result.includes('value=3.1s (secondary'));
    assert.ok(result.includes('no delta available'));
    assert.ok(result.includes('original target: speed=150 delta=10%'));
  });

  it('formats multiple candidates', () => {
    const candidates = [
      {
        hash: 'aaa',
        skillName: 'skill-a',
        hypothesis: 'h1',
        target: 'latency',
        value: '4s',
        delta: 10,
        status: 'reverted',
        candidateValue: '4s',
        candidateDelta: 10,
        candidateSource: 'primary',
      },
      {
        hash: 'bbb',
        skillName: 'skill-a',
        hypothesis: 'h2',
        target: 'speed',
        value: '200',
        delta: 5,
        status: 'reverted',
        candidateValue: '3s',
        candidateDelta: null,
        candidateSource: 'secondary',
      },
    ];

    const result = formatCandidates(candidates, 'latency');

    assert.ok(result.includes('[aaa]'));
    assert.ok(result.includes('[bbb]'));
    assert.ok(result.includes('h1'));
    assert.ok(result.includes('h2'));
  });

  it('does not have trailing newline', () => {
    const candidates = [{
      hash: 'x',
      skillName: 's',
      hypothesis: 'h',
      target: 't',
      value: '1',
      delta: 5,
      status: 'reverted',
      candidateValue: '1',
      candidateDelta: 5,
      candidateSource: 'primary',
    }];

    const result = formatCandidates(candidates, 't');
    assert.ok(!result.endsWith('\n'), 'Output should not end with newline (trimEnd applied)');
  });
});
