'use strict';

const { execSync } = require('child_process');

/**
 * Formats the commit message for an experiment commit.
 * Format: experiment({skillName}): {hypothesis} | {target}={value} delta={delta}% {status} | {secondaries}
 */
function formatCommitMessage({ skillName, hypothesis, target, value, delta, status, secondaries }) {
  const secondariesStr = secondaries != null ? String(secondaries) : '';
  return `experiment(${skillName}): ${hypothesis} | ${target}=${value} delta=${delta}% ${status} | ${secondariesStr}`;
}

/**
 * Commits all staged/unstaged changes as an experiment commit.
 * AC-10, AC-13: Each experiment gets exactly one commit before verification.
 *
 * @param {object} opts
 * @param {string} opts.cwd        - Working directory (git repo root)
 * @param {string} opts.skillName  - Skill being evaluated
 * @param {string} opts.hypothesis - Short hypothesis string
 * @param {string} opts.target     - Primary metric name
 * @param {string|number} opts.value      - Primary metric value
 * @param {string|number} opts.delta      - Delta percentage (numeric, sign included)
 * @param {string} opts.status     - "pass" | "fail" | "inconclusive"
 * @param {string} [opts.secondaries]     - Secondary metrics string
 * @returns {string} The commit hash (short)
 */
function commitExperiment({ cwd, skillName, hypothesis, target, value, delta, status, secondaries }) {
  const message = formatCommitMessage({ skillName, hypothesis, target, value, delta, status, secondaries });

  // Stage all changes so the commit captures the experiment state
  execSync('git add -A', { cwd, stdio: 'pipe' });
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd, stdio: 'pipe' });

  const hash = execSync('git rev-parse --short HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  return hash;
}

/**
 * Reverts the HEAD commit using `git revert --no-edit`.
 * AC-7: Keeps failed experiment in history (no reset/amend).
 *
 * @param {object} opts
 * @param {string} opts.cwd - Working directory (git repo root)
 * @returns {string} The revert commit hash (short)
 */
function revertExperiment({ cwd }) {
  execSync('git revert HEAD --no-edit', { cwd, stdio: 'pipe' });
  const hash = execSync('git rev-parse --short HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  return hash;
}

/**
 * Parses a single commit subject line into a structured experiment record.
 * Returns null if the line does not match the experiment format.
 *
 * @param {string} hash
 * @param {string} subject
 * @returns {object|null}
 */
function parseExperimentLine(hash, subject) {
  // Pattern: experiment({skillName}): {hypothesis} | {target}={value} delta={delta}% {status} | {secondaries}
  const outerMatch = subject.match(/^experiment\(([^)]+)\):\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.*)$/);
  if (!outerMatch) return null;

  const [, parsedSkillName, hypothesis, metricsPart, secondaries] = outerMatch;

  // Parse metrics: {target}={value} delta={delta}% {status}
  const metricsMatch = metricsPart.match(/^(\S+)=(\S+)\s+delta=([-+]?[\d.]+)%\s+(\S+)$/);
  if (!metricsMatch) return null;

  const [, target, value, delta, status] = metricsMatch;

  return {
    hash,
    skillName: parsedSkillName,
    hypothesis,
    target,
    value,
    delta: parseFloat(delta),
    status,
    secondaries: secondaries.trim(),
  };
}

/**
 * Queries git log for experiment commits matching a given skill.
 * AC-10: Uses `git log --grep` to retrieve complete experiment history.
 *
 * @param {object} opts
 * @param {string} opts.cwd       - Working directory (git repo root)
 * @param {string} [opts.skillName] - If provided, filters by experiment({skillName}):
 * @returns {Array<{hash, skillName, hypothesis, target, value, delta, status, secondaries}>}
 */
function queryExperiments({ cwd, skillName }) {
  const grepPattern = skillName
    ? `experiment(${skillName}):`
    : 'experiment(';

  let output;
  try {
    output = execSync(
      `git log --grep=${JSON.stringify(grepPattern)} --format="%H %s"`,
      { cwd, stdio: 'pipe' }
    ).toString().trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const results = [];
  for (const line of output.split('\n')) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const hash = line.slice(0, spaceIdx);
    const subject = line.slice(spaceIdx + 1);
    const parsed = parseExperimentLine(hash, subject);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Returns a formatted history string suitable for inclusion in a mutator prompt.
 * AC-10: Provides the complete experiment history for a skill.
 *
 * @param {object} opts
 * @param {string} opts.cwd         - Working directory (git repo root)
 * @param {string} [opts.skillName] - Filter by skill name
 * @param {number} [opts.maxEntries=20] - Maximum number of entries to return
 * @returns {string} Formatted history or "(no experiment history)" if empty
 */
function getExperimentHistory({ cwd, skillName, maxEntries = 20 }) {
  const experiments = queryExperiments({ cwd, skillName });
  const entries = experiments.slice(0, maxEntries);

  if (entries.length === 0) {
    return '(no experiment history)';
  }

  const lines = entries.map((e) => {
    const secondary = e.secondaries ? ` | ${e.secondaries}` : '';
    return `[${e.hash}] ${e.skillName}: ${e.hypothesis} => ${e.target}=${e.value} delta=${e.delta}% ${e.status}${secondary}`;
  });

  return lines.join('\n');
}

module.exports = {
  commitExperiment,
  revertExperiment,
  queryExperiments,
  getExperimentHistory,
  // exported for testing
  formatCommitMessage,
  parseExperimentLine,
};
