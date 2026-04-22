'use strict';

/**
 * filter-dispatch — shared dispatch logic for df-bash-rewrite and future consumers.
 *
 * Exports:
 *   PROTECTED      — array of regexes for orchestrator commands that must never be rewritten
 *   normalizeCmd   — strip leading whitespace; used before rule/filter matching
 *   matchRule      — find the RULES entry for a command; returns {pattern, lines} or null
 *   dispatch(cmd)  — returns {filter: FilterTemplate|null, rewrite: string}
 *                    filter  = matched filter template (null until templates are loaded via loadTemplates)
 *                    rewrite = rewritten command string (original if no rule/filter matched)
 */

// Commands whose output is parsed by the orchestrator or agents — never rewrite.
// Note: prompt-compose --help invocations are NOT protected (negative lookahead)
// so the mute rule in RULES can fire for them.
const PROTECTED = [
  /wave-runner/,
  /ratchet\.js/,
  /ac-coverage/,
  /worktree-deps/,
  /prompt-compose(?!.*(-h|--help)(\s|$))/,
  /plan-consolidator/,
];

// Safe tail-rewrites: [pattern, tailLines]
// Pattern matches against the normalised (trimStart) command string.
// Only simple confirmatory commands — no complex pipelines.
const RULES = [
  // git setup
  { pattern: /^git worktree add\b/,      lines: 1 },
  { pattern: /^git sparse-checkout\b/,   lines: 1 },
  { pattern: /^git checkout -b\b/,       lines: 1 },
  { pattern: /^git stash\b/,             lines: 2 },
  // package managers
  { pattern: /^npm ci(\s|$)/,            lines: 3 },
  { pattern: /^npm install(\s|$)/,       lines: 3 },
  { pattern: /^pnpm install(\s|$)/,      lines: 3 },
  { pattern: /^yarn install(\s|$)/,      lines: 3 },
  // builds
  { pattern: /^npm run build(\s|$)/,     lines: 5 },
  { pattern: /^pnpm(\s+run)?\s+build(\s|$)/, lines: 5 },
  { pattern: /^yarn build(\s|$)/,        lines: 5 },
  // context reduction
  { pattern: /^cat\s+\.deepflow\/decisions\.md(\s*$|\s+2>)/, lines: 5 },
  // prompt-compose template rendering — mute entirely (output is not consumed)
  { pattern: /^cat\s+\/tmp\/t\d+-prompt/, mute: true },
  // prompt-compose --help invocations — help output is redundant in context
  { pattern: /prompt-compose(\.js)?\s+(-h|--help)(\s|$)/, mute: true },
];

// Registry of filter templates loaded at runtime via loadTemplates().
// Each entry is a FilterTemplate: { name, match(cmd), apply(raw) -> FilteredOutput }
let _templates = [];

/**
 * Register filter templates for dispatch to use.
 * Called by consumers that have loaded hooks/filters/templates/*.
 * @param {Array<{name: string, match: (cmd: string) => boolean, apply: (raw: string) => object}>} templates
 */
function loadTemplates(templates) {
  _templates = Array.isArray(templates) ? templates : [];
}

// Canonical list of built-in template module names (relative to hooks/filters/templates/).
const BUILTIN_TEMPLATE_NAMES = [
  'truncate-stable',
  'group-by-prefix',
  'json-project',
  'resolve-and-report',
  'failures-only',
  'head-tail-window',
  'summarize-tree',
  'diff-stat-only',
];

/**
 * Load all built-in archetype templates from hooks/filters/templates/.
 * Idempotent — safe to call multiple times; re-registers on each call.
 * Silently skips modules that fail to load (missing file / syntax error).
 * @returns {Array} the loaded template objects
 */
function loadBuiltinTemplates() {
  const path = require('node:path');
  const templatesDir = path.resolve(__dirname, '..', 'filters', 'templates');
  const loaded = [];
  for (const name of BUILTIN_TEMPLATE_NAMES) {
    try {
      // eslint-disable-next-line global-require
      const tpl = require(path.join(templatesDir, `${name}.js`));
      if (tpl && typeof tpl.match === 'function' && typeof tpl.apply === 'function') {
        loaded.push(tpl);
      }
    } catch (_) {
      // template not yet available — skip gracefully
    }
  }
  _templates = loaded;
  return loaded;
}

/**
 * Strip leading whitespace for consistent matching.
 * @param {string} cmd
 * @returns {string}
 */
function normalizeCmd(cmd) {
  return cmd.trimStart();
}

/**
 * Find the RULES entry whose pattern matches the given (already-normalised) command.
 * @param {string} cmd  — should already be normalised via normalizeCmd
 * @returns {{pattern: RegExp, lines: number}|null}
 */
function matchRule(cmd) {
  for (const rule of RULES) {
    if (rule.pattern.test(cmd)) return rule;
  }
  return null;
}

/**
 * Find the first filter template whose match() accepts the command.
 * @param {string} cmd  — raw (un-normalised) command
 * @returns {{name: string, match: Function, apply: Function}|null}
 */
function matchTemplate(cmd) {
  for (const t of _templates) {
    if (typeof t.match === 'function' && t.match(cmd)) return t;
  }
  return null;
}

/**
 * Dispatch a command through filter templates first, then fall back to RULES tail-rewrite.
 *
 * Returns:
 *   filter  — the matched FilterTemplate object, or null when only a tail-rule (or nothing) matched
 *   rewrite — rewritten command string; equals cmd when no rewrite applies
 *
 * Does NOT check PROTECTED or DF_BASH_REWRITE — callers must guard those themselves.
 *
 * @param {string} cmd
 * @returns {{filter: object|null, rewrite: string}}
 */
function dispatch(cmd) {
  const normalized = normalizeCmd(cmd);

  // Phase 1: named filter templates (higher priority, richer output)
  const tpl = matchTemplate(normalized);
  if (tpl) {
    return { filter: tpl, rewrite: cmd };
  }

  // Phase 2: legacy tail-rewrite rules (including mute rules)
  const rule = matchRule(normalized);
  if (rule) {
    if (rule.mute) {
      return { filter: null, rewrite: ': # muted by df-bash-rewrite' };
    }
    return { filter: null, rewrite: `${cmd} 2>&1 | tail -${rule.lines}` };
  }

  // No match — pass through unchanged
  return { filter: null, rewrite: cmd };
}

// ---------------------------------------------------------------------------
// normalize(cmd) → NormalizedPattern
// ---------------------------------------------------------------------------

/**
 * Token classification regexes — order matters (most specific first).
 *
 * Ref tokens: SHAs (hex 7-40 chars), symbolic refs (HEAD, ORIG_HEAD, FETCH_HEAD,
 * MERGE_HEAD), branch/tag names (alphanumeric + -/_/.), and range expressions
 * using .. or ... (each side classified as ref, joined with the operator).
 * The ~N and ^N ancestor suffixes are included as part of the ref token.
 *
 * Path tokens: absolute filesystem paths (start with /).
 *
 * Glob tokens: contain *, ?, or {…} glob metacharacters (but not absolute paths).
 */

// Matches a SHA (7–40 lowercase hex chars, no uppercase, no non-hex).
const _SHA = /^[0-9a-f]{7,40}$/;

// Matches a known symbolic ref (exact words or with ~N/^N ancestor suffix).
// HEAD alone or with modifiers (HEAD~3, HEAD^2, HEAD~1^2, etc.)
// ORIG_HEAD, FETCH_HEAD, MERGE_HEAD — uppercase-only tokens.
const _SYMBOLIC_REF = /^(?:HEAD(?:[~^]\d+)*|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD)$/;

// Matches a ref-like token that carries structural evidence of being a ref
// (not just a plain subcommand word):
//   - contains a slash  → remote ref:  origin/main, refs/heads/feature
//   - contains a dot    → tag or rev:  v1.2.3, release.1
//   - ends with ~N/^N   → ancestor:    main~2, feature^1
const _REF_WITH_STRUCTURE = /^[A-Za-z0-9._/-]+(~\d+|\^\d+)+$|^[A-Za-z0-9._-]*[/.][A-Za-z0-9._/-]+$/;

// Matches a range expression: <ref>..<ref> or <ref>...<ref>
// Each side must be either a structural ref, SHA, symbolic ref, or a plain word.
// Conservative: only collapse if the range operator is present.
const _REF_RANGE  = /^([A-Za-z0-9._/-]+(?:[~^]\d+)*)(\.{2,3})([A-Za-z0-9._/-]+(?:[~^]\d+)*)$/;

/**
 * Classify a single argv token and return its typed placeholder (or itself).
 *
 * @param {string} token
 * @returns {string}
 */
function _classifyToken(token) {
  // Flags pass through unchanged (start with -)
  if (token.startsWith('-')) return token;

  // Absolute path
  if (token.startsWith('/')) return '<path>';

  // Glob: contains glob metacharacters
  if (/[*?{]/.test(token)) return '<glob>';

  // Range ref: main..feature, HEAD~1...origin/main, etc.
  const rangeMatch = token.match(_REF_RANGE);
  if (rangeMatch) {
    return `<ref>${rangeMatch[2]}<ref>`;
  }

  // Simple ref: SHA, known symbolic ref, or structurally-identifiable ref token
  if (_SHA.test(token) || _SYMBOLIC_REF.test(token) || _REF_WITH_STRUCTURE.test(token)) return '<ref>';

  // Everything else passes through (command names, subcommands, numeric args, etc.)
  return token;
}

/**
 * Normalize a shell command string into a NormalizedPattern.
 *
 * Strategy: split on whitespace (simple argv split — no full shell parse),
 * classify each token, join the argv shape back into a pattern string.
 * The first token (the executable) is always kept verbatim.
 *
 * @param {string} cmd
 * @returns {{ pattern: string; argvShape: string[]; observations: number }}
 */
function normalize(cmd) {
  const trimmed = cmd.trimStart();
  // Naive argv split: split on runs of whitespace.
  // Does not handle quoted strings with embedded spaces — acceptable for
  // the pattern-matching use-case (quoted paths still start with " or ').
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  const argvShape = tokens.map((token, idx) => {
    // Always preserve the executable name (index 0)
    if (idx === 0) return token;
    return _classifyToken(token);
  });

  return {
    pattern: argvShape.join(' '),
    argvShape,
    observations: 0,
  };
}

module.exports = { PROTECTED, RULES, BUILTIN_TEMPLATE_NAMES, normalizeCmd, matchRule, matchTemplate, loadTemplates, loadBuiltinTemplates, dispatch, normalize };
