/**
 * Integration tests for extractModelFromJsonl.
 *
 * Success criteria:
 *   - Valid JSONL with assistant event → returns correct model string
 *   - Missing file → returns null (graceful fallback)
 *   - JSONL with no assistant events → returns null
 *   - Malformed / corrupt JSONL → returns null
 *
 * Strategy: Mirror the extractModelFromJsonl logic from sessions.ts and
 * exercise it against real temp JSONL fixture files.  Mirrors the pattern
 * used in registry-model-fallback.test.js (buildRegistryModelMap unit tests)
 * so the test suite can run without a dist build.
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mirror of extractModelFromJsonl from sessions.ts
// ---------------------------------------------------------------------------

/**
 * Mirrors the extractModelFromJsonl helper from
 * src/ingest/parsers/sessions.ts.
 * Reads up to 8 KB from the start of a JSONL file, finds the first
 * `assistant` event with a non-unknown model on message.model, and returns
 * the normalized model string.  Returns null on any failure or absence.
 */
function extractModelFromJsonl(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;

  const MAX_READ_BYTES = 8192;
  let buf;
  try {
    buf = Buffer.alloc(MAX_READ_BYTES);
    const fd = openSync(jsonlPath, 'r');
    const bytesRead = readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    closeSync(fd);
    buf = buf.subarray(0, bytesRead);
  } catch {
    return null;
  }

  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== 'assistant') continue;
    const msg = event.message;
    const model = msg?.model;
    if (model && model !== 'unknown') {
      return model.replace(/\[\d+[km]\]$/i, '');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

const TEMP_BASE = mkdtempSync(join(tmpdir(), 'deepflow-subagent-model-test-'));

after(() => {
  try {
    if (existsSync(TEMP_BASE)) {
      rmSync(TEMP_BASE, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

function writeTempJsonl(name, lines) {
  const filePath = join(TEMP_BASE, name);
  writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractModelFromJsonl — valid JSONL with assistant event', () => {
  it('returns model from first assistant event with message.model', () => {
    const filePath = writeTempJsonl('valid-assistant.jsonl', [
      JSON.stringify({ type: 'user', timestamp: '2026-04-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
    ]);
    assert.equal(extractModelFromJsonl(filePath), 'claude-sonnet-4-20250514');
  });

  it('returns model from first assistant event when multiple events exist', () => {
    const filePath = writeTempJsonl('multi-event.jsonl', [
      JSON.stringify({ type: 'user', timestamp: '2026-04-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'ping' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 50, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:02:00Z', message: { role: 'assistant', model: 'claude-opus-4-20250514', content: [{ type: 'text', text: 'again' }], usage: { input_tokens: 60, output_tokens: 25 } } }),
    ]);
    // Should return the first assistant event's model
    assert.equal(extractModelFromJsonl(filePath), 'claude-haiku-4-5-20251001');
  });

  it('strips bracket suffix from model string', () => {
    const filePath = writeTempJsonl('bracket-suffix.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514[1m]', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }),
    ]);
    assert.equal(extractModelFromJsonl(filePath), 'claude-sonnet-4-20250514');
  });

  it('strips uppercase bracket suffix (e.g. [1K])', () => {
    const filePath = writeTempJsonl('bracket-uppercase.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001[8K]', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }),
    ]);
    assert.equal(extractModelFromJsonl(filePath), 'claude-haiku-4-5-20251001');
  });
});

describe('extractModelFromJsonl — missing file fallback', () => {
  it('returns null for a path that does not exist', () => {
    const nonExistentPath = join(TEMP_BASE, 'does-not-exist.jsonl');
    assert.equal(extractModelFromJsonl(nonExistentPath), null);
  });
});

describe('extractModelFromJsonl — JSONL without assistant events', () => {
  it('returns null when file only contains user events', () => {
    const filePath = writeTempJsonl('user-only.jsonl', [
      JSON.stringify({ type: 'user', timestamp: '2026-04-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-01T10:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'world' }] } }),
    ]);
    assert.equal(extractModelFromJsonl(filePath), null);
  });

  it('returns null when file is empty', () => {
    const filePath = writeTempJsonl('empty.jsonl', []);
    assert.equal(extractModelFromJsonl(filePath), null);
  });

  it('returns null when file contains only blank lines', () => {
    const filePath = writeTempJsonl('blank-lines.jsonl', ['', '   ', '']);
    assert.equal(extractModelFromJsonl(filePath), null);
  });

  it('returns null when assistant event has model=unknown', () => {
    const filePath = writeTempJsonl('model-unknown.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', model: 'unknown', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }),
    ]);
    assert.equal(extractModelFromJsonl(filePath), null);
  });

  it('returns null when assistant event has no model field on message', () => {
    const filePath = writeTempJsonl('no-model-field.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }),
    ]);
    assert.equal(extractModelFromJsonl(filePath), null);
  });
});

describe('extractModelFromJsonl — malformed JSONL', () => {
  it('returns null for a file containing only non-JSON text', () => {
    const filePath = writeTempJsonl('non-json.jsonl', [
      'this is not json',
      'neither is this',
    ]);
    assert.equal(extractModelFromJsonl(filePath), null);
  });

  it('returns null for corrupt JSONL with truncated JSON', () => {
    const filePath = writeTempJsonl('corrupt.jsonl', [
      '{"type": "assistant", "message": {"model": "claude-sonnet-4-20250514"',  // truncated — no closing braces
    ]);
    assert.equal(extractModelFromJsonl(filePath), null);
  });

  it('skips malformed lines and finds model in a valid subsequent assistant event', () => {
    const filePath = writeTempJsonl('mixed-malformed.jsonl', [
      'not json at all',
      '{broken json',
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-01T10:01:00Z', message: { role: 'assistant', model: 'claude-opus-4-20250514', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }),
    ]);
    // Even though earlier lines are malformed, the valid assistant event should be found
    assert.equal(extractModelFromJsonl(filePath), 'claude-opus-4-20250514');
  });
});

// ---------------------------------------------------------------------------
// Source-level assertion: sessions.ts exports extractModelFromJsonl
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const sessionsSrc = readFileSync(resolve(ROOT, 'src', 'ingest', 'parsers', 'sessions.ts'), 'utf8');

describe('Source-level: sessions.ts declares and exports extractModelFromJsonl', () => {
  it('exports extractModelFromJsonl function', () => {
    assert.match(sessionsSrc, /export function extractModelFromJsonl/, 'should export extractModelFromJsonl');
  });

  it('returns null for missing file', () => {
    assert.match(sessionsSrc, /if \(!existsSync\(jsonlPath\)\) return null/, 'should guard against missing file');
  });

  it('only inspects assistant events', () => {
    assert.match(sessionsSrc, /event\.type !== 'assistant'/, 'should skip non-assistant events');
  });

  it('strips bracket suffix from model', () => {
    assert.ok(sessionsSrc.includes('[km]'), 'should strip bracket suffix (search for [km] pattern)');
  });

  it('is wired into the subagentEntries loop for unknown-model fallback', () => {
    assert.match(sessionsSrc, /extractModelFromJsonl\(candidatePath\)/, 'should call extractModelFromJsonl in the loop');
  });
});
