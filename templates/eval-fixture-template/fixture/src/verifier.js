/**
 * Output verifier
 *
 * Checks that task artifacts meet acceptance criteria.
 * Mirrors the L0–L4 verification levels from /df:verify.
 */

const fs = require('fs');
const path = require('path');

async function verifyOutput(results, config) {
  const checks = [];

  for (const result of results) {
    if (result.status !== 'pass') {
      checks.push({ check: `task-${result.task}-status`, pass: false });
      continue;
    }

    const artifactPath = path.join('output', result.task, 'result.json');
    const exists = fs.existsSync(artifactPath);
    checks.push({ check: `task-${result.task}-artifact`, pass: exists });

    if (exists) {
      const data = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      checks.push({
        check: `task-${result.task}-complete`,
        pass: data.status === 'complete',
      });
    }
  }

  const allPassed = checks.every((c) => c.pass);
  return { pass: allPassed, checks };
}

module.exports = { verifyOutput };
