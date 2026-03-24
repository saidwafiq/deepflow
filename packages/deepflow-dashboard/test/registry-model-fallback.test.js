/**
 * Tests for AC-7 and AC-8: registry model fallback in parseSessions.
 *
 * AC-7: When session has model='unknown' and registry entry has model,
 *        the registry model is used as fallback.
 * AC-8: Registry model does NOT overwrite event-derived model
 *        (event-derived model takes precedence).
 *
 * Also covers:
 *   - registryModelMap building: 'unknown' model entries are ignored
 *   - registryModelMap building: last non-empty entry wins (chronological)
 *   - registryModelMap building: entries without model field are skipped
 *   - registryModelMap building: entries without session_id are skipped
 *   - No fallback applied when registry has no model for that session
 *
 * Strategy: In-memory SQLite via initDatabase() + temp dirs with JSONL fixtures,
 * then parseSessions() integration. Unit tests mirror the registryModelMap
 * building logic from sessions.ts.
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Import from dist (compiled ESM)
const { initDatabase, run, get, all } = await import(resolve(ROOT, 'dist', 'db', 'index.js'));
const { parseSessions } = await import(resolve(ROOT, 'dist', 'ingest', 'parsers', 'sessions.js'));

// ---------------------------------------------------------------------------
// Unit tests: registryModelMap building logic (mirrored from sessions.ts)
// ---------------------------------------------------------------------------

/**
 * Mirror of the registryModelMap-building logic from sessions.ts.
 * Parses JSONL content into a Map<string, string> for model lookups.
 */
function buildRegistryModelMap(jsonlContent) {
  const map = new Map();
  const lines = jsonlContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const sid = entry.session_id;
      const entryModel = entry.model;
      // Store registry model; last non-empty entry wins (entries are appended chronologically)
      if (sid && entryModel && entryModel !== 'unknown') {
        map.set(sid, entryModel);
      }
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

describe('buildRegistryModelMap — unit logic', () => {
  it('stores model from valid registry entry', () => {
    const content = JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'claude-sonnet-4-20250514' });
    const map = buildRegistryModelMap(content);
    assert.equal(map.get('sess-1'), 'claude-sonnet-4-20250514');
  });

  it('ignores entries with model="unknown"', () => {
    const content = JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'unknown' });
    const map = buildRegistryModelMap(content);
    assert.equal(map.has('sess-1'), false, 'model=unknown should be ignored');
  });

  it('ignores entries without model field', () => {
    const content = JSON.stringify({ session_id: 'sess-1', agent_type: 'coder' });
    const map = buildRegistryModelMap(content);
    assert.equal(map.has('sess-1'), false, 'missing model should be ignored');
  });

  it('ignores entries without session_id', () => {
    const content = JSON.stringify({ agent_type: 'coder', model: 'claude-sonnet-4-20250514' });
    const map = buildRegistryModelMap(content);
    assert.equal(map.size, 0, 'missing session_id should be skipped');
  });

  it('last non-empty entry wins (chronological append)', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ].join('\n');
    const map = buildRegistryModelMap(content);
    assert.equal(map.get('sess-1'), 'claude-sonnet-4-20250514', 'last entry should win');
  });

  it('unknown entry between valid entries does not clear previous model', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'unknown' }),
    ].join('\n');
    const map = buildRegistryModelMap(content);
    assert.equal(map.get('sess-1'), 'claude-haiku-4-5-20251001', 'unknown should not clear previous');
  });

  it('handles multiple sessions independently', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
      JSON.stringify({ session_id: 'sess-2', agent_type: 'reviewer', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');
    const map = buildRegistryModelMap(content);
    assert.equal(map.get('sess-1'), 'claude-sonnet-4-20250514');
    assert.equal(map.get('sess-2'), 'claude-haiku-4-5-20251001');
  });

  it('skips malformed JSON lines without crashing', () => {
    const content = [
      'not json',
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ].join('\n');
    const map = buildRegistryModelMap(content);
    assert.equal(map.size, 1);
    assert.equal(map.get('sess-1'), 'claude-sonnet-4-20250514');
  });

  it('returns empty map for empty content', () => {
    const map = buildRegistryModelMap('');
    assert.equal(map.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: parseSessions registry model fallback
// ---------------------------------------------------------------------------

const TEMP_BASE = resolve(tmpdir(), `deepflow-registry-model-test-${Date.now()}`);

function setupClaudeDir(opts = {}) {
  const claudeDir = resolve(TEMP_BASE, `claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectsDir = resolve(claudeDir, 'projects', '-Users-test-apps-myproject');
  mkdirSync(projectsDir, { recursive: true });

  const sessionFiles = opts.sessionFiles ?? {};
  for (const [filename, lines] of Object.entries(sessionFiles)) {
    writeFileSync(resolve(projectsDir, filename), lines.join('\n'));
  }

  if (opts.registry !== undefined && opts.registry !== null) {
    writeFileSync(resolve(claudeDir, 'subagent-sessions.jsonl'), opts.registry);
  }

  return claudeDir;
}

function clearTestData() {
  try { run('DELETE FROM sessions'); } catch { /* ignore */ }
  try { run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:%'"); } catch { /* ignore */ }
}

before(async () => {
  await initDatabase('serve');
});

// ===========================================================================
// AC-7: Registry model used when event stream yields model='unknown'
// ===========================================================================

describe('AC-7: registry model fallback when event model is unknown', () => {
  it('uses registry model when session events have no model info', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-nomodel', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        // Session events with NO model field at all → model stays 'unknown'
        'sess-nomodel.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-nomodel']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'registry model should be used as fallback');
  });

  it('uses registry model when all event models are "unknown"', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-allunk', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-allunk.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'unknown', message: { role: 'assistant', model: 'unknown', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-allunk']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-haiku-4-5-20251001', 'registry model should replace unknown');
  });

  it('model stays unknown when registry has no model for that session', async () => {
    clearTestData();
    const registry = [
      // Registry entry without model field
      JSON.stringify({ session_id: 'sess-noreg', agent_type: 'coder' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-noreg.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-noreg']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'unknown', 'model should remain unknown when registry has no model');
  });

  it('model stays unknown when session is not in registry at all', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'other-sess', agent_type: 'coder', model: 'claude-sonnet-4-20250514' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-absent.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-absent']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'unknown', 'model should remain unknown when session is not in registry');
  });

  it('model stays unknown when registry model is also "unknown"', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-regunk', agent_type: 'coder', model: 'unknown' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-regunk.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-regunk']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'unknown', 'registry model=unknown should not be used as fallback');
  });
});

// ===========================================================================
// AC-8: Event-derived model takes precedence over registry model
// ===========================================================================

describe('AC-8: event-derived model takes precedence over registry model', () => {
  it('event model is preserved when registry also has a model', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-eventmod', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        // Events provide model via message.model
        'sess-eventmod.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4-20250514', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-eventmod']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'event-derived model should take precedence over registry model');
  });

  it('event model from event.model field takes precedence', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-evtmod2', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        // Events provide model via top-level event.model only (not message.model)
        'sess-evtmod2.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-opus-4-20250514', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-evtmod2']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-opus-4-20250514', 'event.model should take precedence over registry');
  });

  it('event model with bracket suffix is stripped but still takes precedence', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-bracket', agent_type: 'coder', model: 'claude-haiku-4-5-20251001' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-bracket.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4-20250514[1m]', message: { role: 'assistant', model: 'claude-sonnet-4-20250514[1m]', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-bracket']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'claude-sonnet-4-20250514', 'bracket suffix should be stripped, event model preserved');
  });
});

// ===========================================================================
// Edge cases: registry model with missing registry file
// ===========================================================================

describe('Registry model fallback — missing registry file', () => {
  it('no fallback when registry file is absent (model stays unknown)', async () => {
    clearTestData();

    const claudeDir = setupClaudeDir({
      registry: null, // no registry file
      sessionFiles: {
        'sess-noreg.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT model FROM sessions WHERE id = ?', ['sess-noreg']);
    assert.ok(row, 'session should exist');
    assert.equal(row.model, 'unknown', 'model should be unknown when no registry file exists');
  });
});

// ===========================================================================
// Source-level assertions for the new registryModelMap logic
// ===========================================================================

import { readFileSync } from 'node:fs';
const sessionsSrc = readFileSync(resolve(ROOT, 'src', 'ingest', 'parsers', 'sessions.ts'), 'utf8');

describe('Source-level: sessions.ts includes registryModelMap logic', () => {
  it('declares registryModelMap', () => {
    assert.match(sessionsSrc, /registryModelMap/, 'should have registryModelMap');
  });

  it('reads model from registry entries', () => {
    assert.match(sessionsSrc, /entry\.model/, 'should read model from entry');
  });

  it('filters out unknown model in registry', () => {
    assert.match(sessionsSrc, /entryModel !== 'unknown'/, 'should skip unknown model entries');
  });

  it('falls back to registry model when event model is unknown', () => {
    assert.match(sessionsSrc, /model === 'unknown'[\s\S]*?registryModelMap\.get/, 'should check model===unknown then consult registryModelMap');
  });

  it('fallback is placed after event loop (event model takes precedence)', () => {
    // The fallback block should appear AFTER the for loop that processes events
    const loopEnd = sessionsSrc.lastIndexOf('hasNewData = true');
    const fallbackPos = sessionsSrc.indexOf("if (model === 'unknown')");
    assert.ok(fallbackPos > loopEnd, 'fallback should be after the event processing loop');
  });
});

// Cleanup temp dirs
process.on('exit', () => {
  try {
    if (existsSync(TEMP_BASE)) {
      rmSync(TEMP_BASE, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});
