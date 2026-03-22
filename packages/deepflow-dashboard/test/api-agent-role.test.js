/**
 * Tests for T5: agent_role API endpoints in costs and sessions routes.
 *
 * Validates:
 *   - GET /api/costs returns by_agent_role array with correct aggregation
 *   - GET /api/costs returns by_agent_role_model array with correct cross-aggregation
 *   - by_agent_role respects user/days filters
 *   - GET /api/sessions?agent_role=orchestrator filters correctly
 *   - agent_role is in allowedFields (GET /api/sessions?fields=agent_role works)
 *   - Response includes agent_role field in session objects
 *
 * Strategy: Initialize a real in-memory SQLite DB via initDatabase(), insert
 * seed rows, then hit the Hono routes via app.request() (no HTTP server needed).
 *
 * Uses Node.js built-in node:test (ESM) to match project conventions.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// We import from dist (compiled ESM).
const { initDatabase, run, all } = await import(resolve(ROOT, 'dist', 'db', 'index.js'));
const { createApiRouter } = await import(resolve(ROOT, 'dist', 'api', 'index.js'));

// ---------------------------------------------------------------------------
// Test setup: in-memory DB + Hono app
// ---------------------------------------------------------------------------

let app;

before(async () => {
  // initDatabase writes to disk by default — we call it in 'serve' mode
  // which uses cwd(). The DB is in-memory via sql.js regardless.
  await initDatabase('serve');

  // Seed test sessions with different agent_roles, users, models, dates
  const sessions = [
    // orchestrator sessions
    { id: 'sess-orch-1', user: 'alice', project: 'proj-a', model: 'claude-sonnet-4-20250514', tokens_in: 1000, tokens_out: 200, cache_read: 0, cache_creation: 0, cost: 0.05, started_at: '2026-03-20T10:00:00Z', agent_role: 'orchestrator' },
    { id: 'sess-orch-2', user: 'alice', project: 'proj-a', model: 'claude-sonnet-4-20250514', tokens_in: 2000, tokens_out: 400, cache_read: 0, cache_creation: 0, cost: 0.10, started_at: '2026-03-21T10:00:00Z', agent_role: 'orchestrator' },
    { id: 'sess-orch-3', user: 'bob', project: 'proj-b', model: 'claude-haiku-4-5-20251001', tokens_in: 500, tokens_out: 100, cache_read: 0, cache_creation: 0, cost: 0.01, started_at: '2026-03-21T11:00:00Z', agent_role: 'orchestrator' },
    // coder sessions
    { id: 'sess-coder-1', user: 'alice', project: 'proj-a', model: 'claude-sonnet-4-20250514', tokens_in: 5000, tokens_out: 1000, cache_read: 0, cache_creation: 0, cost: 0.25, started_at: '2026-03-20T12:00:00Z', agent_role: 'coder' },
    { id: 'sess-coder-2', user: 'alice', project: 'proj-a', model: 'claude-haiku-4-5-20251001', tokens_in: 3000, tokens_out: 600, cache_read: 0, cache_creation: 0, cost: 0.08, started_at: '2026-03-21T14:00:00Z', agent_role: 'coder' },
    // reviewer session
    { id: 'sess-rev-1', user: 'bob', project: 'proj-b', model: 'claude-sonnet-4-20250514', tokens_in: 800, tokens_out: 150, cache_read: 0, cache_creation: 0, cost: 0.04, started_at: '2026-03-22T09:00:00Z', agent_role: 'reviewer' },
    // old session (> 7 days ago, for days filter testing)
    { id: 'sess-old-1', user: 'alice', project: 'proj-a', model: 'claude-sonnet-4-20250514', tokens_in: 10000, tokens_out: 2000, cache_read: 0, cache_creation: 0, cost: 1.00, started_at: '2026-01-01T10:00:00Z', agent_role: 'orchestrator' },
  ];

  for (const s of sessions) {
    run(
      `INSERT OR REPLACE INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cost, started_at, agent_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.user, s.project, s.model, s.tokens_in, s.tokens_out, s.cache_read, s.cache_creation, s.cost, s.started_at, s.agent_role]
    );
  }

  // Create Hono app with API routes
  const { Hono } = await import('hono');
  app = new Hono();
  app.route('/api', createApiRouter({ mode: 'serve' }));
});

// Helper to make requests and parse JSON
async function getJson(path) {
  const res = await app.request(path);
  assert.equal(res.status, 200, `Expected 200 for ${path}, got ${res.status}`);
  return res.json();
}

// ===========================================================================
// GET /api/costs — by_agent_role
// ===========================================================================

describe('GET /api/costs — by_agent_role aggregation', () => {
  it('response includes by_agent_role array', async () => {
    const body = await getJson('/api/costs?days=90');
    assert.ok(Array.isArray(body.by_agent_role), 'by_agent_role should be an array');
  });

  it('by_agent_role groups costs by agent_role', async () => {
    const body = await getJson('/api/costs?days=90');
    const roles = body.by_agent_role.map((r) => r.agent_role).sort();
    // All 3 roles present (orchestrator, coder, reviewer) + the old session's orchestrator
    assert.ok(roles.includes('orchestrator'), 'should include orchestrator');
    assert.ok(roles.includes('coder'), 'should include coder');
    assert.ok(roles.includes('reviewer'), 'should include reviewer');
  });

  it('by_agent_role sums cost correctly for orchestrator', async () => {
    const body = await getJson('/api/costs?days=90');
    const orch = body.by_agent_role.find((r) => r.agent_role === 'orchestrator');
    assert.ok(orch, 'orchestrator row should exist');
    // sess-orch-1 (0.05) + sess-orch-2 (0.10) + sess-orch-3 (0.01) + sess-old-1 (1.00) = 1.16
    assert.ok(Math.abs(orch.cost - 1.16) < 0.001, `orchestrator cost should be ~1.16, got ${orch.cost}`);
  });

  it('by_agent_role sums input_tokens and output_tokens', async () => {
    const body = await getJson('/api/costs?days=90');
    const coder = body.by_agent_role.find((r) => r.agent_role === 'coder');
    assert.ok(coder, 'coder row should exist');
    // sess-coder-1 (5000+3000=8000 in, 1000+600=1600 out)
    assert.equal(coder.input_tokens, 8000, 'coder input_tokens');
    assert.equal(coder.output_tokens, 1600, 'coder output_tokens');
  });
});

// ===========================================================================
// GET /api/costs — by_agent_role_model
// ===========================================================================

describe('GET /api/costs — by_agent_role_model cross-aggregation', () => {
  it('response includes by_agent_role_model array', async () => {
    const body = await getJson('/api/costs?days=90');
    assert.ok(Array.isArray(body.by_agent_role_model), 'by_agent_role_model should be an array');
  });

  it('by_agent_role_model has both agent_role and model fields', async () => {
    const body = await getJson('/api/costs?days=90');
    for (const row of body.by_agent_role_model) {
      assert.ok('agent_role' in row, 'each row should have agent_role');
      assert.ok('model' in row, 'each row should have model');
      assert.ok('cost' in row, 'each row should have cost');
    }
  });

  it('by_agent_role_model groups by (agent_role, model) pairs', async () => {
    const body = await getJson('/api/costs?days=90');
    const pairs = body.by_agent_role_model.map((r) => `${r.agent_role}:${r.model}`);
    // coder has two models: sonnet and haiku
    assert.ok(pairs.includes('coder:claude-sonnet-4-20250514'), 'coder:sonnet pair');
    assert.ok(pairs.includes('coder:claude-haiku-4-5-20251001'), 'coder:haiku pair');
  });

  it('by_agent_role_model sums correctly for coder:haiku', async () => {
    const body = await getJson('/api/costs?days=90');
    const coderHaiku = body.by_agent_role_model.find(
      (r) => r.agent_role === 'coder' && r.model === 'claude-haiku-4-5-20251001'
    );
    assert.ok(coderHaiku, 'coder:haiku row should exist');
    assert.equal(coderHaiku.input_tokens, 3000);
    assert.equal(coderHaiku.output_tokens, 600);
    assert.ok(Math.abs(coderHaiku.cost - 0.08) < 0.001);
  });
});

// ===========================================================================
// GET /api/costs — by_agent_role respects user filter
// ===========================================================================

describe('GET /api/costs — by_agent_role with user filter', () => {
  it('filters by_agent_role to only the specified user', async () => {
    const body = await getJson('/api/costs?days=90&user=bob');
    const roles = body.by_agent_role.map((r) => r.agent_role).sort();
    // bob has: sess-orch-3 (orchestrator) and sess-rev-1 (reviewer)
    assert.deepEqual(roles, ['orchestrator', 'reviewer'], 'bob should only have orchestrator and reviewer');
  });

  it('user-filtered orchestrator cost reflects only that user', async () => {
    const body = await getJson('/api/costs?days=90&user=bob');
    const orch = body.by_agent_role.find((r) => r.agent_role === 'orchestrator');
    assert.ok(orch, 'orchestrator row should exist for bob');
    // Only sess-orch-3 (0.01)
    assert.ok(Math.abs(orch.cost - 0.01) < 0.001, `bob orchestrator cost should be ~0.01, got ${orch.cost}`);
  });
});

// ===========================================================================
// GET /api/costs — by_agent_role respects days filter
// ===========================================================================

describe('GET /api/costs — by_agent_role with days filter', () => {
  it('days=7 excludes old sessions from by_agent_role', async () => {
    const body = await getJson('/api/costs?days=7');
    const orch = body.by_agent_role.find((r) => r.agent_role === 'orchestrator');
    assert.ok(orch, 'orchestrator row should exist');
    // With days=7, sess-old-1 (1.00) should be excluded
    // Only sess-orch-1 (0.05) + sess-orch-2 (0.10) + sess-orch-3 (0.01) = 0.16
    assert.ok(Math.abs(orch.cost - 0.16) < 0.001, `orchestrator cost with days=7 should be ~0.16, got ${orch.cost}`);
  });
});

// ===========================================================================
// GET /api/sessions — agent_role query param filter
// ===========================================================================

describe('GET /api/sessions — agent_role filter', () => {
  it('filters sessions by agent_role=orchestrator', async () => {
    const body = await getJson('/api/sessions?agent_role=orchestrator');
    assert.ok(body.data.length > 0, 'should return at least one session');
    for (const row of body.data) {
      assert.equal(row.agent_role, 'orchestrator', 'all returned sessions should be orchestrator');
    }
  });

  it('returns correct count for agent_role=orchestrator', async () => {
    const body = await getJson('/api/sessions?agent_role=orchestrator');
    // sess-orch-1, sess-orch-2, sess-orch-3, sess-old-1 = 4
    assert.equal(body.total, 4, 'should have 4 orchestrator sessions');
  });

  it('filters sessions by agent_role=coder', async () => {
    const body = await getJson('/api/sessions?agent_role=coder');
    assert.equal(body.total, 2, 'should have 2 coder sessions');
    for (const row of body.data) {
      assert.equal(row.agent_role, 'coder');
    }
  });

  it('filters sessions by agent_role=reviewer', async () => {
    const body = await getJson('/api/sessions?agent_role=reviewer');
    assert.equal(body.total, 1, 'should have 1 reviewer session');
    assert.equal(body.data[0].agent_role, 'reviewer');
  });

  it('returns empty when filtering by nonexistent agent_role', async () => {
    const body = await getJson('/api/sessions?agent_role=nonexistent');
    assert.equal(body.total, 0, 'should have 0 sessions for nonexistent role');
    assert.equal(body.data.length, 0);
  });

  it('combines agent_role filter with user filter', async () => {
    const body = await getJson('/api/sessions?agent_role=orchestrator&user=alice');
    // alice orchestrator: sess-orch-1, sess-orch-2, sess-old-1 = 3
    assert.equal(body.total, 3, 'alice should have 3 orchestrator sessions');
    for (const row of body.data) {
      assert.equal(row.agent_role, 'orchestrator');
      assert.equal(row.user, 'alice');
    }
  });
});

// ===========================================================================
// GET /api/sessions — agent_role in allowedFields (fields= whitelist)
// ===========================================================================

describe('GET /api/sessions — agent_role in allowedFields', () => {
  it('fields=agent_role returns only agent_role column', async () => {
    const body = await getJson('/api/sessions?fields=agent_role');
    assert.ok(body.data.length > 0, 'should return data');
    for (const row of body.data) {
      assert.ok('agent_role' in row, 'row should have agent_role field');
      // When selecting only agent_role, other fields should NOT be present
      assert.ok(!('tokens_in' in row), 'row should not have tokens_in when only agent_role selected');
    }
  });

  it('fields=agent_role,cost returns both columns', async () => {
    const body = await getJson('/api/sessions?fields=agent_role,cost');
    assert.ok(body.data.length > 0);
    for (const row of body.data) {
      assert.ok('agent_role' in row, 'row should have agent_role');
      assert.ok('cost' in row, 'row should have cost');
      assert.ok(!('tokens_in' in row), 'row should not have tokens_in');
    }
  });
});

// ===========================================================================
// GET /api/sessions — agent_role field present in full response
// ===========================================================================

describe('GET /api/sessions — agent_role in full response objects', () => {
  it('session objects include agent_role when no fields filter', async () => {
    const body = await getJson('/api/sessions');
    assert.ok(body.data.length > 0, 'should return sessions');
    for (const row of body.data) {
      assert.ok('agent_role' in row, 'every session should have agent_role field');
      assert.ok(
        typeof row.agent_role === 'string',
        `agent_role should be a string, got ${typeof row.agent_role}`
      );
    }
  });

  it('agent_role values match what was inserted', async () => {
    const body = await getJson('/api/sessions?limit=500');
    const roles = new Set(body.data.map((r) => r.agent_role));
    assert.ok(roles.has('orchestrator'));
    assert.ok(roles.has('coder'));
    assert.ok(roles.has('reviewer'));
  });
});

// ===========================================================================
// Source-level: verify costs.ts response shape includes new keys
// ===========================================================================

import { readFileSync } from 'node:fs';
const costsSrc = readFileSync(resolve(ROOT, 'src', 'api', 'costs.ts'), 'utf8');
const sessionsSrc = readFileSync(resolve(ROOT, 'src', 'api', 'sessions.ts'), 'utf8');

describe('Source-level: costs.ts response includes by_agent_role keys', () => {

  it('response JSON includes by_agent_role key', () => {
    assert.ok(costsSrc.includes('by_agent_role:'), 'costs.ts should include by_agent_role in response');
  });

  it('response JSON includes by_agent_role_model key', () => {
    assert.ok(costsSrc.includes('by_agent_role_model:'), 'costs.ts should include by_agent_role_model in response');
  });

  it('by_agent_role query groups by agent_role', () => {
    assert.match(costsSrc, /GROUP BY agent_role\b/);
  });

  it('by_agent_role_model query groups by agent_role and model', () => {
    assert.match(costsSrc, /GROUP BY agent_role, model/);
  });
});

// ===========================================================================
// Source-level: sessions.ts has agent_role in allowedFields
// ===========================================================================

describe('Source-level: sessions.ts allowedFields includes agent_role', () => {

  it('allowedFields array contains agent_role', () => {
    assert.match(sessionsSrc, /allowedFields\s*=\s*\[.*'agent_role'.*\]/);
  });

  it('agent_role query param is read from request', () => {
    assert.match(sessionsSrc, /c\.req\.query\('agent_role'\)/);
  });

  it('agent_role condition is added to WHERE clause', () => {
    assert.match(sessionsSrc, /agent_role = \?/);
  });
});
