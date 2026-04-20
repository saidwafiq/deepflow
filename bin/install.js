#!/usr/bin/env node
/**
 * deepflow installer
 * Usage: npx deepflow
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { scanHookEvents, removeDeepflowHooks } = require('../hooks/lib/installer-utils');

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

// Legacy subcommand: `deepflow auto` is now `/df:auto` inside Claude Code
if (process.argv[2] === 'auto') {
  console.error('`deepflow auto` has moved inside Claude Code for better visibility.');
  console.error('');
  console.error('Usage:');
  console.error('  1. Open Claude Code: claude');
  console.error('  2. Run: /df:auto');
  console.error('');
  process.exit(1);
}

// Colors
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

// Paths
const GLOBAL_DIR = path.join(os.homedir(), '.claude');
const PROJECT_DIR = path.join(process.cwd(), '.claude');
const PACKAGE_DIR = path.resolve(__dirname, '..');

function updateGlobalPackage() {
  const currentVersion = require(path.join(PACKAGE_DIR, 'package.json')).version;
  try {
    const globalPkgPath = execFileSync('node', ['-e',
      "try{console.log(require(require('path').join(require('child_process').execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'deepflow','package.json')).version)}catch(e){console.log('')}"
    ], { encoding: 'utf8' }).trim();

    if (globalPkgPath && globalPkgPath !== currentVersion) {
      console.log(`Updating global npm package (${globalPkgPath} → ${currentVersion})...`);
      execFileSync('npm', ['install', '-g', `deepflow@${currentVersion}`], { stdio: 'inherit' });
      console.log('');
    }
  } catch (e) {
    // No global installation or npm not available - skip silently
  }
}

async function main() {
  // Handle --uninstall flag
  if (process.argv.includes('--uninstall')) {
    return uninstall();
  }

  console.log('');
  console.log(`${c.cyan}deepflow installer${c.reset}`);
  console.log('');

  // Update global npm package if stale
  updateGlobalPackage();

  // Detect existing installations
  const globalInstalled = isInstalled(GLOBAL_DIR);
  const projectInstalled = isInstalled(PROJECT_DIR);

  let level;

  if (globalInstalled && projectInstalled) {
    // Both installed - ask which to update
    console.log(`${c.yellow}!${c.reset} Found installations in both locations:`);
    console.log(`  Global:  ${GLOBAL_DIR}`);
    console.log(`  Project: ${PROJECT_DIR}`);
    console.log('');
    level = await askInstallLevel('Which do you want to update?');
  } else if (globalInstalled) {
    // Only global - update it
    console.log(`Updating global installation...`);
    level = 'global';
  } else if (projectInstalled) {
    // Only project - update it
    console.log(`Updating project installation...`);
    level = 'project';
  } else {
    // Fresh install - ask
    level = await askInstallLevel('Where do you want to install deepflow?');
  }

  const CLAUDE_DIR = level === 'global' ? GLOBAL_DIR : PROJECT_DIR;
  const levelLabel = level === 'global' ? 'globally' : 'in this project';

  console.log('');
  console.log(`Installing ${levelLabel}...`);
  console.log('');

  // Create directories
  const dirs = [
    'commands/df',
    'skills',
    'agents'
  ];

  if (level === 'global') {
    dirs.push('hooks');
  }

  for (const dir of dirs) {
    fs.mkdirSync(path.join(CLAUDE_DIR, dir), { recursive: true });
  }

  // Copy commands
  copyDir(
    path.join(PACKAGE_DIR, 'src', 'commands', 'df'),
    path.join(CLAUDE_DIR, 'commands', 'df')
  );
  log('Commands installed');

  // Copy skills
  copyDir(
    path.join(PACKAGE_DIR, 'src', 'skills'),
    path.join(CLAUDE_DIR, 'skills')
  );
  log('Skills installed');

  // Copy agents
  copyDir(
    path.join(PACKAGE_DIR, 'src', 'agents'),
    path.join(CLAUDE_DIR, 'agents')
  );
  log('Agents installed');

  // Copy templates (explore-protocol, explore-agent, etc.)
  copyDir(
    path.join(PACKAGE_DIR, 'templates'),
    path.join(CLAUDE_DIR, 'templates')
  );
  log('Templates installed');

  // Copy bin utilities (plan-consolidator, wave-runner, ratchet)
  const binDest = path.join(CLAUDE_DIR, 'bin');
  fs.mkdirSync(binDest, { recursive: true });
  for (const script of ['plan-consolidator.js', 'prompt-compose.js', 'wave-runner.js', 'ratchet.js', 'worktree-deps.js']) {
    const src = path.join(PACKAGE_DIR, 'bin', script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(binDest, script));
    }
  }
  log('Bin utilities installed');

  // Copy hooks (global only - statusline requires global settings)
  if (level === 'global') {
    const hooksDir = path.join(PACKAGE_DIR, 'hooks');
    if (fs.existsSync(hooksDir)) {
      const copyDirRecursive = (srcDir, destDir) => {
        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const subDest = path.join(destDir, entry.name);
            fs.mkdirSync(subDest, { recursive: true });
            copyDirRecursive(path.join(srcDir, entry.name), subDest);
          } else if (entry.name.endsWith('.js')) {
            fs.copyFileSync(
              path.join(srcDir, entry.name),
              path.join(destDir, entry.name)
            );
          }
        }
      };
      copyDirRecursive(hooksDir, path.join(CLAUDE_DIR, 'hooks'));
      log('Hooks installed');
    }
  }

  // Get version from package.json (single source of truth)
  const packageJson = require(path.join(PACKAGE_DIR, 'package.json'));
  const installedVersion = packageJson.version;

  // Update cache to reflect installed version (prevents stale "update available" message)
  const cacheDir = path.join(GLOBAL_DIR, 'cache');
  const cacheFile = path.join(cacheDir, 'df-update-check.json');
  if (installedVersion) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      updateAvailable: false,
      currentVersion: installedVersion,
      latestVersion: installedVersion,
      timestamp: Date.now()
    }, null, 2));
  } else if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
  }

  // Configure hooks (global only)
  if (level === 'global') {
    await configureHooks(CLAUDE_DIR);
  }

  // Configure project settings (project only)
  if (level === 'project') {
    configureProjectSettings(CLAUDE_DIR);
  }

  console.log('');
  console.log(`${c.green}Installation complete!${c.reset}`);
  console.log('');
  console.log(`Installed to ${c.cyan}${CLAUDE_DIR}${c.reset}:`);
  console.log('  commands/df/     — /df:discover, /df:debate, /df:spec, /df:plan, /df:execute, /df:verify, /df:auto, /df:update');
  console.log('  skills/          — gap-discovery, atomic-commits, code-completeness, browse-fetch, browse-verify, auto-cycle');
  console.log('  agents/          — reasoner (/df:auto — autonomous execution via /loop)');
  console.log('  bin/             — plan-consolidator, prompt-compose, wave-runner, ratchet, worktree-deps');
  console.log('  templates/       — explore-protocol (auto-injected into Explore agents via hook)');
  if (level === 'global') {
    console.log('  hooks/           — statusline, update checker, invariant checker, worktree guard, explore protocol, implement protocol, verify protocol');
  }
  console.log('  hooks/df-spec-*  — spec validation (auto-enforced by /df:spec and /df:plan)');
  console.log('  env/             — ENABLE_LSP_TOOL (code navigation via goToDefinition, findReferences, workspaceSymbol)');
  console.log('  permissions/     — granular allow-list for background agents (git, build, test, read/write)');
  console.log('');
  if (level === 'project') {
    console.log(`${c.dim}Note: Statusline is only available with global install.${c.reset}`);
    console.log('');
  }
  console.log('Quick start:');
  if (level === 'global') {
    console.log('  1. cd your-project');
    console.log('  2. claude');
  } else {
    console.log('  1. claude');
  }
  console.log('  2. Describe what you want to build');
  console.log('  3. /df:discover feature-name');
  console.log('');
}

function isInstalled(claudeDir) {
  // Check if deepflow commands exist
  const commandsDir = path.join(claudeDir, 'commands', 'df');
  return fs.existsSync(commandsDir) && fs.readdirSync(commandsDir).length > 0;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;

  const resolvedSrcRoot = path.resolve(src);
  const resolvedDestRoot = path.resolve(dest);

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Reject symlinks to prevent symlink attacks
    if (entry.isSymbolicLink()) {
      process.stderr.write(`[deepflow] skipping symlink: ${srcPath}\n`);
      continue;
    }

    // Guard against path traversal — resolved paths must stay under their roots
    const resolvedSrc = path.resolve(srcPath);
    const resolvedDest = path.resolve(destPath);
    if (!resolvedSrc.startsWith(resolvedSrcRoot + path.sep) && resolvedSrc !== resolvedSrcRoot) {
      process.stderr.write(`[deepflow] skipping path traversal attempt (src): ${srcPath}\n`);
      continue;
    }
    if (!resolvedDest.startsWith(resolvedDestRoot + path.sep) && resolvedDest !== resolvedDestRoot) {
      process.stderr.write(`[deepflow] skipping path traversal attempt (dest): ${destPath}\n`);
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Returns true if settings.json contains any hook commands that reference a
 * dashboard-owned hook file (identified by @hook-owner: dashboard in its source).
 * Checks both settings.hooks.* entries and settings.statusLine.
 */
function detectDashboardHooks(settings, claudeDir) {
  const hooksInstallDir = path.join(claudeDir, 'hooks');
  if (!fs.existsSync(hooksInstallDir)) return false;

  // Collect all command strings currently wired in settings
  const wiredCommands = [];
  if (settings.hooks) {
    for (const entries of Object.values(settings.hooks)) {
      for (const hook of entries) {
        const cmd = hook.hooks?.[0]?.command;
        if (cmd) wiredCommands.push(cmd);
      }
    }
  }
  if (settings.statusLine?.command) {
    wiredCommands.push(settings.statusLine.command);
  }

  // For each wired command, resolve the hook filename and check its @hook-owner
  for (const cmd of wiredCommands) {
    // Commands look like: node "/path/to/.claude/hooks/df-foo.js"
    const match = cmd.match(/["']?([^"'\s]+\.js)["']?\s*$/);
    if (!match) continue;
    const hookPath = match[1];
    if (!fs.existsSync(hookPath)) continue;
    try {
      const content = fs.readFileSync(hookPath, 'utf8');
      const firstLines = content.split('\n').slice(0, 10).join('\n');
      const ownerMatch = firstLines.match(/\/\/\s*@hook-owner:\s*(.+)/);
      if (ownerMatch && ownerMatch[1].trim() === 'dashboard') return true;
    } catch (_) {
      // Skip unreadable files
    }
  }
  return false;
}

async function configureHooks(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hooksSourceDir = path.join(PACKAGE_DIR, 'hooks');

  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settings = {};
    }
  }

  // Enable LSP tool
  if (!settings.env) settings.env = {};
  settings.env.ENABLE_LSP_TOOL = "1";
  log('LSP tool enabled');

  // Configure permissions for background agents
  configurePermissions(settings);
  log('Agent permissions configured');

  // Scan hook files for @hook-event tags — only deepflow-owned hooks
  const { eventMap, untagged } = scanHookEvents(hooksSourceDir, 'deepflow');

  // Remember if there was a pre-existing non-deepflow statusLine
  const hadExternalStatusLine = settings.statusLine &&
    !settings.statusLine.command?.includes('/hooks/df-');

  // Remove all existing deepflow hooks (orphan cleanup + idempotency)
  removeDeepflowHooks(settings);

  // Migration warning: detect dashboard-owned hooks already wired in settings.json
  // (they were installed by an older deepflow version that didn't distinguish owners)
  const hasDashboardHooks = detectDashboardHooks(settings, claudeDir);
  if (hasDashboardHooks) {
    console.log('');
    console.log(`  ${c.yellow}!${c.reset} Dashboard hooks detected — run \`npx deepflow-dashboard install\` to manage them separately.`);
    console.log('');
  }

  // Wire hooks by event
  if (!settings.hooks) settings.hooks = {};

  for (const [event, files] of eventMap) {
    if (event === 'statusLine') {
      // Handle statusLine separately — it's settings.statusLine, not settings.hooks
      const statusFile = files[0]; // Only one statusline hook expected
      const statusCmd = `node "${path.join(claudeDir, 'hooks', statusFile)}"`;

      if (hadExternalStatusLine) {
        if (process.stdin.isTTY) {
          const answer = await ask(
            `  ${c.yellow}!${c.reset} Existing statusLine found. Replace with deepflow? [y/N] `
          );
          if (answer.toLowerCase() === 'y') {
            settings.statusLine = { type: 'command', command: statusCmd };
            log('Statusline configured');
          } else {
            console.log(`  ${c.yellow}!${c.reset} Skipped statusline configuration`);
          }
        } else {
          // Non-interactive (e.g. Claude Code bash tool) — skip prompt, keep existing
          console.log(`  ${c.yellow}!${c.reset} Existing statusLine found — kept (non-interactive mode)`);
        }
      } else {
        settings.statusLine = { type: 'command', command: statusCmd };
        log('Statusline configured');
      }
      continue;
    }

    // Regular hook events
    if (!settings.hooks[event]) settings.hooks[event] = [];

    for (const file of files) {
      const cmd = `node "${path.join(claudeDir, 'hooks', file)}"`;
      settings.hooks[event].push({
        hooks: [{ type: 'command', command: cmd }]
      });
    }
    log(`${event} hook configured`);
  }

  // Log untagged files (copied but not wired)
  for (const file of untagged) {
    console.log(`  ${c.dim}${file} copied (no @hook-event tag — not wired)${c.reset}`);
  }

  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function configureProjectSettings(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settings = {};
    }
  }

  // Enable LSP tool
  if (!settings.env) settings.env = {};
  settings.env.ENABLE_LSP_TOOL = "1";

  // Configure permissions for background agents
  configurePermissions(settings);

  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log('LSP tool enabled + agent permissions configured (project)');
}

// Permissions required for background agents to work without blocking
const DEEPFLOW_PERMISSIONS = [
  // Agents need to read/write code
  "Edit",
  "Write",
  "Read",
  // Agents need to search codebase
  "Glob",
  "Grep",
  // Git operations (orchestrator handles worktrees, agents read status)
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git log:*)",
  "Bash(git stash:*)",
  "Bash(git checkout:*)",
  "Bash(git branch:*)",
  "Bash(git revert:*)",
  "Bash(git worktree:*)",
  "Bash(git ls-files:*)",
  "Bash(git merge:*)",
  // Build & test (ratchet health checks)
  "Bash(npm run build:*)",
  "Bash(npm test:*)",
  "Bash(npm run lint:*)",
  "Bash(npx tsc:*)",
  "Bash(cargo build:*)",
  "Bash(cargo test:*)",
  "Bash(go build:*)",
  "Bash(go test:*)",
  "Bash(pytest:*)",
  "Bash(python -m pytest:*)",
  "Bash(ruff:*)",
  "Bash(mypy:*)",
  // Utility
  "Bash(node:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(mkdir:*)",
  "Bash(date:*)",
  "Bash(wc:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
];

function configurePermissions(settings) {
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const existing = new Set(settings.permissions.allow);
  let added = 0;

  for (const perm of DEEPFLOW_PERMISSIONS) {
    if (!existing.has(perm)) {
      settings.permissions.allow.push(perm);
      added++;
    }
  }
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function askInstallLevel(prompt) {
  if (!process.stdin.isTTY) {
    // Non-interactive — default to global
    console.log(`${c.dim}Non-interactive mode — defaulting to global install${c.reset}`);
    return 'global';
  }
  console.log(prompt);
  console.log('');
  console.log(`  ${c.cyan}1${c.reset}) Global  ${c.dim}(~/.claude/ - available in all projects)${c.reset}`);
  console.log(`  ${c.cyan}2${c.reset}) Project ${c.dim}(./.claude/ - only this project)${c.reset}`);
  console.log('');

  const answer = await ask('Choose [1/2]: ');

  if (answer === '2') {
    return 'project';
  }
  return 'global';
}

function log(msg) {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

async function uninstall() {
  console.log('');
  console.log(`${c.cyan}deepflow uninstaller${c.reset}`);
  console.log('');

  const globalInstalled = isInstalled(GLOBAL_DIR);
  const projectInstalled = isInstalled(PROJECT_DIR);

  if (!globalInstalled && !projectInstalled) {
    console.log('No deepflow installation found.');
    return;
  }

  let level;

  if (globalInstalled && projectInstalled) {
    console.log('Found installations in both locations:');
    console.log(`  Global:  ${GLOBAL_DIR}`);
    console.log(`  Project: ${PROJECT_DIR}`);
    console.log('');
    level = await askInstallLevel('Which do you want to remove?');
  } else if (globalInstalled) {
    level = 'global';
  } else {
    level = 'project';
  }

  const CLAUDE_DIR = level === 'global' ? GLOBAL_DIR : PROJECT_DIR;
  const levelLabel = level === 'global' ? 'global' : 'project';

  if (!process.stdin.isTTY) {
    console.log('Uninstall requires interactive mode. Run from a terminal.');
    return;
  }
  const confirm = await ask(`Remove ${levelLabel} installation from ${CLAUDE_DIR}? [y/N] `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    return;
  }

  console.log('');

  // Remove deepflow files
  const toRemove = [
    'commands/df',
    'skills/atomic-commits',
    'skills/code-completeness',
    'skills/gap-discovery',
    'skills/browse-fetch',
    'skills/browse-verify',
    'agents/reasoner.md',
    'bin/plan-consolidator.js',
    'bin/prompt-compose.js',
    'bin/wave-runner.js',
    'bin/ratchet.js',
    'bin/worktree-deps.js',
    'templates'
  ];

  if (level === 'global') {
    // Dynamically find deepflow-owned hook files to remove.
    // Check @hook-owner tag from the installed file; skip dashboard-owned hooks.
    const hooksDir = path.join(CLAUDE_DIR, 'hooks');
    if (fs.existsSync(hooksDir)) {
      for (const file of fs.readdirSync(hooksDir)) {
        if (!file.startsWith('df-') || !file.endsWith('.js') || file.endsWith('.test.js')) continue;
        const filePath = path.join(hooksDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const firstLines = content.split('\n').slice(0, 10).join('\n');
          const ownerMatch = firstLines.match(/\/\/\s*@hook-owner:\s*(.+)/);
          if (ownerMatch && ownerMatch[1].trim() === 'deepflow') {
            toRemove.push(`hooks/${file}`);
          }
          // dashboard-owned hooks are intentionally left in place
        } catch (_) {
          // Skip unreadable files
        }
      }
    }
    // Remove hooks/lib (shared hook utilities)
    toRemove.push('hooks/lib');
  }

  for (const item of toRemove) {
    const fullPath = path.join(CLAUDE_DIR, item);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true });
      console.log(`  ${c.green}✓${c.reset} Removed ${item}`);
    }
  }

  // Clear update cache and trigger file
  const cacheDir = path.join(GLOBAL_DIR, 'cache');
  for (const file of ['df-update-check.json', 'df-trigger-time']) {
    const filePath = path.join(cacheDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Remove hook entries and settings from global settings.json
  if (level === 'global') {
    const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        // Remove all deepflow hook wiring dynamically
        removeDeepflowHooks(settings);
        console.log(`  ${c.green}✓${c.reset} Removed deepflow hooks from settings`);

        // Remove ENABLE_LSP_TOOL
        if (settings.env?.ENABLE_LSP_TOOL) {
          delete settings.env.ENABLE_LSP_TOOL;
          if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
          console.log(`  ${c.green}✓${c.reset} Removed ENABLE_LSP_TOOL from settings`);
        }

        // Remove deepflow permissions
        if (settings.permissions?.allow) {
          const dfPerms = new Set(DEEPFLOW_PERMISSIONS);
          settings.permissions.allow = settings.permissions.allow.filter(p => !dfPerms.has(p));
          if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
          if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions;
          console.log(`  ${c.green}✓${c.reset} Removed deepflow permissions from settings`);
        }

        atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
      } catch (e) {
        // Fail silently
      }
    }
  }

  // Remove ENABLE_LSP_TOOL and deepflow permissions from project settings.local.json
  if (level === 'project') {
    const localSettingsPath = path.join(PROJECT_DIR, 'settings.local.json');
    if (fs.existsSync(localSettingsPath)) {
      try {
        const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
        if (localSettings.env?.ENABLE_LSP_TOOL) {
          delete localSettings.env.ENABLE_LSP_TOOL;
          if (localSettings.env && Object.keys(localSettings.env).length === 0) delete localSettings.env;
        }
        if (localSettings.permissions?.allow) {
          const dfPerms = new Set(DEEPFLOW_PERMISSIONS);
          localSettings.permissions.allow = localSettings.permissions.allow.filter(p => !dfPerms.has(p));
          if (localSettings.permissions.allow.length === 0) delete localSettings.permissions.allow;
          if (localSettings.permissions && Object.keys(localSettings.permissions).length === 0) delete localSettings.permissions;
        }
        if (Object.keys(localSettings).length === 0) {
          fs.unlinkSync(localSettingsPath);
          console.log(`  ${c.green}✓${c.reset} Removed settings.local.json (empty after cleanup)`);
        } else {
          atomicWriteFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));
          console.log(`  ${c.green}✓${c.reset} Removed deepflow settings from settings.local.json`);
        }
      } catch (e) {
        // Fail silently
      }
    }
  }

  console.log('');
  console.log(`${c.green}Uninstall complete.${c.reset}`);
  console.log('');
}

// Export for testing
module.exports = { scanHookEvents, removeDeepflowHooks, atomicWriteFileSync };

// Only run main when executed directly (not when required by tests)
if (require.main === module) {
  main().catch(err => {
    console.error('Installation failed:', err.message);
    process.exit(1);
  });
}
