#!/usr/bin/env node
/**
 * deepflow statusline for Claude Code
 * Displays: model | project | context usage
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  blink: '\x1b[5m',
  cyan: '\x1b[36m'
};

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    console.log(buildStatusLine(data));
  } catch (e) {
    // Fail silently to avoid breaking statusline
    console.log('');
  }
});

function buildStatusLine(data) {
  const parts = [];

  // Check for updates
  const updateInfo = checkForUpdate();
  if (updateInfo && updateInfo.updateAvailable) {
    parts.push(`${colors.yellow}⬆ /df:update${colors.reset}`);
  }

  // Model name
  const model = formatModel(data.model || 'unknown');
  parts.push(model);

  // Project name (from cwd)
  const project = path.basename(data.cwd || process.cwd());
  parts.push(`${colors.cyan}${project}${colors.reset}`);

  // Context window meter
  const contextMeter = buildContextMeter(data.tokenUsage || {});
  parts.push(contextMeter);

  return parts.join(` ${colors.dim}│${colors.reset} `);
}

function formatModel(model) {
  // Shorten model names
  const modelMap = {
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-sonnet-4-20250514': 'Sonnet 4',
    'claude-haiku-3-5-20241022': 'Haiku 3.5'
  };
  return modelMap[model] || model.replace('claude-', '').replace(/-\d+$/, '');
}

function buildContextMeter(tokenUsage) {
  const used = tokenUsage.total || 0;
  const limit = tokenUsage.limit || 200000;

  // Scale so 80% shows as 100% (enforce 80% limit visually)
  const effectiveLimit = limit * 0.8;
  const percentage = Math.min(100, Math.round((used / effectiveLimit) * 100));

  // Build 10-segment bar
  const segments = 10;
  const filled = Math.round((percentage / 100) * segments);
  const bar = '█'.repeat(filled) + '░'.repeat(segments - filled);

  // Color based on usage
  let color;
  if (percentage < 63) {
    color = colors.green;
  } else if (percentage < 81) {
    color = colors.yellow;
  } else if (percentage < 95) {
    color = colors.orange;
  } else {
    color = colors.blink + colors.red;
  }

  return `${color}${bar}${colors.reset} ${percentage}%`;
}

function checkForUpdate() {
  try {
    const cacheDir = path.join(os.homedir(), '.claude', 'cache');
    const cachePath = path.join(cacheDir, 'df-update-check.json');

    if (!fs.existsSync(cachePath)) return null;

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return cache;
  } catch (e) {
    return null;
  }
}
