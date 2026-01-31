#!/usr/bin/env node
/**
 * deepflow statusline for Claude Code
 * Displays: update | model | project | context usage
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

  // Model name (Claude Code format: data.model.display_name)
  const model = data.model?.display_name || data.model?.id || 'unknown';
  parts.push(model);

  // Project name (Claude Code format: data.workspace.current_dir)
  const currentDir = data.workspace?.current_dir || data.cwd || process.cwd();
  const project = path.basename(currentDir);
  parts.push(`${colors.cyan}${project}${colors.reset}`);

  // Context window meter (Claude Code format: data.context_window)
  const contextMeter = buildContextMeter(data.context_window || {});
  parts.push(contextMeter);

  return parts.join(` ${colors.dim}│${colors.reset} `);
}

function buildContextMeter(contextWindow) {
  // Use pre-calculated percentage if available
  let percentage = contextWindow.used_percentage || 0;

  // Fallback: calculate from current_usage if available
  if (!percentage && contextWindow.current_usage && contextWindow.context_window_size) {
    const usage = contextWindow.current_usage;
    const totalTokens = (usage.input_tokens || 0) +
                        (usage.cache_creation_input_tokens || 0) +
                        (usage.cache_read_input_tokens || 0);
    percentage = (totalTokens / contextWindow.context_window_size) * 100;
  }

  percentage = Math.min(100, Math.round(percentage));

  // Write context usage to file for deepflow commands
  writeContextUsage(percentage);

  // Build 10-segment bar
  const segments = 10;
  const filled = Math.round((percentage / 100) * segments);
  const bar = '█'.repeat(filled) + '░'.repeat(segments - filled);

  // Color based on usage
  let color;
  if (percentage < 50) {
    color = colors.green;
  } else if (percentage < 70) {
    color = colors.yellow;
  } else if (percentage < 90) {
    color = colors.orange;
  } else {
    color = colors.blink + colors.red;
  }

  return `${color}${bar}${colors.reset} ${percentage}%`;
}

function checkForUpdate() {
  try {
    const cachePath = path.join(os.homedir(), '.claude', 'cache', 'df-update-check.json');
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch (e) {
    // Fail silently
  }
  return null;
}

function writeContextUsage(percentage) {
  try {
    const deepflowDir = path.join(process.cwd(), '.deepflow');
    if (!fs.existsSync(deepflowDir)) {
      fs.mkdirSync(deepflowDir, { recursive: true });
    }
    const contextPath = path.join(deepflowDir, 'context.json');
    fs.writeFileSync(contextPath, JSON.stringify({
      percentage,
      timestamp: Date.now()
    }));
  } catch (e) {
    // Fail silently
  }
}
