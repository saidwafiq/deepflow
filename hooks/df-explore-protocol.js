#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
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
 * Phase 1: globs source files and extracts symbols via inline regex — no subprocess,
 * no model calls. Results are filtered to strip noise paths and injected as
 * structured context for Phase 2.
 *
 * Exits silently (code 0) on all errors — never blocks tool execution (REQ-8).
 */

'use strict';

const fs = require('fs');
const { readStdinIfMain } = require('./lib/hook-stdin');
const { runPhase1, findProtocol } = require('./lib/symbol-extract');

readStdinIfMain(module, (payload) => {
  try {
    const { tool_name, tool_input, cwd } = payload;

    // Only intercept Agent calls with subagent_type "Explore"
    if (tool_name !== 'Agent') {
      return;
    }
    const subagentType = (tool_input.subagent_type || '').toLowerCase();
    if (subagentType !== 'explore') {
      return;
    }

    const effectiveCwd = cwd || process.cwd();

    // --- Deduplication guard (AC-8) ---
    // If the prompt already carries injected markers, skip re-injection entirely.
    const existingPrompt = tool_input.prompt || '';
    if (
      existingPrompt.includes('Search Protocol (auto-injected') ||
      existingPrompt.includes('LSP Phase')
    ) {
      return;
    }

    const protocolPath = findProtocol(effectiveCwd);
    const originalPrompt = existingPrompt;

    // --- Phase 1: inline regex symbol extraction (AC-1, AC-7, AC-9) ---
    const { symbols, hit: phase1Hit } = runPhase1(originalPrompt, effectiveCwd);

    let updatedPrompt;

    if (phase1Hit) {
      // Phase 1 succeeded — inject symbol locations + protocol (requires template)
      if (!protocolPath) {
        // No template found and Phase 1 succeeded — allow without modification
        return;
      }
      const protocol = fs.readFileSync(protocolPath, 'utf8').trim();

      // AC-3: Format each symbol as `filepath:line -- name (kind)`
      const locationLines = symbols
        .map((s) => `${s.filepath}:${s.line} -- ${s.name} (${s.kind})`)
        .join('\n');
      const phase1Block =
        '\n\n---\n## [LSP Phase -- locations found]\n\n' +
        locationLines +
        '\n\nRead ONLY these ranges. Do not use Grep, Glob, or Bash.';

      updatedPrompt =
        `${originalPrompt}${phase1Block}\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\n${protocol}`;
    } else {
      // Phase 1 empty — fall back to static template injection (AC-5)
      if (!protocolPath) {
        // AC-6: no template and regex found nothing — exit silently with no modification
        return;
      }
      const protocol = fs.readFileSync(protocolPath, 'utf8').trim();

      // Inject static template only, with auto-injected marker so dedup guard fires next time
      updatedPrompt =
        `${originalPrompt}\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\n${protocol}`;
    }

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
  } catch (_) {
    // AC-10: catch ALL errors — malformed JSON, missing tool_input, filesystem errors, etc.
    // Always exit 0; never block tool execution (REQ-8).
  }
});
