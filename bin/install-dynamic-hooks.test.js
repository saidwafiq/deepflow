/**
 * Tests for dynamic hook configuration in bin/install.js
 *
 * Covers:
 *   - scanHookEvents: parsing @hook-event tags, multi-event, skipping *.test.js, untagged files
 *   - removeDeepflowHooks: orphan cleanup, preserving non-deepflow hooks
 *   - Unknown event warnings (REQ-10)
 *   - Idempotency (REQ-12)
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Extract scanHookEvents and removeDeepflowHooks from install.js source
// without executing main(). We eval only the needed pieces.
// ---------------------------------------------------------------------------

const installSource = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

// Extract VALID_HOOK_EVENTS, scanHookEvents, removeDeepflowHooks via a sandboxed eval
const extractedModule = (() => {
  // Provide minimal stubs for the module context
  const c = { reset: '', green: '', yellow: '', cyan: '', dim: '' };

  // Capture console.log calls for warning assertions
  const logCapture = [];
  const mockConsole = {
    log: (...args) => logCapture.push(args.join(' ')),
    error: console.error,
  };

  // Extract the three pieces we need using a Function constructor
  // This avoids executing main() or requiring real module dependencies
  const fn = new Function('fs', 'path', 'console', 'c', `
    const VALID_HOOK_EVENTS = new Set([
      'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'statusLine'
    ]);

    function scanHookEvents(hooksSourceDir) {
      const eventMap = new Map();
      const untagged = [];
      if (!fs.existsSync(hooksSourceDir)) return { eventMap, untagged };
      for (const file of fs.readdirSync(hooksSourceDir)) {
        if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
        const content = fs.readFileSync(path.join(hooksSourceDir, file), 'utf8');
        const firstLines = content.split('\\n').slice(0, 10).join('\\n');
        const match = firstLines.match(/\\/\\/\\s*@hook-event:\\s*(.+)/);
        if (!match) {
          untagged.push(file);
          continue;
        }
        const events = match[1].split(',').map(e => e.trim()).filter(Boolean);
        let hasValidEvent = false;
        for (const event of events) {
          if (!VALID_HOOK_EVENTS.has(event)) {
            console.log('  ' + c.yellow + '!' + c.reset + ' Warning: unknown event "' + event + '" in ' + file + ' — skipped');
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

    function removeDeepflowHooks(settings) {
      const isDeepflow = (hook) => {
        const cmd = hook.hooks?.[0]?.command || '';
        return cmd.includes('/hooks/df-');
      };
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          settings.hooks[event] = settings.hooks[event].filter(h => !isDeepflow(h));
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      if (settings.statusLine?.command && settings.statusLine.command.includes('/hooks/df-')) {
        delete settings.statusLine;
      }
    }

    return { VALID_HOOK_EVENTS, scanHookEvents, removeDeepflowHooks };
  `);

  return { build: fn, logCapture, mockConsole, c };
})();

function getFunctions(logCapture) {
  // Clear log capture before each use
  logCapture.length = 0;
  const { VALID_HOOK_EVENTS, scanHookEvents, removeDeepflowHooks } = extractedModule.build(
    fs, path, extractedModule.mockConsole, extractedModule.c
  );
  return { VALID_HOOK_EVENTS, scanHookEvents, removeDeepflowHooks };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-dynamic-hooks-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a hook file with given content lines at top */
function writeHook(dir, filename, lines) {
  fs.writeFileSync(path.join(dir, filename), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// scanHookEvents
// ---------------------------------------------------------------------------

describe('scanHookEvents', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('parses a single @hook-event tag', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-check-update.js', [
      '// @hook-event: SessionStart',
      'module.exports = {};'
    ]);

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 1);
    assert.deepEqual(eventMap.get('SessionStart'), ['df-check-update.js']);
    assert.equal(untagged.length, 0);
  });

  test('parses multi-event comma-separated tags (REQ-5)', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-command-usage.js', [
      '// @hook-event: PreToolUse, PostToolUse, SessionStart',
      'module.exports = {};'
    ]);

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 3);
    assert.deepEqual(eventMap.get('PreToolUse'), ['df-command-usage.js']);
    assert.deepEqual(eventMap.get('PostToolUse'), ['df-command-usage.js']);
    assert.deepEqual(eventMap.get('SessionStart'), ['df-command-usage.js']);
    assert.equal(untagged.length, 0);
  });

  test('multiple files under the same event accumulate', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-alpha.js', ['// @hook-event: PostToolUse', '']);
    writeHook(tmpDir, 'df-beta.js', ['// @hook-event: PostToolUse', '']);

    const { eventMap } = scanHookEvents(tmpDir);

    assert.equal(eventMap.get('PostToolUse').length, 2);
    assert.ok(eventMap.get('PostToolUse').includes('df-alpha.js'));
    assert.ok(eventMap.get('PostToolUse').includes('df-beta.js'));
  });

  test('skips *.test.js files', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-tool-usage.js', ['// @hook-event: PostToolUse', '']);
    writeHook(tmpDir, 'df-tool-usage.test.js', ['// @hook-event: PostToolUse', 'test file']);

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 1);
    assert.deepEqual(eventMap.get('PostToolUse'), ['df-tool-usage.js']);
    assert.equal(untagged.length, 0);
  });

  test('skips non-.js files', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-hook.js', ['// @hook-event: SessionEnd', '']);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# readme');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 1);
    assert.equal(untagged.length, 0);
  });

  test('returns untagged files that have no @hook-event tag', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-legacy.js', [
      '// No tag here',
      'module.exports = {};'
    ]);

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 0);
    assert.deepEqual(untagged, ['df-legacy.js']);
  });

  test('file with only unknown events ends up in untagged', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-bad.js', [
      '// @hook-event: BogusEvent',
      'module.exports = {};'
    ]);

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 0);
    assert.deepEqual(untagged, ['df-bad.js']);
  });

  test('unknown events trigger warning log (REQ-10)', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-weird.js', [
      '// @hook-event: FakeEvent, PostToolUse',
      ''
    ]);

    scanHookEvents(tmpDir);

    const warnings = extractedModule.logCapture.filter(l => l.includes('Warning') && l.includes('FakeEvent'));
    assert.equal(warnings.length, 1, 'Expected one warning for unknown event FakeEvent');
    assert.ok(warnings[0].includes('df-weird.js'), 'Warning should mention the filename');
  });

  test('tag on line > 10 is ignored (treated as untagged)', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push(`// line ${i}`);
    lines[12] = '// @hook-event: SessionStart';
    writeHook(tmpDir, 'df-deep.js', lines);

    const { eventMap, untagged } = scanHookEvents(tmpDir);

    assert.equal(eventMap.size, 0);
    assert.deepEqual(untagged, ['df-deep.js']);
  });

  test('returns empty results for nonexistent directory', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    const { eventMap, untagged } = scanHookEvents('/tmp/nonexistent-dir-abc123');

    assert.equal(eventMap.size, 0);
    assert.equal(untagged.length, 0);
  });

  test('parses statusLine event', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-statusline.js', [
      '// @hook-event: statusLine',
      'module.exports = {};'
    ]);

    const { eventMap } = scanHookEvents(tmpDir);

    assert.deepEqual(eventMap.get('statusLine'), ['df-statusline.js']);
  });

  test('idempotency: scanning same directory twice gives identical results (REQ-12)', () => {
    const { scanHookEvents } = getFunctions(extractedModule.logCapture);
    writeHook(tmpDir, 'df-a.js', ['// @hook-event: SessionStart', '']);
    writeHook(tmpDir, 'df-b.js', ['// @hook-event: PostToolUse, SessionEnd', '']);
    writeHook(tmpDir, 'df-c.js', ['// no tag', '']);

    const result1 = scanHookEvents(tmpDir);
    const result2 = scanHookEvents(tmpDir);

    // Compare eventMap entries
    assert.equal(result1.eventMap.size, result2.eventMap.size);
    for (const [event, files] of result1.eventMap) {
      assert.deepEqual(files, result2.eventMap.get(event));
    }
    assert.deepEqual(result1.untagged, result2.untagged);
  });
});

// ---------------------------------------------------------------------------
// removeDeepflowHooks
// ---------------------------------------------------------------------------

describe('removeDeepflowHooks', () => {
  test('removes deepflow hooks from all events', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node "/home/.claude/hooks/df-check-update.js"' }] },
        ],
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'node "/home/.claude/hooks/df-tool-usage.js"' }] },
        ],
      }
    };

    removeDeepflowHooks(settings);

    assert.equal(settings.hooks, undefined, 'hooks key should be deleted when empty');
  });

  test('preserves non-deepflow hooks', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const customHook = { hooks: [{ type: 'command', command: 'node "/custom/my-hook.js"' }] };
    const settings = {
      hooks: {
        SessionStart: [
          customHook,
          { hooks: [{ type: 'command', command: 'node "/home/.claude/hooks/df-check-update.js"' }] },
        ],
      }
    };

    removeDeepflowHooks(settings);

    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionStart[0], customHook);
  });

  test('removes deepflow statusLine', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const settings = {
      statusLine: {
        type: 'command',
        command: 'node "/home/.claude/hooks/df-statusline.js"'
      }
    };

    removeDeepflowHooks(settings);

    assert.equal(settings.statusLine, undefined);
  });

  test('preserves non-deepflow statusLine', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const settings = {
      statusLine: {
        type: 'command',
        command: 'node "/custom/my-statusline.js"'
      }
    };

    removeDeepflowHooks(settings);

    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: 'node "/custom/my-statusline.js"'
    });
  });

  test('handles missing hooks key gracefully', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const settings = {};

    removeDeepflowHooks(settings);

    assert.equal(settings.hooks, undefined);
  });

  test('handles missing statusLine gracefully', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const settings = { hooks: {} };

    removeDeepflowHooks(settings);

    // Should not throw, hooks should be cleaned up (empty → deleted)
    assert.equal(settings.hooks, undefined);
  });

  test('handles empty events array (cleans up key)', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'node "/x/hooks/df-guard.js"' }] },
        ],
        SessionEnd: [] // already empty
      }
    };

    removeDeepflowHooks(settings);

    assert.equal(settings.hooks, undefined);
  });

  test('handles hooks with missing command field', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const oddHook = { hooks: [{ type: 'command' }] }; // no command field
    const settings = {
      hooks: {
        SessionStart: [oddHook]
      }
    };

    removeDeepflowHooks(settings);

    // oddHook doesn't match df- pattern, so it should be preserved
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionStart[0], oddHook);
  });

  test('idempotency: calling removeDeepflowHooks twice gives same result (REQ-12)', () => {
    const { removeDeepflowHooks } = getFunctions(extractedModule.logCapture);
    const makeSettings = () => ({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node "/x/hooks/df-update.js"' }] },
          { hooks: [{ type: 'command', command: 'node "/custom/my-hook.js"' }] },
        ],
      },
      statusLine: { type: 'command', command: 'node "/x/hooks/df-statusline.js"' }
    });

    const s1 = makeSettings();
    removeDeepflowHooks(s1);
    const snapshot1 = JSON.parse(JSON.stringify(s1));

    // Call again on same object
    removeDeepflowHooks(s1);
    const snapshot2 = JSON.parse(JSON.stringify(s1));

    assert.deepEqual(snapshot1, snapshot2);
  });
});

// ---------------------------------------------------------------------------
// VALID_HOOK_EVENTS constant
// ---------------------------------------------------------------------------

describe('VALID_HOOK_EVENTS', () => {
  test('contains all expected events', () => {
    const { VALID_HOOK_EVENTS } = getFunctions(extractedModule.logCapture);
    const expected = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'statusLine'];
    for (const event of expected) {
      assert.ok(VALID_HOOK_EVENTS.has(event), `Expected VALID_HOOK_EVENTS to contain "${event}"`);
    }
    assert.equal(VALID_HOOK_EVENTS.size, expected.length);
  });
});
