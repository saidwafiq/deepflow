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
 *
 * AC-8 canary shadow runner:
 *   After dispatch(), if a proposal in .deepflow/filters-proposed.yaml matches
 *   the current command's normalized pattern, runCanary() is called fire-and-forget
 *   (detached child process via SPIKE-A pattern). The hook return path is never
 *   blocked by the canary.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const { readStdinIfMain } = require('./lib/hook-stdin');
const { PROTECTED, dispatch, normalize } = require('./lib/filter-dispatch');
const { runCanary } = require('./lib/canary-runner');

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

// ---------------------------------------------------------------------------
// Proposal loading — reads .deepflow/filters-proposed.yaml (AC-8)
// ---------------------------------------------------------------------------

/**
 * Parse a minimal YAML proposals file produced by df-filter-suggest --propose.
 * We only need to extract the `pattern` and `template` fields from each entry.
 * This is a line-oriented parser — no YAML library dependency.
 *
 * @param {string} yaml
 * @returns {Array<{pattern: string, template: string}>}
 */
function parseProposalsYaml(yaml) {
  const proposals = [];
  let current = null;
  for (const line of yaml.split('\n')) {
    const stripped = line.trim();
    if (stripped.startsWith('- pattern:')) {
      if (current) proposals.push(current);
      const raw = stripped.slice('- pattern:'.length).trim();
      current = { pattern: _unquoteYaml(raw), template: '' };
    } else if (stripped.startsWith('template:') && current) {
      const raw = stripped.slice('template:'.length).trim();
      current.template = _unquoteYaml(raw);
    }
  }
  if (current) proposals.push(current);
  return proposals;
}

/**
 * Strip surrounding single or double quotes from a YAML scalar.
 * @param {string} s
 * @returns {string}
 */
function _unquoteYaml(s) {
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Load proposals from .deepflow/filters-proposed.yaml relative to cwd.
 * Returns [] if the file does not exist or cannot be parsed.
 *
 * @param {string} cwd
 * @returns {Array<{pattern: string, template: string}>}
 */
function loadProposals(cwd) {
  const proposedPath = path.join(cwd, '.deepflow', 'filters-proposed.yaml');
  try {
    if (!fs.existsSync(proposedPath)) return [];
    const yaml = fs.readFileSync(proposedPath, 'utf8');
    return parseProposalsYaml(yaml);
  } catch (_) {
    return [];
  }
}

/**
 * Find a proposal whose normalized pattern matches the current command's pattern.
 * Uses the same normalize() as telemetry so patterns align.
 *
 * @param {string} cmd
 * @param {Array<{pattern: string, template: string}>} proposals
 * @returns {{pattern: string, template: string}|null}
 */
function findMatchingProposal(cmd, proposals) {
  if (!proposals || proposals.length === 0) return null;
  const { pattern } = normalize(cmd);
  for (const p of proposals) {
    if (p.pattern === pattern) return p;
  }
  return null;
}

/**
 * Build a minimal FilterTemplate stub from a proposal record so runCanary()
 * can call apply(). The stub uses the identity function — the actual template
 * apply logic is not loaded here to keep PreToolUse overhead minimal.
 * The canary child only uses the filterName for logging; the filteredOutput is
 * pre-computed by applyFilter() in the parent before the child is spawned.
 *
 * @param {object} proposal
 * @returns {{name: string, apply: (raw: string) => string}}
 */
function proposalToFilterStub(proposal) {
  // Attempt to load the real template so the canary measures actual filtering.
  try {
    const filterPath = path.resolve(__dirname, 'filters', 'templates', `${proposal.template}.js`);
    const tpl = require(filterPath);
    if (tpl && typeof tpl.apply === 'function') {
      return { name: proposal.pattern, apply: tpl.apply.bind(tpl) };
    }
  } catch (_) {
    // Template module not available — fall back to identity.
  }
  // Identity stub: filtered === raw (signal_lost will always be false).
  return { name: proposal.pattern, apply: (raw) => raw };
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

  // AC-8: fire canary shadow runner if a proposal matches this command.
  // This MUST be fire-and-forget — never await, never block the hook return.
  try {
    const cwd = (data && data.cwd) ? data.cwd : process.cwd();
    const proposals = loadProposals(cwd);
    const matched = findMatchingProposal(cmd, proposals);
    if (matched) {
      const filterStub = proposalToFilterStub(matched);
      const canaryPath = path.join(cwd, '.deepflow', 'auto-filter-canary.jsonl');
      // rawOutput is not available in PreToolUse (command hasn't run yet).
      // We pass an empty string; the canary records the structural metadata.
      // The actual output-based signal loss measurement happens in PostToolUse
      // context (future extension). For now, canary records pattern + stub result.
      runCanary(cmd, '', filterStub, canaryPath);
    }
  } catch (_) {
    // Canary must never block the hook — swallow all errors.
  }

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

// Named exports so consumers (tests, T19 normalize, T20 telemetry) can call dispatch directly.
// Also export AC-8 helpers for testing.
module.exports = { dispatch, parseProposalsYaml, loadProposals, findMatchingProposal };
