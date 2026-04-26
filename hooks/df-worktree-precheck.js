#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow worktree pre-check
 * PreToolUse hook: blocks Write/Edit when the resolved file path is in the
 * main repo top-level (not under any df/* worktree) while df/* worktrees are
 * active. This is the pre-write counterpart to df-worktree-guard.js (which
 * runs PostToolUse and can only log, not rollback).
 *
 * Block conditions (all must hold):
 *   1. tool_name is Write or Edit
 *   2. file_path is NOT on the allowlist (.deepflow/, PLAN.md, specs/)
 *   3. at least one df/* worktree branch exists
 *   4. resolved absolute file_path is NOT under any df/* worktree path
 *
 * The resolution rule closes the original wave-1 leakage: when a sub-agent
 * inherits the orchestrator's cwd (main repo) and writes to a relative path
 * like "bin/install.js", that resolves to the main-repo file — which is
 * precisely the wrong place when worktrees are active.
 *
 * Escape hatches:
 *   - DF_WORKTREE_GUARD=0 disables the hook entirely (for human-driven
 *     recovery flows that need to touch main while worktrees exist)
 *   - Allowlisted paths (.deepflow/, PLAN.md, specs/) always pass — these
 *     are framework state legitimately written from any cwd
 *
 * Failure policy: exits 0 silently on git failure, parse error, or unknown
 * state — never breaks tool execution in non-deepflow projects.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

const ALLOWLIST = [
  /(?:^|\/)\.deepflow\//,
  /(?:^|\/)PLAN\.md$/,
  /(?:^|\/)specs\//,
];

function isAllowlisted(filePath) {
  return ALLOWLIST.some(re => re.test(filePath));
}

function isOptedOut() {
  return process.env.DF_WORKTREE_GUARD === '0';
}

function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function listDfWorktrees(cwd) {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return [];
  }

  const wts = [];
  let current = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) wts.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === '') {
      if (current.path) {
        wts.push(current);
        current = {};
      }
    }
  }
  if (current.path) wts.push(current);
  return wts.filter(w => w.branch && w.branch.startsWith('df/'));
}

function isUnderAnyWorktree(absFile, worktrees, root) {
  for (const wt of worktrees) {
    const wtAbs = path.isAbsolute(wt.path) ? wt.path : path.resolve(root, wt.path);
    if (absFile === wtAbs) return true;
    if (absFile.startsWith(wtAbs + path.sep)) return true;
  }
  return false;
}

readStdinIfMain(module, (data) => {
  if (isOptedOut()) return;

  const toolName = data.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit') return;

  const filePath = (data.tool_input && data.tool_input.file_path) || '';
  if (!filePath) return;

  if (isAllowlisted(filePath)) return;

  const cwd = data.cwd || process.cwd();
  const root = repoRoot(cwd);
  if (!root) return;

  const worktrees = listDfWorktrees(cwd);
  if (worktrees.length === 0) return;

  const absFile = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

  if (isUnderAnyWorktree(absFile, worktrees, root)) return;

  if (absFile === root || !absFile.startsWith(root + path.sep)) return;

  const wtList = worktrees.map(w => w.path).join(', ');
  console.error(
    `[df-worktree-precheck] BLOCKED ${toolName} to "${filePath}" — ` +
    `path resolves to "${absFile}" which is in the main repo while df/* worktrees are active. ` +
    `Sub-agents MUST write to their assigned worktree using absolute paths. ` +
    `Active worktrees: ${wtList}. ` +
    `Override with DF_WORKTREE_GUARD=0 if this is intentional human-driven work.`
  );
  process.exit(1);
});

module.exports = {
  isAllowlisted,
  isUnderAnyWorktree,
  listDfWorktrees,
  ALLOWLIST,
};
