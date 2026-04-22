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

module.exports = { PROTECTED, RULES, normalizeCmd, matchRule, matchTemplate, loadTemplates, dispatch };
