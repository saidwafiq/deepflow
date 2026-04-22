'use strict';

/**
 * summarize-tree — compresses directory-tree output into a depth-bucketed summary.
 *
 * Archetype: summarize-tree
 * Matches: `tree` and `find` commands that produce indented directory listings.
 *
 * apply() counts files/dirs per depth level and emits a compact tally, plus
 * the first few lines of actual tree output as context.
 */

const MATCH_RE = /^(tree\b|find\s+\S+.*-print\b|find\s+\S+\s+-name\b)/;
const PREVIEW_LINES = 8;

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  return MATCH_RE.test(cmd.trimStart());
}

/**
 * Estimate tree depth from leading whitespace / pipes.
 * `tree` output uses "│   ", "├── ", "└── " prefixes; `find` uses path separators.
 * @param {string} line
 * @returns {number}
 */
function depthOf(line) {
  // tree-style indentation: each level adds 4 chars of prefix
  const treeMatch = line.match(/^([│ ]*[├└]──\s)/);
  if (treeMatch) return Math.floor(treeMatch[1].length / 4);
  // find-style: count path separators
  const slashes = (line.match(/\//g) || []).length;
  return slashes;
}

/**
 * @param {string} raw
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const depthCounts = new Map();

  for (const line of lines) {
    const d = depthOf(line);
    depthCounts.set(d, (depthCounts.get(d) || 0) + 1);
  }

  const preview = lines.slice(0, PREVIEW_LINES);
  const dropped = lines.length - preview.length;

  // depth summary rows (max 5 depth levels shown)
  const depthRows = [...depthCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 5)
    .map(([d, n]) => `  depth ${d}: ${n} item(s)`);

  const header = `# summarize-tree (${lines.length} items, ${depthCounts.size} depth level(s))`;
  const body = [
    ...depthRows,
    '---',
    ...preview,
  ].join('\n');

  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'summarize-tree', archetype: 'summarize-tree', match, apply };
