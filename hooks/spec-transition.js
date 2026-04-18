#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * spec-transition — PostToolUse hook
 *
 * Detects writes/edits to spec files and appends a JSONL transition event to
 * .deepflow/events.jsonl with the fields:
 *   { ts, spec, from_column, to_column, sub_state, tool }
 *
 * REQ-1, REQ-2, REQ-3, REQ-4, REQ-8
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

// ── Pure helpers (exported for unit testing without spawning the hook) ─────────

/**
 * Derive the kanban column from a spec file path.
 * Operates on the basename only to avoid false-positives from directory names.
 *
 * @param {string} filePath
 * @returns {'done'|'doing'|'backlog'}
 */
function columnOf(filePath) {
  const base = filePath.split('/').pop();
  if (/^done-/.test(base)) return 'done';
  if (/^doing-/.test(base)) return 'doing';
  return 'backlog';
}

/** Regex for sub-state marker (REQ-4: deterministic, no LLM) */
const SUB_STATE_RE = /<!--\s*sub_state:\s*(doing|waiting)\s*-->/i;

/**
 * Extract sub_state from spec file content.
 * Returns 'doing' | 'waiting' | null. First match wins.
 *
 * @param {string} content
 * @returns {string|null}
 */
function subStateOf(content) {
  const m = SUB_STATE_RE.exec(content);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Glob pattern check: does filePath match a spec path we care about?
 *
 * Accepted patterns:
 *   specs/*.md          (backlog — no prefix)
 *   specs/doing-*.md
 *   specs/done-*.md
 *   .deepflow/specs-done/*.md
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isSpecPath(filePath) {
  if (!filePath) return false;
  // Normalize to forward slashes
  const p = filePath.replace(/\\/g, '/');
  return (
    /(?:^|\/)specs\/[^/]+\.md$/.test(p) ||
    /(?:^|\/)\.deepflow\/specs-done\/[^/]+\.md$/.test(p)
  );
}

/**
 * Read the prior column for a spec from the last matching event in events.jsonl.
 * Returns null if no prior event exists.
 *
 * @param {string} eventsPath - Absolute path to events.jsonl
 * @param {string} specName   - Canonical spec name (basename)
 * @returns {string|null}
 */
function readLastColumn(eventsPath, specName) {
  try {
    if (!fs.existsSync(eventsPath)) return null;
    const content = fs.readFileSync(eventsPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    // Scan in reverse — last event for this spec wins
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const evt = JSON.parse(lines[i]);
        if (evt.spec === specName) return evt.to_column || null;
      } catch (_) {
        // Skip malformed lines
      }
    }
  } catch (_) {
    // Fail silently (REQ-8)
  }
  return null;
}

/**
 * Build the JSONL event object.
 *
 * @param {object} opts
 * @param {string} opts.specName    - Canonical spec name (basename of path)
 * @param {string|null} opts.fromColumn
 * @param {string} opts.toColumn
 * @param {string|null} opts.subState
 * @param {string} opts.tool        - Claude Code tool_name
 * @returns {object}
 */
function buildEvent({ specName, fromColumn, toColumn, subState, tool }) {
  return {
    ts: new Date().toISOString(),
    spec: specName,
    from_column: fromColumn,
    to_column: toColumn,
    sub_state: subState,
    tool,
  };
}

// ── Hook entry point ───────────────────────────────────────────────────────────

readStdinIfMain(module, (data) => {
  try {
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    // Extract the file path from the tool input.
    // Claude Code uses `file_path` for Write/Edit tools; `path` in some variants.
    const filePath =
      toolInput.file_path ||
      toolInput.path ||
      (typeof toolInput.target_file === 'string' ? toolInput.target_file : null) ||
      null;

    // Exit silently for non-file tool invocations (REQ-7 / scope requirement #7)
    if (!filePath || !isSpecPath(filePath)) {
      process.exit(0);
    }

    // Resolve project root from cwd or fall back to process.cwd()
    const cwd = data.cwd || process.cwd();
    const deepflowDir = path.join(cwd, '.deepflow');
    const eventsPath = path.join(deepflowDir, 'events.jsonl');

    // Compute column and sub_state
    const toColumn = columnOf(filePath);
    const specName = filePath.split('/').pop(); // basename

    // Read file content to extract sub_state.
    // The tool_response may contain the new content; fall back to reading from disk.
    let fileContent = null;
    try {
      const response = data.tool_response || data.tool_result || {};
      if (typeof response === 'string') {
        fileContent = response;
      } else if (typeof response.content === 'string') {
        fileContent = response.content;
      }
    } catch (_) { /* ignore */ }

    if (fileContent === null) {
      try {
        // Best-effort disk read; file may not exist yet for first-write
        const abs = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(cwd, filePath);
        if (fs.existsSync(abs)) {
          fileContent = fs.readFileSync(abs, 'utf8');
        }
      } catch (_) { /* ignore */ }
    }

    // Also check tool_input for new_string (Edit tool) or content (Write tool)
    if (fileContent === null) {
      fileContent =
        toolInput.new_string ||
        toolInput.content ||
        null;
    }

    const subState = fileContent !== null ? subStateOf(fileContent) : null;

    // Derive from_column from last event for this spec (null on first event)
    const fromColumn = readLastColumn(eventsPath, specName);

    // Build and append the event
    const evt = buildEvent({
      specName,
      fromColumn,
      toColumn,
      subState,
      tool: toolName,
    });

    // Ensure .deepflow/ directory exists (REQ-8: create if absent)
    if (!fs.existsSync(deepflowDir)) {
      fs.mkdirSync(deepflowDir, { recursive: true });
    }

    fs.appendFileSync(eventsPath, JSON.stringify(evt) + '\n');
  } catch (err) {
    // REQ-8: never error-exit the hook host — log to stderr and exit 0
    process.stderr.write(`[spec-transition] error: ${err.message}\n`);
  }
  // readStdinIfMain always exits 0 after callback returns
});

// ── Exports for unit testing (T14) ────────────────────────────────────────────
module.exports = { columnOf, subStateOf, isSpecPath, buildEvent, readLastColumn };
