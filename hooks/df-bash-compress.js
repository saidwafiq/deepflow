#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow bash output compressor
 * PostToolUse hook: when a Bash call produces more than THRESHOLD non-empty lines,
 * injects a one-line summary to stdout so the orchestrator skips the raw output.
 *
 * Skips compression when:
 *   - Output is ≤ THRESHOLD lines (already short)
 *   - Output starts with { or [ (JSON — orchestrator may parse it)
 *   - Exit code ≠ 0 (keep full error context for debugging)
 *   - Not a deepflow project (.deepflow dir absent)
 *
 * The summary is appended after the raw output as a system message.
 * execute.md instructs: "when [df-bash-compress] appears, use the summary only."
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

const THRESHOLD = 15;

function isDeepflowProject(cwd) {
  try {
    return fs.existsSync(path.join(cwd, '.deepflow'));
  } catch (_) {
    return false;
  }
}

function extractOutput(toolResponse) {
  if (!toolResponse) return { text: '', exitCode: 0 };
  if (typeof toolResponse === 'string') return { text: toolResponse, exitCode: 0 };
  const text = toolResponse.output ?? toolResponse.content ?? '';
  const exitCode = toolResponse.returncode ?? 0;
  return { text: String(text), exitCode };
}

function looksLikeJson(text) {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

readStdinIfMain(module, (data) => {
  if (data.tool_name !== 'Bash') return;

  const cwd = data.cwd || process.cwd();
  if (!isDeepflowProject(cwd)) return;

  const { text, exitCode } = extractOutput(data.tool_response);

  if (exitCode !== 0) return;
  if (looksLikeJson(text)) return;

  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length <= THRESHOLD) return;

  const first = lines[0].slice(0, 100);
  const last = lines[lines.length - 1].slice(0, 100);
  const omitted = lines.length - 2;

  process.stdout.write(
    `[df-bash-compress] ${lines.length} lines (use this summary, ignore raw output above) — ` +
    `"${first}" … ${omitted > 0 ? `(${omitted} omitted) … ` : ''}"${last}"\n`
  );
});
