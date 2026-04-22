'use strict';

/**
 * group-by-prefix — collapses lists by shared path/package prefix.
 *
 * Archetype: group-by-prefix
 * Matches: `ls` listings and directory-enumeration commands that produce many
 * lines sharing a common prefix (e.g. package names, sub-directory paths).
 *
 * apply() groups lines by their first path segment or colon-delimited prefix
 * and emits a summary with per-group counts.
 */

const MATCH_RE = /^(ls(\s+-[a-zA-Z]+)*(\s+\S+)?|find\s+\S+\s+(-maxdepth\s+\d+\s+)?-type\s+[fd])\s*$/;

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  return MATCH_RE.test(cmd.trimStart());
}

/**
 * Extract a grouping prefix from a single output line.
 * Uses the first path segment or the first word before a colon.
 * @param {string} line
 * @returns {string}
 */
function prefixOf(line) {
  const trimmed = line.trim();
  if (!trimmed) return '<empty>';
  // colon prefix (e.g. "packages/foo: <detail>")
  const colon = trimmed.indexOf(':');
  if (colon > 0 && colon < 40) return trimmed.slice(0, colon);
  // path segment
  const slash = trimmed.indexOf('/');
  if (slash > 0) return trimmed.slice(0, slash);
  return trimmed;
}

/**
 * @param {string} raw
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const groups = new Map();
  for (const line of lines) {
    const key = prefixOf(line);
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  const MAX_GROUPS = 20;
  const entries = [...groups.entries()];
  const shown = entries.slice(0, MAX_GROUPS);
  const dropped = entries.length - shown.length;

  const header = `# group-by-prefix (${groups.size} groups, ${lines.length} lines)`;
  const body = shown.map(([k, n]) => `  ${k}${n > 1 ? ` (×${n})` : ''}`).join('\n');

  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'group-by-prefix', archetype: 'group-by-prefix', match, apply };
