#!/usr/bin/env node
// Spike: prove byte-identical round-trip for Standard Task template.
// Strategy: {{TOKEN}} placeholders; caller PRE-RENDERS conditional blocks
// (empty string when absent). Resolver stays trivial.

const fs = require('fs');
const path = require('path');

function render(template, ctx) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in ctx)) throw new Error('missing token: ' + k);
    return String(ctx[k]);
  });
}

const dir = __dirname;
const tmpl = fs.readFileSync(path.join(dir, 'standard-task.tmpl'), 'utf8');

// Shared literal values
const TASK_ID = 'T42';
const DESCRIPTION = 'add login form';
const FILES = 'src/login.ts';
const SPEC = 'specs/doing-login.md';
const ACS = 'AC-1 form renders, AC-2 submit works';
const FALLBACK_BODY = [
  'Impact: Callers: src/app.ts (bootstraps login) | Duplicates: [active→consolidate] [dead→DELETE] | Data flow: auth store',
  'Prior tasks: T40: scaffolded auth module',
  'Steps: 1. chub search/get for APIs 2. LSP findReferences, add unlisted callers 3. LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files) 4. Implement 5. Commit',
].join('\n');

// ---- Minimal fixture: all conditionals empty, task_body uses fallback ----
const ctxMin = {
  TASK_ID, DESCRIPTION, FILES, SPEC, ACS,
  REVERTED_BLOCK: '',
  SPIKE_BLOCK: '',
  DOMAIN_MODEL_BLOCK: '',
  EXISTING_TYPES_BLOCK: '',
  TASK_BODY: FALLBACK_BODY,
};

// ---- Full fixture: all conditionals present, task_body is custom ----
const spikeBlock =
  'spike_results:\n' +
  '  hypothesis: form validates email\n' +
  '  outcome: PASS\n' +
  '  edge_cases: empty string, unicode\n' +
  '  insight: use HTML5 validation\n';

const ctxFull = {
  TASK_ID, DESCRIPTION, FILES, SPEC, ACS,
  REVERTED_BLOCK: 'DO NOT repeat: - Cycle 3: "flaky test"\n',
  SPIKE_BLOCK: spikeBlock,
  DOMAIN_MODEL_BLOCK: '--- CONTEXT: Domain Model ---\nUser {id, email}\nSession {userId, token}\n',
  EXISTING_TYPES_BLOCK: '--- CONTEXT: Existing Types ---\ninterface LoginForm { email: string; password: string }\n',
  TASK_BODY: 'Custom task body pulled from WAVE_JSON.task_detail_body',
};

function check(label, ctx, expectedPath) {
  const rendered = render(tmpl, ctx);
  const expected = fs.readFileSync(path.join(dir, expectedPath), 'utf8');
  const ok = rendered === expected;
  console.log(`[${label}] byte-identical: ${ok}`);
  if (!ok) {
    const rb = Buffer.from(rendered), eb = Buffer.from(expected);
    console.log(`  rendered bytes: ${rb.length}, expected bytes: ${eb.length}`);
    const min = Math.min(rb.length, eb.length);
    for (let i = 0; i < min; i++) {
      if (rb[i] !== eb[i]) {
        console.log(`  first diff at byte ${i}: rendered=${JSON.stringify(rendered.slice(Math.max(0,i-20), i+20))}`);
        console.log(`                         expected=${JSON.stringify(expected.slice(Math.max(0,i-20), i+20))}`);
        break;
      }
    }
    if (rb.length !== eb.length && rb.slice(0, min).equals(eb.slice(0, min))) {
      console.log(`  diff is trailing bytes only. extra: ${JSON.stringify((rb.length > eb.length ? rendered : expected).slice(min))}`);
    }
  }
  return ok;
}

const r1 = check('minimal (optional blocks collapsed)', ctxMin, 'expected-minimal.txt');
const r2 = check('full    (all blocks present)',       ctxFull, 'expected-full.txt');

if (r1 && r2) {
  console.log('\nSPIKE RESULT: PASS — byte-identical round-trip on both fixtures.');
  process.exit(0);
} else {
  console.log('\nSPIKE RESULT: FAIL');
  process.exit(1);
}
