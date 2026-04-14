#!/usr/bin/env node
// CLI entry point — no external deps, manual arg parsing

import { createRequire } from 'module';
import { join, dirname } from 'path';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load CJS installer-utils via createRequire (package is ESM but installer-utils is CJS)
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);

// Resolve subcommand: first non-flag arg, default to 'local'
const subcommand = args.find((a) => !a.startsWith('-')) ?? 'local';

function getFlag(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

/** Check if a port is free; returns true if free */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

/** Find an available port starting from preferred */
async function resolvePort(preferred) {
  const start = parseInt(preferred, 10);
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found starting from ${start}`);
}

async function loadConfig() {
  // Try .deepflow/config.yaml in cwd — best-effort, no hard dep on yaml parser
  return {};
}

/** Path to the global ~/.claude/settings.json */
const GLOBAL_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** Source directory for dashboard hook files (bundled alongside cli.js) */
const DASHBOARD_HOOKS_SRC = join(__dirname, '..', 'hooks');

/** Install destination for hooks in ~/.claude/hooks/ */
const GLOBAL_HOOKS_DIR = join(homedir(), '.claude', 'hooks');

/** Read settings.json, returning {} on missing/invalid */
function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * Remove all dashboard-owned hook entries from settings.
 * Identifies hooks by checking the @hook-owner: dashboard tag in the installed file.
 * Preserves deepflow hooks and any non-dashboard hooks.
 */
function removeDashboardHooks(settings) {
  const isDashboardHook = (hook) => {
    const cmd = hook.hooks?.[0]?.command || '';
    // Extract JS file path from command string like: node "/path/to/file.js"
    const match = cmd.match(/["']?([^"'\s]+\.js)["']?\s*$/);
    if (!match) return false;
    const hookPath = match[1];
    if (!existsSync(hookPath)) return false;
    try {
      const content = readFileSync(hookPath, 'utf8');
      const firstLines = content.split('\n').slice(0, 10).join('\n');
      const ownerMatch = firstLines.match(/\/\/\s*@hook-owner:\s*(.+)/);
      return ownerMatch && ownerMatch[1].trim() === 'dashboard';
    } catch (_) {
      return false;
    }
  };

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(h => !isDashboardHook(h));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  // statusLine: remove if dashboard-owned
  if (settings.statusLine?.command) {
    const match = settings.statusLine.command.match(/["']?([^"'\s]+\.js)["']?\s*$/);
    if (match) {
      const hookPath = match[1];
      try {
        const content = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
        const firstLines = content.split('\n').slice(0, 10).join('\n');
        const ownerMatch = firstLines.match(/\/\/\s*@hook-owner:\s*(.+)/);
        if (ownerMatch && ownerMatch[1].trim() === 'dashboard') {
          delete settings.statusLine;
        }
      } catch (_) {}
    }
  }
}

async function installDashboardHooks() {
  const { atomicWriteFileSync, scanHookEvents } = require('../hooks/lib/installer-utils.js');

  // Copy hook files to ~/.claude/hooks/
  mkdirSync(GLOBAL_HOOKS_DIR, { recursive: true });

  const { eventMap, untagged } = scanHookEvents(DASHBOARD_HOOKS_SRC, 'dashboard');

  // Collect all dashboard hook filenames that will be installed
  const allFiles = new Set();
  for (const files of eventMap.values()) {
    for (const f of files) allFiles.add(f);
  }
  for (const f of untagged) allFiles.add(f);

  // Copy hook source files (skip lib/ subdirectory — it's shared utilities)
  for (const file of allFiles) {
    const src = join(DASHBOARD_HOOKS_SRC, file);
    if (existsSync(src)) {
      copyFileSync(src, join(GLOBAL_HOOKS_DIR, file));
    }
  }

  // Also copy hook-stdin.js (runtime dep for dashboard hooks, no @hook-event tag)
  const hooksLibSrc = join(DASHBOARD_HOOKS_SRC, 'lib');
  const hooksLibDest = join(GLOBAL_HOOKS_DIR, 'lib');
  if (existsSync(hooksLibSrc)) {
    mkdirSync(hooksLibDest, { recursive: true });
    for (const file of readdirSync(hooksLibSrc)) {
      if (file.endsWith('.js') && !file.endsWith('.test.js')) {
        copyFileSync(join(hooksLibSrc, file), join(hooksLibDest, file));
      }
    }
  }

  // Wire hooks into settings.json — merge with existing, no duplicates
  const settings = readSettings(GLOBAL_SETTINGS_PATH);

  // Remove existing dashboard hooks first (idempotency + orphan cleanup)
  removeDashboardHooks(settings);

  if (!settings.hooks) settings.hooks = {};

  for (const [event, files] of eventMap) {
    if (event === 'statusLine') {
      const statusFile = files[0];
      const cmd = `node "${join(GLOBAL_HOOKS_DIR, statusFile)}"`;
      settings.statusLine = { type: 'command', command: cmd };
      console.log('  dashboard statusLine configured');
      continue;
    }

    if (!settings.hooks[event]) settings.hooks[event] = [];
    for (const file of files) {
      const cmd = `node "${join(GLOBAL_HOOKS_DIR, file)}"`;
      settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd }] });
    }
    console.log(`  ${event} hook configured`);
  }

  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  atomicWriteFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log('');
  console.log('deepflow-dashboard hooks installed.');
}

async function uninstallDashboardHooks() {
  const { atomicWriteFileSync } = require('../hooks/lib/installer-utils.js');

  if (!existsSync(GLOBAL_SETTINGS_PATH)) {
    console.log('No settings.json found — nothing to remove.');
    return;
  }

  const settings = readSettings(GLOBAL_SETTINGS_PATH);
  removeDashboardHooks(settings);

  atomicWriteFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('deepflow-dashboard hooks removed from settings.json.');
  console.log('Hook files in ~/.claude/hooks/ are left in place.');
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`
deepflow-dashboard — analytics dashboard for Claude Code

Usage:
  npx deepflow-dashboard              Start local dashboard (default)
  npx deepflow-dashboard local        Start local dashboard
  npx deepflow-dashboard serve        Start team server
  npx deepflow-dashboard backfill     Backfill remote server with local data
  npx deepflow-dashboard install      Install dashboard telemetry hooks
  npx deepflow-dashboard uninstall    Remove dashboard telemetry hooks

Options:
  --port <n>      Port to listen on (env: DASHBOARD_PORT, default: 3333)
  --url <url>     Remote server URL (for backfill)
  --help          Show this help
`);
    process.exit(0);
  }

  if (subcommand === 'install') {
    await installDashboardHooks();
    process.exit(0);
  }

  if (subcommand === 'uninstall') {
    await uninstallDashboardHooks();
    process.exit(0);
  }

  if (subcommand === 'backfill') {
    const url = getFlag('--url');
    if (!url) {
      console.error('backfill requires --url <server>');
      process.exit(1);
    }
    const { runBackfill } = await import('../dist/backfill.js').catch(async () => {
      const { runBackfill } = await import('../src/backfill.ts');
      return { runBackfill };
    });
    await runBackfill({ url });
    process.exit(0);
  }

  if (subcommand !== 'local' && subcommand !== 'serve') {
    console.error(`Unknown subcommand: ${subcommand}. Run with --help for usage.`);
    process.exit(1);
  }

  const config = await loadConfig();

  // Port priority: --port > DASHBOARD_PORT env > config > 3333
  const preferredPort =
    getFlag('--port') ??
    process.env.DASHBOARD_PORT ??
    config.dev_port ??
    3333;

  const port = await resolvePort(preferredPort);

  // Dynamic import so TypeScript source can be compiled separately
  const { startServer } = await import('../dist/server.js').catch(async () => {
    // Fallback: try tsx / ts-node for dev use
    const { startServer } = await import('../src/server.ts');
    return { startServer };
  });

  await startServer({ mode: subcommand, port });
}

main().catch((err) => {
  console.error('[deepflow-dashboard] fatal:', err.message);
  process.exit(1);
});
