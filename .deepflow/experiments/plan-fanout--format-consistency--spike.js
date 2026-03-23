#!/usr/bin/env node
/**
 * Spike: plan-fanout format consistency validation
 *
 * Tests regex-based parsing against 5 simulated sub-agent outputs.
 * Validates that markdown-only mini-plans are parseable without failures.
 *
 * Usage: node .deepflow/experiments/plan-fanout--format-consistency--spike.js
 * Exit: 0 = all parses succeeded, 1 = parse failures found
 */

'use strict';

// ---------------------------------------------------------------------------
// 5 simulated sub-agent outputs (one per spec variant)
// ---------------------------------------------------------------------------

const agentOutputs = [
  // Agent 1: Trivial — logger utility
  {
    name: 'logger-utility',
    output: `### logger-utility

- [ ] **T1**: Add structured logger module with configurable log levels
  - Files: src/utils/logger.js
  - Blocked by: none

- [ ] **T2**: Add logger integration tests
  - Files: test/utils/logger.test.js
  - Blocked by: T1`,
  },

  // Agent 2: Medium — REST endpoint with auth
  {
    name: 'auth-endpoint',
    output: `### auth-endpoint

- [ ] **T1**: Implement POST /auth/login endpoint with JWT issuance
  - Files: src/routes/auth.js, src/middleware/jwt.js
  - Blocked by: none

- [ ] **T2**: Add rate limiting middleware to auth routes
  - Files: src/middleware/rateLimit.js
  - Blocked by: T1

- [ ] **T3**: Write integration tests for login and rate limiting
  - Files: test/routes/auth.test.js
  - Blocked by: T2`,
  },

  // Agent 3: Medium — Config file parser
  {
    name: 'config-parser',
    output: `### config-parser

- [ ] **T1**: Implement YAML config file reader with schema validation
  - Files: src/config/reader.js, src/config/schema.js
  - Blocked by: none

- [ ] **T2**: Add config hot-reload watcher using fs.watch
  - Files: src/config/watcher.js
  - Blocked by: T1

- [ ] **T3** [SPIKE]: Validate config merge strategy for nested overrides
  - Files: .deepflow/experiments/config-parser--merge-strategy--active.md
  - Blocked by: none`,
  },

  // Agent 4: Complex — Multi-tenant data layer
  {
    name: 'multi-tenant-data',
    output: `### multi-tenant-data

- [ ] **T1**: Create tenant context middleware with request-scoped isolation
  - Files: src/middleware/tenantContext.js
  - Blocked by: none

- [ ] **T2**: Implement tenant-aware query builder wrapping Knex
  - Files: src/db/tenantQueryBuilder.js
  - Blocked by: T1

- [ ] **T3**: Add tenant provisioning API (create, suspend, delete)
  - Files: src/api/tenants.js, src/db/tenantLifecycle.js
  - Blocked by: T1

- [ ] **T4**: Implement cross-tenant audit log with append-only writes
  - Files: src/db/auditLog.js, src/middleware/auditMiddleware.js
  - Blocked by: T2, T3

- [ ] **T5**: Write load tests verifying tenant isolation under concurrent requests
  - Files: test/load/tenantIsolation.test.js
  - Blocked by: T4`,
  },

  // Agent 5: Constrained — DB migration with rollback safety
  {
    name: 'db-migration',
    output: `### db-migration

- [ ] **T1** [SPIKE]: Validate that migration dry-run mode works with postgres test container
  - Files: .deepflow/experiments/db-migration--dry-run--active.md
  - Blocked by: none
  - Blocks: T2, T3

- [ ] **T2**: Implement forward migration runner with checksum verification
  - Files: src/migrations/runner.js, src/migrations/checksum.js
  - Blocked by: T1

- [ ] **T3**: Implement rollback runner with pre-migration snapshot capture
  - Files: src/migrations/rollback.js, src/migrations/snapshot.js
  - Blocked by: T1

- [ ] **T4**: Write migration tests covering forward, rollback, and conflict scenarios
  - Files: test/migrations/runner.test.js
  - Blocked by: T2, T3`,
  },
];

// ---------------------------------------------------------------------------
// Regex patterns (mirrors wave-runner.js + additional field extraction)
// ---------------------------------------------------------------------------

// Matches: - [ ] **T{N}**: description
//          - [ ] **T{N}** [TAG]: description
const RE_TASK = /^\s*-\s+\[\s+\]\s+\*\*T(\d+)\*\*(?:\s+\[[^\]]*\])?[:\s]*(.*)/;

// Matches: - Files: path1, path2
const RE_FILES = /^\s+-\s+Files?:\s*(.+)/i;

// Matches: - Blocked by: none | T1 | T1, T2
const RE_BLOCKED = /^\s+-\s+Blocked\s+by:\s*(.+)/i;

// ---------------------------------------------------------------------------
// Parser: extract tasks with their annotations from a mini-plan text
// ---------------------------------------------------------------------------

function parseMiniPlan(text) {
  const lines = text.split('\n');
  const tasks = [];
  let current = null;

  for (const line of lines) {
    const taskMatch = line.match(RE_TASK);
    if (taskMatch) {
      current = {
        id: `T${taskMatch[1]}`,
        description: taskMatch[2].trim(),
        files: null,
        blockedBy: null,
        parseErrors: [],
      };
      tasks.push(current);
      continue;
    }

    if (!current) continue;

    const filesMatch = line.match(RE_FILES);
    if (filesMatch) {
      current.files = filesMatch[1].trim();
      continue;
    }

    const blockedMatch = line.match(RE_BLOCKED);
    if (blockedMatch) {
      current.blockedBy = blockedMatch[1].trim();
      continue;
    }
  }

  // Validate required fields
  for (const task of tasks) {
    if (!task.files) {
      task.parseErrors.push(`${task.id}: missing Files: field`);
    }
    if (task.blockedBy === null) {
      task.parseErrors.push(`${task.id}: missing Blocked by: field`);
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Run spike: parse all 5 outputs, collect results
// ---------------------------------------------------------------------------

let totalTasks = 0;
let totalFailures = 0;
const results = [];

for (const agent of agentOutputs) {
  const tasks = parseMiniPlan(agent.output);
  const failures = tasks.flatMap(t => t.parseErrors);

  results.push({
    name: agent.name,
    taskCount: tasks.length,
    failures,
  });

  totalTasks += tasks.length;
  totalFailures += failures.length;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('=== plan-fanout format consistency spike ===\n');
console.log('Prompt template format: markdown-only (no JSON schema)\n');

let allPassed = true;

for (const r of results) {
  const status = r.failures.length === 0 ? 'PASS' : 'FAIL';
  if (r.failures.length > 0) allPassed = false;
  console.log(`Agent [${r.name}]: ${r.taskCount} tasks — ${status}`);
  if (r.failures.length > 0) {
    for (const f of r.failures) {
      console.log(`  ERROR: ${f}`);
    }
  }
}

console.log('');
console.log(`Total tasks parsed: ${totalTasks}`);
console.log(`Total parse failures: ${totalFailures}`);
console.log(`Consistency score: ${totalFailures === 0 ? '100%' : Math.round((1 - totalFailures / (totalTasks * 2)) * 100) + '%'}`);
console.log('');
console.log(`RESULT: ${allPassed ? 'PASS — hypothesis validated' : 'FAIL — hypothesis rejected'}`);

process.exit(allPassed ? 0 : 1);
