'use strict';

/**
 * bash-scopes — per-agent Bash command allow/denyOverride scope declarations.
 *
 * Consumed by hooks/df-bash-scope.js (T107) to decide allow/block per Bash
 * invocation. This module is a pure data declaration — no stdin, no env reads.
 *
 * Precedence contract (enforced by the hook, not here):
 *   denyOverride beats allow — if a command matches any denyOverride pattern,
 *   it is blocked regardless of any allow match.
 *
 * Pattern convention:
 *   - All RegExp literals, anchored with ^ for first-token matching.
 *   - Patterns are tested against the FULL command string by df-bash-scope.js.
 *   - More specific patterns come before broader ones within each array.
 *
 * Agent scopes (REQ-2):
 *   df-haiku-ops   — widest: all git operations + all fs mutations
 *   df-implement   — build/test runners + read-only git + node scripts
 *   df-test        — same as df-implement (test runners are its primary job)
 *   df-integration — same as df-implement
 *   df-optimize    — df-implement scope + measurement tools
 *   df-spike       — build/test + read-only git + arbitrary CLI within worktree
 */

// ---------------------------------------------------------------------------
// Shared pattern sets — reused across multiple agents
// ---------------------------------------------------------------------------

/**
 * Read-only git commands safe in any worktree context.
 * These do not mutate repository state.
 */
const GIT_READ_ONLY = [
  /^git\s+status\b/,
  /^git\s+diff\b/,
  /^git\s+log\b/,
  /^git\s+show\b/,
  /^git\s+branch\s+--show-current\b/,
  /^git\s+branch\s+-[a-z]*v[a-z]*\b/,   // git branch -v, -vv, --list
  /^git\s+rev-parse\b/,
  /^git\s+ls-files\b/,
  /^git\s+remote\s+-v\b/,
];

/**
 * Build/test runners permitted for implementation-class agents.
 */
const BUILD_TEST_RUNNERS = [
  /^npm\s+(run|test|build|install)\b/,
  /^pnpm\s+(run|test|build|install)\b/,
  /^yarn\s+(run|test|build|install)\b/,
  /^npx\s+/,
  /^node\s+/,
  /^tsc\b/,
  /^jest\b/,
  /^vitest\b/,
  /^mocha\b/,
  /^ts-node\b/,
];

/**
 * History-rewriting and cross-branch git operations blocked for impl-class agents.
 * Does NOT include `git add` or `git commit` (without --amend) — those are
 * explicitly allowed for df-implement / df-test / df-integration / df-optimize
 * so they can commit on their own df/<spec> branch per REQ-1 (fix-narrow-bash-per-agent).
 */
const GIT_HISTORY_REWRITING_DENY = [
  /^git\s+push\b/,
  /^git\s+merge\b/,
  /^git\s+rebase\b/,
  /^git\s+reset\b/,
  /^git\s+stash\b/,
  /^git\s+branch\b(?!\s+--show-current|\s+-[a-z]*v)/, // branch mutations (not -v/--show-current)
  /^git\s+checkout\b/,
  /^git\s+worktree\b/,
  /^git\s+tag\b/,
];

/**
 * git commit --amend is blocked for impl-class agents (history rewriting).
 * Plain `git commit` (without --amend) is allowed.
 */
const GIT_AMEND_DENY = [
  /^git\s+commit\s+--amend\b/,
];

/**
 * Search tools that belong to exploration agents, not implementation agents.
 * These patterns mirror hooks/df-implement-bash-search-guard.js (REQ-5:
 * that guard is retired; its denial is now subsumed here).
 */
const SEARCH_TOOL_DENY = [
  /(?:^|&&\s*|;\s*|\|\s*)grep\b/,
  /(?:^|&&\s*|;\s*|\|\s*)rg\b/,
  /(?:^|&&\s*|;\s*|\|\s*)ag\b/,
  /(?:^|&&\s*|;\s*|\|\s*)find\b.*-name\b/,
];

// denyOverride for implementation-class agents (df-implement, df-test, df-integration, df-optimize).
// git add and plain git commit are intentionally absent — they are in the allow list instead.
const IMPL_DENY = [...GIT_HISTORY_REWRITING_DENY, ...GIT_AMEND_DENY, ...SEARCH_TOOL_DENY];

// ---------------------------------------------------------------------------
// SCOPES map
// ---------------------------------------------------------------------------

const SCOPES = {
  /**
   * df-haiku-ops — the commit/fs-mutation delegate.
   * Widest scope: all git operations (read + write) and all fs mutations.
   * denyOverride is empty — haiku-ops is trusted to perform any shell work.
   */
  'df-haiku-ops': {
    allow: [
      // All git (read and write)
      /^git\b/,
      // Filesystem mutations
      /^mkdir\b/,
      /^mv\b/,
      /^cp\b/,
      /^rm\b/,
      /^touch\b/,
      /^chmod\b/,
      /^ln\b/,
      // Build/test (haiku-ops may run health checks after mutations)
      ...BUILD_TEST_RUNNERS,
      // General shell utilities
      /^echo\b/,
      /^cat\b/,
      /^ls\b/,
      /^pwd\b/,
      /^cd\b/,
      /^which\b/,
      /^env\b/,
    ],
    denyOverride: [],
  },

  /**
   * df-implement — writes code; commits on its own df/<spec> branch.
   * Allow: build/test runners, read-only git, git add/commit (non-amend), node script execution.
   * Deny: search tools (use Read with explicit paths), git history-rewriting / cross-branch ops.
   */
  'df-implement': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
      // Commit operations on own branch (REQ-1: fix-narrow-bash-per-agent)
      /^git\s+add\b/,
      /^git\s+commit\b/,
      // Lightweight read utilities
      /^ls\b/,
      /^pwd\b/,
      /^cat\b/,
      /^echo\b/,
      /^which\b/,
    ],
    denyOverride: IMPL_DENY,
  },

  /**
   * df-test — runs test suites; same operational profile as df-implement.
   */
  'df-test': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
      // Commit operations on own branch (REQ-1: fix-narrow-bash-per-agent)
      /^git\s+add\b/,
      /^git\s+commit\b/,
      /^ls\b/,
      /^pwd\b/,
      /^cat\b/,
      /^echo\b/,
      /^which\b/,
    ],
    denyOverride: IMPL_DENY,
  },

  /**
   * df-integration — integration verification; same profile as df-implement.
   */
  'df-integration': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
      // Commit operations on own branch (REQ-1: fix-narrow-bash-per-agent)
      /^git\s+add\b/,
      /^git\s+commit\b/,
      /^ls\b/,
      /^pwd\b/,
      /^cat\b/,
      /^echo\b/,
      /^which\b/,
    ],
    denyOverride: IMPL_DENY,
  },

  /**
   * df-optimize — performance work; extends df-implement with measurement tools.
   */
  'df-optimize': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
      // Commit operations on own branch (REQ-1: fix-narrow-bash-per-agent)
      /^git\s+add\b/,
      /^git\s+commit\b/,
      /^ls\b/,
      /^pwd\b/,
      /^cat\b/,
      /^echo\b/,
      /^which\b/,
      // Measurement tools
      /^time\b/,
      /^hyperfine\b/,
      /^perf\b/,
      /^\/usr\/bin\/time\b/,
    ],
    denyOverride: IMPL_DENY,
  },

  /**
   * df-spike-platform — platform installation/verification spike agent.
   * Needs to copy/move/diff/remove files between ~/.claude/** and /tmp/**,
   * and find files under ~/.claude/projects/**. Inherits build/test patterns
   * from df-spike. Still blocks git mutations (commits only via df-haiku-ops).
   *
   * AC-12: SCOPES['df-spike-platform'] must exist as a key.
   * AC-17: 'cp ~/.claude/settings.local.json /tmp/bak' must be allowed.
   */
  'df-spike-platform': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
      // fs operations against /tmp/** and ~/.claude/**
      /^cp\s+.*(?:\/tmp\/|~\/\.claude\/)/, // cp from/to /tmp/ or ~/.claude/
      /^mv\s+.*(?:\/tmp\/|~\/\.claude\/)/,
      /^cat\s+.*(?:\/tmp\/|~\/\.claude\/)/,
      /^diff\s+.*(?:\/tmp\/|~\/\.claude\/)/,
      /^rm\s+.*(?:\/tmp\/|~\/\.claude\/)/,
      // find under ~/.claude/projects/**
      /^find\s+~\/\.claude\/projects\b/,
      /^find\s+.*\/\.claude\/projects\b/,
      // Network / fetching (inherited from spike spirit)
      /^curl\b/,
      /^wget\b/,
      // Light read utilities
      /^ls\b/,
      /^pwd\b/,
      /^echo\b/,
      /^which\b/,
    ],
    denyOverride: [
      /^git\s+push\b/,
      /^git\s+commit\b/,
      /^git\s+add\b/,
      /^git\s+merge\b/,
      /^git\s+rebase\b/,
      /^git\s+reset\b/,
      /^git\s+stash\b/,
      /^git\s+branch\b(?!\s+--show-current|\s+-[a-z]*v)/,
      /^git\s+checkout\b/,
      /^git\s+worktree\b/,
      /^git\s+tag\b/,
    ],
  },

  /**
   * df-spike — proof-of-concept exploration; arbitrary CLI within worktree.
   * Wider than df-implement: network tools (curl, wget), language toolchains,
   * package managers, etc. Still blocks git mutations (commits via df-haiku-ops).
   *
   * REQ-2: "build/test + read-only git + arbitrary CLI within worktree"
   * AC-10: curl must be allowed.
   */
  'df-spike': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
      // Network / fetching
      /^curl\b/,
      /^wget\b/,
      // Arbitrary CLI — broad allow for exploration
      /.*/,
    ],
    denyOverride: [
      // Block git push for spike — commits only via df-haiku-ops
      /^git\s+push\b/,
      /^git\s+commit\b/,
      /^git\s+merge\b/,
      /^git\s+rebase\b/,
      /^git\s+reset\b/,
      /^git\s+stash\b/,
      /^git\s+worktree\b/,
    ],
  },
};

module.exports = { SCOPES };
