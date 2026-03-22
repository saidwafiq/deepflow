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

    // Generate timestamp
    const timestamp = new Date().toISOString();

    // Build registry entry
    const entry = {
      session_id,
      agent_type,
      agent_id,
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
