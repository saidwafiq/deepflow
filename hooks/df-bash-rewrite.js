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
 *   3. Command matches a known safe pattern (allowlist)
 *   4. Command is not already compressed (no existing | tail / | head)
 *   5. Command output is not consumed programmatically (protected list)
 *
 * Outputs hookSpecificOutput.updatedInput to stdout; Claude Code substitutes
 * the rewritten command transparently — the model never sees the rewrite.
 */

'use strict';

const { readStdinIfMain } = require('./lib/hook-stdin');

// Commands whose output is parsed by the orchestrator or agents — never rewrite.
const PROTECTED = [
  /wave-runner/,
  /ratchet\.js/,
  /ac-coverage/,
  /worktree-deps/,
  /prompt-compose(?!.*(-h|--help)(\s|$))/,
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
  // context reduction
  { pattern: /^cat\s+\.deepflow\/decisions\.md(\s*$|\s+2>)/, lines: 5 },
  // prompt-compose template rendering — mute entirely (output is not consumed)
  { pattern: /^cat\s+\/tmp\/t\d+-prompt/, mute: true },
  // prompt-compose --help invocations — help output is redundant in context
  { pattern: /prompt-compose(\.js)?\s+(-h|--help)(\s|$)/, mute: true },
];

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

function matchRule(cmd) {
  const trimmed = cmd.trimStart();
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return rule;
  }
  return null;
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

  const rule = matchRule(cmd);
  if (!rule) return;

  const rewritten = rule.mute
    ? ': # muted by df-bash-rewrite'
    : `${cmd} 2>&1 | tail -${rule.lines}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'df-bash-rewrite: confirmatory command',
      updatedInput: { ...input, command: rewritten },
    },
  }));
});
