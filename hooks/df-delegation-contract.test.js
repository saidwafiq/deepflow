/**
 * Tests for hooks/df-delegation-contract.js
 *
 * Covers AC-1..AC-10 for specs/agent-delegation-contract.md
 *
 * AC coverage map:
 *   AC-1  — DELEGATION.md with 7 agents exists (verified via findDelegationMd + loadContract)
 *   AC-2  — Contract entries parsed correctly (exercised via loadContract on real DELEGATION.md)
 *   AC-3  — Router vs Interpreter section in DELEGATION.md (prose section skipped by parser)
 *   AC-4  — forbidden-input violations → permissionDecision: "block"
 *   AC-5  — required-input missing → permissionDecision: "block"
 *   AC-6  — violation message includes DELEGATION.md#<agent-name> reference
 *   AC-7  — unknown agents pass through (not in DELEGATION.md)
 *   AC-8  — skip marker bypasses enforcement
 *   AC-9  — non-Task tools pass through unchanged
 *   AC-10 — fail-open on any internal error (empty payload, missing contract)
 *
 * Uses Node.js built-in node:test. No external dependencies.
 */

'use strict';

// covers specs/agent-delegation-contract.md#AC-1
// covers specs/agent-delegation-contract.md#AC-2
// covers specs/agent-delegation-contract.md#AC-3
// covers specs/agent-delegation-contract.md#AC-4
// covers specs/agent-delegation-contract.md#AC-5
// covers specs/agent-delegation-contract.md#AC-6
// covers specs/agent-delegation-contract.md#AC-7
// covers specs/agent-delegation-contract.md#AC-8
// covers specs/agent-delegation-contract.md#AC-9
// covers specs/agent-delegation-contract.md#AC-10

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { main, buildViolationMessage, deriveHint, SKIP_MARKER } = require('./df-delegation-contract');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal DELEGATION.md with two agents for isolated tests */
const FIXTURE_DELEGATION_MD = `
# Delegation Contract

## df-implement

\`\`\`yaml
allowed-inputs:
  - task-description:
  - files:
forbidden-inputs:
  - orchestrator-summary
required-output-schema:
  - task-status
\`\`\`

## df-spike

\`\`\`yaml
allowed-inputs:
  - hypothesis
forbidden-inputs:
  - implementation-tasks
required-output-schema:
  - conclusion
\`\`\`
`;

/**
 * Create a temp cwd with a DELEGATION.md at src/agents/DELEGATION.md.
 * Returns the tmpDir path; caller must clean up.
 */
function makeTmpCwd(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-delcon-test-'));
  const agentsDir = path.join(tmpDir, 'src', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'DELEGATION.md'), content || FIXTURE_DELEGATION_MD, 'utf8');
  return tmpDir;
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// AC-9: non-Task tools pass through
// ---------------------------------------------------------------------------

describe('AC-9: non-Task tools pass through', () => {
  test('returns null for Agent tool', () => {
    const result = main({ tool_name: 'Agent', tool_input: { prompt: 'test', subagent_type: 'df-implement' }, cwd: '/tmp' });
    assert.equal(result, null);
  });

  test('returns null for Bash tool', () => {
    const result = main({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/tmp' });
    assert.equal(result, null);
  });

  test('returns null for Read tool', () => {
    const result = main({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo' }, cwd: '/tmp' });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// AC-10: fail-open on errors
// ---------------------------------------------------------------------------

describe('AC-10: fail-open on internal errors', () => {
  test('returns null when payload is null', () => {
    assert.equal(main(null), null);
  });

  test('returns null when tool_input is missing', () => {
    assert.equal(main({ tool_name: 'Task' }), null);
  });

  test('returns null when cwd has no DELEGATION.md (empty contract)', () => {
    const result = main({
      tool_name: 'Task',
      tool_input: { subagent_type: 'df-implement', prompt: 'do something' },
      cwd: '/nonexistent/path/xyz123abc',
    });
    assert.equal(result, null);
  });

  test('returns null when subagent_type is empty string', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: { subagent_type: '', prompt: 'some prompt' },
        cwd: tmpDir,
      });
      assert.equal(result, null);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7: unknown agents pass through
// ---------------------------------------------------------------------------

describe('AC-7: unknown agents pass through', () => {
  test('returns null for agent not in DELEGATION.md', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: { subagent_type: 'df-unknown-agent', prompt: 'anything goes' },
        cwd: tmpDir,
      });
      assert.equal(result, null);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8: skip marker bypasses enforcement
// ---------------------------------------------------------------------------

describe('AC-8: skip marker bypasses enforcement', () => {
  test('returns null when skip marker is present even with forbidden content', () => {
    const tmpDir = makeTmpCwd();
    try {
      const prompt = `${SKIP_MARKER}\norchestrator-summary: this is a paraphrased summary`;
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt,
        },
        cwd: tmpDir,
      });
      assert.equal(result, null);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: forbidden-input violations → block
// ---------------------------------------------------------------------------

describe('AC-4: forbidden-input violations', () => {
  test('blocks when prompt contains a forbidden-input pattern', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt: 'orchestrator-summary: here is what I think the codebase does...',
        },
        cwd: tmpDir,
      });
      assert.ok(result !== null, 'expected a block response');
      assert.equal(result.hookSpecificOutput.permissionDecision, 'block');
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('blocks when df-spike prompt contains forbidden implementation-tasks pattern', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-spike',
          prompt: 'Please add implementation-tasks to the codebase',
        },
        cwd: tmpDir,
      });
      assert.ok(result !== null);
      assert.equal(result.hookSpecificOutput.permissionDecision, 'block');
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('forbidden check is case-insensitive', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt: 'ORCHESTRATOR-SUMMARY: I paraphrased the context',
        },
        cwd: tmpDir,
      });
      assert.ok(result !== null);
      assert.equal(result.hookSpecificOutput.permissionDecision, 'block');
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: required-input missing → block
// ---------------------------------------------------------------------------

describe('AC-5: required-input field markers', () => {
  test('blocks when required field markers are missing from prompt', () => {
    const tmpDir = makeTmpCwd();
    try {
      // df-implement requires "task-description:" and "files:" in prompt
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt: 'just do the thing, no structured fields here',
        },
        cwd: tmpDir,
      });
      assert.ok(result !== null);
      assert.equal(result.hookSpecificOutput.permissionDecision, 'block');
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('passes when all required field markers are present and no forbidden content', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt: 'task-description: implement the feature\nfiles: src/foo.js\n',
        },
        cwd: tmpDir,
      });
      // Should pass (no violations)
      assert.equal(result, null);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: violation message includes DELEGATION.md#<agent-name>
// ---------------------------------------------------------------------------

describe('AC-6: violation message format', () => {
  test('userMessage contains DELEGATION.md#<agent-name>', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt: 'orchestrator-summary: here is paraphrased context',
        },
        cwd: tmpDir,
      });
      assert.ok(result !== null);
      const msg = result.hookSpecificOutput.userMessage;
      assert.ok(msg.includes('DELEGATION CONTRACT VIOLATION'), `expected violation header, got: ${msg}`);
      assert.ok(msg.includes('Agent: df-implement'), `expected agent name, got: ${msg}`);
      assert.ok(msg.includes('DELEGATION.md#df-implement'), `expected delegation ref, got: ${msg}`);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('userMessage includes Rule: field', () => {
    const tmpDir = makeTmpCwd();
    try {
      const result = main({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-spike',
          prompt: 'implementation-tasks: build everything',
        },
        cwd: tmpDir,
      });
      assert.ok(result !== null);
      const msg = result.hookSpecificOutput.userMessage;
      assert.ok(msg.includes('Rule:'), `expected Rule: field, got: ${msg}`);
      assert.ok(msg.includes('Fix:'), `expected Fix: field, got: ${msg}`);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-1 + AC-2: real DELEGATION.md with 7 agents is parseable
// ---------------------------------------------------------------------------

describe('AC-1 AC-2: real DELEGATION.md is parseable', () => {
  const WORKDIR = path.resolve(__dirname, '..');
  const delegationPath = path.join(WORKDIR, 'src', 'agents', 'DELEGATION.md');

  test('AC-1: DELEGATION.md exists with at least 7 agent entries', () => {
    assert.ok(fs.existsSync(delegationPath), `DELEGATION.md not found at ${delegationPath}`);
    const { loadContract } = require('./lib/delegation-contract');
    const map = loadContract(delegationPath);
    assert.ok(map.size >= 7, `expected >= 7 agents, got ${map.size}: ${[...map.keys()].join(', ')}`);
  });

  test('AC-2: each agent entry has allowedInputs, forbiddenInputs, requiredOutputSchema arrays', () => {
    const { loadContract } = require('./lib/delegation-contract');
    const map = loadContract(delegationPath);
    for (const [name, entry] of map) {
      assert.ok(Array.isArray(entry.allowedInputs), `${name}.allowedInputs not array`);
      assert.ok(Array.isArray(entry.forbiddenInputs), `${name}.forbiddenInputs not array`);
      assert.ok(Array.isArray(entry.requiredOutputSchema), `${name}.requiredOutputSchema not array`);
    }
  });

  test('AC-3: Router vs Interpreter section is present in DELEGATION.md', () => {
    const content = fs.readFileSync(delegationPath, 'utf8');
    assert.ok(content.includes('Router vs Interpreter'), 'expected Router vs Interpreter section');
    assert.ok(content.includes('Orchestrators MUST pass verbatim'), 'expected orchestrator rule');
  });
});

// ---------------------------------------------------------------------------
// buildViolationMessage unit tests
// ---------------------------------------------------------------------------

describe('buildViolationMessage', () => {
  test('includes agent name, rule, ref, fix for each violation', () => {
    const violations = [
      { rule: 'forbidden-input:orchestrator-summary', detail: 'Prompt contains forbidden pattern' },
    ];
    const msg = buildViolationMessage('df-implement', violations);
    assert.ok(msg.includes('DELEGATION CONTRACT VIOLATION'));
    assert.ok(msg.includes('Agent: df-implement'));
    assert.ok(msg.includes('Rule: forbidden-input:orchestrator-summary'));
    assert.ok(msg.includes('Ref: DELEGATION.md#df-implement'));
    assert.ok(msg.includes('Fix:'));
  });

  test('includes multiple violations', () => {
    const violations = [
      { rule: 'forbidden-input:x', detail: 'detail x' },
      { rule: 'required-input:task-description:', detail: 'detail y' },
    ];
    const msg = buildViolationMessage('df-implement', violations);
    assert.ok(msg.includes('forbidden-input:x'));
    assert.ok(msg.includes('required-input:task-description:'));
  });
});

// ---------------------------------------------------------------------------
// deriveHint unit tests
// ---------------------------------------------------------------------------

describe('deriveHint', () => {
  test('forbidden-input rule produces removal hint', () => {
    const hint = deriveHint('forbidden-input:orchestrator-summary', '', 'df-implement');
    assert.ok(hint.includes('orchestrator-summary'), `got: ${hint}`);
  });

  test('required-input rule produces addition hint', () => {
    const hint = deriveHint('required-input:task-description:', '', 'df-implement');
    assert.ok(hint.includes('task-description:'), `got: ${hint}`);
  });

  test('unknown rule falls back to detail or generic hint', () => {
    const hint = deriveHint('custom-rule', 'custom detail', 'df-implement');
    assert.ok(hint.length > 0);
  });
});

// ---------------------------------------------------------------------------
// stdin dispatch integration (binary invocation)
// ---------------------------------------------------------------------------

describe('stdin dispatch (binary)', () => {
  const HOOK_PATH = path.resolve(__dirname, 'df-delegation-contract.js');

  test('exits 0 and produces no output for non-Task tool', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/tmp' });
    const r = spawnSync('node', [HOOK_PATH], { input: payload, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 and produces no output for malformed JSON', () => {
    const r = spawnSync('node', [HOOK_PATH], { input: 'not-json', encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('exits 0 and emits block JSON for forbidden-input violation', () => {
    const tmpDir = makeTmpCwd();
    try {
      const payload = JSON.stringify({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'df-implement',
          prompt: 'orchestrator-summary: paraphrased context here',
        },
        cwd: tmpDir,
      });
      const r = spawnSync('node', [HOOK_PATH], { input: payload, encoding: 'utf8', timeout: 5000 });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stdout.length > 0, 'expected JSON output');
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'block');
      assert.ok(out.hookSpecificOutput.userMessage.includes('DELEGATION CONTRACT VIOLATION'));
    } finally {
      cleanTmpDir(tmpDir);
    }
  });
});
