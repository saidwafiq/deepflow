#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-tool: Task
// @hook-owner: deepflow
/**
 * df-context-injection — inject curated context bundles into Task subagent prompts.
 *
 * PreToolUse hook on Task: extracts task_id from tool_input.prompt, finds the
 * matching task entry in `specs/doing-*.md` under `## Tasks (curated)`, and
 * prepends the entry's Context bundle + Subagent prompt to the original prompt
 * before the subagent receives it.
 *
 * Curator pattern: orchestrator computes bundle once, hook injects per spawn,
 * subagent doesn't re-discover. Eliminates the warmup tax measured in the
 * orchestration-vs-solo bench.
 *
 * Pass-through cases (exit 0, no stdout):
 *   - tool_name !== 'Task'
 *   - prompt already contains INJECTION_MARKER (dedup)
 *   - no specs/doing-*.md found
 *   - spec has no `## Tasks (curated)` section (legacy spec)
 *   - task_id cannot be extracted from prompt
 *   - task_id not found in any curated spec
 *
 * Fail-open: ANY thrown error exits 0 silently.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

const SPECS_DIR = 'specs';
const INJECTION_MARKER = '<!-- df-context-injection -->';
const CURATED_SECTION_RE = /^##\s+Tasks\s+\(curated\)\s*$/m;

/**
 * Best-effort task ID extraction from a free-form prompt.
 * Returns "T<digits>" or null.
 */
function extractTaskId(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;

  // 1. "Task: T1" or "T: T1" style
  let m = prompt.match(/\bT(?:ask)?\s*[:\s]\s*T(\d+)\b/i);
  if (m) return 'T' + m[1];

  // 2. "T1:" inline style
  m = prompt.match(/\b(T\d+):/);
  if (m) return m[1];

  // 3. "## T1" header style
  m = prompt.match(/^##\s+T(\d+)\b/m);
  if (m) return 'T' + m[1];

  return null;
}

/**
 * List curated spec files (specs/doing-*.md). Returns absolute paths.
 * Returns [] if directory missing or unreadable.
 */
function findCuratedSpecs(repoRoot) {
  const dir = path.join(repoRoot, SPECS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (name.startsWith('doing-') && name.endsWith('.md')) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

/**
 * Parse `## Tasks (curated)` section from spec content.
 * Returns array of { id, slice, parallel, context_bundle, subagent_prompt }.
 * Returns [] if section absent.
 */
function parseCuratedSection(specContent) {
  if (!specContent || typeof specContent !== 'string') return [];

  const headerMatch = specContent.match(CURATED_SECTION_RE);
  if (!headerMatch) return [];

  const startIdx = headerMatch.index + headerMatch[0].length;
  // Section ends at next `## ` (level-2 header) or EOF.
  const rest = specContent.slice(startIdx);
  const endMatch = rest.match(/^##\s+/m);
  const sectionBody = endMatch ? rest.slice(0, endMatch.index) : rest;

  // Split on `### T<n>:` headers. Capture id + remainder.
  const taskHeaderRe = /^###\s+(T\d+):\s*(.*)$/gm;
  const positions = [];
  let h;
  while ((h = taskHeaderRe.exec(sectionBody)) !== null) {
    positions.push({
      id: h[1],
      title: (h[2] || '').trim(),
      headerStart: h.index,
      bodyStart: h.index + h[0].length,
    });
  }

  const tasks = [];
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const next = positions[i + 1];
    const chunk = sectionBody.slice(
      cur.bodyStart,
      next ? next.headerStart : sectionBody.length
    );

    tasks.push({
      id: cur.id,
      title: cur.title,
      slice: extractField(chunk, 'Slice'),
      parallel: extractField(chunk, 'Parallel'),
      context_bundle: extractField(chunk, 'Context bundle'),
      subagent_prompt: extractField(chunk, 'Subagent prompt'),
    });
  }
  return tasks;
}

/**
 * Extract a `**FieldName:**` field value from a task chunk.
 * Greedy match until next `**SomeField:**` line or EOF. Preserves code fences.
 */
function extractField(chunk, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Locate the field marker; capture everything until the next **Word:** marker
  // at line start, or end of chunk. (JS regex has no \Z anchor, so we slice manually.)
  const startRe = new RegExp('\\*\\*' + escaped + ':\\*\\*\\s*', 'm');
  const startMatch = chunk.match(startRe);
  if (!startMatch) return '';
  const valueStart = startMatch.index + startMatch[0].length;
  const rest = chunk.slice(valueStart);
  const nextFieldRe = /^\*\*[A-Z][^*]*:\*\*/m;
  const nextMatch = rest.match(nextFieldRe);
  const value = nextMatch ? rest.slice(0, nextMatch.index) : rest;
  return value.trim();
}

/**
 * Render the injection prefix from a task object.
 */
function renderInjection(task) {
  return (
    `=== Curated context for ${task.id} ===\n` +
    `${task.context_bundle}\n\n` +
    `=== Curator instruction ===\n` +
    `${task.subagent_prompt}`
  );
}

function main(payload) {
  const { tool_name, tool_input, cwd } = payload || {};
  if (tool_name !== 'Task') return null;
  if (!tool_input || typeof tool_input !== 'object') return null;

  const prompt = tool_input.prompt || '';
  if (!prompt) return null;
  if (prompt.includes(INJECTION_MARKER)) return null; // dedup

  const taskId = extractTaskId(prompt);
  if (!taskId) return null;

  const repoRoot = cwd || process.cwd();
  const specs = findCuratedSpecs(repoRoot);
  if (specs.length === 0) return null;

  let matched = null;
  for (const specPath of specs) {
    let content;
    try {
      content = fs.readFileSync(specPath, 'utf8');
    } catch (_) {
      continue;
    }
    const tasks = parseCuratedSection(content);
    if (tasks.length === 0) continue;
    const found = tasks.find((t) => t.id === taskId);
    if (found) {
      matched = found;
      break;
    }
  }

  if (!matched) return null;

  const injection = renderInjection(matched);
  const updatedPrompt = `${injection}\n\n${INJECTION_MARKER}\n\n${prompt}`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...tool_input, prompt: updatedPrompt },
    },
  };
}

readStdinIfMain(module, (payload) => {
  try {
    const result = main(payload);
    if (result) process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
});

module.exports = {
  main,
  extractTaskId,
  findCuratedSpecs,
  parseCuratedSection,
  renderInjection,
  INJECTION_MARKER,
};
