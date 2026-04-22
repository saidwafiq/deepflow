#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * df-implement Bash search guard
 * PreToolUse hook: denies grep/rg/find/ag Bash commands when the active
 * subagent is df-implement.
 *
 * Agents use Bash search (grep, rg, find, ag) as a crutch when they should
 * be using Read with explicit paths provided in the task prompt. Searching
 * bloats context and signals the task prompt is under-specified.
 *
 * Detection: checks DEEPFLOW_AGENT_ROLE env var (set by df:execute when
 * spawning subagents). Fails open if the env var is absent — avoids blocking
 * any non-deepflow or user-initiated Bash calls.
 *
 * Affected agents: df-implement only.
 * Unaffected agents: df-spike, df-test, df-integration, df-optimize, user.
 *
 * Output: permissionDecision: 'deny' with a hint to use Read by exact path.
 */

'use strict';

const { readStdinIfMain } = require('./lib/hook-stdin');

// Commands that are classified as search tools. Patterns match the trimmed
// start of the command string (accounting for optional leading env prefixes
// like `cd /foo && grep ...`).
const SEARCH_PATTERNS = [
  /(?:^|&&\s*|;\s*|\|\s*)grep\b/,
  /(?:^|&&\s*|;\s*|\|\s*)rg\b/,
  /(?:^|&&\s*|;\s*|\|\s*)find\s+.*-name\b/,
  /(?:^|&&\s*|;\s*|\|\s*)ag\b/,
];

const DENY_REASON =
  'df-implement-bash-search-guard: search tools are not allowed inside ' +
  'df-implement tasks. Use the Read tool with an exact absolute path instead. ' +
  'All relevant file paths are listed in the task prompt under "Files:".';

/**
 * Detect whether the current process is running as a df-implement subagent.
 * Returns true only when DEEPFLOW_AGENT_ROLE is explicitly "df-implement".
 * Returns false (fail-open) when the env var is absent or has any other value.
 */
function isDfImplement() {
  const role = process.env.DEEPFLOW_AGENT_ROLE;
  if (!role) return false;
  return role.toLowerCase() === 'df-implement';
}

/**
 * Returns true if the command matches a known search tool pattern.
 */
function isSearchCommand(cmd) {
  return SEARCH_PATTERNS.some(re => re.test(cmd));
}

readStdinIfMain(module, (data) => {
  // Only intercept Bash tool calls.
  if (data.tool_name !== 'Bash') return;

  // Fail open: if we cannot detect that we are inside df-implement, allow.
  if (!isDfImplement()) return;

  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (!cmd) return;

  if (!isSearchCommand(cmd)) return;

  // Deny the command.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  }));
});

// Export helpers for unit tests.
module.exports = { isDfImplement, isSearchCommand, DENY_REASON };
