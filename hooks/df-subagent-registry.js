#!/usr/bin/env node
// @hook-event: SubagentStop
// @hook-owner: dashboard
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinIfMain } = require('./lib/hook-stdin');

readStdinIfMain(module, (event) => {
  const { session_id, agent_type, agent_id, agent_transcript_path } = event;

  // Parse subagent transcript to extract real model and token usage
  let model = 'unknown';
  let tokens_in = 0, tokens_out = 0, cache_read = 0, cache_creation = 0;

  if (agent_transcript_path && fs.existsSync(agent_transcript_path)) {
    const lines = fs.readFileSync(agent_transcript_path, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        const msg = evt.message || {};
        const usage = msg.usage || evt.usage;
        // Extract model from assistant messages
        const m = msg.model || evt.model;
        if (m && m !== 'unknown') model = m;
        // Accumulate tokens
        if (usage) {
          tokens_in += usage.input_tokens || 0;
          tokens_out += usage.output_tokens || 0;
          cache_read += usage.cache_read_input_tokens || usage.cache_read_tokens || 0;
          cache_creation += usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0;
        }
      } catch { /* skip malformed lines */ }
    }
  }

  // Strip version suffix from model (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5)
  model = model.replace(/-\d{8}$/, '').replace(/\[\d+[km]\]$/i, '');

  const entry = {
    session_id,
    agent_type,
    agent_id,
    model,
    tokens_in,
    tokens_out,
    cache_read,
    cache_creation,
    timestamp: new Date().toISOString()
  };

  const registryPath = path.join(os.homedir(), '.claude', 'subagent-sessions.jsonl');
  fs.appendFileSync(registryPath, JSON.stringify(entry) + '\n');
});
