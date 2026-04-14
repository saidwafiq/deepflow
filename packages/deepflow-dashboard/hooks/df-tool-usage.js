#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: dashboard
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
const { readStdinIfMain } = require('./lib/hook-stdin');

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

readStdinIfMain(module, (data) => {
  const toolName = data.tool_name || null;
  const toolResponse = data.tool_response;
  const cwd = data.cwd || '';

  let activeCommand = null;
  try {
    const markerPath = path.join(cwd || process.cwd(), '.deepflow', 'active-command.json');
    const markerRaw = fs.readFileSync(markerPath, 'utf8');
    activeCommand = JSON.parse(markerRaw).command || null;
  } catch (_e) { /* no marker or unreadable — null */ }

  // Extract a compact tool_input summary per tool type
  const ti = data.tool_input || {};
  let inputSummary = null;
  if (toolName === 'Bash') inputSummary = ti.command || null;
  else if (toolName === 'LSP') inputSummary = `${ti.operation || '?'}:${(ti.filePath || '').split('/').pop()}:${ti.line || '?'}`;
  else if (toolName === 'Read') inputSummary = (ti.file_path || '').split('/').pop() + (ti.offset ? `:${ti.offset}-${ti.offset + (ti.limit || 0)}` : '');
  else if (toolName === 'Grep') inputSummary = ti.pattern || null;
  else if (toolName === 'Glob') inputSummary = ti.pattern || null;
  else if (toolName === 'Agent') inputSummary = `${ti.subagent_type || '?'}/${ti.model || '?'}`;
  else if (toolName === 'Edit' || toolName === 'Write') inputSummary = (ti.file_path || '').split('/').pop();

  const record = {
    timestamp: new Date().toISOString(),
    session_id: data.session_id || null,
    tool_name: toolName,
    input: inputSummary,
    output_size_est_tokens: Math.ceil(JSON.stringify(toolResponse).length / 4),
    project: cwd ? path.basename(cwd) : null,
    phase: inferPhase(cwd),
    task_id: extractTaskId(cwd),
    active_command: activeCommand,
  };

  const logDir = path.dirname(TOOL_USAGE_LOG);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.appendFileSync(TOOL_USAGE_LOG, JSON.stringify(record) + '\n');
});
