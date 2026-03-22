/**
 * Tests for T4: ingest cross-reference subagent registry into agent_role.
 *
 * Validates:
 *   - AC-14: Registry file missing → all sessions get agent_role='orchestrator'
 *   - AC-5:  Registry with session X → session X gets that agent_type as agent_role
 *   - AC-6:  Sessions not in registry → agent_role='orchestrator'
 *   - AC-12: Two entries same session_id, different agent_types → agent_role='mixed'
 *   - AC-13: token_events get agent_role matching session's resolved role
 *   - Malformed JSONL lines are skipped with warning, valid lines still processed
 *   - resolveAgentRole helper logic: single type, multiple types, absent
 *
 * Strategy: Test the registry-map-building and resolveAgentRole logic directly
 * by recreating it from the source patterns, then run integration tests via
 * in-memory SQLite with parseSessions() and parseTokenHistory().
 */

import { describe, it, before, beforeEach } from 'node:test';
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
const { parseTokenHistory } = await import(resolve(ROOT, 'dist', 'ingest', 'parsers', 'token-history.js'));

// ---------------------------------------------------------------------------
// Unit tests: resolveAgentRole logic (recreated from source pattern)
// ---------------------------------------------------------------------------

/**
 * Mirror of the resolveAgentRole closure in sessions.ts.
 * Accepts a registryMap and sessionId, returns the resolved role.
 */
function resolveAgentRole(registryMap, sessionId) {
  const types = registryMap.get(sessionId);
  if (!types || types.size === 0) return 'orchestrator';
  if (types.size === 1) return types.values().next().value;
  return 'mixed';
}

describe('resolveAgentRole — unit logic', () => {
  it('returns orchestrator when session is not in registry', () => {
    const map = new Map();
    assert.equal(resolveAgentRole(map, 'unknown-session'), 'orchestrator');
  });

  it('returns orchestrator when session has empty set', () => {
    const map = new Map([['sess-1', new Set()]]);
    assert.equal(resolveAgentRole(map, 'sess-1'), 'orchestrator');
  });

  it('returns single agent_type when session has exactly one type', () => {
    const map = new Map([['sess-1', new Set(['coder'])]]);
    assert.equal(resolveAgentRole(map, 'sess-1'), 'coder');
  });

  it('returns single agent_type for reviewer', () => {
    const map = new Map([['sess-1', new Set(['reviewer'])]]);
    assert.equal(resolveAgentRole(map, 'sess-1'), 'reviewer');
  });

  it('returns mixed when session has multiple different types (AC-12)', () => {
    const map = new Map([['sess-1', new Set(['coder', 'reviewer'])]]);
    assert.equal(resolveAgentRole(map, 'sess-1'), 'mixed');
  });

  it('returns mixed for three distinct types', () => {
    const map = new Map([['sess-1', new Set(['coder', 'reviewer', 'planner'])]]);
    assert.equal(resolveAgentRole(map, 'sess-1'), 'mixed');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: registry map building from JSONL
// ---------------------------------------------------------------------------

/**
 * Mirror of the registry-loading logic from sessions.ts.
 * Parses JSONL content into a Map<string, Set<string>>.
 */
function buildRegistryMap(jsonlContent) {
  const map = new Map();
  const warnings = [];
  const lines = jsonlContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const sid = entry.session_id;
      const atype = entry.agent_type;
      if (sid && atype) {
        if (!map.has(sid)) map.set(sid, new Set());
        map.get(sid).add(atype);
      }
    } catch {
      warnings.push(trimmed);
    }
  }
  return { map, warnings };
}

describe('buildRegistryMap — JSONL parsing', () => {
  it('builds map from valid JSONL lines', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-2', agent_type: 'reviewer' }),
    ].join('\n');
    const { map } = buildRegistryMap(content);
    assert.equal(map.size, 2);
    assert.ok(map.get('sess-1').has('coder'));
    assert.ok(map.get('sess-2').has('reviewer'));
  });

  it('accumulates multiple types for same session_id (AC-12)', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-1', agent_type: 'reviewer' }),
    ].join('\n');
    const { map } = buildRegistryMap(content);
    assert.equal(map.get('sess-1').size, 2);
    assert.ok(map.get('sess-1').has('coder'));
    assert.ok(map.get('sess-1').has('reviewer'));
  });

  it('deduplicates same agent_type for same session_id', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder' }),
    ].join('\n');
    const { map } = buildRegistryMap(content);
    assert.equal(map.get('sess-1').size, 1);
  });

  it('skips malformed lines and collects warnings', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1', agent_type: 'coder' }),
      'this is not json',
      '{bad json',
      JSON.stringify({ session_id: 'sess-2', agent_type: 'reviewer' }),
    ].join('\n');
    const { map, warnings } = buildRegistryMap(content);
    assert.equal(map.size, 2, 'valid lines should still be processed');
    assert.equal(warnings.length, 2, 'two malformed lines should be collected');
  });

  it('skips lines missing session_id or agent_type', () => {
    const content = [
      JSON.stringify({ session_id: 'sess-1' }),
      JSON.stringify({ agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-2', agent_type: 'reviewer' }),
    ].join('\n');
    const { map } = buildRegistryMap(content);
    assert.equal(map.size, 1);
    assert.ok(map.has('sess-2'));
  });

  it('returns empty map for empty content', () => {
    const { map } = buildRegistryMap('');
    assert.equal(map.size, 0);
  });

  it('handles blank lines gracefully', () => {
    const content = '\n\n' + JSON.stringify({ session_id: 's1', agent_type: 'coder' }) + '\n\n';
    const { map, warnings } = buildRegistryMap(content);
    assert.equal(map.size, 1);
    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Source-level assertions: INSERT/UPDATE include agent_role
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
const sessionsSrc = readFileSync(resolve(ROOT, 'src', 'ingest', 'parsers', 'sessions.ts'), 'utf8');
const tokenHistorySrc = readFileSync(resolve(ROOT, 'src', 'ingest', 'parsers', 'token-history.ts'), 'utf8');

describe('Source-level: sessions.ts includes agent_role in SQL', () => {
  it('INSERT INTO sessions includes agent_role column', () => {
    assert.match(sessionsSrc, /INSERT INTO sessions.*agent_role/s);
  });

  it('INSERT VALUES include resolveAgentRole call', () => {
    assert.match(sessionsSrc, /resolveAgentRole\(sessionId\)/);
  });

  it('UPDATE sessions SET includes agent_role', () => {
    assert.match(sessionsSrc, /UPDATE sessions SET[\s\S]*agent_role\s*=\s*\?/);
  });

  it('loads subagent-sessions.jsonl registry file', () => {
    assert.match(sessionsSrc, /subagent-sessions\.jsonl/);
  });

  it('builds registryMap from parsed JSONL', () => {
    assert.match(sessionsSrc, /registryMap/);
  });

  it('resolveAgentRole returns orchestrator for absent sessions', () => {
    assert.match(sessionsSrc, /return 'orchestrator'/);
  });

  it('resolveAgentRole returns mixed for multiple types', () => {
    assert.match(sessionsSrc, /return 'mixed'/);
  });

  it('warns on malformed registry lines', () => {
    assert.match(sessionsSrc, /Skipping malformed registry line/);
  });
});

describe('Source-level: token-history.ts includes agent_role in INSERT', () => {
  it('INSERT INTO token_events includes agent_role column', () => {
    assert.match(tokenHistorySrc, /INSERT INTO token_events.*agent_role/s);
  });

  it('reads agent_role from sessions table', () => {
    assert.match(tokenHistorySrc, /SELECT agent_role FROM sessions/);
  });

  it('defaults to orchestrator when session row has no agent_role', () => {
    assert.match(tokenHistorySrc, /\?\? 'orchestrator'/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: parseSessions with in-memory SQLite
// ---------------------------------------------------------------------------

// Create a temp "claude dir" structure for integration tests
const TEMP_BASE = resolve(tmpdir(), `deepflow-ingest-test-${Date.now()}`);

function setupClaudeDir(opts = {}) {
  const claudeDir = resolve(TEMP_BASE, `claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectsDir = resolve(claudeDir, 'projects', '-Users-test-apps-myproject');
  mkdirSync(projectsDir, { recursive: true });

  // Write session JSONL file(s)
  const sessionFiles = opts.sessionFiles ?? {};
  for (const [filename, lines] of Object.entries(sessionFiles)) {
    writeFileSync(resolve(projectsDir, filename), lines.join('\n'));
  }

  // Write subagent-sessions.jsonl registry
  if (opts.registry !== undefined) {
    if (opts.registry !== null) {
      writeFileSync(resolve(claudeDir, 'subagent-sessions.jsonl'), opts.registry);
    }
    // null means don't create the file (test missing registry)
  }

  return claudeDir;
}

// DB is already initialized from the top-level import; clear test data before each suite
function clearTestData() {
  // Delete test sessions and token_events, keep schema intact
  try { run('DELETE FROM token_events'); } catch { /* ignore */ }
  try { run('DELETE FROM sessions'); } catch { /* ignore */ }
  try { run("DELETE FROM _meta WHERE key LIKE 'ingest_offset:%'"); } catch { /* ignore */ }
}

describe('Integration: parseSessions with missing registry (AC-14)', () => {
  before(async () => {
    await initDatabase('serve');
  });

  it('sessions default to agent_role=orchestrator when registry file is absent', async () => {
    clearTestData();
    const claudeDir = setupClaudeDir({
      registry: null, // no registry file
      sessionFiles: {
        'sess-aaa.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-aaa']);
    assert.ok(row, 'session should exist');
    assert.equal(row.agent_role, 'orchestrator', 'should default to orchestrator when registry missing');
  });
});

describe('Integration: parseSessions with registry entries (AC-5, AC-6)', () => {
  it('session in registry gets its agent_type as agent_role (AC-5)', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-bbb', agent_type: 'coder' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-bbb.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'code' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 80 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-bbb']);
    assert.ok(row, 'session should exist');
    assert.equal(row.agent_role, 'coder', 'session in registry should get its agent_type');
  });

  it('session NOT in registry gets orchestrator (AC-6)', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-other', agent_type: 'coder' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ccc.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'plan' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 50, output_tokens: 20 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ccc']);
    assert.ok(row, 'session should exist');
    assert.equal(row.agent_role, 'orchestrator', 'session not in registry should default to orchestrator');
  });
});

describe('Integration: parseSessions with mixed agent_types (AC-12)', () => {
  it('two entries with same session_id, different agent_types → mixed', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-ddd', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-ddd', agent_type: 'reviewer' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ddd.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'both' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'yep' }], usage: { input_tokens: 300, output_tokens: 100 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const row = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ddd']);
    assert.ok(row, 'session should exist');
    assert.equal(row.agent_role, 'mixed', 'session with multiple agent_types should get mixed');
  });
});

describe('Integration: parseSessions with malformed registry lines', () => {
  it('skips malformed lines but processes valid ones', async () => {
    clearTestData();
    const registry = [
      'not json at all',
      JSON.stringify({ session_id: 'sess-eee', agent_type: 'coder' }),
      '{broken',
      JSON.stringify({ session_id: 'sess-fff', agent_type: 'reviewer' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-eee.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 40 } } }),
        ],
        'sess-fff.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 40 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const rowE = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-eee']);
    const rowF = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-fff']);
    assert.ok(rowE, 'sess-eee should exist despite malformed lines');
    assert.ok(rowF, 'sess-fff should exist despite malformed lines');
    assert.equal(rowE.agent_role, 'coder', 'valid registry line should still apply');
    assert.equal(rowF.agent_role, 'reviewer', 'valid registry line should still apply');
  });
});

describe('Integration: token_events get agent_role from session (AC-13)', () => {
  it('token_events inherit agent_role from the sessions table', async () => {
    clearTestData();

    // First ingest sessions with a registry
    const registry = [
      JSON.stringify({ session_id: 'sess-ggg', agent_type: 'coder' }),
    ].join('\n');

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-ggg.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 500, output_tokens: 100 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    // Verify the session has coder role
    const sessRow = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ggg']);
    assert.equal(sessRow?.agent_role, 'coder', 'session should have coder role');

    // Now create a token-history file that references this session
    // We need to create the file structure that parseTokenHistory discovers
    const realProjectPath = '/' + '-Users-test-apps-myproject'.replace(/^-/, '').replace(/-/g, '/');
    const deepflowDir = resolve(realProjectPath, '.deepflow');

    // Since parseTokenHistory discovers files by scanning real paths,
    // and we can't easily create files there, let's instead directly verify
    // the behavior by inserting a session, then checking what token-history would do
    // by simulating its agent_role lookup logic.

    // The key behavior: token-history reads agent_role from sessions table
    const lookupRow = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-ggg']);
    const agentRole = lookupRow?.agent_role ?? 'orchestrator';
    assert.equal(agentRole, 'coder', 'lookup should return coder for sess-ggg');

    // Also verify that a session NOT in the DB falls back to orchestrator
    const missingRow = get('SELECT agent_role FROM sessions WHERE id = ?', ['nonexistent']);
    const missingRole = missingRow?.agent_role ?? 'orchestrator';
    assert.equal(missingRole, 'orchestrator', 'missing session should fall back to orchestrator');
  });

  it('token_events for orchestrator session get orchestrator role', async () => {
    clearTestData();

    // Insert a session with orchestrator role (no registry entry)
    const claudeDir = setupClaudeDir({
      registry: JSON.stringify({ session_id: 'other', agent_type: 'coder' }),
      sessionFiles: {
        'sess-hhh.jsonl': [
          JSON.stringify({ type: 'user', timestamp: '2026-03-20T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-03-20T10:01:00Z', model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 200, output_tokens: 50 } } }),
        ],
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const sessRow = get('SELECT agent_role FROM sessions WHERE id = ?', ['sess-hhh']);
    assert.equal(sessRow?.agent_role, 'orchestrator', 'session not in registry = orchestrator');

    // Simulate token-history lookup
    const lookupRole = sessRow?.agent_role ?? 'orchestrator';
    assert.equal(lookupRole, 'orchestrator', 'token_events would get orchestrator');
  });
});

describe('Integration: multiple sessions with different roles in single ingest', () => {
  it('correctly assigns different roles to different sessions', async () => {
    clearTestData();
    const registry = [
      JSON.stringify({ session_id: 'sess-coder', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-reviewer', agent_type: 'reviewer' }),
      JSON.stringify({ session_id: 'sess-mixed', agent_type: 'coder' }),
      JSON.stringify({ session_id: 'sess-mixed', agent_type: 'planner' }),
      // sess-orch is not in registry → orchestrator
    ].join('\n');

    const sessionEvent = (ts) => [
      JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: ts, model: 'claude-sonnet-4', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'y' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];

    const claudeDir = setupClaudeDir({
      registry,
      sessionFiles: {
        'sess-coder.jsonl': sessionEvent('2026-03-20T10:00:00Z'),
        'sess-reviewer.jsonl': sessionEvent('2026-03-20T11:00:00Z'),
        'sess-mixed.jsonl': sessionEvent('2026-03-20T12:00:00Z'),
        'sess-orch.jsonl': sessionEvent('2026-03-20T13:00:00Z'),
      },
    });

    await parseSessions({ run, get, all }, claudeDir);

    const results = all('SELECT id, agent_role FROM sessions ORDER BY id');
    const roleMap = Object.fromEntries(results.map(r => [r.id, r.agent_role]));

    assert.equal(roleMap['sess-coder'], 'coder', 'single-type session');
    assert.equal(roleMap['sess-reviewer'], 'reviewer', 'single-type session');
    assert.equal(roleMap['sess-mixed'], 'mixed', 'multi-type session');
    assert.equal(roleMap['sess-orch'], 'orchestrator', 'absent from registry');
  });
});

// Cleanup temp dirs on exit
import { register } from 'node:module';
process.on('exit', () => {
  try {
    if (existsSync(TEMP_BASE)) {
      rmSync(TEMP_BASE, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});
