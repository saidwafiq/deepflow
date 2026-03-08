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

// Subcommand routing: `deepflow auto [...]` -> claude --agent .claude/agents/deepflow-auto.md
if (process.argv[2] === 'auto') {
  if (!process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
    console.error('Error: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS environment variable is not set.');
    console.error('');
    console.error('The `deepflow auto` command now uses Claude Code Agent Teams.');
    console.error('To enable it, set the environment variable before running:');
    console.error('');
    console.error('  export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
    console.error('  deepflow auto');
    console.error('');
    process.exit(1);
  }
  try {
    execFileSync('claude', ['--agent', '.claude/agents/deepflow-auto.md', '-p', 'Run the full autonomous cycle now. Auto-promote unprefixed specs to doing-*, then process all doing-* specs through every phase. Do not ask questions — act autonomously.', ...process.argv.slice(3)], { stdio: 'inherit' });
  } catch (e) {
    process.exit(e.status || 1);
  }
  process.exit(0);
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

  // deepflow-auto.sh has been archived; auto mode now uses Agent Teams
  // via `claude --agent .claude/agents/deepflow-auto.md`

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
  console.log('  commands/df/     — /df:discover, /df:debate, /df:spec, /df:plan, /df:execute, /df:verify, /df:note, /df:resume, /df:update');
  console.log('  skills/          — gap-discovery, atomic-commits, code-completeness');
  console.log('  agents/          — reasoner, deepflow-auto (autonomous overnight execution)');
  if (level === 'global') {
    console.log('  hooks/           — statusline, update checker');
  }
  console.log('  hooks/df-spec-*  — spec validation (auto-enforced by /df:spec and /df:plan)');
  console.log('  env/             — ENABLE_LSP_TOOL (code navigation via goToDefinition, findReferences, workspaceSymbol)');
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
  const consolidationCheckCmd = `node "${path.join(claudeDir, 'hooks', 'df-consolidation-check.js')}"`;

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

  // Configure statusline
  if (settings.statusLine) {
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

  // Remove any existing deepflow update check hooks
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(hook => {
    const cmd = hook.hooks?.[0]?.command || '';
    return !cmd.includes('df-check-update') && !cmd.includes('df-consolidation-check');
  });

  // Add update check hook
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: updateCheckCmd
    }]
  });

  // Add consolidation check hook
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: consolidationCheckCmd
    }]
  });
  log('SessionStart hook configured');

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

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log('LSP tool enabled (project)');
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
    'agents/reasoner.md',
    'agents/deepflow-auto.md'
  ];

  if (level === 'global') {
    toRemove.push('hooks/df-statusline.js', 'hooks/df-check-update.js', 'hooks/df-consolidation-check.js');
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
            return !cmd.includes('df-check-update') && !cmd.includes('df-consolidation-check');
          });
          if (settings.hooks.SessionStart.length === 0) {
            delete settings.hooks.SessionStart;
          }
          if (Object.keys(settings.hooks).length === 0) {
            delete settings.hooks;
          }
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          console.log(`  ${c.green}✓${c.reset} Removed SessionStart hook`);
        }
      } catch (e) {
        // Fail silently
      }
    }

    // Remove ENABLE_LSP_TOOL from global settings
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.env?.ENABLE_LSP_TOOL) {
          delete settings.env.ENABLE_LSP_TOOL;
          if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          console.log(`  ${c.green}✓${c.reset} Removed ENABLE_LSP_TOOL from settings`);
        }
      } catch (e) {
        // Fail silently
      }
    }
  }

  // Remove ENABLE_LSP_TOOL from project settings.local.json
  if (level === 'project') {
    const localSettingsPath = path.join(PROJECT_DIR, 'settings.local.json');
    if (fs.existsSync(localSettingsPath)) {
      try {
        const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
        if (localSettings.env?.ENABLE_LSP_TOOL) {
          delete localSettings.env.ENABLE_LSP_TOOL;
          if (localSettings.env && Object.keys(localSettings.env).length === 0) delete localSettings.env;
          if (Object.keys(localSettings).length === 0) {
            fs.unlinkSync(localSettingsPath);
            console.log(`  ${c.green}✓${c.reset} Removed settings.local.json (empty after cleanup)`);
          } else {
            fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));
            console.log(`  ${c.green}✓${c.reset} Removed ENABLE_LSP_TOOL from settings.local.json`);
          }
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
