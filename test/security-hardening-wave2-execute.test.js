const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXECUTE_MD = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

/**
 * Read execute.md content once for all tests.
 */
function readExecuteMd() {
  return fs.readFileSync(EXECUTE_MD, 'utf8');
}

describe('Security Hardening Wave 2 — T4: OPTIMIZE metric_command sourced from config.yaml', () => {
  const content = readExecuteMd();

  // --- Section: OPTIMIZE CYCLE exists ---
  test('execute.md contains an OPTIMIZE CYCLE section', () => {
    assert.ok(
      content.includes('OPTIMIZE CYCLE'),
      'execute.md must contain an OPTIMIZE CYCLE section'
    );
  });

  // --- Happy path: metric_command resolution from config.yaml ---
  describe('config.yaml sourcing instruction', () => {
    test('metric field is described as a reference key, not a shell command', () => {
      assert.ok(
        content.includes('reference key'),
        'execute.md must describe the metric field as a "reference key"'
      );
      assert.ok(
        content.includes('not a shell command'),
        'execute.md must clarify the metric field is "not a shell command"'
      );
    });

    test('contains shell injection pattern to read .deepflow/config.yaml', () => {
      assert.ok(
        content.includes('cat .deepflow/config.yaml'),
        'execute.md must read config.yaml via shell injection'
      );
    });

    test('references optimize.metric_command config path', () => {
      assert.ok(
        content.includes('optimize.metric_command'),
        'execute.md must reference optimize.metric_command config path'
      );
    });

    test('references metric_commands.{metric_key} config path', () => {
      assert.ok(
        content.includes('metric_commands.{metric_key}'),
        'execute.md must reference metric_commands.{metric_key} config path'
      );
    });

    test('resolving metric_command is marked as required', () => {
      assert.ok(
        content.includes('Resolve `metric_command` from config.yaml (required)'),
        'execute.md must mark metric_command resolution as required'
      );
    });
  });

  // --- Error handling: missing metric_command ---
  describe('refusal when metric_command is absent', () => {
    test('contains ERROR message template for missing metric_command', () => {
      assert.ok(
        content.includes('ERROR: metric_command for'),
        'execute.md must include an ERROR message for missing metric_command'
      );
    });

    test('error message references config.yaml as the fix location', () => {
      assert.ok(
        content.includes('is not defined in .deepflow/config.yaml'),
        'Error message must point to .deepflow/config.yaml'
      );
    });

    test('error message includes guidance to add under optimize.metric_command or metric_commands', () => {
      assert.ok(
        content.includes('Add it under `optimize.metric_command` or `metric_commands.{metric_key}`'),
        'Error message must tell the user how to fix the missing metric_command'
      );
    });

    test('sets task status to pending on refusal', () => {
      assert.ok(
        content.includes('TaskUpdate(status: "pending")'),
        'execute.md must set task status to pending when refusing'
      );
    });

    test('explicitly forbids proceeding to baseline measurement on refusal', () => {
      assert.ok(
        content.includes('Do NOT proceed to baseline measurement or cycle loop'),
        'execute.md must forbid proceeding when metric_command is missing'
      );
    });

    test('error includes task_id placeholder for traceability', () => {
      assert.ok(
        content.includes('Task "{task_id}" will not execute'),
        'Error message must reference {task_id} for traceability'
      );
    });
  });

  // --- Edge case: metric_command resolves successfully ---
  describe('successful resolution path', () => {
    test('contains continue instruction when metric_command resolves', () => {
      assert.ok(
        content.includes('If `metric_command` resolves'),
        'execute.md must have a branch for successful metric_command resolution'
      );
    });

    test('successful path loads or inits optimize_state', () => {
      assert.ok(
        content.includes('Load or init `optimize_state` in auto-memory.yaml'),
        'Successful resolution must proceed to load optimize_state'
      );
    });

    test('optimize_state fields include metric_command', () => {
      assert.ok(
        content.includes('metric_command'),
        'optimize_state must include metric_command field'
      );
    });
  });

  // --- Structural: old inline eval pattern is removed ---
  describe('no inline eval of metric field as shell command', () => {
    test('Init section does not contain raw eval of metric field without config lookup', () => {
      // The old pattern was: Parse metric/... then immediately measure baseline.
      // The new pattern interposes config.yaml lookup. Verify the old one-liner is gone.
      const initSection = content.split('OPTIMIZE CYCLE')[1] || '';
      // The old pattern had Init as one paragraph ending with "Measure baseline"
      // Now there should be a config.yaml resolve step between Init and baseline measurement
      const hasResolveBeforeBaseline = initSection.indexOf('Resolve `metric_command` from config.yaml') <
        initSection.indexOf('Measure baseline');
      assert.ok(
        hasResolveBeforeBaseline,
        'Config.yaml resolution must appear before baseline measurement in the OPTIMIZE CYCLE section'
      );
    });
  });

  // --- Structural: config.yaml NOT_FOUND fallback in shell injection ---
  describe('shell injection fallback', () => {
    test('config.yaml read has NOT_FOUND fallback', () => {
      assert.ok(
        content.includes("|| echo 'NOT_FOUND'"),
        'Config.yaml shell injection must include NOT_FOUND fallback'
      );
    });
  });
});
