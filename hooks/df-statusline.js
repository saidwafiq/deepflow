#!/usr/bin/env node
// @hook-event: statusLine
// @hook-owner: deepflow
/**
 * deepflow statusline for Claude Code
 * Displays: update | model | project | context usage
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinIfMain } = require('./lib/hook-stdin');

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

readStdinIfMain(module, (data) => {
  console.log(buildStatusLine(data));
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
  const contextMeter = buildContextMeter(data.context_window || {}, data);
  parts.push(contextMeter);

  // Kanban segment (gated by df.statusline.kanban flag in .deepflow/config.yaml)
  const kanbanSegment = buildKanbanSegment(currentDir);
  if (kanbanSegment) {
    parts.push(kanbanSegment);
  }

  return parts.join(` ${colors.dim}│${colors.reset} `);
}

function buildKanbanSegment(projectDir) {
  try {
    const configPath = path.join(projectDir, '.deepflow', 'config.yaml');
    if (!fs.existsSync(configPath)) return null;

    // Parse df.statusline.kanban without a yaml dependency:
    // Read the config as text and look for the flag using a regex.
    // This is safe because config.yaml is machine-written by deepflow templates
    // and the flag is always a simple scalar boolean.
    const configText = fs.readFileSync(configPath, 'utf8');
    const kanbanMatch = configText.match(/^\s*kanban\s*:\s*(true|false)\s*$/m);
    // Also support nested form: "statusline:\n  kanban: true"
    // Strategy: find the statusline block then look for kanban inside it.
    let kanbanEnabled = false;
    if (kanbanMatch) {
      // Top-level kanban key (legacy / flat config)
      kanbanEnabled = kanbanMatch[1] === 'true';
    } else {
      // Look for df.statusline.kanban in nested YAML:
      // Match "statusline:" section then "kanban: true/false" within it.
      const statuslineBlock = configText.match(/^statusline\s*:\s*\n((?:[ \t]+.+\n?)*)/m);
      if (statuslineBlock) {
        const nestedMatch = statuslineBlock[1].match(/^\s*kanban\s*:\s*(true|false)\s*$/m);
        if (nestedMatch) kanbanEnabled = nestedMatch[1] === 'true';
      } else {
        // Try df: block with statusline.kanban inside
        const dfBlock = configText.match(/^df\s*:\s*\n((?:[ \t]+.+\n?)*)/m);
        if (dfBlock) {
          const statuslineInDf = dfBlock[1].match(/^\s*statusline\s*:\s*\n((?:[ \t]+.+\n?)*)/m);
          if (statuslineInDf) {
            const nestedKanban = statuslineInDf[1].match(/^\s*kanban\s*:\s*(true|false)\s*$/m);
            if (nestedKanban) kanbanEnabled = nestedKanban[1] === 'true';
          } else {
            // flat inside df block: "  statusline.kanban: true" style not standard; skip
          }
        }
      }
    }

    if (!kanbanEnabled) return null;

    const eventsPath = path.join(projectDir, '.deepflow', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return null;

    // Read the whole file and take the last non-empty line.
    // events.jsonl is expected to be small (one line per spec transition);
    // whole-file-read is simpler than byte-seeking and avoids splitting UTF-8 chars.
    const eventsText = fs.readFileSync(eventsPath, 'utf8');
    const lines = eventsText.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;

    const lastLine = lines[lines.length - 1];
    const event = JSON.parse(lastLine);

    const column = event.to_column || '-';
    const subState = event.sub_state || '-';
    // Truncate spec name to keep segment under ~30 chars total:
    // "📋 " (2) + column (≤6) + ":" (1) + subState (≤7) + " " (1) + spec (rest)
    let specName = event.spec || '';
    // Strip path prefix and .md suffix for brevity
    specName = path.basename(specName, '.md');
    // Remove doing-/done- prefix for compactness
    specName = specName.replace(/^(doing|done)-/, '');
    // Cap at 14 chars
    if (specName.length > 14) specName = specName.slice(0, 13) + '…';

    return `📋 ${column}:${subState} ${specName}`;
  } catch (e) {
    // Any failure leaves the statusline unaffected
    return null;
  }
}

function buildContextMeter(contextWindow, data) {
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
  writeContextUsage(percentage, data);

  // Write token history for instrumentation
  writeTokenHistory(contextWindow, data);

  // Write cache history for cross-session persistence
  writeCacheHistory(contextWindow, data);

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

function writeContextUsage(percentage, data) {
  try {
    const baseDir = data?.workspace?.current_dir || process.cwd();
    const deepflowDir = path.join(baseDir, '.deepflow');
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

function writeTokenHistory(contextWindow, data) {
  try {
    const baseDir = data?.workspace?.current_dir || process.cwd();
    const deepflowDir = path.join(baseDir, '.deepflow');
    if (!fs.existsSync(deepflowDir)) {
      fs.mkdirSync(deepflowDir, { recursive: true });
    }

    const usage = contextWindow.current_usage || {};
    const timestamp = new Date().toISOString();
    const model = data.model?.id || data.model?.display_name || 'unknown';
    const sessionId = data.session_id || 'unknown';
    const contextWindowSize = contextWindow.context_window_size || 0;
    const usedPercentage = contextWindow.used_percentage || 0;

    const agentRole = process.env.DEEPFLOW_AGENT_ROLE || 'orchestrator';
    const taskId = process.env.DEEPFLOW_TASK_ID || null;

    const record = {
      timestamp,
      input_tokens: usage.input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      context_window_size: contextWindowSize,
      used_percentage: usedPercentage,
      model,
      session_id: sessionId,
      agent_role: agentRole,
      task_id: taskId
    };

    const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');
    fs.appendFileSync(tokenHistoryPath, JSON.stringify(record) + '\n');
  } catch (e) {
    // Fail silently
  }
}

function writeCacheHistory(contextWindow, data) {
  try {
    const usage = contextWindow.current_usage || {};
    const sessionId = data.session_id || 'unknown';

    const inputTokens = usage.input_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens;

    // Compute cache hit ratio: cache_read / total
    const cacheHitRatio = totalTokens > 0 ? cacheReadTokens / totalTokens : 0;

    const model = data.model?.id || data.model?.display_name || 'unknown';
    const agentRole = process.env.DEEPFLOW_AGENT_ROLE || 'orchestrator';
    const taskId = process.env.DEEPFLOW_TASK_ID || null;

    const cacheHistoryPath = path.join(os.homedir(), '.claude', 'cache-history.jsonl');

    // Dedup: only write if session_id differs from last written record
    let lastSessionId = null;
    if (fs.existsSync(cacheHistoryPath)) {
      const content = fs.readFileSync(cacheHistoryPath, 'utf8');
      const lines = content.trimEnd().split('\n');
      if (lines.length > 0) {
        try {
          const lastRecord = JSON.parse(lines[lines.length - 1]);
          lastSessionId = lastRecord.session_id;
        } catch (e) {
          // Ignore parse errors on last line
        }
      }
    }

    if (sessionId === lastSessionId) {
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      cache_hit_ratio: Math.round(cacheHitRatio * 10000) / 10000,
      total_tokens: totalTokens,
      agent_breakdown: {
        agent_role: agentRole,
        task_id: taskId,
        model
      }
    };

    // Ensure ~/.claude directory exists
    const claudeDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    fs.appendFileSync(cacheHistoryPath, JSON.stringify(record) + '\n');
  } catch (e) {
    // Fail silently
  }
}
