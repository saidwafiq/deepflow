#!/usr/bin/env node
// @hook-event: SessionEnd
// @hook-owner: dashboard
/**
 * deepflow dashboard push — SessionEnd hook
 * Collects session summary (tokens, duration, tool calls, model), gets
 * git user.name, and POSTs to dashboard_url from .deepflow/config.yaml.
 * Silently skips if dashboard_url is not configured.
 * Fire-and-forget: exits immediately after spawning background worker.
 */

'use strict';

// Spawn background process so the hook returns immediately
if (process.argv[2] !== '--background') {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, '--background'], {
    detached: true,
    stdio: 'ignore',
    // Pass stdin data through env so background process can read it
    env: { ...process.env, _DF_HOOK_INPUT: getStdinSync() }
  });
  child.unref();
  process.exit(0);
}

// --- Background process ---

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

function getStdinSync() {
  // Non-blocking stdin read for the parent process (limited buffer)
  try {
    return fs.readFileSync('/dev/stdin', { encoding: 'utf8', flag: 'rs' }) || '';
  } catch (_e) {
    return '';
  }
}

/** Read ~/.deepflow/config.yaml and extract dashboard_url (no yaml dep — regex parse). */
function getDashboardUrl() {
  const configPath = path.join(os.homedir(), '.deepflow', 'config.yaml');
  if (!fs.existsSync(configPath)) return null;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/^\s*dashboard_url\s*:\s*(.+)$/m);
    if (!match) return null;
    const val = match[1].trim().replace(/^['"]|['"]$/g, '');
    return val || null;
  } catch (_e) {
    return null;
  }
}

/** Get git user.name in the given directory. Returns 'unknown' on failure. */
function getGitUser(cwd) {
  try {
    return execFileSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || 'unknown';
  } catch (_e) {
    return process.env.USER || 'unknown';
  }
}

/** POST JSON payload to url. Returns true on 200. */
function postJson(url, payload) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      resolve(false);
      return;
    }

    const body = JSON.stringify(payload);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    };

    const req = lib.request(options, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function main() {
  try {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dashboardUrl = getDashboardUrl();

    // Silently skip if not configured
    if (!dashboardUrl) process.exit(0);

    // Parse session data from hook input (passed via env)
    let hookData = {};
    try {
      const raw = process.env._DF_HOOK_INPUT || '';
      if (raw) hookData = JSON.parse(raw);
    } catch (_e) {
      // fallback: empty data, we'll still send what we know
    }

    const gitUser = getGitUser(cwd);
    const projectName = path.basename(cwd);
    const ts = new Date().toISOString();

    // Extract token fields from hook data (Claude Code SessionEnd format)
    const usage = hookData.usage || hookData.context_window?.current_usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || usage.cache_read_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0;
    const model = hookData.model?.id || hookData.model?.display_name || hookData.model || 'unknown';
    const sessionId = hookData.session_id || hookData.sessionId || `${gitUser}:${projectName}:${ts}`;
    const durationMs = hookData.duration_ms || null;
    const toolCalls = hookData.tool_calls || hookData.tool_use_count || 0;

    const payload = {
      user: gitUser,
      project: projectName,
      session_id: sessionId,
      model,
      tokens: {
        [model]: {
          input: inputTokens,
          output: outputTokens,
          cache_read: cacheReadTokens,
          cache_creation: cacheCreationTokens
        }
      },
      started_at: hookData.started_at || ts,
      ended_at: ts,
      duration_ms: durationMs,
      tool_calls: toolCalls
    };

    const ingestUrl = dashboardUrl.replace(/\/$/, '') + '/api/ingest';
    await postJson(ingestUrl, payload);
  } catch (_e) {
    // Never break session end
  }
  process.exit(0);
}

main();
