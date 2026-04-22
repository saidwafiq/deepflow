'use strict';

/**
 * signal-loss-detector — heuristic comparison of raw vs filtered Bash output.
 *
 * Exports:
 *   detectSignalLoss(raw, filtered) → boolean
 *     Returns true when the filtered output appears to suppress more than 50%
 *     of the signal indicators present in the raw output.
 *
 * Signal indicators counted:
 *   1. Error-line matches  — lines matching /^.*(error|fail|exception)/im
 *   2. Unique path tokens  — whitespace-delimited tokens that look like filesystem paths
 *                            (contain a '/' and have at least two non-slash chars)
 *   3. Diff hunk markers   — lines starting with @@ (unified diff hunk headers)
 *
 * signal_lost = true when filtered drops >50% of the raw indicator count
 * (i.e. filteredCount < rawCount * 0.5).
 *
 * Zero raw indicators → signal_lost = false (nothing to lose).
 */

// Matches lines that look like error/failure/exception reports.
// Uses 'im' flags: case-insensitive, multiline (^ anchors to line start).
const ERROR_LINE_RE = /^.*(error|fail|exception)/im;

// Matches any filesystem-path-like token: must contain a '/' with at least
// one non-slash character on each side (e.g. /usr/bin, ./src/foo.js, a/b).
// We do NOT require a leading slash so relative paths are also captured.
const PATH_TOKEN_RE = /[^\s/][^\s]*\/[^\s/][^\s]*/g;

// Matches unified-diff hunk headers at the start of a line.
const DIFF_HUNK_RE = /^@@/m;

/**
 * Count all error/fail/exception lines in a string.
 * @param {string} text
 * @returns {number}
 */
function countErrorLines(text) {
  if (!text) return 0;
  const matches = text.match(new RegExp(ERROR_LINE_RE.source, 'gim'));
  return matches ? matches.length : 0;
}

/**
 * Count unique path-like tokens in a string.
 * @param {string} text
 * @returns {number}
 */
function countUniquePaths(text) {
  if (!text) return 0;
  const matches = text.match(PATH_TOKEN_RE);
  if (!matches) return 0;
  return new Set(matches).size;
}

/**
 * Count diff hunk markers (lines starting with @@) in a string.
 * @param {string} text
 * @returns {number}
 */
function countDiffHunks(text) {
  if (!text) return 0;
  const matches = text.match(new RegExp(DIFF_HUNK_RE.source, 'gm'));
  return matches ? matches.length : 0;
}

/**
 * Compute the total signal-indicator count for a text string.
 * @param {string} text
 * @returns {number}
 */
function countIndicators(text) {
  return countErrorLines(text) + countUniquePaths(text) + countDiffHunks(text);
}

/**
 * Detect whether the filtered output has lost more than 50% of the raw signal.
 *
 * @param {string} raw      — original (unfiltered) command output
 * @param {string} filtered — filtered command output
 * @returns {boolean}       — true if filtered suppresses >50% of raw indicators
 */
function detectSignalLoss(raw, filtered) {
  const rawCount = countIndicators(raw || '');
  // No raw indicators — nothing to lose.
  if (rawCount === 0) return false;

  const filteredCount = countIndicators(filtered || '');
  // signal_lost when filtered has fewer than 50% of raw indicators.
  return filteredCount < rawCount * 0.5;
}

module.exports = { detectSignalLoss, countErrorLines, countUniquePaths, countDiffHunks, countIndicators };
