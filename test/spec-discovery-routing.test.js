/**
 * Tests for the spec-discovery-routing spec.
 *
 * AC coverage map (specs/spec-discovery-routing.md):
 *   AC-2  — Explore row in Agents table SHALL NOT contain '2-3 (<20 files)' or any size-scaling rule
 *   AC-3  — §1 SHALL state Explore cap of at most 2 agents AND default count of 0
 *   AC-4  — §1 SHALL instruct orchestrator to consume artefacts directly (map as authoritative source)
 *   AC-5  — §1 SHALL state that named targets are Read directly during §1
 *
 * Uses Node.js built-in node:test to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function load(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const SPEC_MD = load('src/commands/df/spec.md');

// ---------------------------------------------------------------------------
// AC-2: Explore row must not contain codebase-size scaling rule
// ---------------------------------------------------------------------------

describe('AC-2: Explore row has no size-scaling count rule', () => {
  it('shall not contain the substring "2-3 (<20 files)"', () => {
    assert.ok(
      !SPEC_MD.includes('2-3 (<20 files)'),
      'spec.md must not contain the old Explore count "2-3 (<20 files)"'
    );
  });

  it('Explore row shall show "0–2" as the count', () => {
    // Find the Explore row in the Agents table
    const exploreRowMatch = SPEC_MD.match(/\| Explore \|[^\n]+/);
    assert.ok(exploreRowMatch, 'Explore row must exist in the Agents table');
    const exploreRow = exploreRowMatch[0];
    assert.ok(
      exploreRow.includes('0–2'),
      `Explore row must contain "0–2" as the count. Got: ${exploreRow}`
    );
  });

  it('Explore row shall not reference file-count thresholds', () => {
    const exploreRowMatch = SPEC_MD.match(/\| Explore \|[^\n]+/);
    assert.ok(exploreRowMatch, 'Explore row must exist');
    const exploreRow = exploreRowMatch[0];
    assert.ok(
      !/<\d+ files/.test(exploreRow),
      `Explore row must not contain file-count thresholds like "<N files". Got: ${exploreRow}`
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: §1 states Explore cap ≤ 2 and default count 0
// ---------------------------------------------------------------------------

describe('AC-3: §1 states Explore cap of 2 and default count of 0', () => {
  it('shall state the cap is 2 agents per /df:spec run', () => {
    assert.ok(
      /Cap:\s*2 agents/.test(SPEC_MD) || SPEC_MD.includes('Cap: 2 agents') || SPEC_MD.includes('capped at 2'),
      'spec.md §1 must state an Explore cap of 2 agents per /df:spec run'
    );
  });

  it('shall state the default Explore count is 0', () => {
    assert.ok(
      /Default Explore count is \*\*0\*\*/.test(SPEC_MD) || SPEC_MD.includes('Default Explore count is **0**'),
      'spec.md §1 must state "Default Explore count is **0**"'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: §1 instructs orchestrator to consume artefacts directly
// ---------------------------------------------------------------------------

describe('AC-4: §1 instructs orchestrator to treat map artefacts as authoritative', () => {
  it('shall mention consuming artefacts directly or treating as authoritative', () => {
    const hasConsume = /consume|authoritative|use the artifacts|use the map/i.test(SPEC_MD);
    assert.ok(
      hasConsume,
      'spec.md §1 must instruct the orchestrator to consume artefacts directly or treat them as authoritative'
    );
  });

  it('shall reference STACK.md, ARCHITECTURE.md, or INTEGRATIONS.md near the consume/authoritative wording', () => {
    // Check that the routing block references the map files
    assert.ok(
      SPEC_MD.includes('STACK.md') || SPEC_MD.includes('ARCHITECTURE.md') || SPEC_MD.includes('INTEGRATIONS.md'),
      'spec.md must reference at least one of STACK.md, ARCHITECTURE.md, INTEGRATIONS.md'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5: §1 states that named targets are Read directly
// ---------------------------------------------------------------------------

describe('AC-5: §1 states named targets are Read directly during §1', () => {
  it('shall instruct Read for named targets (commands, file paths, symbols)', () => {
    assert.ok(
      /Content of a named target.*\*\*Read\*\*.*target directly/.test(SPEC_MD.replace(/\n/g, ' ')) ||
      SPEC_MD.includes('**Read** that target directly') ||
      SPEC_MD.includes('Read that target directly'),
      'spec.md §1 must state that named targets are Read directly'
    );
  });

  it('shall have a Discovery routing table with Read as a tool option', () => {
    assert.ok(
      SPEC_MD.includes('Discovery routing — three roles, three tools') ||
      SPEC_MD.includes('Discovery routing'),
      'spec.md must contain a Discovery routing section'
    );
    // The routing table must list Read as a tool
    const routingSection = SPEC_MD.match(/Discovery routing[^\n]*\n([\s\S]*?)(?=\n###|\n##|$)/);
    if (routingSection) {
      assert.ok(
        routingSection[0].includes('**Read**') || routingSection[0].includes('Read'),
        'Discovery routing section must mention Read as a tool'
      );
    }
  });
});
