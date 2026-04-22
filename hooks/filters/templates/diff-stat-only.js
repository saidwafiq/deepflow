'use strict';

/**
 * diff-stat-only — extracts the --stat summary from git diff output.
 *
 * Archetype: diff-stat-only
 * Matches: `git diff` and `git show` commands (without already-stat-only flags).
 *
 * apply() scans raw diff output for the stat block (lines ending in `|  N +++---`)
 * and the summary line (`N file(s) changed, N insertions(+), N deletions(-)`).
 * If the diff is too large the full stat is shown with a truncation marker for
 * the omitted hunk body.
 */

const MATCH_RE = /^git\s+(diff|show)\b/;
const ALREADY_STAT_RE = /--stat\b|--name-only\b|--name-status\b/;

const STAT_LINE_RE = /^\s+\S.*\|\s+\d+/;
const SUMMARY_RE = /^\s*\d+\s+file(s)?\s+changed/;
const HUNK_HEADER_RE = /^@@/;
const DIFF_HEADER_RE = /^(diff --git|index |---|\+\+\+)/;

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  const c = cmd.trimStart();
  return MATCH_RE.test(c) && !ALREADY_STAT_RE.test(c);
}

/**
 * @param {string} raw
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const lines = raw.split('\n');
  const statLines = [];
  let summaryLine = null;
  let hunkLines = 0;

  for (const line of lines) {
    if (STAT_LINE_RE.test(line)) {
      statLines.push(line.trim());
    } else if (SUMMARY_RE.test(line)) {
      summaryLine = line.trim();
    } else if (HUNK_HEADER_RE.test(line) || DIFF_HEADER_RE.test(line)) {
      hunkLines++;
    }
  }

  const header = `# diff-stat-only (${lines.length} raw lines, ${hunkLines} hunk/header lines omitted)`;

  if (!statLines.length && !summaryLine) {
    // No stat block found — emit first 15 lines as fallback
    const preview = lines.slice(0, 15);
    const dropped = lines.length - preview.length;
    return dropped > 0
      ? { header: header + ' [no stat block]', body: preview.join('\n'), truncated: { lines: dropped } }
      : { header: header + ' [no stat block]', body: preview.join('\n') };
  }

  const parts = [...statLines];
  if (summaryLine) parts.push(summaryLine);
  const body = parts.join('\n');

  const dropped = hunkLines;
  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'diff-stat-only', archetype: 'diff-stat-only', match, apply };
