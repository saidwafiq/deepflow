'use strict';
/**
 * Shared installer utilities for deepflow hook management.
 * Used by bin/install.js and any owner-specific installer logic.
 */

const fs = require('fs');
const path = require('path');

// Valid hook events (settings.hooks keys + special "statusLine")
const VALID_HOOK_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'statusLine'
]);

/**
 * Atomically write data to targetPath using a write-to-temp + rename pattern.
 * If the write fails, the original file is left untouched and the temp file is
 * cleaned up. Temp file is created in the same directory as the target so the
 * rename is within the same filesystem (atomic on POSIX).
 */
function atomicWriteFileSync(targetPath, data) {
  const tmpPath = targetPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

/**
 * Scan hook source files for @hook-event tags. Returns:
 *   { eventMap: Map<event, [filename, ...]>, untagged: [filename, ...] }
 *
 * @param {string} hooksSourceDir - Directory to scan for hook files
 * @param {string} [filterOwner]  - When set, only include files whose @hook-owner tag
 *                                  matches this value (case-sensitive). Files with no
 *                                  @hook-owner tag are always excluded when filterOwner
 *                                  is provided.
 */
function scanHookEvents(hooksSourceDir, filterOwner) {
  const eventMap = new Map();  // event → [filenames]
  const untagged = [];

  if (!fs.existsSync(hooksSourceDir)) return { eventMap, untagged };

  for (const file of fs.readdirSync(hooksSourceDir)) {
    if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;

    const content = fs.readFileSync(path.join(hooksSourceDir, file), 'utf8');
    const firstLines = content.split('\n').slice(0, 10).join('\n');

    // Apply owner filter if requested
    if (filterOwner !== undefined) {
      const ownerMatch = firstLines.match(/\/\/\s*@hook-owner:\s*(.+)/);
      if (!ownerMatch || ownerMatch[1].trim() !== filterOwner) continue;
    }

    const match = firstLines.match(/\/\/\s*@hook-event:\s*(.+)/);

    if (!match) {
      untagged.push(file);
      continue;
    }

    const events = match[1].split(',').map(e => e.trim()).filter(Boolean);
    let hasValidEvent = false;

    for (const event of events) {
      if (!VALID_HOOK_EVENTS.has(event)) {
        // Surface warning via stderr so callers can decide how to display it
        process.stderr.write(`[installer-utils] Warning: unknown event "${event}" in ${file} — skipped\n`);
        continue;
      }
      hasValidEvent = true;
      if (!eventMap.has(event)) eventMap.set(event, []);
      eventMap.get(event).push(file);
    }

    if (!hasValidEvent) {
      untagged.push(file);
    }
  }

  return { eventMap, untagged };
}

/**
 * Remove all deepflow hook entries (commands containing /hooks/df-) from settings.
 * Preserves non-deepflow hooks.
 */
function removeDeepflowHooks(settings) {
  const isDeepflow = (hook) => {
    const cmd = hook.hooks?.[0]?.command || '';
    return cmd.includes('/hooks/df-');
  };

  // Clean settings.hooks.*
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(h => !isDeepflow(h));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  // Clean settings.statusLine if it's a deepflow hook
  if (settings.statusLine?.command && settings.statusLine.command.includes('/hooks/df-')) {
    delete settings.statusLine;
  }
}

module.exports = { atomicWriteFileSync, scanHookEvents, removeDeepflowHooks, VALID_HOOK_EVENTS };
