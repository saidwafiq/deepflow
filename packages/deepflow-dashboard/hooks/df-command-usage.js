#!/usr/bin/env node
// @hook-event: PreToolUse, PostToolUse, SessionEnd
// @hook-owner: dashboard
/**
 * deepflow command usage tracker
 * Tracks df:* command invocations with token deltas and tool call counts.
 *
 * Events:
 *   PreToolUse  — detect Skill calls matching df:*, close previous command, open new marker
 *   PostToolUse — increment tool_calls_count on the active marker
 *   SessionStart — close orphaned marker on /clear or /compact (context reset)
 *   SessionEnd  — close any open marker so the last command gets a record
 *
 * Marker: .deepflow/active-command.json
 * Output: .deepflow/command-usage.jsonl (append-only)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

const event = process.env.CLAUDE_HOOK_EVENT || '';

readStdinIfMain(module, (data) => {
  try {
    main(data);
  } catch (_e) {
    // REQ-8: never break Claude Code
  }
});

function main(data) {
  const baseDir = findProjectDir(data);
  if (!baseDir) return;

  const deepflowDir = path.join(baseDir, '.deepflow');
  const markerPath = path.join(deepflowDir, 'active-command.json');
  const usagePath = path.join(deepflowDir, 'command-usage.jsonl');
  const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

  if (event === 'PreToolUse') {
    handlePreToolUse(data, deepflowDir, markerPath, usagePath, tokenHistoryPath);
  } else if (event === 'PostToolUse') {
    handlePostToolUse(data, markerPath);
  } else if (event === 'SessionStart') {
    handleSessionStart(data, markerPath, usagePath, tokenHistoryPath);
  } else if (event === 'SessionEnd') {
    handleSessionEnd(deepflowDir, markerPath, usagePath, tokenHistoryPath);
  }
}

function handlePreToolUse(data, deepflowDir, markerPath, usagePath, tokenHistoryPath) {
  const payload = data;
  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};

  // Only trigger on Skill calls with df:* skill names
  if (toolName !== 'Skill') return;
  const skillName = toolInput.skill || '';
  if (!skillName.startsWith('df:')) return;

  const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';

  // If marker exists, close previous command first (close-on-next)
  if (safeExists(markerPath)) {
    closeCommand(markerPath, usagePath, tokenHistoryPath);
  }

  // Create new marker
  ensureDir(deepflowDir);
  const tokenSnapshot = readLastTokenRecord(tokenHistoryPath);
  const transcriptPath = findTranscriptPath(payload);
  const transcriptOffset = safeFileSize(transcriptPath);

  const marker = {
    command: skillName,
    session_id: sessionId,
    started_at: new Date().toISOString(),
    token_snapshot: {
      input_tokens: tokenSnapshot.input_tokens || 0,
      cache_read_input_tokens: tokenSnapshot.cache_read_input_tokens || 0,
      cache_creation_input_tokens: tokenSnapshot.cache_creation_input_tokens || 0
    },
    transcript_path: transcriptPath,
    transcript_offset: transcriptOffset,
    tool_calls_count: 0
  };

  safeWriteFile(markerPath, JSON.stringify(marker, null, 2));
}

function handlePostToolUse(data, markerPath) {
  if (!safeExists(markerPath)) return;

  // Don't count the Skill call itself (the one that opened the marker)
  const payload = data;
  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};
  if (toolName === 'Skill' && (toolInput.skill || '').startsWith('df:')) return;

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.tool_calls_count = (marker.tool_calls_count || 0) + 1;
    safeWriteFile(markerPath, JSON.stringify(marker, null, 2));
  } catch (_e) {
    // Marker may have been deleted mid-session (REQ-8)
  }
}

/**
 * On /clear or /compact, context resets — close any orphaned marker.
 * Only fires for source=clear|compact (not startup/resume).
 */
function handleSessionStart(data, markerPath, usagePath, tokenHistoryPath) {
  if (!safeExists(markerPath)) return;
  const payload = data;
  const source = payload.source || '';
  if (source === 'clear' || source === 'compact') {
    closeCommand(markerPath, usagePath, tokenHistoryPath);
  }
}

function handleSessionEnd(deepflowDir, markerPath, usagePath, tokenHistoryPath) {
  if (!safeExists(markerPath)) return;
  closeCommand(markerPath, usagePath, tokenHistoryPath);
}

/**
 * Close the active command: compute deltas, parse transcript for output_tokens,
 * append usage record, delete marker.
 */
function closeCommand(markerPath, usagePath, tokenHistoryPath) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_e) {
    safeDelete(markerPath);
    return;
  }

  const endSnapshot = readLastTokenRecord(tokenHistoryPath);
  const startSnapshot = marker.token_snapshot || {};

  // Compute token deltas
  const deltaIn = Math.max(0, (endSnapshot.input_tokens || 0) - (startSnapshot.input_tokens || 0));
  const deltaCacheRead = Math.max(0, (endSnapshot.cache_read_input_tokens || 0) - (startSnapshot.cache_read_input_tokens || 0));
  const deltaCacheCreate = Math.max(0, (endSnapshot.cache_creation_input_tokens || 0) - (startSnapshot.cache_creation_input_tokens || 0));

  // Parse transcript for output_tokens
  const outputTokens = parseTranscriptOutputTokens(
    marker.transcript_path,
    marker.transcript_offset || 0
  );

  const record = {
    command: marker.command,
    session_id: marker.session_id,
    started_at: marker.started_at,
    ended_at: new Date().toISOString(),
    tool_calls_count: marker.tool_calls_count || 0,
    input_tokens_delta: deltaIn,
    output_tokens: outputTokens,
    cache_read_delta: deltaCacheRead,
    cache_creation_delta: deltaCacheCreate
  };

  // Append to usage JSONL
  ensureDir(path.dirname(usagePath));
  try {
    fs.appendFileSync(usagePath, JSON.stringify(record) + '\n');
  } catch (_e) {
    // REQ-8: fail silently
  }

  safeDelete(markerPath);
}

/**
 * Read the last line of token-history.jsonl by seeking the last ~2KB.
 */
function readLastTokenRecord(tokenHistoryPath) {
  try {
    if (!fs.existsSync(tokenHistoryPath)) return {};
    const stat = fs.statSync(tokenHistoryPath);
    if (stat.size === 0) return {};

    const readSize = Math.min(stat.size, 2048);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(tokenHistoryPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const chunk = buf.toString('utf8');
    const lines = chunk.trimEnd().split('\n');
    const lastLine = lines[lines.length - 1].trim();
    if (!lastLine) return {};
    return JSON.parse(lastLine);
  } catch (_e) {
    return {};
  }
}

/**
 * Parse transcript from offset to current end, accumulating output_tokens
 * from message.usage.output_tokens fields (pattern from df-subagent-registry.js).
 */
function parseTranscriptOutputTokens(transcriptPath, offset) {
  let total = 0;
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= offset) return 0;

    const readLen = stat.size - offset;
    const buf = Buffer.alloc(readLen);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readLen, offset);
    fs.closeSync(fd);

    const slice = buf.toString('utf8');
    const lines = slice.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        const usage = (evt.message && evt.message.usage) || evt.usage;
        if (usage && usage.output_tokens) {
          total += usage.output_tokens;
        }
      } catch (_e) {
        // skip malformed lines
      }
    }
  } catch (_e) {
    // REQ-8
  }
  return total;
}

/**
 * Find the project directory from hook payload or environment.
 */
function findProjectDir(data) {
  try {
    if (data && data.cwd) return data.cwd;
    if (data && data.workspace && data.workspace.current_dir) return data.workspace.current_dir;
  } catch (_e) {
    // fall through
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Find the transcript path from the hook payload.
 */
function findTranscriptPath(payload) {
  if (payload.transcript_path) return payload.transcript_path;
  if (payload.session_storage_path) {
    return path.join(payload.session_storage_path, 'transcript.jsonl');
  }
  return '';
}

// --- Utility helpers ---

function safeExists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function safeDelete(filePath) {
  try { fs.unlinkSync(filePath); } catch (_e) { /* REQ-8 */ }
}

function safeWriteFile(filePath, data) {
  try { fs.writeFileSync(filePath, data); } catch (_e) { /* REQ-8 */ }
}

function safeFileSize(filePath) {
  try {
    if (!filePath) return 0;
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch (_e) {
    return 0;
  }
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (_e) { /* REQ-8 */ }
}
