#!/usr/bin/env node
// @hook-event PreToolUse
// @hook-tool Bash
// @hook-owner: deepflow
/**
 * df-bash-scope — per-agent Bash command scope enforcement.
 *
 * PreToolUse hook: identifies the active deepflow sub-agent via cwd inference
 * (T106 agent-role.js) and applies per-agent SCOPES (T105 bash-scopes.js).
 *
 * Precedence: denyOverride beats allow.
 *   1. If command matches ANY denyOverride pattern → block.
 *   2. Else if command matches ANY allow pattern → exit 0 (permit).
 *   3. Default → block (scope closed by default).
 *
 * Pass-through cases (exit 0 silently, no stdout):
 *   - role === null  → orchestrator-level Bash; governed by global allowlist.
 *   - SCOPES[role] absent → unknown agent; defensive pass-through.
 *
 * AC-8: coexistence with df-bash-worktree-guard is by design — both hooks
 * fire independently on the same Bash invocation. Either may block. No
 * coordination needed.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { readStdinIfMain } = require('./lib/hook-stdin');
const { inferAgentRole } = require('./lib/agent-role');
const { SCOPES } = require('./lib/bash-scopes');

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Append one structured line to .deepflow/bash-telemetry.jsonl if the
 * directory already exists. Never creates the directory.
 *
 * @param {string} repoRoot  Absolute path to main repo root (or best-effort cwd).
 * @param {{ role: string|null, command: string, decision: string, reason?: string }} entry
 */
function appendTelemetry(repoRoot, entry) {
  try {
    const dir = path.join(repoRoot, '.deepflow');
    if (!fs.existsSync(dir)) return;
    const logPath = path.join(dir, 'bash-telemetry.jsonl');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (_) {
    // Silently swallow — telemetry must never block.
  }
}

// ---------------------------------------------------------------------------
// Block output helpers
// ---------------------------------------------------------------------------

/**
 * Emit a block decision to stdout and exit 0.
 * Claude Code reads stdout JSON; exit code is not used for decisions.
 *
 * @param {string} message  Human-readable reason string (one line).
 */
function block(message) {
  process.stdout.write(JSON.stringify({ decision: 'block', message }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Test a command string against an array of RegExp patterns.
 * Returns true on first match.
 */
function matchesAny(patterns, cmd) {
  return patterns.some(re => re.test(cmd));
}

/**
 * Extract the first token from a shell command for display in error messages.
 * Strips leading whitespace; stops at the first whitespace or end-of-string.
 * Handles commands like `cd /foo && git commit` by returning just `git`.
 *
 * Strategy: strip compound prefixes (cd ..., env ...) to find the real first
 * meaningful token. For block messages we just want the most recognisable token.
 */
function firstToken(cmd) {
  // Remove leading whitespace then grab up to first whitespace.
  const trimmed = cmd.trim();
  const m = trimmed.match(/^(\S+)/);
  return m ? m[1] : trimmed;
}

// ---------------------------------------------------------------------------
// Main hook logic
// ---------------------------------------------------------------------------

readStdinIfMain(module, (payload) => {
  // Defensive: only act on Bash tool calls.
  if (!payload || payload.tool_name !== 'Bash') return;

  const cmd = (payload.tool_input && payload.tool_input.command) || '';
  if (!cmd) return;

  const cwd = payload.cwd || process.cwd();

  // Infer role from cwd → git branch → PLAN.md tag.
  let role;
  try {
    role = inferAgentRole(cwd);
  } catch (_) {
    // inferAgentRole is already guarded, but be extra safe.
    role = null;
  }

  // Orchestrator-level Bash or non-df branch → pass-through silently.
  if (role === null) {
    appendTelemetry(cwd, { role: null, command: cmd, decision: 'pass-through', reason: 'orchestrator-or-unknown-cwd' });
    return;
  }

  const scope = SCOPES[role];

  // Unknown role (future agent not yet in SCOPES) → defensive pass-through.
  if (!scope) {
    appendTelemetry(cwd, { role, command: cmd, decision: 'pass-through', reason: 'role-not-in-scopes' });
    return;
  }

  const { allow, denyOverride } = scope;

  // Step 1: denyOverride beats allow.
  if (denyOverride.length > 0 && matchesAny(denyOverride, cmd)) {
    const token = firstToken(cmd);

    // AC-3: special-case git commit from df-implement with delegation hint.
    let message;
    if (role === 'df-implement' && /^git\s+commit\b/.test(cmd.trim())) {
      message =
        `df-bash-scope: \`git commit\` is outside df-implement scope (mutation). ` +
        `Delegate via Task(subagent_type:'df-haiku-ops').`;
    } else {
      message =
        `df-bash-scope: \`${token}\` is outside ${role} scope. ` +
        `Command blocked by denyOverride rule.`;
    }

    appendTelemetry(cwd, { role, command: cmd, decision: 'block', reason: `denyOverride:${token}` });
    block(message);
    return; // unreachable — block() exits, but makes logic explicit.
  }

  // Step 2: allow list.
  if (allow.length > 0 && matchesAny(allow, cmd)) {
    appendTelemetry(cwd, { role, command: cmd, decision: 'allow' });
    return; // exit 0 via readStdinIfMain
  }

  // Step 3: default deny — command is not in allow list and not in denyOverride.
  const token = firstToken(cmd);
  const defaultDenyMsg =
    `df-bash-scope: \`${token}\` is not in the ${role} allow-list. ` +
    `Use only the commands permitted for this agent role.`;

  appendTelemetry(cwd, { role, command: cmd, decision: 'block', reason: `default-deny:${token}` });
  block(defaultDenyMsg);
});

// ---------------------------------------------------------------------------
// Exports (for unit tests — T112)
// ---------------------------------------------------------------------------

module.exports = {
  matchesAny,
  firstToken,
  appendTelemetry,
};
