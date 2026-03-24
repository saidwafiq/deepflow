#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw);

    // Extract required fields from SubagentStop event
    const { session_id, agent_type, agent_id } = event;

    // Map agent_type to model (case-sensitive)
    const MODEL_MAP = {
      'reasoner': 'claude-opus-4-6',
      'Explore': 'claude-haiku-4-5'
    };
    const model = MODEL_MAP[agent_type] ?? 'claude-sonnet-4-6';

    // Generate timestamp
    const timestamp = new Date().toISOString();

    // Build registry entry
    const entry = {
      session_id,
      agent_type,
      agent_id,
      model,
      timestamp
    };

    // Append to registry file (fire-and-forget)
    const registryPath = path.join(os.homedir(), '.claude', 'subagent-sessions.jsonl');
    fs.appendFileSync(registryPath, JSON.stringify(entry) + '\n');
  } catch {
    // Exit 0 on any error (fail-open)
    process.exit(0);
  }
});
