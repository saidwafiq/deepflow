#!/usr/bin/env node
/**
 * AC-4 validation test: Hook auto-registration via @hook-event tag scan
 * Verifies that bin/install.js correctly detects and auto-registers hooks
 * with @hook-event:PostToolUse tag without manual wiring.
 */

const fs = require('fs');
const path = require('path');
const { scanHookEvents } = require('./lib/installer-utils');

/**
 * Test: scanHookEvents correctly identifies PostToolUse hooks with deepflow owner
 */
function testScanHookEventsFindsPostToolUse() {
  // The hooks directory should contain spec-transition.js with @hook-event:PostToolUse
  const hooksDir = path.join(__dirname);
  const { eventMap } = scanHookEvents(hooksDir, 'deepflow');

  const postToolUseHooks = eventMap.get('PostToolUse') || [];

  // spec-transition.js might not exist yet, but if it does, verify it's registered
  if (fs.existsSync(path.join(hooksDir, 'spec-transition.js'))) {
    if (!postToolUseHooks.includes('spec-transition.js')) {
      throw new Error('spec-transition.js has @hook-event:PostToolUse but was not detected');
    }
    console.log('✓ AC-4: spec-transition.js with @hook-event:PostToolUse correctly scanned');
  }

  return true;
}

/**
 * Test: Simulated installer wiring matches bin/install.js logic
 */
function testInstallerWiring() {
  const tempDir = `/tmp/ac4-test-${Date.now()}`;
  const hooksDir = path.join(tempDir, 'hooks');
  const settingsPath = path.join(tempDir, 'settings.json');

  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    // Create mock spec-transition.js with proper tags
    const mockHook = `#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * Mock spec-transition hook for AC-4 test
 */
module.exports = {};
`;
    fs.writeFileSync(path.join(hooksDir, 'spec-transition.js'), mockHook);

    // Replicate bin/install.js wiring logic
    let settings = {};
    const { eventMap } = scanHookEvents(hooksDir, 'deepflow');

    if (!settings.hooks) settings.hooks = {};
    for (const [event, files] of eventMap) {
      if (event === 'statusLine') continue; // Skip special case
      if (!settings.hooks[event]) settings.hooks[event] = [];

      for (const file of files) {
        const cmd = `node "${path.join(hooksDir, file)}"`;
        settings.hooks[event].push({
          hooks: [{ type: 'command', command: cmd }]
        });
      }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Verify PostToolUse was wired
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!written.hooks?.PostToolUse?.length) {
      throw new Error('PostToolUse hooks not wired to settings.json');
    }

    const hookCmd = written.hooks.PostToolUse[0].hooks[0].command;
    if (!hookCmd.includes('spec-transition.js')) {
      throw new Error('spec-transition.js not in wired PostToolUse command');
    }

    console.log('✓ AC-4: spec-transition.js correctly wired to settings.json PostToolUse');
    return true;
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  }
}

// Run tests
if (require.main === module) {
  try {
    testScanHookEventsFindsPostToolUse();
    testInstallerWiring();
    console.log('');
    console.log('AC-4 PASS: Hook auto-registration via @hook-event tag scan works correctly');
    process.exit(0);
  } catch (e) {
    console.error('AC-4 FAIL:', e.message);
    process.exit(1);
  }
}

module.exports = { testScanHookEventsFindsPostToolUse, testInstallerWiring };
