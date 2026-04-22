'use strict';

/**
 * head-tail-window — keep first N and last N lines; replace middle with a count marker.
 *
 * Archetype: head-tail-window
 * Matches: long file-listing or log-tailing commands where both the opening and
 * closing context matter (e.g. `cat <large-file>`, `git log --oneline`, `docker logs`).
 *
 * apply() emits:
 *   <first HEAD_LINES lines>
 *   -- N lines omitted --
 *   <last TAIL_LINES lines>
 */

const HEAD_LINES = 5;
const TAIL_LINES = 5;

const MATCH_RE = /^(cat\s+\S+|git\s+log(\s+--oneline)?\b|docker\s+logs\b|kubectl\s+logs\b|journalctl\b)/;

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
  const meaningful = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  const total = meaningful.length;
  const window = HEAD_LINES + TAIL_LINES;

  const header = `# head-tail-window (${total} lines, head=${HEAD_LINES} tail=${TAIL_LINES})`;

  if (total <= window) {
    return { header, body: meaningful.join('\n') };
  }

  const head = meaningful.slice(0, HEAD_LINES);
  const tail = meaningful.slice(-TAIL_LINES);
  const omitted = total - window;

  const body = [
    ...head,
    `-- ${omitted} lines omitted --`,
    ...tail,
  ].join('\n');

  return { header, body, truncated: { lines: omitted } };
}

module.exports = { name: 'head-tail-window', archetype: 'head-tail-window', match, apply };
