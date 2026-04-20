'use strict';

/**
 * hooks/lib/lsp-transport.js
 *
 * Shared LSP JSON-RPC transport layer for deepflow hooks and CLI tools.
 *
 * Extracted verbatim from hooks/df-invariant-check.js (L24-287).
 * Consumers: df-invariant-check.js, bin/lsp-query.js, hooks/lib/symbol-extract.js
 *
 * Exports:
 *   detectLspBinary(projectRoot, diffFilePaths) → { binary, installCmd } | null
 *   queryLsp(binary, projectRoot, fileUri, method, params) → Promise<{ ok, result? }>
 *
 * Also re-exports lower-level helpers for callers that need them:
 *   LSP_DETECTION_RULES  — the detection ruleset
 *   detectLanguageServer — alias for detectLspBinary (original name in invariant check)
 *   isBinaryAvailable    — check if a binary exists on PATH
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

// ── LSP detection rules ───────────────────────────────────────────────────────

/**
 * Language server detection rules.
 * Each entry maps a set of indicator files/patterns to a language server binary
 * and its install instructions.
 */
const LSP_DETECTION_RULES = [
  {
    indicators: ['tsconfig.json'],
    fileExtensions: ['.ts', '.tsx'],
    binary: 'typescript-language-server',
    installCmd: 'npm install -g typescript-language-server',
  },
  {
    indicators: ['jsconfig.json', 'package.json'],
    fileExtensions: ['.js', '.jsx', '.mjs', '.cjs'],
    binary: 'typescript-language-server',
    installCmd: 'npm install -g typescript-language-server',
  },
  {
    indicators: ['pyrightconfig.json'],
    fileExtensions: ['.py'],
    binary: 'pyright',
    installCmd: 'npm install -g pyright',
  },
  {
    indicators: ['Cargo.toml'],
    fileExtensions: ['.rs'],
    binary: 'rust-analyzer',
    installCmd: 'rustup component add rust-analyzer',
  },
  {
    indicators: ['go.mod'],
    fileExtensions: ['.go'],
    binary: 'gopls',
    installCmd: 'go install golang.org/x/tools/gopls@latest',
  },
];

/**
 * Detect the appropriate language server for the given project root.
 * Checks for indicator files first, then falls back to file extensions in the diff.
 *
 * @param {string} projectRoot - Absolute path to the project root directory
 * @param {string[]} diffFilePaths - List of file paths from the diff
 * @returns {{ binary: string, installCmd: string } | null}
 */
function detectLanguageServer(projectRoot, diffFilePaths) {
  for (const rule of LSP_DETECTION_RULES) {
    // Check for indicator files in the project root
    for (const indicator of rule.indicators) {
      try {
        fs.accessSync(path.join(projectRoot, indicator));
        return { binary: rule.binary, installCmd: rule.installCmd };
      } catch (_) {
        // File not present, continue
      }
    }
    // Check for matching file extensions in the diff
    if (rule.fileExtensions && diffFilePaths.some((f) => rule.fileExtensions.some((ext) => f.endsWith(ext)))) {
      return { binary: rule.binary, installCmd: rule.installCmd };
    }
  }
  return null;
}

// Alias: detectLspBinary is the public-facing name for the CLI interface
const detectLspBinary = detectLanguageServer;

/**
 * Check whether a binary is available on the system PATH.
 *
 * @param {string} binary - Binary name to check
 * @returns {boolean}
 */
function isBinaryAvailable(binary) {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Query a language server using JSON-RPC 2.0 over stdio (LSP wire protocol).
 *
 * Fast-fails in <1s when the binary is missing (existence check before spawn).
 * Applies a 10s overall timeout for the full LSP query.
 *
 * Protocol sequence:
 *   1. Send "initialize" request
 *   2. Send the caller-supplied method request
 *   3. Parse Content-Length–framed responses from stdout until we get a
 *      response matching the method request id
 *
 * @param {string} binary      - LSP binary name or absolute path (e.g. "typescript-language-server")
 * @param {string} projectRoot - Absolute path to the project root (passed as rootUri/rootPath)
 * @param {string} fileUri     - file:// URI of the document being queried
 * @param {string} method      - LSP method name (e.g. "textDocument/documentSymbol")
 * @param {object} params      - Method parameters object
 * @returns {Promise<{ ok: true, result: * } | { ok: false, reason: 'lsp_unavailable' }>}
 */
async function queryLsp(binary, projectRoot, fileUri, method, params) {
  // ── Fast-fail: binary existence check (<1s) ────────────────────────────────
  // Resolve absolute path directly, or locate via which-style PATH scan.
  const binaryExists = (() => {
    if (path.isAbsolute(binary)) {
      return fs.existsSync(binary);
    }
    // Check each directory on PATH for the binary
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, binary);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch (_) {
        // Not found in this dir
      }
    }
    return false;
  })();

  if (!binaryExists) {
    return { ok: false, reason: 'lsp_unavailable' };
  }

  return new Promise((resolve) => {
    const LSP_TIMEOUT_MS = 10_000;
    let settled = false;

    function fail() {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (_) { /* ignore */ }
      resolve({ ok: false, reason: 'lsp_unavailable' });
    }

    // ── Spawn the LSP binary ───────────────────────────────────────────────
    let proc;
    try {
      proc = spawn(binary, ['--stdio'], {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (_) {
      return resolve({ ok: false, reason: 'lsp_unavailable' });
    }

    proc.on('error', fail);
    proc.on('close', () => { if (!settled) fail(); });

    // ── Overall 10s timeout ────────────────────────────────────────────────
    const timer = setTimeout(fail, LSP_TIMEOUT_MS);

    // ── JSON-RPC helpers ───────────────────────────────────────────────────
    let msgId = 1;

    function sendMessage(msg) {
      const json = JSON.stringify(msg);
      const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
      proc.stdin.write(header + json, 'utf8');
    }

    const INIT_ID = msgId++;
    const METHOD_ID = msgId++;

    // ── stdout parser: Content-Length framing ─────────────────────────────
    let buffer = '';
    let expectedLength = -1;

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString('utf8');

      while (true) { // eslint-disable-line no-constant-condition
        if (expectedLength === -1) {
          // Look for the header/body separator
          const sepIdx = buffer.indexOf('\r\n\r\n');
          if (sepIdx === -1) break;

          const header = buffer.slice(0, sepIdx);
          const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
          if (!lenMatch) { fail(); return; }

          expectedLength = parseInt(lenMatch[1], 10);
          buffer = buffer.slice(sepIdx + 4); // skip past "\r\n\r\n"
        }

        if (buffer.length < expectedLength) break;

        const body = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;

        let msg;
        try { msg = JSON.parse(body); } catch (_) { fail(); return; }

        if (msg.id === INIT_ID) {
          // Initialize response received — now send the actual method request
          sendMessage({ jsonrpc: '2.0', id: METHOD_ID, method, params });
        } else if (msg.id === METHOD_ID) {
          // Got our response
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { proc.kill(); } catch (_) { /* ignore */ }
            if (msg.error) {
              resolve({ ok: false, reason: 'lsp_unavailable' });
            } else {
              resolve({ ok: true, result: msg.result });
            }
          }
        }
        // Ignore notifications (id-less messages) and other responses
      }
    });

    // ── Send initialize request ────────────────────────────────────────────
    sendMessage({
      jsonrpc: '2.0',
      id: INIT_ID,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: `file://${projectRoot}`,
        rootPath: projectRoot,
        capabilities: {},
      },
    });
  });
}

module.exports = {
  LSP_DETECTION_RULES,
  detectLanguageServer,
  detectLspBinary,
  isBinaryAvailable,
  queryLsp,
};
