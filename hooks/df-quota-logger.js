#!/usr/bin/env node
/**
 * deepflow quota logger
 * Logs Anthropic API quota/usage data to ~/.claude/quota-history.jsonl
 * Runs on SessionStart and SessionEnd events.
 * Exits silently (code 0) on non-macOS or when Keychain token is absent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const https = require('https');

const QUOTA_LOG = path.join(os.homedir(), '.claude', 'quota-history.jsonl');

// Only supported on macOS (Keychain access)
if (process.platform !== 'darwin') {
  process.exit(0);
}

// Spawn background process so hook returns immediately
if (process.argv[2] !== '--background') {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, '--background'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  process.exit(0);
}

// --- Background process ---

async function main() {
  try {
    const token = getToken();
    if (!token) {
      process.exit(0);
    }

    const data = await fetchQuota(token);
    if (!data) {
      process.exit(0);
    }

    appendLog(data);
  } catch (_e) {
    // Never break session hooks
  }
  process.exit(0);
}

function getToken() {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    ).toString().trim();

    if (!raw) return null;

    // The stored value may be a JSON blob with an access_token field
    try {
      const parsed = JSON.parse(raw);
      return parsed.access_token || parsed.token || raw;
    } catch (_e) {
      return raw;
    }
  } catch (_e) {
    return null;
  }
}

function fetchQuota(token) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/organizations/me/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ statusCode: res.statusCode, data: json });
        } catch (_e) {
          resolve({ statusCode: res.statusCode, raw: body.slice(0, 500) });
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function appendLog(payload) {
  try {
    const logDir = path.dirname(QUOTA_LOG);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const event = process.env.CLAUDE_HOOK_EVENT || 'unknown';
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...payload
    });

    fs.appendFileSync(QUOTA_LOG, entry + '\n');
  } catch (_e) {
    // Fail silently
  }
}

main();
