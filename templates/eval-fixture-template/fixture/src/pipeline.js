/**
 * Execution pipeline
 *
 * Orchestrates the plan → execute → verify cycle for a single spec.
 * This is the core loop a skill is expected to drive.
 */

const { loadSpec } = require('./spec-loader');
const { applyTask } = require('./task-runner');
const { verifyOutput } = require('./verifier');

async function runPipeline(config) {
  const spec = loadSpec(config.specs_dir || 'specs');

  if (!spec) {
    console.log('No active spec found — nothing to do.');
    return { status: 'noop' };
  }

  console.log(`Running pipeline for spec: ${spec.name}`);

  const tasks = spec.tasks || [];
  const results = [];

  for (const task of tasks) {
    console.log(`  Task: ${task.id} — ${task.description}`);
    const result = await applyTask(task, config);
    results.push(result);

    if (result.status === 'fail') {
      console.error(`  Task ${task.id} failed: ${result.error}`);
      return { status: 'fail', task: task.id, error: result.error };
    }
  }

  const verification = await verifyOutput(results, config);
  return { status: verification.pass ? 'pass' : 'fail', verification };
}

module.exports = { runPipeline };
