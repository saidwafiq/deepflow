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
 * Phase 1: spawns a `claude --print` subprocess to gather LSP symbols
 * (documentSymbol) relevant to the query before protocol injection.
 * Results are filtered to strip noise paths and injected as structured
 * context for Phase 2.
 *
 * Exits silently (code 0) on all errors — never blocks tool execution (REQ-8).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { readStdinIfMain } = require('./lib/hook-stdin');

/**
 * Read explore_lsp_timeout_ms from .deepflow/config.yaml in cwd.
 * Returns the configured value or the provided default.
 * Uses a simple regex to avoid a YAML parser dependency.
 */
function readLspTimeout(cwd, defaultMs) {
  try {
    const configPath = path.join(cwd, '.deepflow', 'config.yaml');
    if (!fs.existsSync(configPath)) return defaultMs;
    const text = fs.readFileSync(configPath, 'utf8');
    const m = text.match(/^\s*explore_lsp_timeout_ms\s*:\s*(\d+)/m);
    return m ? parseInt(m[1], 10) : defaultMs;
  } catch (_) {
    return defaultMs;
  }
}

/**
 * Path filter — returns true if the filepath should be excluded.
 * Strips node_modules, .claude/worktrees, dist, and .git entries.
 */
function isNoisePath(filepath) {
  return /(node_modules|\.claude\/worktrees|\/dist\/|\.git\/)/.test(filepath);
}

/**
 * Run Phase 1: spawn `claude --print` with an LSP-only prompt.
 * Returns an array of {name, kind, line, filepath} objects, or [] on any failure.
 */
function runPhase1(query, cwd, timeoutMs) {
  const lspPrompt =
    'LSP ONLY — use documentSymbol to find symbols in files relevant to this query: ' +
    query +
    '\n\nReturn ONLY a JSON array of objects with keys: name, kind, line, filepath.' +
    '\nDo NOT use Read, Grep, Bash, or any file-reading tool.' +
    '\nDo NOT add explanation. Output only the JSON array, optionally wrapped in ```json fences.';

  let result;
  try {
    result = spawnSync('claude', ['--print', lspPrompt], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      // Do not set stdio: 'pipe' explicitly — spawnSync defaults pipe for stdout/stderr
    });
  } catch (_) {
    return { symbols: [], hit: false };
  }

  if (result.status !== 0 || !result.stdout) {
    return { symbols: [], hit: false };
  }

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  let raw = result.stdout.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { symbols: [], hit: false };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { symbols: [], hit: false };
  }

  // Filter out noise paths (AC-7)
  const filtered = parsed.filter(
    (entry) => entry && typeof entry.filepath === 'string' && !isNoisePath(entry.filepath)
  );

  return { symbols: filtered, hit: filtered.length > 0 };
}

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
  if (!protocolPath) {
    // No template found — allow without modification
    return;
  }

  const protocol = fs.readFileSync(protocolPath, 'utf8').trim();
  const originalPrompt = existingPrompt;

  // --- Phase 1: LSP symbol pre-fetch (AC-1, AC-7, AC-9) ---
  const timeoutMs = readLspTimeout(effectiveCwd, 15000);
  const { symbols, hit: phase1Hit } = runPhase1(originalPrompt, effectiveCwd, timeoutMs);

  // Build Phase 1 context block for Phase 2 consumption (AC-2, AC-3)
  let phase1Block = '';
  if (phase1Hit) {
    // Format each symbol as `filepath:line -- symbolName (symbolKind)`
    const locationLines = symbols
      .map((s) => `${s.filepath}:${s.line} -- ${s.name} (${s.kind})`)
      .join('\n');
    phase1Block =
      '\n\n---\n## [LSP Phase -- locations found]\n\n' +
      locationLines +
      '\n\nRead ONLY these ranges. Do not use Grep, Glob, or Bash.';
  } else {
    // Signal to Phase 2 that LSP pre-fetch failed — fallback to full search
    phase1Block = '\n\n<!-- phase1_hit: false -->';
  }

  // Append protocol as a system-level suffix the agent must follow
  const updatedPrompt =
    `${originalPrompt}${phase1Block}\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\n${protocol}`;

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
