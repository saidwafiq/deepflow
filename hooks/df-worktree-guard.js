#!/usr/bin/env node
// @hook-event: PostToolUse
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

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const toolName = data.tool_name || '';

    // Only guard Write and Edit
    if (toolName !== 'Write' && toolName !== 'Edit') {
      process.exit(0);
    }

    const filePath = (data.tool_input && data.tool_input.file_path) || '';
    const cwd = data.cwd || process.cwd();

    // Allowlisted paths always pass
    if (isAllowlisted(filePath)) {
      process.exit(0);
    }

    const branch = currentBranch(cwd);

    // Only guard when on main/master
    if (branch !== 'main' && branch !== 'master') {
      process.exit(0);
    }

    // Block only when a df/* worktree branch exists
    if (!dfWorktreeExists(cwd)) {
      process.exit(0);
    }

    // All conditions met — block the write
    console.error(
      `[df-worktree-guard] Blocked ${toolName} to "${filePath}" on main branch ` +
      `while df/* worktree exists. Make changes inside the worktree branch instead.`
    );
    process.exit(1);
  } catch (_e) {
    // Parse or unexpected error — fail open so we never break non-deepflow projects
    process.exit(0);
  }
});
