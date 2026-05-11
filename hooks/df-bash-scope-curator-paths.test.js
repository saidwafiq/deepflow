'use strict';

/**
 * Tests for df-bash-scope curator-path denyOverride.
 *
 * Implementation-class agents (df-implement, df-test, df-integration,
 * df-optimize) MUST be blocked from reading curator-only artefacts via
 * Bash, because those paths leak the orchestrator's cross-task context
 * (specs/**.md, .deepflow/maps/**, decisions, checkpoint, config, CLAUDE.md).
 *
 * The block emits a directional error message that points the agent at
 * the existing CONTEXT_INSUFFICIENT escape hatch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-bash-scope.js');
const { CURATOR_PATH_DENY } = require('./lib/bash-scopes');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImplWorktree() {
  // Per Tier-1 cwd-branch detection (hooks/lib/agent-role.js), the role is
  // inferred from the cwd containing `.deepflow/worktrees/curator-active`
  // and the active git branch matching `df/*`. We construct a minimal
  // simulacrum: a tmp dir laid out as a worktree with a fake .git/HEAD on
  // a df/* branch.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-bash-scope-curator-'));
  const worktree = path.join(root, '.deepflow', 'worktrees', 'curator-active');
  fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git', 'HEAD'), 'ref: refs/heads/df/curator-active\n', 'utf8');
  fs.mkdirSync(path.join(root, '.deepflow'), { recursive: true });
  return { root, worktree };
}

function runHook({ command, cwd }) {
  return spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
    }),
    encoding: 'utf8',
  });
}

function parseDecision(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pattern unit tests — sanity-check the regexes themselves
// ---------------------------------------------------------------------------

describe('CURATOR_PATH_DENY pattern coverage', () => {
  const blocked = [
    'cat specs/foo.md',
    'cat ../../specs/foo.md',
    'cat /Users/x/repo/specs/spec-discovery-routing.md',
    'head specs/done-deprecate-plan-auto.md',
    'tail -n 50 specs/doing-foo.md',
    'cat .deepflow/maps/foo/sketch.md',
    'cat .deepflow/maps/foo/impact.md',
    'cat ../.deepflow/maps/x/findings.md',
    'cat .deepflow/decisions.md',
    'cat .deepflow/checkpoint.json',
    'cat .deepflow/config.yaml',
    'cat CLAUDE.md',
    'cat ./CLAUDE.md',
    'cat /repo/CLAUDE.md',
  ];

  const allowed = [
    'cat package.json',
    'cat README.md',
    'cat src/foo.js',
    'cat hooks/df-bash-scope.js',
    'cat /usr/local/share/man/something.md',
    'echo "no path here"',
    'npm test',
    'node bin/ratchet.js --worktree x',
    'git status',
    'git log --oneline',
    'cat changelog.md', // lowercase — distinct from CLAUDE.md
  ];

  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      const matched = CURATOR_PATH_DENY.some((re) => re.test(cmd));
      assert.equal(matched, true, `expected ${cmd} to match CURATOR_PATH_DENY`);
    });
  }

  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => {
      const matched = CURATOR_PATH_DENY.some((re) => re.test(cmd));
      assert.equal(matched, false, `expected ${cmd} NOT to match CURATOR_PATH_DENY`);
    });
  }
});

// ---------------------------------------------------------------------------
// End-to-end hook tests — spawn df-bash-scope.js as a subprocess
// ---------------------------------------------------------------------------

describe('df-bash-scope curator-path denyOverride (df-implement)', () => {
  it('blocks `cat specs/foo.md` from a df-implement worktree', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({ command: 'cat specs/foo.md', cwd: worktree });
      const decision = parseDecision(r.stdout);
      assert.ok(decision, `expected JSON decision on stdout, got: ${r.stdout}`);
      assert.equal(decision.decision, 'block');
      assert.match(
        decision.message,
        /curator-only artefacts/,
        'block message must mention curator-only artefacts'
      );
      assert.match(
        decision.message,
        /CONTEXT_INSUFFICIENT/,
        'block message must point to the CONTEXT_INSUFFICIENT escape hatch'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks `cat ../../specs/foo.md` (relative escape)', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({ command: 'cat ../../specs/foo.md', cwd: worktree });
      const decision = parseDecision(r.stdout);
      assert.ok(decision);
      assert.equal(decision.decision, 'block');
      assert.match(decision.message, /curator-only artefacts/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks absolute path to specs/', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({
        command: 'cat /Users/x/repo/specs/foo.md',
        cwd: worktree,
      });
      const decision = parseDecision(r.stdout);
      assert.ok(decision);
      assert.equal(decision.decision, 'block');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks `cat .deepflow/maps/foo/sketch.md`', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({
        command: 'cat .deepflow/maps/foo/sketch.md',
        cwd: worktree,
      });
      const decision = parseDecision(r.stdout);
      assert.ok(decision);
      assert.equal(decision.decision, 'block');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks `cat CLAUDE.md`', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({ command: 'cat CLAUDE.md', cwd: worktree });
      const decision = parseDecision(r.stdout);
      assert.ok(decision);
      assert.equal(decision.decision, 'block');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks `cat package.json` (inline-bundle contract — emit CONTEXT_INSUFFICIENT instead)', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({ command: 'cat package.json', cwd: worktree });
      const decision = parseDecision(r.stdout);
      assert.ok(decision, `expected JSON decision on stdout, got: ${r.stdout}`);
      assert.equal(decision.decision, 'block');
      assert.match(decision.message, /CONTEXT_INSUFFICIENT/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks `cat README.md` (inline-bundle contract — emit CONTEXT_INSUFFICIENT instead)', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({ command: 'cat README.md', cwd: worktree });
      const decision = parseDecision(r.stdout);
      assert.ok(decision);
      assert.equal(decision.decision, 'block');
      assert.match(decision.message, /CONTEXT_INSUFFICIENT/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows `npm test` (build/test runner)', () => {
    const { worktree, root } = makeImplWorktree();
    try {
      const r = runHook({ command: 'npm test', cwd: worktree });
      assert.equal(r.stdout, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes through when cwd is NOT a worktree (orchestrator-level Bash)', () => {
    // Calling from a non-worktree cwd → role inference returns null → pass-through.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'df-bash-orch-'));
    try {
      const r = runHook({ command: 'cat specs/foo.md', cwd: tmp });
      assert.equal(r.stdout, '', 'orchestrator cwd → pass-through (curator block does not apply)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
