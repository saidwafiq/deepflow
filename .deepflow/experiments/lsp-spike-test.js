#!/usr/bin/env node
/**
 * Spike: Validate LSP programmatic access from Node.js
 * Spawns typescript-language-server --stdio and sends documentSymbol request
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TARGET_FILE = path.join(PROJECT_ROOT, 'hooks/df-spec-lint.js');

let msgId = 0;

function sendMessage(proc, method, params) {
  const id = ++msgId;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  proc.stdin.write(header + msg);
  return id;
}

function sendNotification(proc, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  proc.stdin.write(header + msg);
}

function parseMessages(buffer) {
  const messages = [];
  let remaining = buffer;
  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (remaining.length < bodyStart + len) break;
    const body = remaining.slice(bodyStart, bodyStart + len);
    try { messages.push(JSON.parse(body)); } catch (e) { /* skip */ }
    remaining = remaining.slice(bodyStart + len);
  }
  return { messages, remaining };
}

async function runSpike() {
  const results = { criteria: [] };
  const lsp = spawn('typescript-language-server', ['--stdio'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });

  let buffer = '';
  const responseMap = new Map();

  lsp.stdout.on('data', (data) => {
    buffer += data.toString();
    const { messages, remaining } = parseMessages(buffer);
    buffer = remaining;
    for (const msg of messages) {
      if (msg.id !== undefined) {
        const resolve = responseMap.get(msg.id);
        if (resolve) {
          resolve(msg);
          responseMap.delete(msg.id);
        }
      }
    }
  });

  lsp.stderr.on('data', (data) => {
    // Suppress stderr noise
  });

  function waitForResponse(id, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responseMap.delete(id);
        reject(new Error(`Timeout waiting for response id=${id}`));
      }, timeoutMs);
      responseMap.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  try {
    // 1. Initialize
    console.log('Sending initialize...');
    const initStart = Date.now();
    const initId = sendMessage(lsp, 'initialize', {
      processId: process.pid,
      capabilities: {
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
        },
      },
      rootUri: `file://${PROJECT_ROOT}`,
      workspaceFolders: [{ uri: `file://${PROJECT_ROOT}`, name: 'deepflow' }],
    });
    const initResp = await waitForResponse(initId);
    const initLatency = Date.now() - initStart;
    console.log(`Initialize response received in ${initLatency}ms`);
    console.log(`Server capabilities: ${Object.keys(initResp.result?.capabilities || {}).join(', ')}`);

    // 2. Initialized notification
    sendNotification(lsp, 'initialized', {});

    // 3. Open document
    const fileContent = fs.readFileSync(TARGET_FILE, 'utf-8');
    sendNotification(lsp, 'textDocument/didOpen', {
      textDocument: {
        uri: `file://${TARGET_FILE}`,
        languageId: 'javascript',
        version: 1,
        text: fileContent,
      },
    });
    console.log(`Opened document: ${TARGET_FILE}`);

    // Wait a moment for the server to process
    await new Promise(r => setTimeout(r, 1000));

    // 4. DocumentSymbol request
    console.log('Sending textDocument/documentSymbol...');
    const symStart = Date.now();
    const symId = sendMessage(lsp, 'textDocument/documentSymbol', {
      textDocument: { uri: `file://${TARGET_FILE}` },
    });
    const symResp = await waitForResponse(symId);
    const symLatency = Date.now() - symStart;

    const symbols = symResp.result || [];
    const symbolNames = symbols.map(s => s.name || s.containerName || 'unknown').slice(0, 10);
    console.log(`DocumentSymbol response: ${symbols.length} symbols in ${symLatency}ms`);
    console.log(`Sample symbols: ${symbolNames.join(', ')}`);

    // Evaluate criteria
    const workingLSP = symbols.length > 0 && !symResp.error;
    results.criteria.push({
      name: 'working LSP calls',
      target: 'documentSymbol returns valid symbols',
      actual: workingLSP
        ? `documentSymbol returned ${symbols.length} symbols (${symbolNames.slice(0, 5).join(', ')})`
        : `Failed: ${symResp.error?.message || 'no symbols returned'}`,
      met: workingLSP,
    });

    const latencyOk = symLatency < 5000;
    results.criteria.push({
      name: 'latency',
      target: '<5s per operation',
      actual: `${symLatency}ms (${(symLatency / 1000).toFixed(2)}s)`,
      met: latencyOk,
    });

    results.allMet = workingLSP && latencyOk;
    results.initLatency = initLatency;
    results.symLatency = symLatency;
    results.symbolCount = symbols.length;
    results.symbolNames = symbolNames;

    // Shutdown
    const shutId = sendMessage(lsp, 'shutdown', null);
    await waitForResponse(shutId, 5000).catch(() => {});
    sendNotification(lsp, 'exit', null);

  } catch (err) {
    console.error(`Error: ${err.message}`);
    results.error = err.message;
    results.criteria.push({
      name: 'working LSP calls',
      target: 'documentSymbol returns valid symbols',
      actual: `Error: ${err.message}`,
      met: false,
    });
    results.criteria.push({
      name: 'latency',
      target: '<5s per operation',
      actual: 'N/A (LSP call failed)',
      met: false,
    });
    results.allMet = false;
    lsp.kill();
  }

  // Output results as JSON for easy parsing
  console.log('\n--- RESULTS ---');
  console.log(JSON.stringify(results, null, 2));

  // Give process time to exit cleanly
  setTimeout(() => process.exit(0), 500);
}

runSpike();
