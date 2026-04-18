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
 * guard_done (REQ-7, AC-6):
 *   When .deepflow/config.yaml has `kanban.guard_done: true`, a doing-* → done-*
 *   rename is blocked (exit 1) unless a prior verify-pass event exists in
 *   events.jsonl for that spec with event_type:"verify_pass", verify_level:"L4".
 *   Blocked transitions emit a { ..., blocked:true, reason:"verify_missing" } event.
 *
 * REQ-1, REQ-2, REQ-3, REQ-4, REQ-7, REQ-8
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
 * @param {boolean} [opts.blocked]  - True when guard_done blocked this transition
 * @param {string} [opts.reason]    - Reason string when blocked
 * @returns {object}
 */
function buildEvent({ specName, fromColumn, toColumn, subState, tool, blocked, reason }) {
  const evt = {
    ts: new Date().toISOString(),
    spec: specName,
    from_column: fromColumn,
    to_column: toColumn,
    sub_state: subState,
    tool,
  };
  if (blocked) {
    evt.blocked = true;
    evt.reason = reason || 'unknown';
  }
  return evt;
}

/**
 * Read `kanban.guard_done` boolean from .deepflow/config.yaml.
 * Returns false on any parse error or missing key (opt-in gate).
 *
 * Minimal regex scan — no YAML dep (zero-dep constraint).
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function readGuardDoneFlag(cwd) {
  try {
    const configPath = path.join(cwd, '.deepflow', 'config.yaml');
    if (!fs.existsSync(configPath)) return false;
    const content = fs.readFileSync(configPath, 'utf8');
    // Match nested YAML: "kanban:" section followed by "  guard_done: true"
    // Strategy: find kanban block, then look for guard_done within it.
    const kanbanIdx = content.search(/^\s*kanban\s*:/m);
    if (kanbanIdx === -1) return false;
    // Extract text from kanban: until the next top-level key (no leading spaces)
    const afterKanban = content.slice(kanbanIdx);
    const blockMatch = afterKanban.match(/^\s*kanban\s*:\s*\n((?:[ \t]+.+\n?)*)/m);
    if (!blockMatch) return false;
    const block = blockMatch[1];
    const guardMatch = block.match(/^\s+guard_done\s*:\s*(true|false)\s*(#.*)?$/m);
    if (!guardMatch) return false;
    return guardMatch[1] === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * Check if events.jsonl contains a verify-pass L4 event for the given spec.
 *
 * Matches events where:
 *   event_type === "verify_pass"  AND  verify_level === "L4"  AND
 *   spec matches either `doing-{slug}.md` or `{slug}.md` (the doing-* name used
 *   during verification, before the done rename completes).
 *
 * The slug is derived by stripping the `done-` prefix from the target specName.
 * Example: specName="done-foo.md" → slug="foo" → matches spec="doing-foo.md"
 *
 * @param {string} eventsPath
 * @param {string} specName  - The target done-*.md basename
 * @returns {boolean}
 */
function hasVerifyL4Record(eventsPath, specName) {
  try {
    if (!fs.existsSync(eventsPath)) return false;
    // Derive the slug: strip done- prefix
    const slug = specName.replace(/^done-/, '').replace(/\.md$/, '');
    const candidates = new Set([
      `doing-${slug}.md`,
      `${slug}.md`,
      specName, // also accept records that already reference the done- name
    ]);
    const content = fs.readFileSync(eventsPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (
          evt.event_type === 'verify_pass' &&
          evt.verify_level === 'L4' &&
          candidates.has(evt.spec)
        ) {
          return true;
        }
      } catch (_) {
        // Skip malformed lines
      }
    }
  } catch (_) {
    // Fail silently (REQ-8)
  }
  return false;
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

    // ── guard_done (REQ-7, AC-6) ─────────────────────────────────────────────
    // Block doing-* → done-* transitions when:
    //   1. kanban.guard_done is true in .deepflow/config.yaml (opt-in)
    //   2. toColumn is "done" (this is a done transition)
    //   3. fromColumn was "doing" OR fromColumn is null but the specName starts with done-
    //      (direct Write to done-*.md also counts)
    //   4. No verify-pass L4 event exists in events.jsonl for this spec
    const isDoneTransition = toColumn === 'done';
    if (isDoneTransition) {
      const guardEnabled = readGuardDoneFlag(cwd);
      if (guardEnabled && !hasVerifyL4Record(eventsPath, specName)) {
        // Emit a blocked event before refusing
        const blockedEvt = buildEvent({
          specName,
          fromColumn,
          toColumn,
          subState,
          tool: toolName,
          blocked: true,
          reason: 'verify_missing',
        });
        // Ensure .deepflow/ directory exists
        if (!fs.existsSync(deepflowDir)) {
          fs.mkdirSync(deepflowDir, { recursive: true });
        }
        fs.appendFileSync(eventsPath, JSON.stringify(blockedEvt) + '\n');
        process.stderr.write(
          `kanban.guard_done: refusing to mark ${specName} as done — no verify-L4 record in events.jsonl\n`
        );
        process.exit(1);
      }
    }
    // ── end guard_done ────────────────────────────────────────────────────────

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
module.exports = {
  columnOf,
  subStateOf,
  isSpecPath,
  buildEvent,
  readLastColumn,
  readGuardDoneFlag,
  hasVerifyL4Record,
};
