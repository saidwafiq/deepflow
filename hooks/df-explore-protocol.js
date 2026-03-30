#!/usr/bin/env node
// @hook-event: PreToolUse
/**
 * deepflow explore protocol injector
 * PreToolUse hook: fires before the Agent tool executes.
 * When subagent_type is "Explore", appends the search protocol from
 * templates/explore-protocol.md to the agent prompt via updatedInput.
 *
 * Protocol source resolution (first match wins):
 *   1. {cwd}/templates/explore-protocol.md  (repo checkout)
 *   2. ~/.claude/templates/explore-protocol.md  (installed copy)
 *
 * Exits silently (code 0) on all errors — never blocks tool execution (REQ-8).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinIfMain } = require('./lib/hook-stdin');

/**
 * Locate the explore-protocol.md template.
 * Prefers project-local copy, falls back to installed global copy.
 */
function findProtocol(cwd) {
  const candidates = [
    path.join(cwd, 'templates', 'explore-protocol.md'),
    path.join(os.homedir(), '.claude', 'templates', 'explore-protocol.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

readStdinIfMain(module, (payload) => {
  const { tool_name, tool_input, cwd } = payload;

  // Only intercept Agent calls with subagent_type "Explore"
  if (tool_name !== 'Agent') {
    return;
  }
  const subagentType = (tool_input.subagent_type || '').toLowerCase();
  if (subagentType !== 'explore') {
    return;
  }

  const protocolPath = findProtocol(cwd || process.cwd());
  if (!protocolPath) {
    // No template found — allow without modification
    return;
  }

  const protocol = fs.readFileSync(protocolPath, 'utf8').trim();
  const originalPrompt = tool_input.prompt || '';

  // Append protocol as a system-level suffix the agent must follow
  const updatedPrompt = `${originalPrompt}\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\n${protocol}`;

  const result = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...tool_input,
        prompt: updatedPrompt,
      },
    },
  };

  process.stdout.write(JSON.stringify(result));
});
