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

  // Copy hooks (global only - statusline requires global settings)
  if (level === 'global') {
    const hooksDir = path.join(PACKAGE_DIR, 'hooks');
    if (fs.existsSync(hooksDir)) {
      for (const file of fs.readdirSync(hooksDir)) {
        if (file.endsWith('.js')) {
          fs.copyFileSync(
            path.join(hooksDir, file),
            path.join(CLAUDE_DIR, 'hooks', file)
          );
        }
      }
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
  if (level === 'global') {
    console.log('  hooks/           — statusline, update checker, invariant checker, worktree guard');
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

async function configureHooks(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const statuslineCmd = `node "${path.join(claudeDir, 'hooks', 'df-statusline.js')}"`;
  const updateCheckCmd = `node "${path.join(claudeDir, 'hooks', 'df-check-update.js')}"`;
  const quotaLoggerCmd = `node "${path.join(claudeDir, 'hooks', 'df-quota-logger.js')}"`;
  const toolUsageCmd = `node "${path.join(claudeDir, 'hooks', 'df-tool-usage.js')}"`;
  const dashboardPushCmd = `node "${path.join(claudeDir, 'hooks', 'df-dashboard-push.js')}"`;
  const executionHistoryCmd = `node "${path.join(claudeDir, 'hooks', 'df-execution-history.js')}"`;
  const worktreeGuardCmd = `node "${path.join(claudeDir, 'hooks', 'df-worktree-guard.js')}"`;
  const snapshotGuardCmd = `node "${path.join(claudeDir, 'hooks', 'df-snapshot-guard.js')}"`;
  const invariantCheckCmd = `node "${path.join(claudeDir, 'hooks', 'df-invariant-check.js')}"`;
  const subagentRegistryCmd = `node "${path.join(claudeDir, 'hooks', 'df-subagent-registry.js')}"`;

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

  // Configure statusline
  if (settings.statusLine) {
    if (process.stdin.isTTY) {
      const answer = await ask(
        `  ${c.yellow}!${c.reset} Existing statusLine found. Replace with deepflow? [y/N] `
      );
      if (answer.toLowerCase() === 'y') {
        settings.statusLine = { type: 'command', command: statuslineCmd };
        log('Statusline configured');
      } else {
        console.log(`  ${c.yellow}!${c.reset} Skipped statusline configuration`);
      }
    } else {
      // Non-interactive (e.g. Claude Code bash tool) — skip prompt, keep existing
      console.log(`  ${c.yellow}!${c.reset} Existing statusLine found — kept (non-interactive mode)`);
    }
  } else {
    settings.statusLine = { type: 'command', command: statuslineCmd };
    log('Statusline configured');
  }

  // Configure SessionStart hook for update checking
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  // Remove any existing deepflow update check / quota logger hooks from SessionStart
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(hook => {
    const cmd = hook.hooks?.[0]?.command || '';
    return !cmd.includes('df-check-update') && !cmd.includes('df-quota-logger');
  });

  // Add update check hook
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: updateCheckCmd
    }]
  });

  // Add quota logger to SessionStart
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: quotaLoggerCmd
    }]
  });
  log('SessionStart hook configured');

  // Configure SessionEnd hook for quota logging
  if (!settings.hooks.SessionEnd) {
    settings.hooks.SessionEnd = [];
  }

  // Remove any existing quota logger / dashboard push from SessionEnd
  settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(hook => {
    const cmd = hook.hooks?.[0]?.command || '';
    return !cmd.includes('df-quota-logger') && !cmd.includes('df-dashboard-push');
  });

  // Add quota logger to SessionEnd
  settings.hooks.SessionEnd.push({
    hooks: [{
      type: 'command',
      command: quotaLoggerCmd
    }]
  });

  // Add dashboard push to SessionEnd (fire-and-forget, skips when dashboard_url unset)
  settings.hooks.SessionEnd.push({
    hooks: [{
      type: 'command',
      command: dashboardPushCmd
    }]
  });
  log('Quota logger + dashboard push configured (SessionEnd)');

  // Configure PostToolUse hook for tool usage instrumentation
  if (!settings.hooks.PostToolUse) {
    settings.hooks.PostToolUse = [];
  }

  // Remove any existing deepflow tool usage / execution history / worktree guard / snapshot guard / invariant check hooks from PostToolUse
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(hook => {
    const cmd = hook.hooks?.[0]?.command || '';
    return !cmd.includes('df-tool-usage') && !cmd.includes('df-execution-history') && !cmd.includes('df-worktree-guard') && !cmd.includes('df-snapshot-guard') && !cmd.includes('df-invariant-check');
  });

  // Add tool usage hook
  settings.hooks.PostToolUse.push({
    hooks: [{
      type: 'command',
      command: toolUsageCmd
    }]
  });

  // Add execution history hook
  settings.hooks.PostToolUse.push({
    hooks: [{
      type: 'command',
      command: executionHistoryCmd
    }]
  });

  // Add worktree guard hook (blocks Write/Edit to main-branch files when df/* worktree exists)
  settings.hooks.PostToolUse.push({
    hooks: [{
      type: 'command',
      command: worktreeGuardCmd
    }]
  });

  // Add snapshot guard hook (blocks Write/Edit to ratchet-baseline files in auto-snapshot.txt)
  settings.hooks.PostToolUse.push({
    hooks: [{
      type: 'command',
      command: snapshotGuardCmd
    }]
  });

  // Add invariant check hook (exits 1 on hard failures after git commit)
  settings.hooks.PostToolUse.push({
    hooks: [{
      type: 'command',
      command: invariantCheckCmd
    }]
  });
  log('PostToolUse hook configured');

  // Configure SubagentStop hook for subagent registry
  if (!settings.hooks.SubagentStop) {
    settings.hooks.SubagentStop = [];
  }

  // Remove any existing subagent registry hooks
  settings.hooks.SubagentStop = settings.hooks.SubagentStop.filter(hook => {
    const cmd = hook.hooks?.[0]?.command || '';
    return !cmd.includes('df-subagent-registry');
  });

  // Add subagent registry hook
  settings.hooks.SubagentStop.push({
    hooks: [{
      type: 'command',
      command: subagentRegistryCmd
    }]
  });
  log('SubagentStop hook configured');

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
    'agents/reasoner.md'
  ];

  if (level === 'global') {
    toRemove.push('hooks/df-statusline.js', 'hooks/df-check-update.js', 'hooks/df-invariant-check.js', 'hooks/df-quota-logger.js', 'hooks/df-tool-usage.js', 'hooks/df-dashboard-push.js', 'hooks/df-execution-history.js', 'hooks/df-worktree-guard.js', 'hooks/df-snapshot-guard.js', 'hooks/df-subagent-registry.js');
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

  // Remove SessionStart hook from settings
  if (level === 'global') {
    const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.hooks?.SessionStart) {
          settings.hooks.SessionStart = settings.hooks.SessionStart.filter(hook => {
            const cmd = hook.hooks?.[0]?.command || '';
            return !cmd.includes('df-check-update') && !cmd.includes('df-quota-logger');
          });
          if (settings.hooks.SessionStart.length === 0) {
            delete settings.hooks.SessionStart;
          }
        }
        if (settings.hooks?.SessionEnd) {
          settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(hook => {
            const cmd = hook.hooks?.[0]?.command || '';
            return !cmd.includes('df-quota-logger') && !cmd.includes('df-dashboard-push');
          });
          if (settings.hooks.SessionEnd.length === 0) {
            delete settings.hooks.SessionEnd;
          }
        }
        if (settings.hooks?.PostToolUse) {
          settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(hook => {
            const cmd = hook.hooks?.[0]?.command || '';
            return !cmd.includes('df-tool-usage') && !cmd.includes('df-execution-history') && !cmd.includes('df-worktree-guard') && !cmd.includes('df-snapshot-guard') && !cmd.includes('df-invariant-check');
          });
          if (settings.hooks.PostToolUse.length === 0) {
            delete settings.hooks.PostToolUse;
          }
        }
        if (settings.hooks?.SubagentStop) {
          settings.hooks.SubagentStop = settings.hooks.SubagentStop.filter(hook => {
            const cmd = hook.hooks?.[0]?.command || '';
            return !cmd.includes('df-subagent-registry');
          });
          if (settings.hooks.SubagentStop.length === 0) {
            delete settings.hooks.SubagentStop;
          }
        }
        if (settings.hooks && Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log(`  ${c.green}✓${c.reset} Removed SessionStart/SessionEnd/PostToolUse/SubagentStop hooks`);
      } catch (e) {
        // Fail silently
      }
    }

    // Remove ENABLE_LSP_TOOL and deepflow permissions from global settings
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.env?.ENABLE_LSP_TOOL) {
          delete settings.env.ENABLE_LSP_TOOL;
          if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
          console.log(`  ${c.green}✓${c.reset} Removed ENABLE_LSP_TOOL from settings`);
        }
        if (settings.permissions?.allow) {
          const dfPerms = new Set(DEEPFLOW_PERMISSIONS);
          settings.permissions.allow = settings.permissions.allow.filter(p => !dfPerms.has(p));
          if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
          if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions;
          console.log(`  ${c.green}✓${c.reset} Removed deepflow permissions from settings`);
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
          fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));
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

main().catch(err => {
  console.error('Installation failed:', err.message);
  process.exit(1);
});
