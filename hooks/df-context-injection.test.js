'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, 'df-context-injection.js');
const {
  extractTaskId,
  parseCuratedSection,
  renderInjection,
  INJECTION_MARKER,
} = require('./df-context-injection');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-ctx-inj-'));
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  return dir;
}

function writeSpec(repoDir, name, content) {
  fs.writeFileSync(path.join(repoDir, 'specs', name), content, 'utf8');
}

function runHook(payload, cwd) {
  return spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({ ...payload, cwd }),
    encoding: 'utf8',
  });
}

function curatedSpec(tasks) {
  const blocks = tasks.map(
    (t) => `### ${t.id}: ${t.title || 'example'}
**Slice:** ${t.slice || 'new file foo.js'}
**Parallel:** ${t.parallel || '[P]'}
**Context bundle:**
${t.bundle || 'some bundle text here'}
**Subagent prompt:**
${t.prompt || 'do the thing'}
`,
  );
  return `# Spec

## Tasks (curated)

${blocks.join('\n')}
`;
}

describe('extractTaskId', () => {
  it('returns null for empty prompt', () => {
    assert.equal(extractTaskId(''), null);
  });

  it('returns null for null prompt', () => {
    assert.equal(extractTaskId(null), null);
  });

  it('returns null for undefined prompt', () => {
    assert.equal(extractTaskId(undefined), null);
  });

  it('parses "T1: do this" → T1', () => {
    assert.equal(extractTaskId('T1: do this'), 'T1');
  });

  it('parses "Task: T42" → T42', () => {
    assert.equal(extractTaskId('Task: T42'), 'T42');
  });

  it('parses "## Task T7" → T7', () => {
    assert.equal(extractTaskId('## Task T7'), 'T7');
  });

  it('parses "## T3 implementation" → T3', () => {
    assert.equal(extractTaskId('## T3 implementation'), 'T3');
  });

  it('returns null for "no task here"', () => {
    assert.equal(extractTaskId('no task here'), null);
  });

  it('handles case insensitivity: "task: t5" → T5', () => {
    assert.equal(extractTaskId('task: t5'), 'T5');
  });
});

describe('parseCuratedSection', () => {
  it('returns [] when no curated header', () => {
    assert.deepEqual(parseCuratedSection('# Spec\n\nNo curated section here.'), []);
  });

  it('returns [] for empty content', () => {
    assert.deepEqual(parseCuratedSection(''), []);
  });

  it('parses a single task entry', () => {
    const spec = curatedSpec([
      { id: 'T1', bundle: 'some bundle text here', prompt: 'do the thing' },
    ]);
    const result = parseCuratedSection(spec);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'T1');
    assert.equal(result[0].slice, 'new file foo.js');
    assert.equal(result[0].parallel, '[P]');
    assert.match(result[0].context_bundle, /some bundle text here/);
    assert.match(result[0].subagent_prompt, /do the thing/);
  });

  it('parses two task entries', () => {
    const spec = curatedSpec([
      { id: 'T1', bundle: 'bundle one', prompt: 'prompt one' },
      { id: 'T2', bundle: 'bundle two', prompt: 'prompt two' },
    ]);
    const result = parseCuratedSection(spec);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'T1');
    assert.equal(result[1].id, 'T2');
    assert.match(result[0].context_bundle, /bundle one/);
    assert.match(result[1].context_bundle, /bundle two/);
  });

  it('stops at next ## section header', () => {
    const spec = `# Spec

## Tasks (curated)

### T1: example
**Slice:** new file foo.js
**Parallel:** [P]
**Context bundle:**
the bundle
**Subagent prompt:**
the prompt

## Other Section

### T99: should not parse
**Slice:** nope
**Parallel:** [P]
**Context bundle:**
nope
**Subagent prompt:**
nope
`;
    const result = parseCuratedSection(spec);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'T1');
  });

  it('preserves code fences in bundle verbatim', () => {
    const fenced = '```js\nconst x = 1;\n```';
    const spec = `# Spec

## Tasks (curated)

### T1: example
**Slice:** new file foo.js
**Parallel:** [P]
**Context bundle:**
${fenced}
**Subagent prompt:**
do it
`;
    const result = parseCuratedSection(spec);
    assert.equal(result.length, 1);
    assert.match(result[0].context_bundle, /```js/);
    assert.match(result[0].context_bundle, /const x = 1;/);
    assert.match(result[0].context_bundle, /```/);
  });
});

describe('renderInjection', () => {
  it('renders task fields into output string', () => {
    const out = renderInjection({
      id: 'T1',
      context_bundle: 'X',
      subagent_prompt: 'Y',
    });
    assert.match(out, /T1/);
    assert.match(out, /X/);
    assert.match(out, /Y/);
  });

  it('does NOT include INJECTION_MARKER (added by main, not renderInjection)', () => {
    const out = renderInjection({
      id: 'T1',
      context_bundle: 'X',
      subagent_prompt: 'Y',
    });
    // INJECTION_MARKER is appended by main() between bundle and original prompt;
    // renderInjection only produces the bundle itself.
    assert.ok(!out.includes(INJECTION_MARKER));
  });
});

describe('end-to-end pass-through cases', () => {
  let repo;

  beforeEach(() => {
    repo = tmpRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('non-Task tool → no injection', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('missing tool_input → no injection', () => {
    const r = runHook({ tool_name: 'Task' }, repo);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('no specs/doing-*.md files → no injection', () => {
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('spec without curated section → no injection', () => {
    writeSpec(repo, 'doing-legacy.md', '# Legacy\n\n## Tasks\n- T1: old format\n');
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('no task_id in prompt → no injection', () => {
    writeSpec(repo, 'doing-foo.md', curatedSpec([{ id: 'T1' }]));
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'do something',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('task_id not present in any spec → no injection', () => {
    writeSpec(
      repo,
      'doing-foo.md',
      curatedSpec([{ id: 'T1' }, { id: 'T2' }]),
    );
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T99: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('dedup marker already present → no injection', () => {
    writeSpec(repo, 'doing-foo.md', curatedSpec([{ id: 'T1' }]));
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: `T1: implement\n${INJECTION_MARKER}\nbundle already here`,
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

describe('end-to-end injection happy path', () => {
  let repo;

  beforeEach(() => {
    repo = tmpRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('injects T1 bundle when prompt mentions T1', () => {
    writeSpec(
      repo,
      'doing-foo.md',
      curatedSpec([
        { id: 'T1', bundle: 'BUNDLE-ONE', prompt: 'PROMPT-ONE' },
        { id: 'T2', bundle: 'BUNDLE-TWO', prompt: 'PROMPT-TWO' },
      ]),
    );
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
    const newPrompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.match(newPrompt, /BUNDLE-ONE/);
    assert.match(newPrompt, /T1: implement/);
    assert.ok(newPrompt.includes(INJECTION_MARKER));
    assert.equal(
      parsed.hookSpecificOutput.updatedInput.subagent_type,
      'df-implement',
    );
  });

  it('injects T2 bundle when prompt mentions T2', () => {
    writeSpec(
      repo,
      'doing-foo.md',
      curatedSpec([
        { id: 'T1', bundle: 'BUNDLE-ONE', prompt: 'PROMPT-ONE' },
        { id: 'T2', bundle: 'BUNDLE-TWO', prompt: 'PROMPT-TWO' },
      ]),
    );
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T2: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    const newPrompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.match(newPrompt, /BUNDLE-TWO/);
    assert.doesNotMatch(newPrompt, /BUNDLE-ONE/);
    assert.match(newPrompt, /T2: implement/);
  });

  it('preserves description in updatedInput', () => {
    writeSpec(repo, 'doing-foo.md', curatedSpec([{ id: 'T1' }]));
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'my description',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(
      parsed.hookSpecificOutput.updatedInput.description,
      'my description',
    );
  });
});

describe('multiple specs', () => {
  let repo;

  beforeEach(() => {
    repo = tmpRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('finds T2 in spec-b when spec-a only has T1', () => {
    writeSpec(
      repo,
      'doing-spec-a.md',
      curatedSpec([{ id: 'T1', bundle: 'A-BUNDLE' }]),
    );
    writeSpec(
      repo,
      'doing-spec-b.md',
      curatedSpec([{ id: 'T2', bundle: 'B-BUNDLE' }]),
    );
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T2: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    const newPrompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.match(newPrompt, /B-BUNDLE/);
    assert.doesNotMatch(newPrompt, /A-BUNDLE/);
  });

  it('finds T1 in spec-a when both specs exist', () => {
    writeSpec(
      repo,
      'doing-spec-a.md',
      curatedSpec([{ id: 'T1', bundle: 'A-BUNDLE' }]),
    );
    writeSpec(
      repo,
      'doing-spec-b.md',
      curatedSpec([{ id: 'T2', bundle: 'B-BUNDLE' }]),
    );
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    const newPrompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.match(newPrompt, /A-BUNDLE/);
  });
});

describe('fail-open on broken spec', () => {
  let repo;

  beforeEach(() => {
    repo = tmpRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('does not throw on malformed/binary spec content', () => {
    const garbage = Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0x01, 0x02, 0x03]);
    fs.writeFileSync(path.join(repo, 'specs', 'doing-broken.md'), garbage);
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('does not throw on truncated curated section', () => {
    writeSpec(
      repo,
      'doing-truncated.md',
      '# Spec\n\n## Tasks (curated)\n\n### T1: incomplete\n**Slice:** half',
    );
    const r = runHook(
      {
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          description: 'x',
          prompt: 'T1: implement',
        },
      },
      repo,
    );
    assert.equal(r.status, 0);
    // Either pass-through or injection — must not crash.
    assert.notEqual(r.status, null);
  });
});
