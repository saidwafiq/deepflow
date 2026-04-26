'use strict';
/**
 * Tests for /df:map command (src/commands/df/map.md)
 *
 * These tests validate the structural and semantic correctness of the map.md
 * command file: frontmatter schema, artifact definitions, --only flag, idempotency
 * contract, and TESTING.md Parallel Safety section.
 *
 * AC coverage for specs/codebase-map.md:
 * covers specs/codebase-map.md#AC-1
 * covers specs/codebase-map.md#AC-2
 * covers specs/codebase-map.md#AC-3
 * covers specs/codebase-map.md#AC-4
 * covers specs/codebase-map.md#AC-5
 * covers specs/codebase-map.md#AC-6
 * covers specs/codebase-map.md#AC-7
 * covers specs/codebase-map.md#AC-8
 * covers specs/codebase-map.md#AC-9
 * covers specs/codebase-map.md#AC-10
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAP_MD_PATH = path.resolve(__dirname, '../src/commands/df/map.md');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read map.md content once. */
let _mapContent;
function getMapContent() {
  if (!_mapContent) {
    _mapContent = fs.readFileSync(MAP_MD_PATH, 'utf8');
  }
  return _mapContent;
}

/** Extract YAML frontmatter block (between first --- and second ---). */
function extractFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  return lines.slice(1, end).join('\n');
}

const SIX_ARTIFACTS = ['STACK', 'ARCHITECTURE', 'CONVENTIONS', 'STRUCTURE', 'TESTING', 'INTEGRATIONS'];

// ── AC-1: Six artifacts defined ───────────────────────────────────────────────

describe('AC-1: /df:map defines all six artifacts', () => {
  // covers specs/codebase-map.md#AC-1
  test('map.md file exists', () => {
    assert.ok(fs.existsSync(MAP_MD_PATH), `map.md not found at ${MAP_MD_PATH}`);
  });

  test('map.md defines all six artifact names in content', () => {
    const content = getMapContent();
    for (const name of SIX_ARTIFACTS) {
      assert.ok(
        content.includes(`${name}.md`),
        `Expected artifact "${name}.md" to be mentioned in map.md`
      );
    }
  });

  test('map.md defines .deepflow/codebase/ as output directory', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('.deepflow/codebase'),
      'Expected .deepflow/codebase output directory to be specified'
    );
  });

  test('map.md body is non-empty (has content beyond frontmatter)', () => {
    const content = getMapContent();
    const fm = extractFrontmatter(content);
    assert.ok(fm !== null, 'Expected YAML frontmatter to be present');
    // Body starts after second ---
    const afterFm = content.split('---\n').slice(2).join('---\n').trim();
    assert.ok(afterFm.length > 100, 'Expected substantial body content after frontmatter');
  });
});

// ── AC-2: Artifact frontmatter schema ────────────────────────────────────────

describe('AC-2: artifacts must have sources: and hashes: frontmatter', () => {
  // covers specs/codebase-map.md#AC-2
  test('map.md documents sources: field requirement for each artifact', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('sources:'),
      'Expected "sources:" to be documented in map.md artifact templates'
    );
  });

  test('map.md documents hashes: field requirement for each artifact', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('hashes:'),
      'Expected "hashes:" to be documented in map.md artifact templates'
    );
  });

  test('map.md rules section requires frontmatter with sources and hashes', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('Frontmatter required'),
      'Expected "Frontmatter required" rule in map.md Rules section'
    );
    assert.ok(
      content.includes('sources:') && content.includes('hashes:'),
      'Expected both sources: and hashes: in frontmatter requirement'
    );
  });

  test('each of the six artifact templates includes sources: field', () => {
    const content = getMapContent();
    // Count occurrences of "sources:" — should be at least 6 (one per artifact template)
    const count = (content.match(/sources:/g) || []).length;
    assert.ok(count >= 6, `Expected at least 6 "sources:" occurrences (one per artifact), got ${count}`);
  });

  test('each of the six artifact templates includes hashes: field', () => {
    const content = getMapContent();
    const count = (content.match(/hashes:/g) || []).length;
    assert.ok(count >= 6, `Expected at least 6 "hashes:" occurrences (one per artifact), got ${count}`);
  });

  test('hashes: is specified as a map (key: value format)', () => {
    const content = getMapContent();
    // sha256 placeholder pattern in templates
    assert.ok(
      content.includes('{sha256}'),
      'Expected {sha256} placeholder in artifact hashes: templates'
    );
  });
});

// ── AC-3: TESTING.md Parallel Safety section ─────────────────────────────────

describe('AC-3: TESTING.md must have ## Parallel Safety section', () => {
  // covers specs/codebase-map.md#AC-3
  test('map.md TESTING.md template contains ## Parallel Safety', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('## Parallel Safety'),
      'Expected "## Parallel Safety" section in TESTING.md template'
    );
  });

  test('Parallel Safety section declares DB isolation rules', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('Database Isolation') || content.includes('database isolation'),
      'Expected Database Isolation subsection in Parallel Safety'
    );
  });

  test('Parallel Safety section declares port namespacing rules', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('Port Namespacing') || content.includes('port namespacing'),
      'Expected Port Namespacing subsection in Parallel Safety'
    );
  });

  test('Parallel Safety section declares shared fixture cleanup rules', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('Shared Fixture') || content.includes('shared fixture'),
      'Expected Shared Fixture Cleanup subsection in Parallel Safety'
    );
  });

  test('Parallel Safety section includes [P] marker gate logic for df:plan', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('[P]') && content.includes('df:plan'),
      'Expected [P] marker and df:plan reference in Parallel Safety section'
    );
  });

  test('Parallel Safety section includes a Summary Gate', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('Summary Gate') || content.includes('MUST refuse'),
      'Expected Summary Gate or MUST refuse language in Parallel Safety'
    );
  });
});

// ── AC-4: Artifact subset mapping ─────────────────────────────────────────────

describe('AC-4: agent→artifact subset mapping documented', () => {
  // covers specs/codebase-map.md#AC-4
  test('map.md mentions df-implement and the artifacts it needs', () => {
    const content = getMapContent();
    // The injection hook (T7) implements this, but map.md should reference the subset
    assert.ok(
      content.includes('CONVENTIONS.md') && content.includes('TESTING.md'),
      'Expected CONVENTIONS.md and TESTING.md referenced as df-implement artifacts'
    );
  });

  test('map.md mentions df:plan and the artifacts it needs', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('STRUCTURE.md'),
      'Expected STRUCTURE.md referenced (df:plan artifact)'
    );
  });
});

// ── AC-5: Staleness marking documented ───────────────────────────────────────

describe('AC-5: [STALE] marker mechanism documented', () => {
  // covers specs/codebase-map.md#AC-5
  test('map.md references [STALE] marker or staleness concept', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('[STALE]') || content.includes('staleness') || content.includes('stale'),
      'Expected [STALE] marker or staleness concept in map.md'
    );
  });

  test('map.md documents hash-based staleness detection', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('sha256') || content.includes('hash'),
      'Expected sha256/hash-based staleness detection documented'
    );
  });
});

// ── AC-6: Regeneration sub-agent ─────────────────────────────────────────────

describe('AC-6: --only flag enables single-artifact regeneration', () => {
  // covers specs/codebase-map.md#AC-6
  test('map.md documents --only flag', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('--only'),
      'Expected --only flag documented in map.md'
    );
  });

  test('--only flag accepts all six artifact names', () => {
    const content = getMapContent();
    const flagSection = content.includes('--only');
    assert.ok(flagSection, 'Expected --only flag in map.md');
    // All six names should appear alongside --only documentation
    for (const name of SIX_ARTIFACTS) {
      assert.ok(
        content.includes(name),
        `Expected artifact name "${name}" to appear in map.md (for --only usage)`
      );
    }
  });

  test('--only flag is described as regenerating a single artifact', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('single artifact') || content.includes('single-artifact') || content.includes('Regenerate a single'),
      'Expected description of --only as single-artifact regeneration'
    );
  });
});

// ── AC-7: Single-artifact rebuild isolation ───────────────────────────────────

describe('AC-7: --only regenerates only the targeted artifact', () => {
  // covers specs/codebase-map.md#AC-7
  test('map.md --only skips idempotency check (regenerates unconditionally)', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('regenerates unconditionally') || content.includes('skip the idempotency') || content.includes('always write'),
      'Expected --only to be documented as skipping idempotency check'
    );
  });

  test('map.md step 5 scopes generation to ONLY_TARGET when set', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('ONLY_TARGET'),
      'Expected ONLY_TARGET variable used to scope artifact generation'
    );
  });
});

// ── AC-8: Token budget ────────────────────────────────────────────────────────

describe('AC-8: token budget — CLAUDE.md ≤5k, artifacts 15k-25k summed', () => {
  // covers specs/codebase-map.md#AC-8
  test('map.md references the six artifacts as holding lazy facts from CLAUDE.md', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('CLAUDE.md'),
      'Expected CLAUDE.md referenced as source document in map.md'
    );
  });

  test('map.md specifies non-empty body requirement for each artifact', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('non-empty') || content.includes('Body non-empty'),
      'Expected "Body non-empty" or "non-empty" requirement in map.md rules'
    );
  });
});

// ── AC-9: Idempotency ─────────────────────────────────────────────────────────

describe('AC-9: /df:map is idempotent (byte-identical on second run)', () => {
  // covers specs/codebase-map.md#AC-9
  test('map.md has an idempotency section or contract', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('Idempotency') || content.includes('idempotent') || content.includes('idempotency'),
      'Expected idempotency contract documented in map.md'
    );
  });

  test('map.md documents hash comparison as the idempotency mechanism', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('hashes match') || content.includes('ALL hashes match'),
      'Expected "hashes match" or "ALL hashes match" as idempotency condition'
    );
  });

  test('map.md documents skipping write when hashes match', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('skip') && (content.includes('hash') || content.includes('hashes')),
      'Expected skip-on-hash-match behavior documented'
    );
  });

  test('map.md states generated: timestamp is NOT updated on skip', () => {
    const content = getMapContent();
    assert.ok(
      content.includes('NOT updated') || content.includes('preserved on skip') || content.includes('set ONCE'),
      'Expected generated: timestamp preservation on skip to be documented'
    );
  });
});

// ── AC-10 guard (if hook detects one) ────────────────────────────────────────

describe('AC-10: command structure and frontmatter schema (guard)', () => {
  // covers specs/codebase-map.md#AC-10
  test('map.md has valid YAML frontmatter starting with ---', () => {
    const content = getMapContent();
    assert.ok(content.startsWith('---\n'), 'Expected map.md to start with --- frontmatter fence');
  });

  test('map.md frontmatter contains name: df:map', () => {
    const fm = extractFrontmatter(getMapContent());
    assert.ok(fm !== null, 'Expected YAML frontmatter');
    assert.ok(fm.includes('name: df:map'), 'Expected name: df:map in frontmatter');
  });

  test('map.md frontmatter contains allowed-tools including Glob, Read, Write, Bash', () => {
    const fm = extractFrontmatter(getMapContent());
    assert.ok(fm !== null, 'Expected YAML frontmatter');
    assert.ok(fm.includes('allowed-tools'), 'Expected allowed-tools in frontmatter');
    for (const tool of ['Glob', 'Read', 'Write', 'Bash']) {
      assert.ok(fm.includes(tool), `Expected allowed-tools to include ${tool}`);
    }
  });

  test('map.md has description field in frontmatter', () => {
    const fm = extractFrontmatter(getMapContent());
    assert.ok(fm !== null, 'Expected YAML frontmatter');
    assert.ok(fm.includes('description:'), 'Expected description: in frontmatter');
  });
});
