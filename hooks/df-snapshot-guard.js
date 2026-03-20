#!/usr/bin/env node
/**
 * deepflow snapshot guard
 * PostToolUse hook: blocks Write/Edit to files listed in .deepflow/auto-snapshot.txt.
 *
 * REQ-3 AC-3: exit(1) to block the tool call when all conditions hold:
 *   1. tool_name is Write or Edit
 *   2. file_path matches an entry in .deepflow/auto-snapshot.txt
 *
 * Physical barrier independent of prompt instructions — prevents agents from
 * modifying pre-existing test files that are part of the ratchet baseline.
 *
 * Exits silently (code 0) on parse errors or missing snapshot file — never breaks
 * tool execution in non-deepflow projects.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadSnapshotPaths(cwd) {
  try {
    const snapshotPath = path.join(cwd, '.deepflow', 'auto-snapshot.txt');
    if (!fs.existsSync(snapshotPath)) {
      return null;
    }
    const content = fs.readFileSync(snapshotPath, 'utf8');
    const lines = content.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
    return lines;
  } catch (_) {
    return null;
  }
}

function isSnapshotFile(filePath, snapshotPaths, cwd) {
  // Normalize filePath: resolve relative to cwd if not absolute
  const absFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);

  for (const entry of snapshotPaths) {
    // Snapshot entries may be absolute or relative to cwd
    const absEntry = path.isAbsolute(entry)
      ? entry
      : path.resolve(cwd, entry);

    if (absFilePath === absEntry) {
      return true;
    }
  }
  return false;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const toolName = data.tool_name || '';

    // Only guard Write and Edit
    if (toolName !== 'Write' && toolName !== 'Edit') {
      process.exit(0);
    }

    const filePath = (data.tool_input && data.tool_input.file_path) || '';
    const cwd = data.cwd || process.cwd();

    if (!filePath) {
      process.exit(0);
    }

    const snapshotPaths = loadSnapshotPaths(cwd);

    // No snapshot file present — not a deepflow project or ratchet not initialized
    if (snapshotPaths === null) {
      process.exit(0);
    }

    // Empty snapshot — nothing to protect
    if (snapshotPaths.length === 0) {
      process.exit(0);
    }

    if (!isSnapshotFile(filePath, snapshotPaths, cwd)) {
      process.exit(0);
    }

    // File is in the snapshot — block the write
    console.error(
      `[df-snapshot-guard] Blocked ${toolName} to "${filePath}" — this file is listed in ` +
      `.deepflow/auto-snapshot.txt (ratchet baseline). ` +
      `Pre-existing test files must not be modified by agents. ` +
      `If you need to update this file, do so manually outside the autonomous loop.`
    );
    process.exit(1);
  } catch (_e) {
    // Parse or unexpected error — fail open so we never break non-deepflow projects
    process.exit(0);
  }
});
