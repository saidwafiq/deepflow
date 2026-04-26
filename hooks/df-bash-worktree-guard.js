#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow Bash worktree guard
 * PreToolUse hook: blocks mutating git commands run from the main repo cwd
 * while df/* worktrees exist, unless the command uses `git -C <worktree-path>`
 * to explicitly target a worktree.
 *
 * This closes the original T2-style wave-1 leakage: a sub-agent inherits the
 * orchestrator's cwd (main repo, branch=main) and runs `git commit` — the
 * commit lands on `main` instead of the assigned worktree branch.
 *
 * Mutating git ops checked: commit, add, checkout, reset, revert, cherry-pick,
 * merge, rebase, stash, push, branch, tag.
 *
 * Block conditions (all must hold):
 *   1. tool_name is Bash
 *   2. command contains a mutating git op
 *   3. cwd is NOT inside .deepflow/worktrees/ (i.e. cwd is the main repo)
 *   4. at least one df/* worktree branch exists
 *   5. the mutating git op was invoked WITHOUT a `-C ` flag
 *
 * Escape hatches:
 *   - DF_WORKTREE_GUARD=0 disables the hook (for human-driven recovery)
 *   - Read-only git ops (status, diff, log, show, ls-files, rev-parse,
 *     worktree list, branch --list) are never blocked
 *
 * Failure policy: exits 0 silently on git failure or unknown state.
 */

'use strict';

const { execFileSync } = require('child_process');
const { readStdinIfMain } = require('./lib/hook-stdin');

const MUTATING_OPS = [
  'commit',
  'add',
  'checkout',
  'reset',
  'revert',
  'cherry-pick',
  'merge',
  'rebase',
  'stash',
  'push',
  'branch',
  'tag',
];

const MUTATING_RE = new RegExp(
  '\\bgit(?:\\s+-c\\s+\\S+)*(?:\\s+-C\\s+\\S+)?\\s+(' + MUTATING_OPS.join('|') + ')\\b',
  'g'
);

function isOptedOut() {
  return process.env.DF_WORKTREE_GUARD === '0';
}

function isInsideWorktreeCwd(cwd) {
  return cwd.includes('/.deepflow/worktrees/');
}

function dfWorktreeExists(cwd) {
  try {
    const out = execFileSync('git', ['branch', '--list', 'df/*'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

function findOffendingOps(cmd) {
  const offending = [];
  let m;
  MUTATING_RE.lastIndex = 0;
  while ((m = MUTATING_RE.exec(cmd)) !== null) {
    const segment = m[0];
    if (!/\s-C\s/.test(segment)) {
      offending.push(m[1]);
    }
  }
  return offending;
}

readStdinIfMain(module, (data) => {
  if (isOptedOut()) return;
  if (data.tool_name !== 'Bash') return;

  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (!cmd) return;

  if (!/\bgit\s+/.test(cmd)) return;

  const cwd = data.cwd || process.cwd();
  if (isInsideWorktreeCwd(cwd)) return;

  if (!dfWorktreeExists(cwd)) return;

  const offending = findOffendingOps(cmd);
  if (offending.length === 0) return;

  console.error(
    `[df-bash-worktree-guard] BLOCKED git ${offending.join(', ')} from main repo cwd ` +
    `while df/* worktrees are active. ` +
    `Use \`git -C <worktree-path> ${offending[0]} ...\` to target a specific worktree, ` +
    `or cd into the worktree first. ` +
    `Override with DF_WORKTREE_GUARD=0 for human-driven recovery.`
  );
  process.exit(1);
});

module.exports = {
  MUTATING_OPS,
  MUTATING_RE,
  findOffendingOps,
  isInsideWorktreeCwd,
};
