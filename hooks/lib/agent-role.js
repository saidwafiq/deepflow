'use strict';

/**
 * hooks/lib/agent-role.js
 *
 * Infer the deepflow subagent role from a Bash invocation's working directory.
 * Ported from T104's reference implementation (probe-T104/agent-role-reference.js).
 *
 * Single-source identity: cwd → git branch → PLAN.md tag lookup.
 * No env-var reads (T103 HIGH: DEEPFLOW_AGENT_ROLE is never propagated by Claude Code).
 * No stdin reads — that is the hook's responsibility.
 */

const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

// Mapping from PLAN.md task tag to subagent_type (df:execute §6 routing table).
const TAG_TO_SUBAGENT = {
  '[INTEGRATION]': 'df-integration',
  '[SPIKE]':       'df-spike',
  '[OPTIMIZE]':    'df-optimize',
  '[TEST]':        'df-test',
  // No tag → standard implementation task
};

/**
 * @param {string} cwd  Absolute path (PreToolUse:Bash payload.cwd)
 * @returns {string|null}  subagent_type tag (e.g. 'df-implement', 'df-spike')
 *   or null when cwd is outside any df/<spec>--probe-T{N} worktree, or when
 *   inference fails for any reason (PLAN.md absent, git not available, etc.).
 *
 * Returns null for:
 *   - Branches not matching df/* pattern (orchestrator context or main)
 *   - Branches matching df/<spec> but without a --probe-T{N} task suffix
 *     (spec-level worktree; no per-task identity)
 *   - Any git error (not a repo, detached HEAD, etc.)
 *   - PLAN.md not found in the main repo
 *   - Task ID not found in PLAN.md (stale branch or probe typo)
 */
function inferAgentRole(cwd) {
  try {
    // Step 1: Resolve git branch from cwd. stderr suppressed so hook output stays clean.
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // Step 2: Parse branch name.
    // Pattern handles both df/{spec} and df/{spec}--probe-T{N} forms.
    // The taskId capture group is only set for probe branches.
    const branchMatch = branch.match(/^df\/(.+?)(?:--probe-(T\d+))?$/);
    if (!branchMatch) {
      return null; // Not a deepflow branch; orchestrator or unrelated context.
    }

    const [, /* spec */, taskId] = branchMatch;

    // Step 3: No task suffix → spec-level worktree (orchestrator-level on the spec
    // branch). Cannot infer per-task role; let T107 pass-through via null.
    if (!taskId) {
      return null;
    }

    // Step 4: Find main repo root via --git-common-dir (works for both main repo
    // and linked worktrees; returns the shared .git directory).
    // Deriving root from common-dir avoids the filesystem walk in T104's reference
    // impl while producing an identical result.
    let repoRoot;
    try {
      const commonDir = execSync('git rev-parse --git-common-dir', {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      // commonDir is either an absolute path or relative to cwd.
      // For a linked worktree: /abs/path/to/repo/.git
      // For the main repo:     .git  (relative)
      const absCommonDir = path.isAbsolute(commonDir)
        ? commonDir
        : path.resolve(cwd, commonDir);

      // Strip /.git to get repo working-tree root.
      repoRoot = path.dirname(absCommonDir);
    } catch (_) {
      return null;
    }

    // Step 5: Read PLAN.md from main repo root.
    const planPath = path.join(repoRoot, 'PLAN.md');
    if (!fs.existsSync(planPath)) {
      return null;
    }

    const planContent = fs.readFileSync(planPath, 'utf8');

    // Step 6: Find the task line for taskId.
    // Matches:  - [x] **T106** [SPIKE]: ...
    //           - [ ] **T106**: ...          (no tag, standard impl)
    //           - [~] **T106** [OPTIMIZE]: ...
    // The capture group grabs everything between **T{N}** and the colon,
    // which is either a bracketed tag like [SPIKE] or empty string.
    const taskPattern = new RegExp(
      `^- \\[.\\]\\s+\\*\\*${taskId}\\*\\*\\s*([^:]*):`,
      'm'
    );
    const taskMatch = planContent.match(taskPattern);
    if (!taskMatch) {
      return null; // Task absent from PLAN.md (stale branch or typo).
    }

    // Step 7: Map tag → subagent_type. Empty prefix → df-implement (default).
    const tag = taskMatch[1].trim();
    return TAG_TO_SUBAGENT[tag] || 'df-implement';

  } catch (_) {
    // Any unexpected error → graceful null. Hook caller handles null as pass-through.
    return null;
  }
}

module.exports = { inferAgentRole };
