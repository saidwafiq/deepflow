/**
 * Task runner
 *
 * Executes a single task from the spec. In the real deepflow system this
 * dispatches to Claude via the CLI. In the fixture it runs a stub that
 * creates the expected output files so guard tests can verify them.
 */

const fs = require('fs');
const path = require('path');

async function applyTask(task, config) {
  // Stub: simulate task execution by writing an artifact
  const outputDir = path.join('output', task.id);
  fs.mkdirSync(outputDir, { recursive: true });

  const artifact = {
    task: task.id,
    description: task.description,
    timestamp: new Date().toISOString(),
    status: 'complete',
  };

  fs.writeFileSync(
    path.join(outputDir, 'result.json'),
    JSON.stringify(artifact, null, 2)
  );

  return { status: 'pass', task: task.id, artifact };
}

module.exports = { applyTask };
