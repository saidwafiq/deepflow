/**
 * eval-fixture entry point
 *
 * Simulates a small deepflow-like project that a skill will be asked to modify.
 * The skill under evaluation receives a task referencing this codebase.
 */

const { loadConfig } = require('./config');
const { runPipeline } = require('./pipeline');

async function main() {
  const config = loadConfig();
  await runPipeline(config);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
