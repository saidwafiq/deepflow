/**
 * Tests for CostOverview agent role breakdown (T6 — subagent-instrumentation).
 *
 * Source-level assertion tests that verify the CostOverview.tsx component
 * contains the expected type definitions, section headings, and optional
 * chaining guards for the agent role cost breakdown feature.
 *
 * Uses Node.js built-in node:test (ESM) to match project conventions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const costOverviewPath = resolve(
  ROOT,
  'src',
  'client',
  'views',
  'CostOverview.tsx',
);

// ---------------------------------------------------------------------------
// Helper: read CostOverview.tsx content
// ---------------------------------------------------------------------------

function getSource() {
  return readFileSync(costOverviewPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostOverview — AgentRoleRow interface', () => {
  it('defines AgentRoleRow with agent_role, cost, input_tokens, output_tokens', () => {
    const src = getSource();
    assert.match(src, /interface\s+AgentRoleRow\s*\{/);
    // Extract the interface body to verify fields
    const match = src.match(/interface\s+AgentRoleRow\s*\{([^}]+)\}/);
    assert.ok(match, 'AgentRoleRow interface body should be extractable');
    const body = match[1];
    assert.match(body, /agent_role:\s*string/);
    assert.match(body, /cost:\s*number/);
    assert.match(body, /input_tokens:\s*number/);
    assert.match(body, /output_tokens:\s*number/);
  });
});

describe('CostOverview — AgentRoleModelRow interface', () => {
  it('defines AgentRoleModelRow with agent_role, model, cost, input_tokens, output_tokens', () => {
    const src = getSource();
    assert.match(src, /interface\s+AgentRoleModelRow\s*\{/);
    const match = src.match(/interface\s+AgentRoleModelRow\s*\{([^}]+)\}/);
    assert.ok(match, 'AgentRoleModelRow interface body should be extractable');
    const body = match[1];
    assert.match(body, /agent_role:\s*string/);
    assert.match(body, /model:\s*string/);
    assert.match(body, /cost:\s*number/);
    assert.match(body, /input_tokens:\s*number/);
    assert.match(body, /output_tokens:\s*number/);
  });
});

describe('CostOverview — CostsResponse includes agent role arrays', () => {
  it('CostsResponse has by_agent_role field typed as AgentRoleRow[]', () => {
    const src = getSource();
    assert.match(src, /by_agent_role:\s*AgentRoleRow\[\]/);
  });

  it('CostsResponse has by_agent_role_model field typed as AgentRoleModelRow[]', () => {
    const src = getSource();
    assert.match(src, /by_agent_role_model:\s*AgentRoleModelRow\[\]/);
  });
});

describe('CostOverview — renders "Cost by agent role" section heading', () => {
  it('source contains the "Cost by agent role" heading text', () => {
    const src = getSource();
    assert.ok(
      src.includes('Cost by agent role'),
      'Should contain "Cost by agent role" section heading',
    );
  });
});

describe('CostOverview — renders "Agent role × model" table heading', () => {
  it('source contains the "Cost by agent role × model" heading text', () => {
    const src = getSource();
    assert.ok(
      src.includes('Cost by agent role × model'),
      'Should contain "Cost by agent role × model" table heading',
    );
  });
});

describe('CostOverview — optional chaining guards for by_agent_role data', () => {
  it('guards by_agent_role with && before .length check', () => {
    const src = getSource();
    assert.match(
      src,
      /data\.by_agent_role\s*&&\s*data\.by_agent_role\.length\s*>\s*0/,
      'by_agent_role should be guarded with truthy + length check',
    );
  });

  it('guards by_agent_role_model with && before .length check', () => {
    const src = getSource();
    assert.match(
      src,
      /data\.by_agent_role_model\s*&&\s*data\.by_agent_role_model\.length\s*>\s*0/,
      'by_agent_role_model should be guarded with truthy + length check',
    );
  });
});

describe('CostOverview — agent role table columns', () => {
  it('table header includes Agent Role, Model, Cost, Tokens In, Tokens Out', () => {
    const src = getSource();
    for (const col of ['Agent Role', 'Model', 'Cost', 'Tokens In', 'Tokens Out']) {
      assert.ok(
        src.includes(col),
        `Table should include "${col}" column header`,
      );
    }
  });
});
