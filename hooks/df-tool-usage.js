#!/usr/bin/env node
/**
 * deepflow tool usage logger
 * Logs every PostToolUse event to ~/.claude/tool-usage.jsonl for token instrumentation.
 * Exits silently (code 0) on all errors — never breaks tool execution.
 *
 * Output record fields (REQ-2):
 *   timestamp, session_id, tool_name, command, output_size_est_tokens,
 *   project, phase, task_id
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TOOL_USAGE_LOG = path.join(os.homedir(), '.claude', 'tool-usage.jsonl');

/**
 * Infer phase from cwd.
 * If cwd contains .deepflow/worktrees/, parse the worktree dir name for phase.
 * Worktree dirs are named "execute", "verify", or task-specific names.
 * Default: "manual"
 */
function inferPhase(cwd) {
  if (!cwd) return 'manual';
  const match = cwd.match(/\.deepflow[/\\]worktrees[/\\]([^/\\]+)/);
  if (!match) return 'manual';
  const worktreeName = match[1].toLowerCase();
  if (worktreeName === 'execute') return 'execute';
  if (worktreeName === 'verify') return 'verify';
  // Could be a task-specific worktree — still inside worktrees/, treat as execute
  return 'execute';
}

/**
 * Extract task_id from worktree directory name.
 * Pattern: T{n} prefix, e.g. "T3-feature" → "T3", "T12" → "T12"
 * Returns null if not in a worktree or no task prefix found.
 */
function extractTaskId(cwd) {
  if (!cwd) return null;
  const match = cwd.match(/\.deepflow[/\\]worktrees[/\\]([^/\\]+)/);
  if (!match) return null;
  const worktreeName = match[1];
  const taskMatch = worktreeName.match(/^(T\d+)/i);
  return taskMatch ? taskMatch[1].toUpperCase() : null;
}

// Read all stdin, then process
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);

    const toolName = data.tool_name || null;
    const toolResponse = data.tool_response;
    const cwd = data.cwd || '';

    const record = {
      timestamp: new Date().toISOString(),
      session_id: data.session_id || null,
      tool_name: toolName,
      command: (toolName === 'Bash' && data.tool_input && data.tool_input.command != null)
        ? data.tool_input.command
        : null,
      output_size_est_tokens: Math.ceil(JSON.stringify(toolResponse).length / 4),
      project: cwd ? path.basename(cwd) : null,
      phase: inferPhase(cwd),
      task_id: extractTaskId(cwd),
    };

    const logDir = path.dirname(TOOL_USAGE_LOG);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    fs.appendFileSync(TOOL_USAGE_LOG, JSON.stringify(record) + '\n');
  } catch (_e) {
    // Fail silently — never break tool execution
  }
  process.exit(0);
});
