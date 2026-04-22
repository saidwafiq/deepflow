#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * Bash output rewriter — reduces context rot from verbose-but-confirmatory commands.
 * PreToolUse hook: rewrites known noisy commands to pipe through tail -N before
 * execution so their full output never enters the context window.
 *
 * Only rewrites when ALL conditions hold:
 *   1. Tool is Bash
 *   2. DF_BASH_REWRITE != "0" (opt-out escape hatch)
 *   3. Command matches a known safe pattern (allowlist) or a filter template
 *   4. Command is not already compressed (no existing | tail / | head)
 *   5. Command output is not consumed programmatically (protected list)
 *
 * Outputs hookSpecificOutput.updatedInput to stdout; Claude Code substitutes
 * the rewritten command transparently — the model never sees the rewrite.
 */

'use strict';

const { readStdinIfMain } = require('./lib/hook-stdin');
const { PROTECTED, dispatch } = require('./lib/filter-dispatch');

function isOptedOut() {
  return process.env.DF_BASH_REWRITE === '0';
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

readStdinIfMain(module, (data) => {
  if (data.tool_name !== 'Bash') return;

  if (isOptedOut()) return;

  const input = data.tool_input || {};
  const cmd = input.command || '';
  if (!cmd) return;

  if (isProtected(cmd)) return;
  if (isAlreadyCompressed(cmd)) return;
  if (isComplex(cmd)) return;

  const { filter, rewrite } = dispatch(cmd);

  // No rewrite needed (dispatch returned original cmd unchanged)
  if (rewrite === cmd && filter === null) return;

  // filter templates handle output themselves; for now only tail-rewrites are active.
  // When a filter template matches, rewrite equals cmd — future PostToolUse step applies it.
  // Only emit updatedInput when the command string actually changed.
  if (rewrite === cmd) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'df-bash-rewrite: confirmatory command',
      updatedInput: { ...input, command: rewrite },
    },
  }));
});

// Named export so consumers (tests, T19 normalize, T20 telemetry) can call dispatch directly.
module.exports = { dispatch };
