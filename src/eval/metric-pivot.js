'use strict';

const { queryExperiments } = require('./git-memory');

/**
 * Parses a secondaries string into a key/value map.
 * Secondaries format: "key=value key=value ..." (space-separated, produced by formatSecondaries)
 *
 * @param {string} secondaries
 * @returns {Object<string, string>}
 */
function parseSecondaries(secondaries) {
  if (!secondaries) return {};
  const result = {};
  for (const token of secondaries.split(/\s+/)) {
    const eqIdx = token.indexOf('=');
    if (eqIdx === -1) continue;
    const key = token.slice(0, eqIdx);
    const val = token.slice(eqIdx + 1);
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Surfaces previously-reverted experiments that had a positive delta on newTarget.
 *
 * A candidate is an experiment where:
 *   - status === 'reverted' (the experiment was rolled back)
 *   - The newTarget metric was either:
 *     a) The primary target and had delta > 0, OR
 *     b) Recorded as a secondary metric (value parsed from secondaries string)
 *        — in this case the experiment is included as a candidate since we cannot
 *          compute a delta without a baseline; callers should review the raw value.
 *
 * AC-14: After --target pivot, git log --grep="experiment:" is parsed and
 * previously-reverted experiments with positive delta on new target are
 * surfaced as candidates.
 *
 * @param {object} opts
 * @param {string} opts.cwd        - Working directory (git repo root)
 * @param {string} opts.skillName  - Skill being evaluated
 * @param {string} opts.newTarget  - The new primary metric after a pivot
 * @returns {Array<{hash, skillName, hypothesis, target, value, delta, status, secondaries, candidateValue, candidateDelta}>}
 */
function surfaceCandidates({ cwd, skillName, newTarget }) {
  const experiments = queryExperiments({ cwd, skillName });

  const candidates = [];

  for (const exp of experiments) {
    if (exp.status !== 'reverted') continue;

    // Case A: newTarget was the primary metric for this experiment
    if (exp.target === newTarget) {
      if (exp.delta > 0) {
        candidates.push({
          ...exp,
          candidateValue: exp.value,
          candidateDelta: exp.delta,
          candidateSource: 'primary',
        });
      }
      continue;
    }

    // Case B: newTarget appears as a secondary metric
    const secondaryMap = parseSecondaries(exp.secondaries);
    if (Object.prototype.hasOwnProperty.call(secondaryMap, newTarget)) {
      candidates.push({
        ...exp,
        candidateValue: secondaryMap[newTarget],
        candidateDelta: null, // delta unknown for secondaries — only raw value available
        candidateSource: 'secondary',
      });
    }
  }

  return candidates;
}

/**
 * Formats surfaced candidates for stdout display.
 *
 * @param {Array} candidates - Result of surfaceCandidates()
 * @param {string} newTarget - The new primary metric name
 * @returns {string}
 */
function formatCandidates(candidates, newTarget) {
  if (candidates.length === 0) {
    return `No reverted experiments found with positive delta on target="${newTarget}".`;
  }

  const lines = [
    `Reverted experiments with positive signal on "${newTarget}" (candidates for retry):`,
    '',
  ];

  for (const c of candidates) {
    const deltaStr =
      c.candidateDelta !== null
        ? `delta=+${c.candidateDelta}% (primary)`
        : `value=${c.candidateValue} (secondary — no delta available)`;

    lines.push(`  [${c.hash}] ${c.skillName}: ${c.hypothesis}`);
    lines.push(`         ${newTarget}=${c.candidateValue}  ${deltaStr}`);
    lines.push(`         original target: ${c.target}=${c.value} delta=${c.delta}%`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

module.exports = {
  surfaceCandidates,
  formatCandidates,
  // exported for testing
  parseSecondaries,
};
