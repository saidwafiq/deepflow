#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow verify protocol injector
 * PreToolUse hook: fires before the Agent tool executes.
 * When the Agent prompt signals a /df:verify spawn, appends:
 *   - the active spec's Acceptance Criteria checklist (truncated at 60 lines),
 *   - the project's build_command and test_command from .deepflow/config.yaml.
 *
 * Detection signals (any of):
 *   - prompt mentions "/df:verify" or the phrase "verify" phase
 *   - prompt references a spec path (specs/doing-*.md or specs/done-*.md)
 *   - prompt contains an "AC-N" token indicating AC verification
 *
 * Active spec resolution:
 *   - exactly one specs/doing-*.md must exist; otherwise fail-open.
 *
 * Exits silently (code 0) on all errors — never blocks tool execution (REQ-4).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

const INJECTION_MARKER = '<!-- df-verify-protocol-injected -->';
const MAX_AC_LINES = 60;
const MAX_TOTAL_LINES = 120;

/**
 * Returns true if the prompt looks like a /df:verify-spawned agent invocation.
 */
function parsePromptMarkers(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  if (prompt.includes('/df:verify')) return true;
  if (/\bverify\s+phase\b/i.test(prompt)) return true;
  if (/\bspecs\/(doing|done)-[^\s`'")]+\.md\b/.test(prompt)) return true;
  if (/\bAC-\d+\b/.test(prompt)) return true;
  return false;
}

/**
 * Find exactly one active spec. Returns absolute path or null.
 */
function findActiveSpec(cwd) {
  const specsDir = path.join(cwd, 'specs');
  if (!fs.existsSync(specsDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(specsDir);
  } catch (_) {
    return null;
  }
  const matches = entries.filter((f) => f.startsWith('doing-') && f.endsWith('.md'));
  if (matches.length !== 1) return null;
  return path.join(specsDir, matches[0]);
}

/**
 * Parse the Acceptance Criteria section of a spec.
 * Returns { slug, acs: string[] } where acs is a list of raw bullet lines.
 */
function parseAcceptanceCriteria(specPath) {
  let content;
  try {
    content = fs.readFileSync(specPath, 'utf8');
  } catch (_) {
    return { slug: '', acs: [] };
  }
  const base = path.basename(specPath, '.md');
  const slug = base.replace(/^(doing|done)-/, '');

  const lines = content.split('\n');
  let inAc = false;
  const acs = [];
  for (const line of lines) {
    // Acceptance Criteria heading — tolerate ##, ###, bold, etc.
    if (/^#{1,6}\s+Acceptance Criteria\b/i.test(line)) {
      inAc = true;
      continue;
    }
    if (inAc) {
      // Stop at the next heading of equal or higher level
      if (/^#{1,6}\s+\S/.test(line)) break;
      // Collect bullet lines that look like AC entries
      if (/^\s*[-*]\s+/.test(line)) {
        acs.push(line.trim());
      }
    }
  }
  return { slug, acs };
}

/**
 * Extract build_command and test_command from .deepflow/config.yaml.
 * Returns { build, test } — values may be null when missing or empty.
 */
function parseConfigCommands(cwd) {
  const configPath = path.join(cwd, '.deepflow', 'config.yaml');
  if (!fs.existsSync(configPath)) return { build: null, test: null };
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return { build: null, test: null };
  }

  // Scan only the `quality:` block so we don't accidentally pick up
  // build_command/test_command from `ratchet:` etc. Fall back to first
  // occurrence if no `quality:` block found.
  const lines = raw.split('\n');
  let qualityStart = -1;
  let qualityEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^quality:\s*$/.test(lines[i])) {
      qualityStart = i + 1;
      // Find end of block (next top-level key).
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_][A-Za-z0-9_]*:\s*(#|$)/.test(lines[j])) {
          qualityEnd = j;
          break;
        }
      }
      break;
    }
  }

  const searchLines = qualityStart >= 0 ? lines.slice(qualityStart, qualityEnd) : lines;
  const pickCommand = (key) => {
    for (const line of searchLines) {
      const m = line.match(new RegExp(`^\\s+${key}:\\s*(.*?)\\s*(?:#.*)?$`));
      if (m) {
        let v = m[1].trim();
        // Strip surrounding quotes
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (v.length === 0) return null;
        return v;
      }
    }
    return null;
  };

  return {
    build: pickCommand('build_command'),
    test: pickCommand('test_command'),
  };
}

/**
 * Build the injection block. Returns the text to append to the prompt.
 */
function buildInjectionBlock({ slug, acs, build, test }) {
  const parts = [];
  parts.push(INJECTION_MARKER);
  parts.push('--- CONTEXT: Verification Protocol ---');
  parts.push(`Acceptance criteria for ${slug || '(unknown spec)'}:`);

  let acLines = acs.slice(0, MAX_AC_LINES);
  if (acs.length > MAX_AC_LINES) {
    acLines.push(`... (${acs.length - MAX_AC_LINES} more truncated)`);
  }
  if (acLines.length === 0) {
    parts.push('(no acceptance criteria parsed)');
  } else {
    parts.push(...acLines);
  }

  if (build || test) {
    parts.push('');
    parts.push('Project commands:');
    if (build) parts.push(`- build: ${build}`);
    if (test) parts.push(`- test: ${test}`);
  }

  // Cap total lines as a defence-in-depth against unexpected bloat.
  let out = parts;
  if (out.length > MAX_TOTAL_LINES) {
    out = out.slice(0, MAX_TOTAL_LINES - 1).concat([`... (truncated at ${MAX_TOTAL_LINES} lines)`]);
  }
  return out.join('\n');
}

function main(payload) {
  const { tool_name, tool_input, cwd } = payload || {};
  if (tool_name !== 'Agent') return null;
  if (!tool_input || typeof tool_input !== 'object') return null;

  const originalPrompt = tool_input.prompt || '';
  if (!parsePromptMarkers(originalPrompt)) return null;

  // Dedup guard — avoid double injection.
  if (originalPrompt.includes(INJECTION_MARKER)) return null;

  const effectiveCwd = cwd || process.cwd();

  const specPath = findActiveSpec(effectiveCwd);
  if (!specPath) return null;

  const { slug, acs } = parseAcceptanceCriteria(specPath);
  const { build, test } = parseConfigCommands(effectiveCwd);

  // If we have literally nothing useful to inject, stay silent.
  if (acs.length === 0 && !build && !test) return null;

  const injection = buildInjectionBlock({ slug, acs, build, test });
  const updatedPrompt = `${originalPrompt}\n\n${injection}`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...tool_input,
        prompt: updatedPrompt,
      },
    },
  };
}

readStdinIfMain(module, (payload) => {
  try {
    const result = main(payload);
    if (result) {
      process.stdout.write(JSON.stringify(result));
    }
  } catch (_) {
    // AC-6: fail-open on ANY error — malformed input, fs errors, etc.
  }
});

module.exports = {
  main,
  parsePromptMarkers,
  findActiveSpec,
  parseAcceptanceCriteria,
  parseConfigCommands,
  buildInjectionBlock,
  INJECTION_MARKER,
};
