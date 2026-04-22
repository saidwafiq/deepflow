#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * Test/build invocation cap for df-implement agents.
 *
 * PreToolUse hook: intercepts Bash calls matching the project's
 * `build_command` or `test_command` (from `.deepflow/config.yaml`).
 * Allows exactly ONE invocation per task ID; the second invocation
 * is denied with a "fix root cause" hint.
 *
 * Task ID resolution (hybrid, highest-priority first):
 *   1. DEEPFLOW_TASK_ID environment variable
 *   2. Runtime state file `.deepflow/runtime/active-task.json` (walked up from cwd)
 *   3. Fail-open: no task ID → allow and do not enforce the cap
 *
 * Counter state is persisted at:
 *   `.deepflow/runtime/task-counters/{task_id}.json`
 *
 * The hook fails open on any error (missing config, fs errors, etc.)
 * to avoid blocking unrelated work.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load build_command and test_command from .deepflow/config.yaml.
 * Returns { buildCommand, testCommand } — either may be null.
 * Uses a minimal YAML line parser; no external deps.
 */
function loadCommands(cwd) {
  // Walk up from cwd to find .deepflow/config.yaml
  let current = cwd || process.cwd();
  const root = path.parse(current).root;
  while (current !== root) {
    const candidate = path.join(current, '.deepflow', 'config.yaml');
    if (fs.existsSync(candidate)) {
      return parseCommandsFromConfig(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { buildCommand: null, testCommand: null };
}

function parseCommandsFromConfig(configPath) {
  let buildCommand = null;
  let testCommand = null;
  try {
    const lines = fs.readFileSync(configPath, 'utf8').split('\n');
    // Find the `quality:` section and read build_command / test_command from it.
    // Simple state-machine: enter quality section, extract keyed values.
    let inQuality = false;
    for (const line of lines) {
      const stripped = line.trimEnd();
      // Detect section headers (non-indented key:)
      if (/^\S/.test(stripped)) {
        inQuality = stripped.startsWith('quality:');
      }
      if (!inQuality) continue;
      // Look for build_command and test_command under quality section
      const buildMatch = stripped.match(/^\s+build_command:\s*"?([^"#\n]+)"?\s*$/);
      if (buildMatch) {
        const val = buildMatch[1].trim();
        if (val) buildCommand = val;
      }
      const testMatch = stripped.match(/^\s+test_command:\s*"?([^"#\n]+)"?\s*$/);
      if (testMatch) {
        const val = testMatch[1].trim();
        if (val) testCommand = val;
      }
    }
  } catch (_e) {
    // Fail open
  }
  return { buildCommand, testCommand };
}

// ---------------------------------------------------------------------------
// Task ID resolution (hybrid)
// ---------------------------------------------------------------------------

function getTaskId(cwd) {
  // 1. Environment variable
  const envId = process.env.DEEPFLOW_TASK_ID;
  if (envId && envId.trim()) return envId.trim();

  // 2. Runtime state file — walk up from cwd
  if (cwd) {
    let current = cwd;
    const root = path.parse(current).root;
    while (current !== root) {
      const runtimeFile = path.join(current, '.deepflow', 'runtime', 'active-task.json');
      if (fs.existsSync(runtimeFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
          if (data && data.task_id) return String(data.task_id);
        } catch (_e) {
          // Fail open
        }
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  // 3. No task ID — fail open
  return null;
}

// ---------------------------------------------------------------------------
// Counter file I/O
// ---------------------------------------------------------------------------

function findDeepflowRoot(cwd) {
  let current = cwd || process.cwd();
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.deepflow'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function counterFilePath(deepflowRoot, taskId) {
  return path.join(deepflowRoot, '.deepflow', 'runtime', 'task-counters', `${taskId}.json`);
}

function readCounter(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_e) {
    // Fail open
  }
  return null;
}

function writeCounter(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (_e) {
    // Fail open — if we can't write, don't block
  }
}

// ---------------------------------------------------------------------------
// Command matching
// ---------------------------------------------------------------------------

function commandMatchesTarget(cmd, target) {
  if (!target || !cmd) return false;
  // Normalize whitespace for comparison
  const trimCmd = cmd.trim();
  const trimTarget = target.trim();
  // Exact prefix match (command may have extra flags or redirects)
  return trimCmd === trimTarget || trimCmd.startsWith(trimTarget + ' ') || trimCmd.startsWith(trimTarget + '\t');
}

// ---------------------------------------------------------------------------
// Main hook logic
// ---------------------------------------------------------------------------

readStdinIfMain(module, (data) => {
  if (data.tool_name !== 'Bash') return;

  const input = data.tool_input || {};
  const cmd = (input.command || '').trim();
  if (!cmd) return;

  const cwd = data.cwd || '';

  // Load configured commands
  const { buildCommand, testCommand } = loadCommands(cwd);
  if (!buildCommand && !testCommand) return; // No commands configured — fail open

  // Check if command matches build or test command
  const isBuild = commandMatchesTarget(cmd, buildCommand);
  const isTest = commandMatchesTarget(cmd, testCommand);
  if (!isBuild && !isTest) return; // Not a tracked command — pass through

  // Resolve task ID
  const taskId = getTaskId(cwd);
  if (!taskId) return; // No task context — fail open

  // Find deepflow root for counter storage
  const deepflowRoot = findDeepflowRoot(cwd);
  if (!deepflowRoot) return; // No .deepflow dir — fail open

  const filePath = counterFilePath(deepflowRoot, taskId);
  const existing = readCounter(filePath);

  const commandType = isBuild ? 'build_command' : 'test_command';

  if (!existing) {
    // First invocation — record it and allow
    writeCounter(filePath, {
      task_id: taskId,
      test_invocations: 1,
      command_type: commandType,
      first_invocation_at: new Date().toISOString(),
    });
    return; // Allow (no output = pass through)
  }

  // Counter exists — this is the 2nd+ invocation → deny
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `df-implement-test-invocation-cap: task ${taskId} has already invoked ` +
        `${commandType} once. Fix root cause; do not iterate health filters. ` +
        `Counter file: .deepflow/runtime/task-counters/${taskId}.json`,
    },
  }));
});
