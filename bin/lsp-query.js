#!/usr/bin/env node
/**
 * bin/lsp-query.js
 *
 * Pure-Node CLI that wraps the shared LSP transport (hooks/lib/lsp-transport.js)
 * with a `textDocument/didOpen` handshake, so `documentSymbol` / `findReferences`
 * return non-empty results against servers (notably typescript-language-server)
 * that require the document to be opened in the session first.
 *
 * Usage:
 *   lsp-query --op <documentSymbol|findReferences|workspaceSymbol> [flags]
 *
 * Flags:
 *   --op <method>       Required. One of: documentSymbol, findReferences, workspaceSymbol.
 *   --file <path>       Required for documentSymbol and findReferences.
 *   --line <N>          Required for findReferences (0-indexed).
 *   --char <N>          Required for findReferences (0-indexed).
 *   --query <str>       Required for workspaceSymbol.
 *   --cwd <path>        Optional. Defaults to process.cwd().
 *   --verbose           Optional. Print diagnostic to stderr (lsp_error vs lsp_unavailable).
 *
 * Contract (AC-2, AC-6, REQ-4):
 *   - Prints a compact single-line JSON array to stdout.
 *   - Exits 0 even on LSP failure (fail-open). Exits 1 only on CLI misuse.
 *   - 1s soft budget per invocation; on timeout returns `[]`.
 *   - Arrays truncated to 120 items for documentSymbol / findReferences.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { detectLspBinary, detectLanguageServer } = require('../hooks/lib/lsp-transport');

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_BUDGET_MS = 1000;
const TRUNCATE_LIMIT = 120;

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--op':        args.op = argv[++i]; break;
      case '--file':      args.file = argv[++i]; break;
      case '--line':      args.line = parseInt(argv[++i], 10); break;
      case '--char':      args.char = parseInt(argv[++i], 10); break;
      case '--query':     args.query = argv[++i]; break;
      case '--cwd':       args.cwd = argv[++i]; break;
      case '--verbose':   args.verbose = true; break;
      case '-h':
      case '--help':      args.help = true; break;
      default:
        // Unknown flag → ignore for forward compatibility (fail-open)
        break;
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: lsp-query --op <documentSymbol|findReferences|workspaceSymbol> [flags]',
    '  --file <path>    (documentSymbol, findReferences)',
    '  --line <N>       (findReferences, 0-indexed)',
    '  --char <N>       (findReferences, 0-indexed)',
    '  --query <str>    (workspaceSymbol)',
    '  --cwd <path>     (optional, defaults to process.cwd())',
    '  --verbose        (optional, stderr diagnostics)',
  ].join('\n');
}

// ── Fail-open helpers ────────────────────────────────────────────────────────

function emitEmpty(args, diagnostic) {
  if (args && args.verbose && diagnostic) {
    try { process.stderr.write(`lsp-query: ${diagnostic}\n`); } catch (_) { /* ignore */ }
  }
  process.stdout.write('[]\n');
  process.exit(0);
}

// ── Language ID derivation ───────────────────────────────────────────────────

const LANGUAGE_ID_BY_EXT = {
  '.ts':  'typescript',
  '.tsx': 'typescriptreact',
  '.js':  'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py':  'python',
  '.go':  'go',
  '.rs':  'rust',
  '.java': 'java',
};

function languageIdFor(file) {
  const ext = path.extname(file || '').toLowerCase();
  return LANGUAGE_ID_BY_EXT[ext] || 'plaintext';
}

// ── LSP wire helpers ─────────────────────────────────────────────────────────

function frameMessage(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
  return header + json;
}

/**
 * Run a single LSP method against the binary with a proper didOpen handshake.
 *
 * Sequence:
 *   → initialize              (id=1)
 *   ← initializeResult
 *   → initialized             (notification)
 *   → textDocument/didOpen    (notification, if file provided)
 *   → <method>                (id=2)
 *   ← <method> result
 *   → shutdown / exit
 *
 * @param {string} binary       - LSP binary name or absolute path.
 * @param {string} projectRoot  - Absolute path to project root (rootUri/rootPath).
 * @param {string} method       - LSP method (e.g. 'textDocument/documentSymbol').
 * @param {object} params       - Method parameters.
 * @param {object} [openDoc]    - Optional { uri, languageId, text } to didOpen.
 * @param {number} [budgetMs]   - Overall budget in ms.
 * @returns {Promise<{ ok:true, result:* } | { ok:false, reason:'lsp_unavailable'|'lsp_error'|'timeout'|'parse_error', detail?:string }>}
 */
function queryLspWithDoc(binary, projectRoot, method, params, openDoc, budgetMs) {
  const timeoutMs = Math.max(100, budgetMs || DEFAULT_BUDGET_MS);

  // Fast-fail: binary existence check (PATH scan or absolute).
  const binaryExists = (() => {
    if (path.isAbsolute(binary)) {
      try { return fs.existsSync(binary); } catch (_) { return false; }
    }
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      try {
        fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
        return true;
      } catch (_) { /* keep looking */ }
    }
    return false;
  })();

  if (!binaryExists) {
    return Promise.resolve({ ok: false, reason: 'lsp_unavailable', detail: `binary not on PATH: ${binary}` });
  }

  return new Promise((resolve) => {
    let settled = false;
    let proc;
    let timer;

    function settle(value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { proc && proc.kill(); } catch (_) { /* ignore */ }
      resolve(value);
    }

    try {
      proc = spawn(binary, ['--stdio'], {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      return resolve({ ok: false, reason: 'lsp_unavailable', detail: `spawn failed: ${err.message}` });
    }

    proc.on('error', (err) => settle({ ok: false, reason: 'lsp_unavailable', detail: `proc error: ${err.message}` }));
    proc.on('close', () => {
      if (!settled) settle({ ok: false, reason: 'lsp_unavailable', detail: 'process closed before response' });
    });

    timer = setTimeout(() => settle({ ok: false, reason: 'timeout', detail: `exceeded ${timeoutMs}ms` }), timeoutMs);

    const INIT_ID = 1;
    const METHOD_ID = 2;
    const SHUTDOWN_ID = 3;

    function send(msg) {
      try { proc.stdin.write(frameMessage(msg), 'utf8'); } catch (_) { /* ignore */ }
    }

    // ── stdout parser: Content-Length framing ────────────────────────────────
    let buffer = Buffer.alloc(0);
    let expectedLength = -1;

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      while (true) { // eslint-disable-line no-constant-condition
        if (expectedLength === -1) {
          const sepIdx = buffer.indexOf('\r\n\r\n');
          if (sepIdx === -1) break;
          const header = buffer.slice(0, sepIdx).toString('utf8');
          const m = header.match(/Content-Length:\s*(\d+)/i);
          if (!m) { settle({ ok: false, reason: 'parse_error', detail: 'missing Content-Length' }); return; }
          expectedLength = parseInt(m[1], 10);
          buffer = buffer.slice(sepIdx + 4);
        }

        if (buffer.length < expectedLength) break;

        const body = buffer.slice(0, expectedLength).toString('utf8');
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;

        let msg;
        try { msg = JSON.parse(body); } catch (err) {
          settle({ ok: false, reason: 'parse_error', detail: `json parse: ${err.message}` });
          return;
        }

        if (msg.id === INIT_ID) {
          // initialize succeeded — kick off notifications + method request
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });

          if (openDoc && openDoc.uri && typeof openDoc.text === 'string') {
            send({
              jsonrpc: '2.0',
              method: 'textDocument/didOpen',
              params: {
                textDocument: {
                  uri: openDoc.uri,
                  languageId: openDoc.languageId || 'plaintext',
                  version: 1,
                  text: openDoc.text,
                },
              },
            });
          }

          send({ jsonrpc: '2.0', id: METHOD_ID, method, params });
        } else if (msg.id === METHOD_ID) {
          if (msg.error) {
            // Try a polite shutdown, then resolve with lsp_error.
            send({ jsonrpc: '2.0', id: SHUTDOWN_ID, method: 'shutdown', params: null });
            send({ jsonrpc: '2.0', method: 'exit', params: null });
            settle({ ok: false, reason: 'lsp_error', detail: msg.error.message || 'lsp error' });
          } else {
            send({ jsonrpc: '2.0', id: SHUTDOWN_ID, method: 'shutdown', params: null });
            send({ jsonrpc: '2.0', method: 'exit', params: null });
            settle({ ok: true, result: msg.result });
          }
        }
        // Ignore notifications / other ids.
      }
    });

    // Kick off
    send({
      jsonrpc: '2.0',
      id: INIT_ID,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: `file://${projectRoot}`,
        rootPath: projectRoot,
        capabilities: {
          textDocument: {
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            references:     { dynamicRegistration: false },
          },
          workspace: {
            symbol: { dynamicRegistration: false },
          },
        },
      },
    });
  });
}

// ── Result shaping ───────────────────────────────────────────────────────────

function truncateArray(result) {
  if (!Array.isArray(result)) return result;
  if (result.length <= TRUNCATE_LIMIT) return result;
  return result.slice(0, TRUNCATE_LIMIT);
}

function resultToArray(result) {
  if (Array.isArray(result)) return result;
  if (result == null) return [];
  return [result];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(usage() + '\n');
    process.exit(0);
  }

  if (!args.op) {
    // CLI misuse — exit 1 with usage on stderr, still print [] to stdout for consumer safety.
    process.stderr.write(usage() + '\n');
    process.stdout.write('[]\n');
    process.exit(1);
  }

  const cwd = path.resolve(args.cwd || process.cwd());

  // Determine which file (if any) we need for didOpen + what to pass to detect.
  const diffFiles = [];
  if (args.file) diffFiles.push(args.file);

  // Binary detection (fail-open).
  let detected;
  try {
    detected = detectLspBinary(cwd, diffFiles) || detectLanguageServer(cwd, diffFiles);
  } catch (err) {
    return emitEmpty(args, `detect error: ${err.message}`);
  }

  if (!detected) {
    return emitEmpty(args, 'no LSP binary detected for this project');
  }

  const binary = detected.binary;

  // Build op-specific params + openDoc.
  let method, params;
  let openDoc = null;

  switch (args.op) {
    case 'documentSymbol': {
      if (!args.file) return emitEmpty(args, '--file required for documentSymbol');
      const absFile = path.resolve(args.file);
      const uri = `file://${absFile}`;
      let text = '';
      try { text = fs.readFileSync(absFile, 'utf8'); } catch (err) {
        return emitEmpty(args, `cannot read file: ${err.message}`);
      }
      openDoc = { uri, languageId: languageIdFor(absFile), text };
      method = 'textDocument/documentSymbol';
      params = { textDocument: { uri } };
      break;
    }
    case 'findReferences': {
      if (!args.file) return emitEmpty(args, '--file required for findReferences');
      if (!Number.isInteger(args.line) || !Number.isInteger(args.char)) {
        return emitEmpty(args, '--line and --char (integers) required for findReferences');
      }
      const absFile = path.resolve(args.file);
      const uri = `file://${absFile}`;
      let text = '';
      try { text = fs.readFileSync(absFile, 'utf8'); } catch (err) {
        return emitEmpty(args, `cannot read file: ${err.message}`);
      }
      openDoc = { uri, languageId: languageIdFor(absFile), text };
      method = 'textDocument/references';
      params = {
        textDocument: { uri },
        position: { line: args.line, character: args.char },
        context: { includeDeclaration: true },
      };
      break;
    }
    case 'workspaceSymbol': {
      if (typeof args.query !== 'string' || args.query.length === 0) {
        return emitEmpty(args, '--query required for workspaceSymbol');
      }
      // didOpen optional for workspace/symbol — skip it.
      method = 'workspace/symbol';
      params = { query: args.query };
      break;
    }
    default:
      return emitEmpty(args, `unknown --op: ${args.op}`);
  }

  let response;
  try {
    response = await queryLspWithDoc(binary, cwd, method, params, openDoc, DEFAULT_BUDGET_MS);
  } catch (err) {
    return emitEmpty(args, `transport error: ${err.message}`);
  }

  if (!response.ok) {
    return emitEmpty(args, `${response.reason}: ${response.detail || ''}`);
  }

  let arr = resultToArray(response.result);
  if (args.op === 'documentSymbol' || args.op === 'findReferences') {
    arr = truncateArray(arr);
  }

  // Compact single-line JSON (AC-2).
  try {
    process.stdout.write(JSON.stringify(arr) + '\n');
  } catch (err) {
    return emitEmpty(args, `serialize error: ${err.message}`);
  }
  process.exit(0);
}

main().catch((err) => {
  // Global fail-open.
  try { process.stderr.write(`lsp-query: unexpected: ${err.stack || err.message}\n`); } catch (_) { /* ignore */ }
  process.stdout.write('[]\n');
  process.exit(0);
});
