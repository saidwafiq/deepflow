#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow worktree guard
 * PostToolUse hook: blocks Write/Edit to main-branch files when a df/* worktree exists.
 *
 * REQ-3 AC-4: exit(1) to block the tool call when all conditions hold:
 *   1. tool_name is Write or Edit
 *   2. current branch is main (or master)
 *   3. a df/* worktree branch exists
 *   4. file_path is NOT on the allowlist (.deepflow/, PLAN.md, specs/)
 *
 * REQ-3 AC-5: allowlisted paths always pass through (no false positives).
 *
 * Exits silently (code 0) on parse errors or git failures — never breaks tool
 * execution in non-deepflow projects.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

// Paths that are always allowed regardless of worktree state
const ALLOWLIST = [
  /(?:^|\/)\.deepflow\//,
  /(?:^|\/)PLAN\.md$/,
  /(?:^|\/)specs\//,
];

function isAllowlisted(filePath) {
  return ALLOWLIST.some(re => re.test(filePath));
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
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

/**
 * List all worktrees as { path, branch } objects parsed from `git worktree list --porcelain`.
 * Returns [] on git failure.
 */
function listWorktrees(cwd) {
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

  const worktrees = [];
  let current = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      // e.g. "branch refs/heads/df/foo"
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === '') {
      if (current.path) {
        worktrees.push(current);
        current = {};
      }
    }
  }
  if (current.path) worktrees.push(current);
  return worktrees;
}

/**
 * Parse PLAN.md content and return the in-progress task's Files: list.
 * "In-progress" = first unchecked `[ ]` task, or the task whose id matches branchName.
 * Returns an array of file path strings (possibly empty).
 */
function extractInProgressFiles(planContent, branchName) {
  if (!planContent) return [];
  const lines = planContent.split('\n');

  // Collect task blocks: start indices at lines matching `- [ ]` or `- [x]`
  const taskStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s*\[[ xX]\]\s*\*?\*?T\d+/.test(lines[i]) || /^\s*-\s*\[[ xX]\]/.test(lines[i])) {
      taskStarts.push(i);
    }
  }

  function getBlock(startIdx) {
    const end = taskStarts.find(i => i > startIdx) ?? lines.length;
    return lines.slice(startIdx, end);
  }

  function getFilesFromBlock(block) {
    for (const line of block) {
      const m = line.match(/^\s*-?\s*Files:\s*(.+)$/i);
      if (m) {
        return m[1]
          .split(',')
          .map(s => s.trim().replace(/^[`"']|[`"']$/g, ''))
          .filter(s => s.length > 0 && !/^\{.*\}$/.test(s) && !/^\[.*\]$/.test(s));
      }
    }
    return [];
  }

  // Prefer: first unchecked task
  for (const idx of taskStarts) {
    if (/^\s*-\s*\[ \]/.test(lines[idx])) {
      return getFilesFromBlock(getBlock(idx));
    }
  }

  // Fallback: task matching branch name (e.g., df/feature-x → match "feature-x" in header)
  if (branchName) {
    const slug = branchName.replace(/^df\//, '');
    for (const idx of taskStarts) {
      if (lines[idx].toLowerCase().includes(slug.toLowerCase())) {
        return getFilesFromBlock(getBlock(idx));
      }
    }
  }

  return [];
}

/**
 * Normalize a file path for intersection comparison.
 * Returns path relative to repo root when possible; otherwise basename.
 */
function normalizePath(p, repoRoot) {
  if (!p) return '';
  const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot || '', p);
  if (repoRoot && abs.startsWith(repoRoot + path.sep)) {
    return abs.slice(repoRoot.length + 1);
  }
  return p;
}

readStdinIfMain(module, (data) => {
  const toolName = data.tool_name || '';

  // Only guard Write and Edit
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return;
  }

  const filePath = (data.tool_input && data.tool_input.file_path) || '';
  const cwd = data.cwd || process.cwd();

  // Allowlisted paths always pass
  if (isAllowlisted(filePath)) {
    return;
  }

  const branch = currentBranch(cwd);

  // REQ-2: Cross-worktree file intersection check.
  // For every df/* worktree OTHER than the current one, read its PLAN.md,
  // find the in-progress task, and BLOCK if filePath intersects its Files: list.
  try {
    const worktrees = listWorktrees(cwd);
    const currentWorktreePath = worktrees.find(w => w.branch === branch)?.path || cwd;

    for (const wt of worktrees) {
      if (!wt.branch || !wt.branch.startsWith('df/')) continue;
      if (wt.path === currentWorktreePath) continue;

      const planPath = path.join(wt.path, 'PLAN.md');
      let planContent;
      try {
        planContent = fs.readFileSync(planPath, 'utf8');
      } catch (_) {
        continue; // no PLAN.md — skip gracefully
      }

      const claimed = extractInProgressFiles(planContent, wt.branch);
      if (claimed.length === 0) continue;

      // Repo root of the OTHER worktree: normalize writing file against current cwd
      // but compare against claimed paths (which are repo-relative in PLAN.md).
      const writeRel = normalizePath(filePath, currentWorktreePath);
      const writeBase = path.basename(filePath);

      for (const claimedFile of claimed) {
        const claimedRel = claimedFile.replace(/^\.\//, '');
        const claimedBase = path.basename(claimedRel);
        if (
          writeRel === claimedRel ||
          filePath === claimedRel ||
          filePath.endsWith('/' + claimedRel) ||
          writeBase === claimedBase && (writeRel.endsWith(claimedRel) || claimedRel.endsWith(writeRel))
        ) {
          console.error(
            `[df-worktree-guard] Blocked ${toolName} to "${filePath}" — ` +
            `file is claimed by in-progress task in worktree ${wt.branch} (${wt.path}). ` +
            `Coordinate or wait for that task to complete.`
          );
          process.exit(1);
        }
      }
    }
  } catch (_) {
    // Never break tool execution on unexpected errors
  }

  // Only guard when on main/master
  if (branch !== 'main' && branch !== 'master') {
    return;
  }

  // Block only when a df/* worktree branch exists
  if (!dfWorktreeExists(cwd)) {
    return;
  }

  // All conditions met — block the write
  console.error(
    `[df-worktree-guard] Blocked ${toolName} to "${filePath}" on main branch ` +
    `while df/* worktree exists. Make changes inside the worktree branch instead.`
  );
  process.exit(1);
});
