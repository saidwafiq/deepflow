#!/usr/bin/env node
// CLI entry point — no external deps, manual arg parsing

import { createRequire } from 'module';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createServer } from 'net';

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

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`
deepflow-dashboard — analytics dashboard for Claude Code

Usage:
  npx deepflow-dashboard              Start local dashboard (default)
  npx deepflow-dashboard local        Start local dashboard
  npx deepflow-dashboard serve        Start team server
  npx deepflow-dashboard backfill     Backfill remote server with local data

Options:
  --port <n>      Port to listen on (env: DASHBOARD_PORT, default: 3333)
  --url <url>     Remote server URL (for backfill)
  --help          Show this help
`);
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
    console.error(`Unknown subcommand: ${subcommand}`);
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
