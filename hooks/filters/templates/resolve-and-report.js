'use strict';

/**
 * resolve-and-report — surfaces symlink cycles / resolution errors in `ls -la`, `readlink`, `realpath`.
 *
 * Archetype: resolve-and-report
 * Matches: symlink resolution commands (`readlink`, `realpath`, `ls -la` on specific paths).
 *
 * apply() scans output for "too many levels of symbolic links", "circular", "No such file",
 * and similar error tokens, then emits a compact error-first report.
 */

const MATCH_RE = /^(readlink|realpath|ls\s+-[a-zA-Z]*l[a-zA-Z]*)\s+\S/;

const ERROR_TOKENS = [
  /too many levels of symbolic links/i,
  /circular symlink/i,
  /no such file or directory/i,
  /permission denied/i,
  /not a directory/i,
  /symlink loop/i,
];

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  return MATCH_RE.test(cmd.trimStart());
}

/**
 * @param {string} raw
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const lines = raw.split('\n');
  const meaningful = lines.filter(l => l.trim());

  const errors = meaningful.filter(l => ERROR_TOKENS.some(re => re.test(l)));
  const normal = meaningful.filter(l => !ERROR_TOKENS.some(re => re.test(l)));

  const MAX_NORMAL = 10;
  const shownNormal = normal.slice(0, MAX_NORMAL);
  const dropped = normal.length - shownNormal.length;

  const header = `# resolve-and-report (${errors.length} error(s), ${normal.length} ok line(s))`;
  const parts = [];
  if (errors.length) {
    parts.push('ERRORS:');
    errors.forEach(e => parts.push(`  ! ${e.trim()}`));
  }
  if (shownNormal.length) {
    if (errors.length) parts.push('OK:');
    shownNormal.forEach(l => parts.push(`  ${l.trim()}`));
  }

  const body = parts.join('\n');
  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'resolve-and-report', archetype: 'resolve-and-report', match, apply };
