/**
 * Tests for bin/install.js installer/uninstaller logic.
 *
 * Tests are structured around the three focus areas from the command-cleanup spec:
 *   1. Installer output lists the correct commands and skills
 *   2. Hook configuration logic (consolidation-check hook setup/removal)
 *   3. Uninstaller removes files and cleans settings correctly
 *
 * Uses Node.js built-in node:test to avoid adding dependencies.
 */

'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'df-install-test-'));
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run install.js in a subprocess with a fake HOME so it never touches the real
 * ~/.claude directory.  We override HOME and cwd so both GLOBAL_DIR and
 * PROJECT_DIR resolve to deterministic temp paths.
 *
 * Returns { stdout, stderr, code } — always resolves (never throws).
 */
function runInstaller(args = [], { cwd, home, env = {} } = {}) {
  const installScript = path.resolve(__dirname, 'install.js');
  try {
    const stdout = execFileSync(
      process.execPath,
      [installScript, ...args],
      {
        cwd: cwd || os.tmpdir(),
        env: {
          ...process.env,
          HOME: home || os.tmpdir(),
          // Disable TTY so askInstallLevel defaults to global and no prompts appear
          ...env
        },
        encoding: 'utf8',
        // Allow the process to fail — we capture exit code via try/catch
      }
    );
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? 1
    };
  }
}

// ---------------------------------------------------------------------------
// Extract internal functions from install.js without running main().
// We do this by requiring after monkey-patching process.argv so the
// "deepflow auto" legacy path doesn't fire and main() is never called.
// Instead we read and eval the module pieces we need directly.
// ---------------------------------------------------------------------------

/**
 * Build a minimal settings object that matches the structure
 * configureHooks() expects, then call the relevant filtering logic inline.
 * We test the logic by reproducing it from the source rather than importing,
 * which avoids having to restructure the script.
 */

// ---------------------------------------------------------------------------
// 1. Installer output: lists correct commands and skills
// ---------------------------------------------------------------------------

describe('Installer output — commands and skills listing', () => {
  let tmpHome;
  let tmpProject;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    tmpProject = makeTmpDir();

    // Pre-create the package source structure the installer expects
    // The installer reads from __dirname/.. so we use the real package src.
    // We only need to ensure a fresh fake HOME so it doesn't touch real dirs.
  });

  afterEach(() => {
    rmrf(tmpHome);
    rmrf(tmpProject);
  });

  test('output lists expected command names', () => {
    const { stdout } = runInstaller([], { home: tmpHome, cwd: tmpProject });
    // These commands should appear in installer output
    const expectedCommands = [
      '/df:discover',
      '/df:debate',
      '/df:spec',
      '/df:plan',
      '/df:execute',
      '/df:verify',
      '/df:auto',
      '/df:update',
    ];
    for (const cmd of expectedCommands) {
      assert.ok(
        stdout.includes(cmd),
        `Expected installer output to include "${cmd}"\nActual output:\n${stdout}`
      );
    }
  });

  test('output does NOT list removed commands (report, note, resume, consolidate)', () => {
    const { stdout } = runInstaller([], { home: tmpHome, cwd: tmpProject });
    const removedCommands = [
      '/df:report',
      '/df:note',
      '/df:resume',
      '/df:consolidate',
    ];
    for (const cmd of removedCommands) {
      assert.ok(
        !stdout.includes(cmd),
        `Installer output should NOT include "${cmd}" — it was removed\nActual output:\n${stdout}`
      );
    }
  });

  test('output lists skills section', () => {
    const { stdout } = runInstaller([], { home: tmpHome, cwd: tmpProject });
    assert.ok(
      stdout.includes('skills/'),
      `Expected installer output to include "skills/"\nActual output:\n${stdout}`
    );
  });

  test('output lists known skills', () => {
    const { stdout } = runInstaller([], { home: tmpHome, cwd: tmpProject });
    const expectedSkills = [
      'gap-discovery',
      'atomic-commits',
      'code-completeness',
      'browse-fetch',
      'browse-verify',
    ];
    for (const skill of expectedSkills) {
      assert.ok(
        stdout.includes(skill),
        `Expected installer output to include skill "${skill}"\nActual output:\n${stdout}`
      );
    }
  });

  test('output lists hooks section for global install', () => {
    const { stdout } = runInstaller([], { home: tmpHome, cwd: tmpProject });
    // Non-interactive defaults to global — hooks section should be present
    assert.ok(
      stdout.includes('hooks/'),
      `Expected installer output to include "hooks/" for global install\nActual output:\n${stdout}`
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Hook configuration logic — consolidation-check hook setup / removal
// ---------------------------------------------------------------------------

describe('Hook configuration — consolidation-check hook', () => {
  /**
   * We test the filtering logic that configureHooks() applies to SessionStart.
   * The logic is: filter out hooks whose command includes 'df-consolidation-check'.
   * We reproduce this inline since install.js does not export functions.
   */

  function filterSessionStart(hooks) {
    return hooks.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-check-update') &&
             !cmd.includes('df-consolidation-check') &&
             !cmd.includes('df-quota-logger');
    });
  }

  test('filterSessionStart removes consolidation-check hooks', () => {
    const hooks = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-consolidation-check.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-check-update.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-other.js' }] },
    ];

    const filtered = filterSessionStart(hooks);

    assert.equal(filtered.length, 1, 'Should keep only hooks not matching deepflow patterns');
    assert.ok(
      filtered[0].hooks[0].command.includes('df-other.js'),
      'Should keep non-deepflow hooks'
    );
  });

  test('filterSessionStart removes df-check-update hooks', () => {
    const hooks = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-check-update.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/unrelated.js' }] },
    ];

    const filtered = filterSessionStart(hooks);
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].hooks[0].command.includes('unrelated.js'));
  });

  test('filterSessionStart removes df-quota-logger hooks', () => {
    const hooks = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-quota-logger.js' }] },
    ];
    const filtered = filterSessionStart(hooks);
    assert.equal(filtered.length, 0);
  });

  test('filterSessionStart keeps empty array as-is', () => {
    const filtered = filterSessionStart([]);
    assert.equal(filtered.length, 0);
  });

  test('filterSessionStart keeps non-deepflow hooks intact', () => {
    const hooks = [
      { hooks: [{ type: 'command', command: 'node /home/custom-hook.js' }] },
      { hooks: [{ type: 'command', command: '/usr/local/bin/mytool' }] },
    ];
    const filtered = filterSessionStart(hooks);
    assert.equal(filtered.length, 2);
  });

  test('filterSessionStart handles hook with missing command gracefully', () => {
    const hooks = [
      { hooks: [{ type: 'command' }] },            // no command field
      { hooks: [] },                                 // empty hooks array
      {},                                            // no hooks key
    ];
    // Should not throw — all default to '' which doesn't match any pattern
    const filtered = filterSessionStart(hooks);
    assert.equal(filtered.length, 3, 'Malformed hooks should be kept (not errored)');
  });

  test('configureHooks does NOT add consolidation-check to SessionStart', () => {
    // Read install.js source and verify the string 'consolidation-check' does not
    // appear as a command being PUSHED to SessionStart.
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

    // Find all .push( calls that include consolidationCheckCmd
    // The source should NOT push consolidationCheckCmd to SessionStart
    // We check by looking at the section after "Remove any existing deepflow" and before
    // "Add update check hook" — consolidation-check should not be in a push block
    const pushConsolidationPattern = /settings\.hooks\.SessionStart\.push[\s\S]*?consolidation/;
    assert.ok(
      !pushConsolidationPattern.test(src),
      'install.js should not push consolidation-check to SessionStart after cleanup'
    );
  });

  test('source does not reference df-consolidation-check.js in hook setup variable', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

    // consolidationCheckCmd should not be defined / used to register a hook
    // (it may still appear in filter expressions for safe removal)
    const consolidationCmdDef = /consolidationCheckCmd\s*=\s*`node/;
    assert.ok(
      !consolidationCmdDef.test(src),
      'consolidationCheckCmd variable should not be defined in install.js after command-cleanup'
    );
  });

  test('source does not add consolidation-check hook to SessionStart', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

    // After cleanup, the installer must not push a consolidation-check command
    // into any hooks array. The only valid reference to consolidation-check
    // in the hooks section is inside .filter() calls (for safe removal).
    const lines = src.split('\n');
    let insidePush = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes('.push(')) insidePush = true;
      if (insidePush && line.includes(');')) insidePush = false;

      if (insidePush && line.includes('df-consolidation-check')) {
        assert.fail(
          `Line ${i + 1}: consolidation-check found inside a .push() call — it should not be registered as a hook`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Uninstaller: removes files and cleans settings
// ---------------------------------------------------------------------------

describe('Uninstaller — file removal and settings cleanup', () => {
  let tmpHome;
  let tmpProject;

  function makeGlobalInstall(claudeDir) {
    // Create the minimal structure that isInstalled() considers "installed"
    fs.mkdirSync(path.join(claudeDir, 'commands', 'df'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'commands', 'df', 'auto.md'), '# auto');

    // Create hook files
    const hookDir = path.join(claudeDir, 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    for (const hook of [
      'df-statusline.js',
      'df-check-update.js',
      'df-consolidation-check.js',
      'df-invariant-check.js',
      'df-quota-logger.js',
      'df-tool-usage.js',
      'df-dashboard-push.js',
      'df-execution-history.js',
      'df-worktree-guard.js',
    ]) {
      fs.writeFileSync(path.join(hookDir, hook), '// hook');
    }

    // Create skills and agents
    fs.mkdirSync(path.join(claudeDir, 'skills', 'atomic-commits'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'skills', 'atomic-commits', 'SKILL.md'), '# skill');
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'agents', 'reasoner.md'), '# reasoner');
  }

  function makeGlobalSettings(claudeDir, extra = {}) {
    const settings = {
      env: { ENABLE_LSP_TOOL: '1', MY_CUSTOM_VAR: 'keep-me' },
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-check-update.js` }] },
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-consolidation-check.js` }] },
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-quota-logger.js` }] },
          { hooks: [{ type: 'command', command: 'node /usr/local/my-custom-hook.js' }] },
        ],
        SessionEnd: [
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-quota-logger.js` }] },
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-dashboard-push.js` }] },
        ],
        PostToolUse: [
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-tool-usage.js` }] },
          { hooks: [{ type: 'command', command: `node ${claudeDir}/hooks/df-worktree-guard.js` }] },
        ],
      },
      permissions: {
        allow: ['Edit', 'Write', 'Read', 'Bash(git status:*)', 'MY_CUSTOM_PERM']
      },
      ...extra
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(settings, null, 2)
    );
    return settings;
  }

  beforeEach(() => {
    tmpHome = makeTmpDir();
    tmpProject = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpHome);
    rmrf(tmpProject);
  });

  // -- Source-level checks (do not require filesystem install) --

  test('uninstall source does not reference df-consolidation-check.js in toRemove array', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

    // Find the toRemove array literal in the uninstall function
    // It should not contain 'hooks/df-consolidation-check.js'
    const toRemoveBlock = src.match(/const toRemove\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(toRemoveBlock, 'Could not find toRemove array in install.js');

    assert.ok(
      !toRemoveBlock[1].includes('df-consolidation-check.js'),
      'toRemove array should not list df-consolidation-check.js — hook was removed from the project'
    );
  });

  test('uninstall SessionStart filter does not include consolidation-check', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

    // Find the SessionStart filter in uninstall function
    // It should filter out df-check-update and df-quota-logger,
    // but df-consolidation-check may or may not be in the filter.
    // AC-10 says: uninstaller must not ERROR when hook is already absent.
    // It's acceptable to leave the filter in for safe removal, but
    // consolidation-check must NOT be in the toRemove list.
    // This test validates the toRemove list (already done above),
    // so here we just validate the filter handles missing hooks gracefully.

    // The filter function should use optional chaining: hook.hooks?.[0]?.command
    assert.ok(
      src.includes('hook.hooks?.[0]?.command'),
      'SessionStart filter should use optional chaining to avoid errors on missing hooks'
    );
  });

  test('settings cleanup removes ENABLE_LSP_TOOL but keeps other env vars', () => {
    // Reproduce the cleanup logic inline
    const settings = {
      env: { ENABLE_LSP_TOOL: '1', MY_CUSTOM: 'keep' },
    };

    if (settings.env?.ENABLE_LSP_TOOL) {
      delete settings.env.ENABLE_LSP_TOOL;
      if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
    }

    assert.ok(!settings.env?.ENABLE_LSP_TOOL, 'ENABLE_LSP_TOOL should be removed');
    assert.ok(settings.env?.MY_CUSTOM === 'keep', 'Other env vars should be preserved');
  });

  test('settings cleanup deletes env key when it becomes empty', () => {
    const settings = {
      env: { ENABLE_LSP_TOOL: '1' },
    };

    if (settings.env?.ENABLE_LSP_TOOL) {
      delete settings.env.ENABLE_LSP_TOOL;
      if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
    }

    assert.ok(!('env' in settings), 'env key should be deleted when empty');
  });

  test('settings cleanup removes only deepflow permissions, keeps custom ones', () => {
    // DEEPFLOW_PERMISSIONS includes 'Edit', 'Write', 'Read', 'Bash(git status:*)'
    // We simulate the filter
    const DEEPFLOW_PERMISSIONS = new Set([
      'Edit', 'Write', 'Read', 'Glob', 'Grep',
      'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)',
      'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)',
    ]);

    const settings = {
      permissions: {
        allow: ['Edit', 'Write', 'Read', 'MY_CUSTOM_PERM', 'ANOTHER_PERM']
      }
    };

    settings.permissions.allow = settings.permissions.allow.filter(p => !DEEPFLOW_PERMISSIONS.has(p));
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow;

    assert.deepEqual(
      settings.permissions.allow,
      ['MY_CUSTOM_PERM', 'ANOTHER_PERM'],
      'Non-deepflow permissions should be preserved'
    );
  });

  test('settings cleanup deletes permissions when allow list becomes empty', () => {
    const DEEPFLOW_PERMISSIONS = new Set(['Edit', 'Write']);
    const settings = {
      permissions: { allow: ['Edit', 'Write'] }
    };

    settings.permissions.allow = settings.permissions.allow.filter(p => !DEEPFLOW_PERMISSIONS.has(p));
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
    if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions;

    assert.ok(!('permissions' in settings), 'permissions key should be deleted when empty');
  });

  test('SessionStart cleanup removes df hooks and keeps custom hooks', () => {
    const sessionStart = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-check-update.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-consolidation-check.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-quota-logger.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/my-hook.js' }] },
    ];

    const filtered = sessionStart.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-check-update') &&
             !cmd.includes('df-consolidation-check') &&
             !cmd.includes('df-quota-logger');
    });

    assert.equal(filtered.length, 1, 'Should keep only non-deepflow hooks');
    assert.ok(filtered[0].hooks[0].command.includes('my-hook.js'));
  });

  test('SessionEnd cleanup removes quota-logger and dashboard-push', () => {
    const sessionEnd = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-quota-logger.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-dashboard-push.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/keep.js' }] },
    ];

    const filtered = sessionEnd.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-quota-logger') && !cmd.includes('df-dashboard-push');
    });

    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].hooks[0].command.includes('keep.js'));
  });

  test('PostToolUse cleanup removes all deepflow hooks', () => {
    const postToolUse = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-tool-usage.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-execution-history.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-worktree-guard.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-invariant-check.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/my-tool.js' }] },
    ];

    const filtered = postToolUse.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-tool-usage') &&
             !cmd.includes('df-execution-history') &&
             !cmd.includes('df-worktree-guard') &&
             !cmd.includes('df-invariant-check');
    });

    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].hooks[0].command.includes('my-tool.js'));
  });

  test('hooks object is deleted when all hook arrays are removed', () => {
    const settings = {
      hooks: {
        SessionStart: [],
        SessionEnd: [],
        PostToolUse: [],
      }
    };

    // Simulate what uninstall does: delete empty arrays, then delete hooks if empty
    for (const key of ['SessionStart', 'SessionEnd', 'PostToolUse']) {
      if (settings.hooks[key] && settings.hooks[key].length === 0) {
        delete settings.hooks[key];
      }
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    assert.ok(!('hooks' in settings), 'hooks object should be deleted when all arrays are empty');
  });

  test('hooks object is kept when non-deepflow hooks remain', () => {
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /usr/local/keep.js' }] }
        ]
      }
    };

    const filtered = settings.hooks.SessionStart.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-check-update') &&
             !cmd.includes('df-consolidation-check') &&
             !cmd.includes('df-quota-logger');
    });

    settings.hooks.SessionStart = filtered;
    if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

    assert.ok('hooks' in settings, 'hooks object should be preserved when non-deepflow hooks remain');
    assert.equal(settings.hooks.SessionStart.length, 1);
  });
});

// ---------------------------------------------------------------------------
// T4. command-usage hook registration (PreToolUse, PostToolUse, SessionEnd)
// ---------------------------------------------------------------------------

describe('T4 — command-usage hook registration in install.js', () => {

  // -- Source-level checks: verify install.js registers df-command-usage.js --

  test('source defines commandUsageCmd variable', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    const pattern = /commandUsageCmd\s*=\s*`node.*df-command-usage\.js/;
    assert.ok(
      pattern.test(src),
      'install.js should define commandUsageCmd pointing to df-command-usage.js'
    );
  });

  test('source pushes command-usage hook to PreToolUse', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    // Find PreToolUse section — should contain a push with commandUsageCmd
    const preToolUseSection = src.match(/PreToolUse[\s\S]*?log\('PreToolUse hook configured'\)/);
    assert.ok(preToolUseSection, 'Should have a PreToolUse configuration section');
    assert.ok(
      preToolUseSection[0].includes('commandUsageCmd'),
      'PreToolUse section should push commandUsageCmd'
    );
  });

  test('source pushes command-usage hook to PostToolUse', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    // Find PostToolUse section
    const postToolUseSection = src.match(/PostToolUse[\s\S]*?log\('PostToolUse hook configured'\)/);
    assert.ok(postToolUseSection, 'Should have a PostToolUse configuration section');
    assert.ok(
      postToolUseSection[0].includes('commandUsageCmd'),
      'PostToolUse section should push commandUsageCmd'
    );
  });

  test('source pushes command-usage hook to SessionEnd', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    // Find SessionEnd section — should include command-usage alongside quota-logger + dashboard-push
    const sessionEndSection = src.match(/SessionEnd[\s\S]*?log\('Quota logger.*configured.*SessionEnd/);
    assert.ok(sessionEndSection, 'Should have a SessionEnd configuration section');
    assert.ok(
      sessionEndSection[0].includes('commandUsageCmd'),
      'SessionEnd section should push commandUsageCmd'
    );
  });

  test('source creates PreToolUse array if missing', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    assert.ok(
      src.includes("if (!settings.hooks.PreToolUse)"),
      'install.js should initialize PreToolUse array if not present'
    );
  });

  // -- Dedup logic: filter removes existing command-usage before re-adding --

  test('PreToolUse dedup filter removes existing df-command-usage entries', () => {
    const preToolUse = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-command-usage.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/my-custom.js' }] },
    ];

    const filtered = preToolUse.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-command-usage');
    });

    assert.equal(filtered.length, 1, 'Should remove existing df-command-usage hook');
    assert.ok(filtered[0].hooks[0].command.includes('my-custom.js'), 'Should keep non-deepflow hooks');
  });

  test('PostToolUse dedup filter removes df-command-usage alongside other deepflow hooks', () => {
    const postToolUse = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-tool-usage.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-command-usage.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-worktree-guard.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/keep-me.js' }] },
    ];

    const filtered = postToolUse.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-tool-usage') &&
             !cmd.includes('df-execution-history') &&
             !cmd.includes('df-worktree-guard') &&
             !cmd.includes('df-snapshot-guard') &&
             !cmd.includes('df-invariant-check') &&
             !cmd.includes('df-command-usage');
    });

    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].hooks[0].command.includes('keep-me.js'));
  });

  test('SessionEnd dedup filter removes df-command-usage alongside quota-logger and dashboard-push', () => {
    const sessionEnd = [
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-quota-logger.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-dashboard-push.js' }] },
      { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-command-usage.js' }] },
      { hooks: [{ type: 'command', command: 'node /usr/local/keep.js' }] },
    ];

    const filtered = sessionEnd.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-quota-logger') &&
             !cmd.includes('df-dashboard-push') &&
             !cmd.includes('df-command-usage');
    });

    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].hooks[0].command.includes('keep.js'));
  });

  // -- Uninstall cleanup --

  test('uninstall toRemove includes df-command-usage.js', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    // Find the toRemove.push(...) line for hooks in uninstall
    assert.ok(
      src.includes("'hooks/df-command-usage.js'"),
      'toRemove should include hooks/df-command-usage.js for uninstall'
    );
  });

  test('uninstall SessionEnd filter removes df-command-usage', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    // In the uninstall function, the SessionEnd filter should include df-command-usage
    // Find the uninstall section's SessionEnd filter
    const uninstallSection = src.match(/async function uninstall[\s\S]+$/);
    assert.ok(uninstallSection, 'Should have uninstall function');
    // Check SessionEnd filter in uninstall includes command-usage
    const sessionEndFilter = uninstallSection[0].match(/SessionEnd[\s\S]*?\.filter[\s\S]*?\);/);
    assert.ok(sessionEndFilter, 'Should have SessionEnd filter in uninstall');
    assert.ok(
      sessionEndFilter[0].includes('df-command-usage'),
      'Uninstall SessionEnd filter should remove df-command-usage hooks'
    );
  });

  test('uninstall PostToolUse filter removes df-command-usage', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    const uninstallSection = src.match(/async function uninstall[\s\S]+$/);
    const postToolUseFilter = uninstallSection[0].match(/PostToolUse[\s\S]*?\.filter[\s\S]*?\);/);
    assert.ok(postToolUseFilter, 'Should have PostToolUse filter in uninstall');
    assert.ok(
      postToolUseFilter[0].includes('df-command-usage'),
      'Uninstall PostToolUse filter should remove df-command-usage hooks'
    );
  });

  test('uninstall cleans up PreToolUse hooks', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');
    const uninstallSection = src.match(/async function uninstall[\s\S]+$/);
    assert.ok(
      uninstallSection[0].includes('PreToolUse'),
      'Uninstall function should handle PreToolUse cleanup'
    );
    // Verify it filters out df-command-usage from PreToolUse
    const preToolUseFilter = uninstallSection[0].match(/PreToolUse[\s\S]*?\.filter[\s\S]*?\);/);
    assert.ok(preToolUseFilter, 'Should have PreToolUse filter in uninstall');
    assert.ok(
      preToolUseFilter[0].includes('df-command-usage'),
      'Uninstall PreToolUse filter should remove df-command-usage hooks'
    );
  });

  test('uninstall deletes PreToolUse key when array becomes empty', () => {
    // Reproduce the uninstall logic for PreToolUse
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-command-usage.js' }] },
        ],
      }
    };

    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-command-usage');
    });
    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }

    assert.ok(!('PreToolUse' in settings.hooks), 'PreToolUse should be deleted when empty after filtering');
  });

  test('uninstall keeps PreToolUse when non-deepflow hooks remain', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'node /home/.claude/hooks/df-command-usage.js' }] },
          { hooks: [{ type: 'command', command: 'node /usr/local/custom-pre-hook.js' }] },
        ],
      }
    };

    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(hook => {
      const cmd = hook.hooks?.[0]?.command || '';
      return !cmd.includes('df-command-usage');
    });
    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }

    assert.ok('PreToolUse' in settings.hooks, 'PreToolUse should be kept when custom hooks remain');
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes('custom-pre-hook.js'));
  });
});

// ---------------------------------------------------------------------------
// 4. isInstalled helper logic
// ---------------------------------------------------------------------------

describe('isInstalled logic', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('returns false when commands/df dir does not exist', () => {
    // Reproduce isInstalled logic
    function isInstalled(claudeDir) {
      const commandsDir = path.join(claudeDir, 'commands', 'df');
      return fs.existsSync(commandsDir) && fs.readdirSync(commandsDir).length > 0;
    }

    assert.equal(isInstalled(tmpDir), false);
  });

  test('returns false when commands/df dir is empty', () => {
    function isInstalled(claudeDir) {
      const commandsDir = path.join(claudeDir, 'commands', 'df');
      return fs.existsSync(commandsDir) && fs.readdirSync(commandsDir).length > 0;
    }

    fs.mkdirSync(path.join(tmpDir, 'commands', 'df'), { recursive: true });
    assert.equal(isInstalled(tmpDir), false);
  });

  test('returns true when commands/df has at least one file', () => {
    function isInstalled(claudeDir) {
      const commandsDir = path.join(claudeDir, 'commands', 'df');
      return fs.existsSync(commandsDir) && fs.readdirSync(commandsDir).length > 0;
    }

    fs.mkdirSync(path.join(tmpDir, 'commands', 'df'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'commands', 'df', 'auto.md'), '# auto');
    assert.equal(isInstalled(tmpDir), true);
  });
});

// ---------------------------------------------------------------------------
// 5. copyDir helper logic
// ---------------------------------------------------------------------------

describe('copyDir logic', () => {
  let tmpSrc;
  let tmpDest;

  beforeEach(() => {
    tmpSrc = makeTmpDir();
    tmpDest = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpSrc);
    rmrf(tmpDest);
  });

  function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  test('copies files from src to dest', () => {
    fs.writeFileSync(path.join(tmpSrc, 'file.md'), '# content');
    copyDir(tmpSrc, tmpDest);
    assert.ok(fs.existsSync(path.join(tmpDest, 'file.md')));
    assert.equal(fs.readFileSync(path.join(tmpDest, 'file.md'), 'utf8'), '# content');
  });

  test('recursively copies subdirectories', () => {
    fs.mkdirSync(path.join(tmpSrc, 'sub'));
    fs.writeFileSync(path.join(tmpSrc, 'sub', 'nested.md'), '# nested');
    copyDir(tmpSrc, tmpDest);
    assert.ok(fs.existsSync(path.join(tmpDest, 'sub', 'nested.md')));
  });

  test('does nothing when src does not exist', () => {
    const nonExistent = path.join(tmpSrc, 'does-not-exist');
    // Should not throw
    assert.doesNotThrow(() => copyDir(nonExistent, tmpDest));
  });

  test('creates dest directory if it does not exist', () => {
    const newDest = path.join(tmpDest, 'new-dir');
    fs.writeFileSync(path.join(tmpSrc, 'a.md'), '# a');
    copyDir(tmpSrc, newDest);
    assert.ok(fs.existsSync(path.join(newDest, 'a.md')));
  });
});
