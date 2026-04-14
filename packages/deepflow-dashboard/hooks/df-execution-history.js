#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: dashboard
/**
 * deepflow execution history recorder
 * PostToolUse hook: fires when the Agent tool completes.
 * Appends task_start + task_end records to {cwd}/.deepflow/execution-history.jsonl.
 * Exits silently (code 0) on all errors — never blocks tool execution (REQ-8).
 *
 * Output record fields:
 *   type, task_id, spec, session_id, timestamp, status
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

/**
 * Extract task_id from Agent prompt.
 * Pattern: T{n} anywhere in the prompt, e.g. "T21: fix bug" → "T21"
 * Falls back to DEEPFLOW_TASK_ID env var (C-6).
 */
function extractTaskId(prompt) {
  if (prompt) {
    const match = prompt.match(/T(\d+)/);
    if (match) return `T${match[1]}`;
  }
  return process.env.DEEPFLOW_TASK_ID || null;
}

/**
 * Extract spec name from Agent prompt.
 * Looks for pattern: "spec: {name}" or "spec:{name}"
 */
function extractSpec(prompt) {
  if (!prompt) return null;
  const match = prompt.match(/spec:\s*(\S+)/i);
  return match ? match[1] : null;
}

/**
 * Parse task status from tool_response content.
 * Looks for TASK_STATUS:{pass|revert|fail} in the response text.
 * Defaults to "unknown" if not found (REQ-2).
 */
function extractStatus(toolResponse) {
  const responseStr = JSON.stringify(toolResponse || '');
  const match = responseStr.match(/TASK_STATUS:(pass|revert|fail)/);
  return match ? match[1] : 'unknown';
}

/**
 * Resolve the project root from cwd.
 * Walks up to find the .deepflow directory, or falls back to cwd itself.
 */
function resolveProjectRoot(cwd) {
  if (!cwd) return process.cwd();
  // If inside a worktree, strip down to the project root
  const worktreeMatch = cwd.match(/^(.*?)(?:\/\.deepflow\/worktrees\/[^/]+)/);
  if (worktreeMatch) return worktreeMatch[1];
  return cwd;
}

readStdinIfMain(module, (data) => {
  // Only fire for Agent tool calls
  if (data.tool_name !== 'Agent') {
    return;
  }

  const prompt = (data.tool_input && data.tool_input.prompt) || '';
  const taskId = extractTaskId(prompt);

  // Only record if we have a task_id
  if (!taskId) {
    return;
  }

  const cwd = data.cwd || process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const historyFile = path.join(projectRoot, '.deepflow', 'execution-history.jsonl');

  const timestamp = new Date().toISOString();
  const sessionId = data.session_id || null;
  const spec = extractSpec(prompt);
  const status = extractStatus(data.tool_response);

  const startRecord = {
    type: 'task_start',
    task_id: taskId,
    spec,
    session_id: sessionId,
    timestamp,
  };

  const endRecord = {
    type: 'task_end',
    task_id: taskId,
    session_id: sessionId,
    status,
    timestamp,
  };

  const logDir = path.dirname(historyFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.appendFileSync(historyFile, JSON.stringify(startRecord) + '\n');
  fs.appendFileSync(historyFile, JSON.stringify(endRecord) + '\n');
});
