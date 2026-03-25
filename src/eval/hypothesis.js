'use strict';

/**
 * Hypothesis loading for df:eval.
 *
 * AC-11: Loop accepts --hypothesis flag; without it, reads hypotheses.md from
 *        benchmark dir and returns the next unused hypothesis.
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse markdown list items from hypotheses.md content.
 * Recognises both ordered (1. ...) and unordered (- ... / * ...) list items.
 *
 * @param {string} content - Raw file content
 * @returns {string[]} - Array of hypothesis strings (trimmed, non-empty)
 */
function parseHypothesesFile(content) {
  return content
    .split('\n')
    .map((line) => line.match(/^(?:\d+\.|[-*])\s+(.+)/))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter((h) => h.length > 0);
}

/**
 * Load the active hypothesis for an eval session.
 *
 * Resolution order:
 *   1. If `flag` is a non-empty string → return it directly.
 *   2. Otherwise read `{benchDir}/hypotheses.md` and return the first entry.
 *      If the file is missing or contains no list items, throw an error.
 *
 * "Next unused" is kept simple for now: always return the first list item.
 * Iteration tracking (marking items as used) is left to the loop's git-memory
 * history, which records which hypotheses were already attempted.
 *
 * @param {object} opts
 * @param {string} [opts.flag]     - Value of --hypothesis CLI flag (may be undefined)
 * @param {string}  opts.benchDir  - Path to the benchmark directory
 * @returns {string} - The hypothesis string to use
 * @throws {Error}   - If no hypothesis can be resolved
 */
function loadHypothesis({ flag, benchDir }) {
  // 1. CLI flag takes priority
  if (flag && typeof flag === 'string' && flag.trim().length > 0) {
    return flag.trim();
  }

  // 2. Fall back to hypotheses.md
  const hypothesesPath = path.join(benchDir, 'hypotheses.md');

  let content;
  try {
    content = fs.readFileSync(hypothesesPath, 'utf8');
  } catch (err) {
    throw new Error(
      `No --hypothesis flag provided and could not read ${hypothesesPath}: ${err.message}`
    );
  }

  const hypotheses = parseHypothesesFile(content);

  if (hypotheses.length === 0) {
    throw new Error(
      `No hypotheses found in ${hypothesesPath}. Add list items (- ... or 1. ...) to define hypotheses.`
    );
  }

  // Return the first hypothesis (loop history tracks which were attempted)
  return hypotheses[0];
}

module.exports = {
  loadHypothesis,
  parseHypothesesFile,
};
