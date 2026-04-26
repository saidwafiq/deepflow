#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow experiment immutable guard
 * PostToolUse hook: blocks Write/Edit to existing experiment result files under
 * `.deepflow/experiments/*.md` to enforce append-only immutability (REQ-7).
 *
 * Blocks when ALL of the following hold:
 *   1. tool_name is Write or Edit
 *   2. file_path matches `.deepflow/experiments/*.md` (any .md under that dir)
 *   3. the file already exists on disk (new files are allowed)
 *   4. the filename does NOT end in `--active.md` (in-progress scratchpads are exempt)
 *
 * Carve-outs — always allowed (exit 0):
 *   - Any path ending in `--active.md`  (in-progress experiment scratchpads)
 *   - Any path ending in `.jsonl`        (calibration append logs)
 *
 * Exits silently (code 0) on parse errors — never breaks tool execution in
 * non-deepflow projects.
 *
 * Exits with code 2 + stderr message when blocking.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

/**
 * Returns true if the path matches the experiments directory pattern:
 *   .deepflow/experiments/<something>.md
 * Works with both absolute and relative paths.
 */
function isExperimentMd(filePath) {
  // Normalise separators and check for the experiments segment
  const normalised = filePath.replace(/\\/g, '/');
  return /(?:^|\/)\.deepflow\/experiments\/[^/]+\.md$/.test(normalised);
}

/**
 * Returns true for paths that are explicitly exempt from the immutability rule.
 *   - *--active.md  (in-progress scratchpads)
 *   - *.jsonl       (calibration append logs)
 */
function isCarvedOut(filePath) {
  return filePath.endsWith('--active.md') || filePath.endsWith('.jsonl');
}

/**
 * Returns true when the file already exists on disk.
 * We resolve relative paths against cwd before checking.
 */
function fileExists(filePath, cwd) {
  try {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);
    return fs.existsSync(abs);
  } catch (_) {
    return false;
  }
}

readStdinIfMain(module, (data) => {
  const toolName = data.tool_name || '';

  // Only guard Write and Edit
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return;
  }

  const filePath = (data.tool_input && data.tool_input.file_path) || '';
  const cwd = data.cwd || process.cwd();

  if (!filePath) {
    return;
  }

  // Must match .deepflow/experiments/*.md pattern
  if (!isExperimentMd(filePath)) {
    return;
  }

  // Carve-outs: --active.md and .jsonl always pass through
  if (isCarvedOut(filePath)) {
    return;
  }

  // New files are allowed — only block mutations to existing results
  if (!fileExists(filePath, cwd)) {
    return;
  }

  // All conditions met — block the write
  console.error(
    `[df-experiment-immutable] Blocked ${toolName} to "${filePath}" — ` +
    `experiment result files under .deepflow/experiments/ are immutable after first write. ` +
    `To record a new result, create a new file with an updated status suffix (e.g. --passed.md, --failed.md). ` +
    `In-progress scratchpads (*--active.md) and append logs (*.jsonl) are exempt.`
  );
  process.exit(2);
});
