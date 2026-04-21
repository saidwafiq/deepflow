#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow bash output rewriter
 * PreToolUse hook: rewrites known verbose-but-confirmatory commands to limit
 * their output before execution — nothing verbose ever enters the context.
 *
 * Only rewrites when ALL conditions hold:
 *   1. Tool is Bash
 *   2. Running inside a deepflow project (.deepflow dir present)
 *   3. Command matches a known safe pattern (allowlist)
 *   4. Command is not already compressed (no existing | tail / | head)
 *   5. Command output is not consumed programmatically (protected list)
 *
 * Outputs hookSpecificOutput.updatedInput to stdout; Claude Code substitutes
 * the rewritten command transparently — the model never sees the rewrite.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

// Commands whose output is parsed by the orchestrator or agents — never rewrite.
const PROTECTED = [
  /wave-runner/,
  /ratchet\.js/,
  /ac-coverage/,
  /worktree-deps/,
  /prompt-compose/,
  /plan-consolidator/,
];

// Safe rewrites: [pattern, tailLines]
// Pattern matches against the trimmed command string.
// Only simple confirmatory commands — no complex pipelines.
const RULES = [
  // git setup
  { pattern: /^git worktree add\b/,      lines: 1 },
  { pattern: /^git sparse-checkout\b/,   lines: 1 },
  { pattern: /^git checkout -b\b/,       lines: 1 },
  { pattern: /^git stash\b/,             lines: 2 },
  // package managers
  { pattern: /^npm ci(\s|$)/,            lines: 3 },
  { pattern: /^npm install(\s|$)/,       lines: 3 },
  { pattern: /^pnpm install(\s|$)/,      lines: 3 },
  { pattern: /^yarn install(\s|$)/,      lines: 3 },
  // builds
  { pattern: /^npm run build(\s|$)/,     lines: 5 },
  { pattern: /^pnpm(\s+run)?\s+build(\s|$)/, lines: 5 },
  { pattern: /^yarn build(\s|$)/,        lines: 5 },
];

function isDeepflowProject(cwd) {
  try {
    return fs.existsSync(path.join(cwd, '.deepflow'));
  } catch (_) {
    return false;
  }
}

function isProtected(cmd) {
  return PROTECTED.some(re => re.test(cmd));
}

function isAlreadyCompressed(cmd) {
  return /\|\s*(tail|head)\b/.test(cmd);
}

function isComplex(cmd) {
  // Skip heredocs, subshell assignments, multi-statement
  return cmd.includes('<<') || /^\s*\w+=\$\(/.test(cmd);
}

function matchRule(cmd) {
  const trimmed = cmd.trimStart();
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return rule;
  }
  return null;
}

readStdinIfMain(module, (data) => {
  if (data.tool_name !== 'Bash') return;

  const cwd = data.cwd || process.cwd();
  if (!isDeepflowProject(cwd)) return;

  const input = data.tool_input || {};
  const cmd = input.command || '';
  if (!cmd) return;

  if (isProtected(cmd)) return;
  if (isAlreadyCompressed(cmd)) return;
  if (isComplex(cmd)) return;

  const rule = matchRule(cmd);
  if (!rule) return;

  const rewritten = `${cmd} 2>&1 | tail -${rule.lines}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'df-bash-rewrite: confirmatory command',
      updatedInput: { ...input, command: rewritten },
    },
  }));
});
