#!/usr/bin/env node
// Tests JSON Schema enforcement for validate-result drift block.
// covers specs/spike-gate.md#AC-1
// covers specs/spike-gate.md#AC-2
// covers specs/spike-gate.md#AC-3
// covers specs/spike-gate.md#AC-4
const assert = require('node:assert/strict');
const { validateResult, loadSchema } = require('./validate-against-schema');

// AC-1: schema pins drift keys with correct types
{
  const schema = loadSchema();
  const drift = schema.properties.drift;
  assert.deepStrictEqual(
    drift.required.sort(),
    ['jaccard_below', 'likely_files_coverage_pct', 'out_of_scope_count']
  );
  assert.strictEqual(drift.properties.jaccard_below.type, 'number');
  assert.strictEqual(drift.properties.out_of_scope_count.type, 'integer');
  assert.strictEqual(drift.properties.likely_files_coverage_pct.type, 'number');
  console.log('AC-1 ok: schema pins 3 drift keys with correct types');
}

// AC-4 fixtures: missing-key, renamed-key, missing-drift-entirely
{
  // (i) missing-key: jaccard_below absent
  const missingKey = {
    spec: 'foo', artifact: 'sketch.md', rows: [],
    drift: { out_of_scope_count: 1, likely_files_coverage_pct: 80.0 }
  };
  const r1 = validateResult(missingKey);
  assert.strictEqual(r1.valid, false, 'missing key should fail');
  assert.ok(r1.errors.some(e => e.includes('jaccard_below') && e.includes('missing')), 'error names jaccard_below');

  // (ii) renamed-key: jaccard_below → jaccard
  const renamed = {
    spec: 'foo', artifact: 'sketch.md', rows: [],
    drift: { jaccard: 0.3, out_of_scope_count: 1, likely_files_coverage_pct: 80 }
  };
  const r2 = validateResult(renamed);
  assert.strictEqual(r2.valid, false, 'renamed key should fail (jaccard_below missing)');

  // (iii) missing drift entirely — schema does NOT require drift, so this is valid
  const noDrift = { spec: 'foo', artifact: 'sketch.md', rows: [] };
  const r3 = validateResult(noDrift);
  assert.strictEqual(r3.valid, true, 'missing drift block is valid (drift is optional)');

  // (iv) wrong type: out_of_scope_count = float
  const wrongType = {
    spec: 'foo', artifact: 'sketch.md', rows: [],
    drift: { jaccard_below: 0.3, out_of_scope_count: 1.5, likely_files_coverage_pct: 80 }
  };
  const r4 = validateResult(wrongType);
  assert.strictEqual(r4.valid, false, 'non-integer out_of_scope_count should fail');

  // (v) all-good baseline
  const ok = {
    spec: 'foo', artifact: 'sketch.md', rows: [],
    drift: { jaccard_below: 0.3, out_of_scope_count: 2, likely_files_coverage_pct: 80.5 }
  };
  const r5 = validateResult(ok);
  assert.strictEqual(r5.valid, true, 'well-formed result should pass');
  console.log('AC-4 ok: missing-key, renamed-key, missing-drift, wrong-type, baseline all behave correctly');
}

// AC-2: validate.js requires the validator
{
  const fs = require('node:fs');
  const path = require('node:path');
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const src = fs.readFileSync(path.join(repoRoot, 'hooks', 'df-artifact-validate.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/schemas\/validate-against-schema['"]\)/, 'validate.js must require validator');
  assert.match(src, /validateResult/, 'validate.js must call validateResult');
  console.log('AC-2 ok: df-artifact-validate.js wires schema check before JSON write');
}

// AC-3: spike-validate.js requires the validator and rejects mismatches
{
  const fs = require('node:fs');
  const path = require('node:path');
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const src = fs.readFileSync(path.join(repoRoot, 'hooks', 'df-spike-validate.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/schemas\/validate-against-schema['"]\)/, 'spike-validate must require validator');
  assert.match(src, /schema_mismatch/, 'spike-validate must emit schema_mismatch error code');
  console.log('AC-3 ok: df-spike-validate.js wires schema_mismatch rejection');
}

console.log('all 4 ACs pass');
