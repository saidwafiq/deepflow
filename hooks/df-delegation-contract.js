#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow delegation contract enforcer
 *
 * PreToolUse hook: fires before the Task tool executes. Validates that:
 *   1. The `subagent_type` matches an agent entry defined in DELEGATION.md.
 *   2. The Task prompt does not contain forbidden-input patterns for that agent.
 *   3. The Task prompt includes all required field markers for that agent.
 *
 * When validation fails the hook returns permissionDecision: "block" with a
 * structured DELEGATION CONTRACT VIOLATION error message.
 *
 * Pass-through behaviour:
 *   - Non-Task tools are always passed through (exit 0, no output).
 *   - Prompts containing `<!-- df-delegation-contract:skip -->` bypass enforcement.
 *   - Unknown agents (not in DELEGATION.md) pass through (fail-open).
 *   - Any internal error (fs, JSON parse, missing contract) passes through silently.
 *
 * Contract resolution: mirrors df-explore-protocol.js pattern.
 *   1. {cwd}/src/agents/DELEGATION.md
 *   2. ~/.claude/src/agents/DELEGATION.md
 *
 * Mirrors dispatch shape of df-explore-protocol.js / df-implement-protocol.js.
 */

'use strict';

const { readStdinIfMain } = require('./lib/hook-stdin');
const {
  findDelegationMd,
  loadContract,
  validatePrompt,
} = require('./lib/delegation-contract');

const SKIP_MARKER = '<!-- df-delegation-contract:skip -->';

// ---------------------------------------------------------------------------
// Error message builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable DELEGATION CONTRACT VIOLATION block.
 *
 * @param {string} agentName
 * @param {Array<{rule: string, detail: string}>} violations
 * @returns {string}
 */
function buildViolationMessage(agentName, violations) {
  const lines = [
    'DELEGATION CONTRACT VIOLATION',
    `Agent: ${agentName}`,
  ];

  for (const v of violations) {
    lines.push(`Rule: ${v.rule}`);
    lines.push(`Ref: DELEGATION.md#${agentName}`);
    // Derive a one-line remediation hint from the rule tag
    const hint = deriveHint(v.rule, v.detail, agentName);
    lines.push(`Fix: ${hint}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Derive a short remediation hint from the violation rule string.
 *
 * @param {string} rule     e.g. "forbidden-input:orchestrator-summary"
 * @param {string} detail   full detail string from validatePrompt
 * @param {string} agentName
 * @returns {string}
 */
function deriveHint(rule, detail, agentName) {
  if (rule.startsWith('forbidden-input:')) {
    const pattern = rule.slice('forbidden-input:'.length);
    return `Remove "${pattern}" content from the ${agentName} prompt. Pass raw artifacts or delegate compression to reasoner.`;
  }
  if (rule.startsWith('required-input:')) {
    const field = rule.slice('required-input:'.length);
    return `Add required field "${field}" to the ${agentName} prompt. See DELEGATION.md#${agentName} for the expected contract.`;
  }
  if (rule === 'unknown-agent') {
    return `Register agent "${agentName}" in src/agents/DELEGATION.md before spawning it.`;
  }
  return detail || 'Review DELEGATION.md for the correct input contract.';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {object} payload  Parsed PreToolUse JSON from Claude Code.
 * @returns {object|null}   Hook response or null (pass-through).
 */
function main(payload) {
  const { tool_name, tool_input, cwd } = payload || {};

  // Pass-through: only enforce on Task spawns.
  if (tool_name !== 'Task') return null;
  if (!tool_input || typeof tool_input !== 'object') return null;

  const prompt = typeof tool_input.prompt === 'string' ? tool_input.prompt : '';

  // Escape hatch: explicit skip marker bypasses enforcement.
  if (prompt.includes(SKIP_MARKER)) return null;

  // Resolve subagent_type — Task tool uses this field.
  const subagentType = (tool_input.subagent_type || '').trim();

  const effectiveCwd = (typeof cwd === 'string' && cwd) ? cwd : process.cwd();

  // Load contract (fail-open: returns empty Map on any error).
  const delegationPath = findDelegationMd(effectiveCwd);
  const contractMap = delegationPath ? loadContract(delegationPath) : new Map();

  // If contract is empty (DELEGATION.md not found or unreadable), pass through.
  if (contractMap.size === 0) return null;

  // Unknown agent — pass through (AC-8 style: unregistered agents are not blocked).
  if (!subagentType || !contractMap.has(subagentType)) return null;

  // Validate the prompt against the loaded contract.
  const { ok, violations } = validatePrompt(subagentType, prompt, contractMap);
  if (ok) return null;

  // Build a block response.
  const message = buildViolationMessage(subagentType, violations);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'block',
      userMessage: message,
    },
  };
}

// ---------------------------------------------------------------------------
// Stdin dispatch (mirrors df-explore-protocol.js / df-implement-protocol.js)
// ---------------------------------------------------------------------------

readStdinIfMain(module, (payload) => {
  try {
    const result = main(payload);
    if (result) {
      process.stdout.write(JSON.stringify(result));
    }
    // null result → pass-through → no output, exit 0 (via hook-stdin).
  } catch (_) {
    // Fail-open: any unhandled error → pass-through.
  }
});

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
  main,
  buildViolationMessage,
  deriveHint,
  SKIP_MARKER,
};
