'use strict';

/**
 * truncate-stable — generic tail-window filter for stable/confirmatory commands.
 *
 * Archetype: truncate-stable
 * Matches: package manager installs and simple build commands whose tail lines
 * are sufficient confirmation (npm ci, yarn install, pnpm install, etc.).
 *
 * apply() keeps the last KEEP_LINES lines and marks truncated if any were dropped.
 */

const KEEP_LINES = 5;

const MATCH_RE = /^(npm\s+(ci|install)|pnpm\s+(install|ci)|yarn\s+install)\b/;

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  return MATCH_RE.test(cmd.trimStart());
}

/**
 * @param {string} raw  — full stdout string from the command
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const lines = raw.split('\n');
  // drop trailing empty line produced by a final newline
  const meaningful = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  const kept = meaningful.slice(-KEEP_LINES);
  const dropped = meaningful.length - kept.length;

  const header = `# truncate-stable (kept last ${kept.length} of ${meaningful.length} lines)`;
  const body = kept.join('\n');

  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'truncate-stable', archetype: 'truncate-stable', match, apply };
