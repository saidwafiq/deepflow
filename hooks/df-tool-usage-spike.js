#!/usr/bin/env node
/**
 * Spike hook: capture raw PostToolUse stdin payload
 * Writes the raw JSON to /tmp/df-posttooluse-payload.json for inspection.
 * Safe to install temporarily — exits cleanly (code 0) always.
 *
 * Usage in ~/.claude/settings.json:
 *   "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node /path/to/df-tool-usage-spike.js" }] }]
 */

'use strict';

const fs = require('fs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    // Write raw payload for inspection
    fs.writeFileSync('/tmp/df-posttooluse-payload.json', raw);

    // Also append a minimal summary line for quick review
    const data = JSON.parse(raw);
    const summary = {
      hook_event_name: data.hook_event_name,
      tool_name: data.tool_name,
      tool_use_id: data.tool_use_id,
      session_id: data.session_id,
      cwd: data.cwd,
      permission_mode: data.permission_mode,
      tool_input_keys: data.tool_input ? Object.keys(data.tool_input) : [],
      tool_response_keys: data.tool_response ? Object.keys(data.tool_response) : [],
      transcript_path: data.transcript_path,
    };
    fs.appendFileSync('/tmp/df-posttooluse-summary.jsonl', JSON.stringify(summary) + '\n');
  } catch (_e) {
    // Fail silently — never break tool execution
  }
  process.exit(0);
});
