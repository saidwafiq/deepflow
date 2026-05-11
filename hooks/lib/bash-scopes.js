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

/**
 * Read-style verbs blocked for impl-class agents (df-implement, df-test,
 * df-integration, df-optimize). The curator pattern's promise: all required
 * file content is bundled inline in the task prompt. Re-reading via Bash
 * burns cache tokens and signals the bundle is incomplete — the agent must
 * emit `CONTEXT_INSUFFICIENT: <path>` instead. Matches both standalone and
 * chained forms (`cd foo && cat bar.go`, `... | head -10`).
 */
const READ_STYLE_VERB_DENY = [
  // `cat` excludes heredoc forms (`cat <<EOF`, `cat <<-'EOF'`) which write,
  // not read — common for inline file generation.
  /(?:^|&&\s*|;\s*|\|\s*)cat\b(?!\s+<<-?\s*['"]?\w)/,
  /(?:^|&&\s*|;\s*|\|\s*)head\b/,
  /(?:^|&&\s*|;\s*|\|\s*)tail\b/,
  /(?:^|&&\s*|;\s*|\|\s*)less\b/,
  /(?:^|&&\s*|;\s*|\|\s*)more\b/,
  /(?:^|&&\s*|;\s*|\|\s*)bat\b/,
  /(?:^|&&\s*|;\s*|\|\s*)batcat\b/,
  /(?:^|&&\s*|;\s*|\|\s*)view\b/,
];

/**
 * Curator-only artifact paths — any reference to these in a Bash command
 * indicates a sub-agent reaching beyond its inline bundle. The curator
 * pattern's promise is that subagents receive bundled context inline; if
 * a subagent needs more context it must emit `CONTEXT_INSUFFICIENT: <path>`
 * and let the curator augment the bundle.
 *
 * Block targets (in any path-prefix combination):
 *   - specs/{name}.md  — full spec text (would leak other tasks' bundles)
 *   - .deepflow/maps/   — sketch.md / impact.md / findings.md (orchestrator inputs)
 *   - .deepflow/decisions.md  — historical decisions index (orchestrator-only)
 *   - .deepflow/checkpoint.json  — execute orchestrator state
 *   - .deepflow/config.yaml  — project config (orchestrator-only)
 *   - CLAUDE.md  — codebase guide (orchestrator warmup, not subagent context)
 *
 * Patterns match the path substring anywhere in the command, so both
 * `cat specs/foo.md` and `cat ../../specs/foo.md` and absolute paths
 * (`/abs/path/specs/foo.md`) all trip the deny.
 */
const CURATOR_PATH_DENY = [
  /\bspecs\/\S+\.md\b/,
  /\.deepflow\/maps\/\S+/,
  /\.deepflow\/decisions\.md\b/,
  /\.deepflow\/checkpoint\.json\b/,
  /\.deepflow\/config\.yaml\b/,
  /(?:^|[\s/'"`])CLAUDE\.md\b/,
];

// denyOverride for implementation-class agents (df-implement, df-test, df-integration, df-optimize).
// git add and plain git commit are intentionally absent — they are in the allow list instead.
// READ_STYLE_VERB_DENY enforces the curator pattern's inline-bundle contract: no shell file reads.
const IMPL_DENY = [
  ...GIT_HISTORY_REWRITING_DENY,
  ...GIT_AMEND_DENY,
  ...SEARCH_TOOL_DENY,
  ...READ_STYLE_VERB_DENY,
  ...CURATOR_PATH_DENY,
];

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
      // cat is allowed at the allow layer for heredoc forms (`cat <<EOF`,
      // common for inline file writes). Plain reads (`cat foo.go`) are
      // re-blocked by READ_STYLE_VERB_DENY in denyOverride (which excludes
      // heredoc syntax). denyOverride beats allow per the precedence contract.
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
      // cat is allowed at the allow layer for heredoc forms (`cat <<EOF`,
      // common for inline file writes). Plain reads (`cat foo.go`) are
      // re-blocked by READ_STYLE_VERB_DENY in denyOverride (which excludes
      // heredoc syntax). denyOverride beats allow per the precedence contract.
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
      // cat is allowed at the allow layer for heredoc forms (`cat <<EOF`,
      // common for inline file writes). Plain reads (`cat foo.go`) are
      // re-blocked by READ_STYLE_VERB_DENY in denyOverride (which excludes
      // heredoc syntax). denyOverride beats allow per the precedence contract.
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
      // cat is allowed at the allow layer for heredoc forms (`cat <<EOF`,
      // common for inline file writes). Plain reads (`cat foo.go`) are
      // re-blocked by READ_STYLE_VERB_DENY in denyOverride (which excludes
      // heredoc syntax). denyOverride beats allow per the precedence contract.
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
      // cat is allowed at the allow layer for heredoc forms (`cat <<EOF`,
      // common for inline file writes). Plain reads (`cat foo.go`) are
      // re-blocked by READ_STYLE_VERB_DENY in denyOverride (which excludes
      // heredoc syntax). denyOverride beats allow per the precedence contract.
      /^cat\b/,
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

// ---------------------------------------------------------------------------
// Read-style verb helpers (used by slice-guard and tests)
// ---------------------------------------------------------------------------

/**
 * Shell verbs that read file contents and output them to stdout.
 * Used to identify commands that access file content directly —
 * the slice-guard needs to intercept these when an active slice is set.
 *
 * Covers:
 *   - POSIX/GNU: cat, head, tail, less, more
 *   - Modern alternatives: bat, batcat (syntax-highlighted cat)
 *   - Editor-like: view (read-only vi)
 *
 * Does NOT include: grep, rg, ag, find — those are search tools already
 * covered by SEARCH_TOOL_DENY.
 */
const READ_STYLE_VERBS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'batcat',
  'view',
]);

/**
 * Interpreter eval forms — `<interp> -c "<code>"` / `-e "<code>"` / `eval "<code>"`.
 * These are how a subagent can read arbitrary files without using a shell read
 * verb (e.g. `python3 -c "open('secret').read()"`). Blocked unconditionally
 * inside curator worktrees; the subagent must use Read/Edit/Write tools or
 * emit `CONTEXT_INSUFFICIENT: <path>` to expand its slice.
 *
 * Patterns intentionally match anywhere in the command string (no `^` anchor)
 * so they catch chained forms like `cd worktree && python3 -c '...'`.
 */
const INTERPRETER_EVAL_DENY = [
  /(?:^|[\s;&|`(])python3?\s+(?:-[A-Za-z]*\s+)*-c\s/,
  /(?:^|[\s;&|`(])node\s+(?:-[A-Za-z]*\s+)*(?:-e|--eval)\s/,
  /(?:^|[\s;&|`(])(?:ruby|perl)\s+(?:-[A-Za-z]*\s+)*-e\s/,
  /(?:^|[\s;&|`(])deno\s+eval\b/,
  /(?:^|[\s;&|`(])bun\s+(?:-[A-Za-z]*\s+)*(?:-e|--eval)\s/,
  /(?:^|[\s;&|`(])(?:bash|sh|zsh|ksh)\s+(?:-[A-Za-z]*\s+)*-c\s/,
  /(?:^|[\s;&|`(])awk\s+(?:-[A-Za-z]*\s+)*'[^']*getline/,
];

/**
 * Split a shell command string into logical command segments.
 *
 * Strategy: split on `|`, `&&`, `;`, and `||` — every operator that introduces
 * a separate command. Heredoc bodies (`<<WORD`) are treated as opaque (no further
 * splitting after the heredoc operator). Used by the slice guard to inspect
 * EVERY chained command, not just the first — closes the `cd worktree && cat secret`
 * bypass.
 *
 * @param {string} cmd   Raw command string.
 * @returns {string[]}   Array of trimmed command segments; always at least one element.
 */
function splitCommandSegments(cmd) {
  if (!cmd || typeof cmd !== 'string') return [''];

  const segments = [];
  let current = '';
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];

    // Skip heredoc bodies: <<'WORD' or <<"WORD" or <<WORD
    if (ch === '<' && cmd[i + 1] === '<') {
      current += cmd.slice(i);
      i = cmd.length;
      continue;
    }

    // && — boundary
    if (ch === '&' && cmd[i + 1] === '&') {
      segments.push(current.trim());
      current = '';
      i += 2;
      continue;
    }

    // || — boundary
    if (ch === '|' && cmd[i + 1] === '|') {
      segments.push(current.trim());
      current = '';
      i += 2;
      continue;
    }

    // | (single pipe) — boundary
    if (ch === '|') {
      segments.push(current.trim());
      current = '';
      i++;
      continue;
    }

    // ; — boundary (but not inside heredoc, handled above)
    if (ch === ';') {
      segments.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  segments.push(current.trim());
  return segments.filter(s => s.length > 0);
}

/**
 * Split a shell command string into pipe-separated segments.
 *
 * Strategy: split on `|` that are NOT part of `||` (logical OR) or heredoc
 * operators (`<<`). This allows `go test ./... 2>&1 | grep FAIL` to be treated
 * as a compound command where the first segment is `go test` (non-read-style)
 * and the whole pipeline is permitted.
 *
 * @param {string} cmd   Raw command string.
 * @returns {string[]}   Array of trimmed pipe segments; always at least one element.
 */
function splitPipeSegments(cmd) {
  if (!cmd || typeof cmd !== 'string') return [''];

  const segments = [];
  let current = '';
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];

    // Skip heredoc bodies: <<'WORD' or <<"WORD" or <<WORD
    if (ch === '<' && cmd[i + 1] === '<') {
      // Consume the heredoc operator and everything after it;
      // treat the rest as opaque (no more pipe segments).
      current += cmd.slice(i);
      i = cmd.length;
      continue;
    }

    // Pipe character
    if (ch === '|') {
      // Logical OR (||) — keep together, not a pipe segment boundary
      if (cmd[i + 1] === '|') {
        current += '||';
        i += 2;
        continue;
      }
      // True pipe: flush current segment
      segments.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  segments.push(current.trim());
  return segments;
}

/**
 * Extract the file path arguments from a read-style shell command.
 *
 * Handles:
 *   - Flags: skip tokens that start with `-`.
 *   - Heredoc syntax: `cat <<'EOF'` or `cat <<EOF` — returns [] (no file arg;
 *     the content is inline, not read from a file path).
 *   - Quoted file paths: strips surrounding `"` or `'`.
 *   - Multiple file args: `cat foo.go bar.go` returns ['foo.go', 'bar.go'].
 *
 * @param {string} cmd   A single pipe segment (not a full pipeline).
 * @returns {string[]}   Array of file path strings extracted from the command.
 *                       Returns [] when the command is a heredoc or has no file args.
 */
function extractReadStyleFileArgs(cmd) {
  if (!cmd || typeof cmd !== 'string') return [];

  const trimmed = cmd.trimStart();

  // Heredoc: any `<<` in the command → content is inline, no file args
  if (/<</.test(trimmed)) return [];

  // Tokenise (naive whitespace split — does not handle embedded spaces in quoted paths)
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // First token is the verb — skip it; collect remaining non-flag tokens.
  // Flags that take a value argument (e.g. -n 5, -c 10) consume the next
  // token too; we detect this by checking if the previous token was a
  // short flag and the current token is purely numeric.
  const fileArgs = [];
  let prevWasFlag = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];

    // Skip redirection operators and their targets
    if (token === '>' || token === '>>' || token === '2>' || token === '2>>' || token === '&>') {
      i++; // skip the redirection target token too
      prevWasFlag = false;
      continue;
    }
    if (token.startsWith('>') || token.startsWith('2>') || token.startsWith('&>')) {
      prevWasFlag = false;
      continue;
    }

    // Skip flags (e.g. -n, --lines, -c)
    if (token.startsWith('-')) {
      prevWasFlag = true;
      continue;
    }

    // Skip purely numeric tokens that follow a flag — they are flag arguments
    // (e.g. the `5` in `head -n 5 foo.go`), not file paths.
    if (prevWasFlag && /^\d+$/.test(token)) {
      prevWasFlag = false;
      continue;
    }
    prevWasFlag = false;

    // Strip surrounding quotes
    const unquoted = token.replace(/^['"]|['"]$/g, '');
    fileArgs.push(unquoted);
  }

  return fileArgs;
}

module.exports = {
  SCOPES,
  CURATOR_PATH_DENY,
  READ_STYLE_VERBS,
  READ_STYLE_VERB_DENY,
  SEARCH_TOOL_DENY,
  INTERPRETER_EVAL_DENY,
  splitPipeSegments,
  splitCommandSegments,
  extractReadStyleFileArgs,
};
