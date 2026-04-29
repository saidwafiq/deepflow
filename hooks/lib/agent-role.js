'use strict';

/**
 * hooks/lib/agent-role.js
 *
 * Infer the deepflow subagent role from a Bash invocation payload.
 * Ported from T104's reference implementation (probe-T104/agent-role-reference.js).
 * Extended by T108 to add a transcript-walk fallback tier.
 *
 * Two-tier strategy (T108):
 *   Tier 1: cwd-branch inference (inferAgentRoleFromCwd) — deterministic for
 *            task agents running in df/<spec>--probe-T{N} worktrees.
 *   Tier 2: transcript-walk (inferAgentRoleViaTranscript) — covers df-haiku-ops
 *            and any subagent running from an arbitrary cwd (T114 spike result).
 *
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
 * Tier-1: Infer agent role from the working directory via git branch + PLAN.md tag lookup.
 *
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
function inferAgentRoleFromCwd(cwd) {
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

/**
 * Tier-2: Infer agent role by walking the parent transcript's subagents directory.
 *
 * Background (T114 spike): PreToolUse:Bash payloads carry `transcript_path` pointing
 * to the PARENT (orchestrator) session's .jsonl file. Claude Code writes a sibling
 * `<sid>/subagents/agent-{agentId}.meta.json` for each active subagent. We find the
 * most-recently-active subagent whose .jsonl was written within `staleMs` of `nowMs`
 * and return its agentType — that IS the currently-executing subagent.
 *
 * Heuristic boundary: mtime recency. If two subagents are active simultaneously
 * (unlikely for df:execute's sequential cherry-pick flow), the most-recently-active
 * one wins. Stale agents (idle for > staleMs) are excluded so a completed prior
 * subagent doesn't shadow the current one.
 *
 * @param {string}  transcriptPath  Absolute path to the parent session .jsonl file.
 * @param {object}  [opts]
 * @param {number}  [opts.nowMs=Date.now()]  Reference timestamp for staleness check.
 * @param {number}  [opts.staleMs=5000]      Subagent .jsonl must be newer than this.
 * @returns {string|null}  agentType string or null on any failure / no recent subagent.
 */
function inferAgentRoleViaTranscript(transcriptPath, opts = {}) {
  if (!transcriptPath) return null;
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const staleMs = opts.staleMs !== undefined ? opts.staleMs : 5000;

  try {
    const dir = path.dirname(transcriptPath);
    const base = path.basename(transcriptPath, '.jsonl');
    const subDir = path.join(dir, base, 'subagents');

    let entries;
    try {
      entries = fs.readdirSync(subDir);
    } catch (_) {
      return null; // subagents dir doesn't exist → no active subagent
    }

    // Build candidate list: meta files whose sibling .jsonl mtime is within staleMs.
    const candidates = entries
      .filter(n => n.endsWith('.meta.json'))
      .map(n => {
        const agentId = n.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
        const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
        try {
          const st = fs.statSync(jsonlPath);
          return { agentId, metaPath: path.join(subDir, n), mtimeMs: st.mtimeMs };
        } catch (_) {
          return null;
        }
      })
      .filter(c => c !== null && (nowMs - c.mtimeMs) < staleMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // most-recent first

    if (candidates.length === 0) return null;

    try {
      const meta = JSON.parse(fs.readFileSync(candidates[0].metaPath, 'utf8'));
      return meta.agentType || meta.agent_type || null;
    } catch (_) {
      return null;
    }
  } catch (_) {
    // Belt-and-suspenders: no error must escape.
    return null;
  }
}

/**
 * Combined two-tier agent role inference.
 *
 * Accepts a full PreToolUse payload object OR a bare cwd string (back-compat
 * transitional overload — existing callers that pass cwd directly keep working).
 *
 * Tier 1: cwd-branch inference (fast, deterministic for task-worktree agents).
 * Tier 2: transcript-walk (covers df-haiku-ops + agents from arbitrary cwds).
 * Tier 3: orchestrator pass-through → null.
 *
 * @param {object|string} payload  Full hook payload object, or a bare cwd string.
 * @returns {string|null}  subagent_type or null.
 */
function inferAgentRole(payload) {
  // Back-compat: bare cwd string passed by transitional callers.
  if (typeof payload === 'string') return inferAgentRoleFromCwd(payload);
  if (!payload) return null;

  // Tier 1: cwd-branch inference.
  const fromCwd = inferAgentRoleFromCwd(payload.cwd);
  if (fromCwd) return fromCwd;

  // Tier 2: transcript-walk fallback.
  if (payload.transcript_path) {
    const fromTranscript = inferAgentRoleViaTranscript(payload.transcript_path);
    if (fromTranscript) return fromTranscript;
  }

  // Tier 3: orchestrator pass-through.
  return null;
}

module.exports = { inferAgentRole, inferAgentRoleFromCwd, inferAgentRoleViaTranscript };
