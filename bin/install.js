#!/usr/bin/env node
/**
 * deepflow installer
 * Usage: npx deepflow
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

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

async function main() {
  // Handle --uninstall flag
  if (process.argv.includes('--uninstall')) {
    return uninstall();
  }

  console.log('');
  console.log(`${c.cyan}deepflow installer${c.reset}`);
  console.log('');

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

  // Configure statusline (global only)
  if (level === 'global') {
    await configureStatusline(CLAUDE_DIR);
  }

  console.log('');
  console.log(`${c.green}Installation complete!${c.reset}`);
  console.log('');
  console.log(`Installed to ${c.cyan}${CLAUDE_DIR}${c.reset}:`);
  console.log('  commands/df/     — /df:spec, /df:plan, /df:execute, /df:verify');
  console.log('  skills/          — gap-discovery, atomic-commits, code-completeness');
  console.log('  agents/          — reasoner');
  if (level === 'global') {
    console.log('  hooks/           — statusline, update checker');
  }
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
  console.log('  3. /df:spec feature-name');
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

async function configureStatusline(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hookCmd = `node "${path.join(claudeDir, 'hooks', 'df-statusline.js')}"`;

  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settings = {};
    }

    if (settings.statusLine) {
      const answer = await ask(
        `  ${c.yellow}!${c.reset} Existing statusLine found. Replace with deepflow? [y/N] `
      );
      if (answer.toLowerCase() !== 'y') {
        console.log(`  ${c.yellow}!${c.reset} Skipped statusline configuration`);
        return;
      }
    }
  }

  settings.statusLine = {
    type: 'command',
    command: hookCmd
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log('Statusline configured');
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
    'agents/reasoner.md'
  ];

  if (level === 'global') {
    toRemove.push('hooks/df-statusline.js', 'hooks/df-check-update.js');
  }

  for (const item of toRemove) {
    const fullPath = path.join(CLAUDE_DIR, item);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true });
      console.log(`  ${c.green}✓${c.reset} Removed ${item}`);
    }
  }

  // Clear update cache
  const cacheFile = path.join(GLOBAL_DIR, 'cache', 'df-update-check.json');
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
  }

  console.log('');
  console.log(`${c.green}Uninstall complete.${c.reset}`);
  console.log('');
}

main().catch(err => {
  console.error('Installation failed:', err.message);
  process.exit(1);
});
