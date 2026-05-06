#!/usr/bin/env node
// @hook-event: SubagentStop
// @hook-owner: deepflow
/**
 * df-subagent-telemetry-drain — drain subagent token usage into token-history.jsonl
 *
 * SubagentStop hook: fires after a subagent completes. Reads the subagent's
 * JSONL transcript, sums all assistant-turn token usage, and appends one row
 * to `.deepflow/token-history.jsonl`.
 *
 * Idempotency: uses `agent_id` as a dedup key. Re-running against the same
 * agent_id is a no-op (AC-7).
 *
 * Token field mapping (from subagent JSONL assistant entries):
 *   message.usage.input_tokens                  → input_tokens
 *   message.usage.cache_creation_input_tokens   → cache_creation_input_tokens
 *   message.usage.cache_read_input_tokens        → cache_read_input_tokens
 *   message.usage.output_tokens                  → output_tokens
 *
 * Output record fields:
 *   { timestamp, agent_id, agent_role, task_id,
 *     input_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens, output_tokens,
 *     model, session_id }
 *
 * SubagentStop payload shape (observed empirically):
 *   { hook_event_name, agent_id, agent_type, session_id, transcript_path, cwd,
 *     agent_transcript_path }
 *
 * Malformed/missing JSONL: exits 0 and appends an error entry to
 * `.deepflow/events.jsonl` (AC-8).
 *
 * Never throws — all I/O is wrapped in try/catch. Hook exits 0 always.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readStdinIfMain } = require('./lib/hook-stdin');

// ---------------------------------------------------------------------------
// Core drain logic — exported so tests can call it without spawning
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL string into an array of objects.
 * Lines that are empty or fail to parse are silently skipped.
 *
 * @param {string} content
 * @returns {Object[]}
 */
function parseJsonl(content) {
  const lines = content.split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (_) {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Sum token usage across all assistant-turn entries in a subagent JSONL.
 *
 * @param {Object[]} entries — parsed JSONL records
 * @returns {{ input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, model }}
 */
function sumTokenUsage(entries) {
  let input_tokens = 0;
  let cache_creation_input_tokens = 0;
  let cache_read_input_tokens = 0;
  let output_tokens = 0;
  let model = 'unknown';

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const usage = (entry.message && entry.message.usage) || {};
    input_tokens += Number(usage.input_tokens) || 0;
    cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0;
    cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
    output_tokens += Number(usage.output_tokens) || 0;
    if (entry.message && entry.message.model) {
      model = entry.message.model;
    }
  }

  return { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, model };
}

/**
 * Locate the subagent's JSONL file given the hook payload.
 *
 * Strategy (in priority order):
 *   1. payload.agent_transcript_path — direct path (may be provided by future Claude versions)
 *   2. Derive from transcript_path + agent_id:
 *      <parent_dir>/<session_base>/subagents/agent-<agent_id>.jsonl
 *   3. Walk subagents/ dir for any file matching agent-<agent_id>.jsonl
 *
 * Returns null if no path can be determined.
 *
 * @param {Object} payload
 * @returns {string|null}
 */
function resolveAgentJsonlPath(payload) {
  const { agent_id, agent_transcript_path, transcript_path } = payload;

  // Strategy 1: direct path
  if (agent_transcript_path && fs.existsSync(agent_transcript_path)) {
    return agent_transcript_path;
  }

  // Strategy 2: derive from transcript_path + agent_id
  if (transcript_path && agent_id) {
    const dir = path.dirname(transcript_path);
    const base = path.basename(transcript_path, '.jsonl');
    const derived = path.join(dir, base, 'subagents', `agent-${agent_id}.jsonl`);
    if (fs.existsSync(derived)) {
      return derived;
    }
  }

  // Strategy 3: walk subagents dir
  if (transcript_path && agent_id) {
    const dir = path.dirname(transcript_path);
    const base = path.basename(transcript_path, '.jsonl');
    const subDir = path.join(dir, base, 'subagents');
    if (fs.existsSync(subDir)) {
      const pattern = `agent-${agent_id}.jsonl`;
      const entries = fs.readdirSync(subDir);
      for (const entry of entries) {
        if (entry === pattern) {
          return path.join(subDir, entry);
        }
      }
    }
  }

  return null;
}

/**
 * Extract task_id from the first user message in a subagent transcript.
 * Looks for patterns like "T4:", "T: T4", "## T4", etc.
 *
 * @param {Object[]} entries
 * @returns {string|null}
 */
function extractTaskIdFromTranscript(entries) {
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const msg = entry.message;
    if (!msg) continue;

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(b => b && b.type === 'text')
        .map(b => b.text || '')
        .join('\n');
    }

    if (!text) continue;

    // "T4:" or "T4 :" patterns
    let m = text.match(/\b(T\d+)\s*:/);
    if (m) return m[1];

    // "Task: T4" pattern
    m = text.match(/\bT(?:ask)?\s*[:\s]\s*(T\d+)\b/i);
    if (m) return m[1];

    // "## T4" header
    m = text.match(/^##\s+(T\d+)\b/m);
    if (m) return m[1];
  }
  return null;
}

/**
 * Check if the given agent_id already has a row in token-history.jsonl.
 *
 * @param {string} tokenHistoryPath
 * @param {string} agentId
 * @returns {boolean}
 */
function isDuplicate(tokenHistoryPath, agentId) {
  if (!fs.existsSync(tokenHistoryPath)) return false;
  try {
    const content = fs.readFileSync(tokenHistoryPath, 'utf8');
    const entries = parseJsonl(content);
    return entries.some(e => e.agent_id === agentId);
  } catch (_) {
    return false;
  }
}

/**
 * Append an error entry to .deepflow/events.jsonl.
 *
 * @param {string} deepflowDir
 * @param {string} agentId
 * @param {string} errorMessage
 */
function appendErrorEvent(deepflowDir, agentId, errorMessage) {
  try {
    fs.mkdirSync(deepflowDir, { recursive: true });
    const eventsPath = path.join(deepflowDir, 'events.jsonl');
    const record = {
      ts: new Date().toISOString(),
      event: 'telemetry-drain-error',
      agent_id: agentId || 'unknown',
      error: errorMessage,
    };
    fs.appendFileSync(eventsPath, JSON.stringify(record) + '\n');
  } catch (_) {
    // Never break Claude Code on hook errors
  }
}

/**
 * Main drain function: reads subagent JSONL, sums tokens, appends to token-history.jsonl.
 *
 * @param {Object} params
 * @param {Object}  params.payload         — SubagentStop hook payload
 * @param {string}  params.deepflowDir     — absolute path to .deepflow/ directory
 * @param {string}  params.tokenHistoryPath — absolute path to token-history.jsonl
 * @returns {{ record: Object|null, skipped: boolean, error: string|null }}
 */
function drain({ payload, deepflowDir, tokenHistoryPath }) {
  const agentId = payload.agent_id || null;
  const agentRole = payload.agent_type || payload.subagent_type || 'unknown';
  const sessionId = payload.session_id || 'unknown';

  // Idempotency check
  if (agentId && isDuplicate(tokenHistoryPath, agentId)) {
    return { record: null, skipped: true, error: null };
  }

  // Resolve subagent JSONL path
  const agentJsonlPath = resolveAgentJsonlPath(payload);

  if (!agentJsonlPath) {
    const msg = `agent JSONL not found for agent_id=${agentId}`;
    appendErrorEvent(deepflowDir, agentId, msg);
    return { record: null, skipped: false, error: msg };
  }

  // Read and parse subagent JSONL
  let entries;
  try {
    const content = fs.readFileSync(agentJsonlPath, 'utf8');
    entries = parseJsonl(content);
  } catch (err) {
    const msg = `failed to read agent JSONL at ${agentJsonlPath}: ${err.message}`;
    appendErrorEvent(deepflowDir, agentId, msg);
    return { record: null, skipped: false, error: msg };
  }

  if (!entries || entries.length === 0) {
    const msg = `agent JSONL is empty or malformed at ${agentJsonlPath}`;
    appendErrorEvent(deepflowDir, agentId, msg);
    return { record: null, skipped: false, error: msg };
  }

  // Sum token usage
  const tokenUsage = sumTokenUsage(entries);

  // Extract task_id from transcript
  const task_id = extractTaskIdFromTranscript(entries);

  // Build record
  const record = {
    timestamp: new Date().toISOString(),
    agent_id: agentId,
    agent_role: agentRole,
    task_id,
    input_tokens: tokenUsage.input_tokens,
    cache_creation_input_tokens: tokenUsage.cache_creation_input_tokens,
    cache_read_input_tokens: tokenUsage.cache_read_input_tokens,
    output_tokens: tokenUsage.output_tokens,
    model: tokenUsage.model,
    session_id: sessionId,
  };

  // Ensure .deepflow directory exists
  fs.mkdirSync(deepflowDir, { recursive: true });
  fs.appendFileSync(tokenHistoryPath, JSON.stringify(record) + '\n');

  return { record, skipped: false, error: null };
}

// ---------------------------------------------------------------------------
// Hook entry-point
// ---------------------------------------------------------------------------

readStdinIfMain(module, (data) => {
  if (data.hook_event_name && data.hook_event_name !== 'SubagentStop') return;

  const cwd = data.cwd || process.cwd();
  const deepflowDir = path.join(cwd, '.deepflow');
  const tokenHistoryPath = path.join(deepflowDir, 'token-history.jsonl');

  try {
    drain({
      payload: data,
      deepflowDir,
      tokenHistoryPath,
    });
  } catch (_) {
    // Never break Claude Code on hook errors
    try {
      appendErrorEvent(deepflowDir, data.agent_id || 'unknown', `unexpected error: ${_.message}`);
    } catch (_2) {
      // Silently swallow nested errors
    }
  }
});

module.exports = {
  drain,
  parseJsonl,
  sumTokenUsage,
  resolveAgentJsonlPath,
  extractTaskIdFromTranscript,
  isDuplicate,
  appendErrorEvent,
};
