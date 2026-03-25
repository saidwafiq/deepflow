#!/usr/bin/env node
/**
 * Behavior tests for eval fixture
 *
 * These tests verify that the skill produced correct functional output,
 * not just that files exist. Run after the skill execution completes.
 *
 * Run: node tests/behavior.test.js
 * Exit 0 = all pass, exit 1 = one or more failed
 */

const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixture');

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function assertArtifact(taskId, extraChecks = () => {}) {
  const artifactPath = path.join(FIXTURE_DIR, 'output', taskId, 'result.json');
  const exists = fs.existsSync(artifactPath);

  assert(`output/${taskId}/result.json exists`, exists);

  if (!exists) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (e) {
    assert(`output/${taskId}/result.json is valid JSON`, false, e.message);
    return;
  }

  assert(`output/${taskId} status === "complete"`, data.status === 'complete');
  extraChecks(data);
}

// ---------------------------------------------------------------------------
// Task output tests — verify skill produced the expected artifacts
// ---------------------------------------------------------------------------

console.log('\n[behavior] Task output checks');

assertArtifact('T1', (data) => {
  assert('T1 has message field', typeof data.message === 'string');
});

assertArtifact('T2', (data) => {
  assert('T2 has items field', data.items !== undefined);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n[behavior] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
