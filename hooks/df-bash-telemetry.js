#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * Bash telemetry collector (REQ-5).
 * PostToolUse hook: appends one JSONL row per Bash call to
 * .deepflow/bash-telemetry.jsonl with fields:
 *   { ts, pattern, raw_lines, raw_bytes, filter_applied, exit_code, follow_up_within_ms }
 *
 * follow_up_within_ms: elapsed ms since the last PostToolUse for the same
 * normalized pattern (null on first occurrence). Tracks call-chaining as a
 * proxy for "the previous output didn't answer the question".
 *
 * Last-ts per pattern is persisted to .deepflow/bash-telemetry-last-ts.json
 * so the metric survives across hook invocations.
 *
 * Never throws — all I/O is wrapped in try/catch. Hook exits 0 always.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readStdinIfMain } = require('./lib/hook-stdin');
const { normalize, dispatch } = require('./lib/filter-dispatch');

// ---------------------------------------------------------------------------
// Core telemetry logic — exported so tests can call it without spawning
// ---------------------------------------------------------------------------

/**
 * Read the last-ts sidecar file and return the parsed object.
 * @param {string} sidecarPath
 * @returns {Object} — map of pattern → ISO-8601 string (or empty {})
 */
function readLastTs(sidecarPath) {
  try {
    if (fs.existsSync(sidecarPath)) {
      return JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    }
  } catch (_) {
    // Corrupt sidecar — start fresh
  }
  return {};
}

/**
 * Write the last-ts sidecar file.
 * @param {string} sidecarPath
 * @param {Object} data
 */
function writeLastTs(sidecarPath, data) {
  fs.writeFileSync(sidecarPath, JSON.stringify(data));
}

/**
 * Extract the raw text output from a tool_result payload.
 * Claude Code encodes Bash output as:
 *   tool_result.content  — array of {type:'text', text:'...'} blocks
 *                        — OR a plain string
 *   Fallback: empty string.
 * @param {*} toolResult
 * @returns {string}
 */
function extractRawOutput(toolResult) {
  if (!toolResult) return '';
  // Array of content blocks
  if (Array.isArray(toolResult.content)) {
    return toolResult.content
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('');
  }
  // Plain string content
  if (typeof toolResult.content === 'string') {
    return toolResult.content;
  }
  // Direct text field (some versions)
  if (typeof toolResult === 'string') return toolResult;
  return '';
}

/**
 * Derive exit_code from tool_result.
 * Claude Code does not always expose exit_code directly; use is_error as a proxy.
 * @param {*} toolResult
 * @returns {number|null}
 */
function extractExitCode(toolResult) {
  if (!toolResult) return null;
  // Direct exit_code field (may be added by Claude Code in future versions)
  if (typeof toolResult.exit_code === 'number') return toolResult.exit_code;
  if (toolResult.is_error === true) return 1;
  if (toolResult.is_error === false) return 0;
  return null;
}

/**
 * Build and append a telemetry record.
 *
 * @param {Object} params
 * @param {string}  params.cmd          — raw command string
 * @param {*}       params.toolResult   — tool_result from the hook payload
 * @param {string}  params.telemetryPath — absolute path to bash-telemetry.jsonl
 * @param {string}  params.sidecarPath  — absolute path to bash-telemetry-last-ts.json
 * @returns {Object} the written record (useful for tests)
 */
function appendTelemetry({ cmd, toolResult, telemetryPath, sidecarPath }) {
  const ts = new Date().toISOString();
  const { pattern } = normalize(cmd);
  const { filter } = dispatch(cmd);
  const filter_applied = filter !== null;

  const raw = extractRawOutput(toolResult);
  const raw_bytes = Buffer.byteLength(raw, 'utf8');
  // Count non-empty lines; a completely empty output = 0 lines
  const raw_lines = raw.length === 0 ? 0 : raw.split('\n').length;

  const exit_code = extractExitCode(toolResult);

  // Compute follow-up gap
  const lastTsMap = readLastTs(sidecarPath);
  const prev = lastTsMap[pattern];
  let follow_up_within_ms = null;
  if (prev) {
    const prevMs = new Date(prev).getTime();
    const nowMs = new Date(ts).getTime();
    follow_up_within_ms = nowMs - prevMs;
  }

  // Update sidecar
  lastTsMap[pattern] = ts;
  writeLastTs(sidecarPath, lastTsMap);

  const record = {
    ts,
    pattern,
    raw_lines,
    raw_bytes,
    filter_applied,
    exit_code,
    follow_up_within_ms,
  };

  // Ensure .deepflow directory exists
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  fs.appendFileSync(telemetryPath, JSON.stringify(record) + '\n');

  return record;
}

// ---------------------------------------------------------------------------
// Hook entry-point
// ---------------------------------------------------------------------------

readStdinIfMain(module, (data) => {
  if (data.tool_name !== 'Bash') return;

  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (!cmd) return;

  const cwd = data.cwd || process.cwd();
  const deepflowDir = path.join(cwd, '.deepflow');
  const telemetryPath = path.join(deepflowDir, 'bash-telemetry.jsonl');
  const sidecarPath   = path.join(deepflowDir, 'bash-telemetry-last-ts.json');

  try {
    appendTelemetry({
      cmd,
      toolResult: data.tool_result,
      telemetryPath,
      sidecarPath,
    });
  } catch (_) {
    // Never break Claude Code on hook errors
  }
});

module.exports = { appendTelemetry, extractRawOutput, extractExitCode, readLastTs, writeLastTs };
