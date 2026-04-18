#!/usr/bin/env node
// Spike: validate columnOf / subStateOf regex determinism
// Run: node kanban-regex--determinism--spike.js

// --- Proposed regexes ---

/**
 * Derive kanban column from a spec file path.
 * Matches the basename prefix, not the directory name.
 */
function columnOf(filePath) {
  const base = filePath.split('/').pop(); // basename
  if (/^done-/.test(base)) return 'done';
  if (/^doing-/.test(base)) return 'doing';
  return 'backlog';
}

/**
 * Extract sub-state from spec content via HTML comment marker.
 * Returns first match or null. Case-insensitive, whitespace-tolerant.
 */
const SUB_STATE_RE = /<!--\s*sub_state:\s*(doing|waiting)\s*-->/i;

function subStateOf(content) {
  const m = SUB_STATE_RE.exec(content);
  return m ? m[1].toLowerCase() : null;
}

// --- Fixture table ---

const columnFixtures = [
  // [filePath, expected]
  ['specs/foo.md',                          'backlog'],
  ['specs/doing-foo.md',                    'doing'],
  ['specs/done-foo.md',                     'done'],
  ['specs/doing-foo-bar-baz.md',            'doing'],   // extra dashes
  ['specs/done-my-feature--v2.md',          'done'],    // double-dash
  ['.deepflow/specs-done/old-spec.md',      'backlog'], // archived: basename has no prefix
  ['specs/doingfoo.md',                     'backlog'], // no hyphen separator
  ['specs/done.md',                         'backlog'], // prefix IS the name, no hyphen
  ['doing-foo.md',                          'doing'],   // no directory
  ['a/b/c/done-nested.md',                  'done'],    // deep nested path
];

const subStateFixtures = [
  // [content, expected]
  ['<!-- sub_state: doing -->',              'doing'],
  ['<!-- sub_state: waiting -->',            'waiting'],
  ['<!--sub_state:doing-->',                 'doing'],   // no spaces
  ['<!--  sub_state:  waiting  -->',         'waiting'], // extra spaces
  ['<!-- SUB_STATE: DOING -->',              'doing'],   // uppercase
  ['text before <!-- sub_state: waiting --> text after', 'waiting'],
  ['no marker here',                         null],
  ['<!-- sub_state: unknown -->',            null],      // unknown value → no match
  ['<!-- kanban:sub_state=doing -->',        null],      // wrong format from spec draft (old)
  // multiple markers: first wins
  ['<!-- sub_state: waiting --> <!-- sub_state: doing -->', 'waiting'],
  // malformed markers
  ['<!-- sub_state doing -->',               null],      // missing colon
  ['<!-- sub_state: -->',                    null],      // empty value
];

// --- Runner ---

let pass = 0, fail = 0;

console.log('=== columnOf fixtures ===');
for (const [input, expected] of columnFixtures) {
  const actual = columnOf(input);
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} columnOf("${input}") → ${actual} (expected: ${expected})`);
}

console.log('\n=== subStateOf fixtures ===');
for (const [input, expected] of subStateFixtures) {
  const actual = subStateOf(input);
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} subStateOf("${input.slice(0, 60)}") → ${JSON.stringify(actual)} (expected: ${JSON.stringify(expected)})`);
}

console.log(`\n=== Results: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
