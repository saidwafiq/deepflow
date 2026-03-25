/**
 * Configuration loader
 *
 * Reads .deepflow/config.yaml and returns a validated config object.
 * Merges project-level overrides over defaults.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  build_command: 'node scripts/build.js',
  test_command: 'node tests/run.js',
  dev_command: 'node src/index.js',
  dev_port: 3000,
  max_consecutive_reverts: 3,
};

function loadConfig(root = process.cwd()) {
  const configPath = path.join(root, '.deepflow', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  // Minimal YAML parser for key: value lines (no nested blocks needed here)
  const raw = fs.readFileSync(configPath, 'utf8');
  const overrides = {};

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\w+):\s*"?([^"#\n]+)"?\s*$/);
    if (match) {
      overrides[match[1].trim()] = match[2].trim();
    }
  }

  return { ...DEFAULTS, ...overrides };
}

module.exports = { loadConfig, DEFAULTS };
