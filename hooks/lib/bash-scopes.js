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
 * Mutations that ONLY df-haiku-ops is allowed to perform.
 * Deny these for every implementation-class agent.
 * This list is used in denyOverride for df-implement / df-test /
 * df-integration / df-optimize / df-spike.
 *
 * Note: git push is also blocked for df-spike per REQ-2 (commits allowed
 * only through df-haiku-ops, spike's own step is not relevant here since
 * df-haiku-ops is the commit delegate).
 */
const GIT_MUTATING_DENY = [
  /^git\s+commit\b/,
  /^git\s+add\b/,
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

// denyOverride for all implementation-class agents
const IMPL_DENY = [...GIT_MUTATING_DENY, ...SEARCH_TOOL_DENY];

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
   * df-implement — writes code; delegates commits to df-haiku-ops.
   * Allow: build/test runners, read-only git, node script execution.
   * Deny: search tools (use Read with explicit paths), git mutations.
   */
  'df-implement': {
    allow: [
      ...BUILD_TEST_RUNNERS,
      ...GIT_READ_ONLY,
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
