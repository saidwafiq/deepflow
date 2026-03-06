#!/usr/bin/env node
/**
 * deepflow spec linter
 * Validates spec files against hard invariants and advisory checks.
 *
 * Usage (CLI):   node df-spec-lint.js <spec-file.md>
 * Usage (module): const { validateSpec } = require('./df-spec-lint');
 */

'use strict';

const REQUIRED_SECTIONS = [
  'Objective',
  'Requirements',
  'Constraints',
  'Out of Scope',
  'Acceptance Criteria',
  'Technical Notes',
];

/**
 * Validate a spec's content against hard invariants and advisory checks.
 *
 * @param {string} content  - The raw markdown content of the spec file.
 * @param {object} opts
 * @param {'interactive'|'auto'} opts.mode
 * @returns {{ hard: string[], advisory: string[] }}
 */
function validateSpec(content, { mode = 'interactive' } = {}) {
  const hard = [];
  const advisory = [];

  // ── (a) Required sections ────────────────────────────────────────────
  const headersFound = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^##\s+(.+)/i);
    if (m) headersFound.push(m[1].trim());
  }

  for (const section of REQUIRED_SECTIONS) {
    const found = headersFound.some(
      (h) => h.toLowerCase() === section.toLowerCase()
    );
    if (!found) {
      hard.push(`Missing required section: "## ${section}"`);
    }
  }

  // ── (b) Requirement lines must have REQ-N: prefix ───────────────────
  const reqSection = extractSection(content, 'Requirements');
  if (reqSection !== null) {
    const lines = reqSection.split('\n');
    for (const line of lines) {
      // Only consider list items (lines starting with - or *)
      if (!/^\s*[-*]\s+/.test(line)) continue;
      // Must match REQ-\d+: with optional bold markers
      if (!/^\s*[-*]\s*\*{0,2}(REQ-\d+)\*{0,2}\s*:/.test(line)) {
        hard.push(
          `Requirement line missing REQ-N: prefix: "${line.trim()}"`
        );
      }
    }
  }

  // ── (c) Acceptance Criteria must use checkbox format ─────────────────
  const acSection = extractSection(content, 'Acceptance Criteria');
  if (acSection !== null) {
    const lines = acSection.split('\n');
    for (const line of lines) {
      if (!/^\s*[-*]\s+/.test(line)) continue;
      if (!/^\s*- \[ \]/.test(line)) {
        hard.push(
          `Acceptance Criteria line missing "- [ ]" checkbox: "${line.trim()}"`
        );
      }
    }
  }

  // ── (d) No duplicate REQ-N IDs ──────────────────────────────────────
  const reqIdPattern = /\*{0,2}(REQ-\d+)\*{0,2}\s*:/g;
  const seenIds = new Map();
  let match;
  while ((match = reqIdPattern.exec(content)) !== null) {
    const id = match[1];
    if (seenIds.has(id)) {
      hard.push(`Duplicate requirement ID: ${id}`);
    }
    seenIds.set(id, true);
  }

  // ── Advisory checks ──────────────────────────────────────────────────

  // (adv-a) Line count > 100
  const lineCount = content.split('\n').length;
  if (lineCount > 100) {
    advisory.push(`Spec exceeds 100 lines (${lineCount} lines)`);
  }

  // (adv-b) Orphaned REQ-N IDs not referenced in Acceptance Criteria
  if (reqSection !== null && acSection !== null) {
    const reqIds = [];
    const reqLinePattern = /\*{0,2}(REQ-\d+)\*{0,2}\s*:/g;
    let reqMatch;
    while ((reqMatch = reqLinePattern.exec(reqSection)) !== null) {
      reqIds.push(reqMatch[1]);
    }
    for (const id of reqIds) {
      if (!acSection.includes(id)) {
        advisory.push(`Orphaned requirement: ${id} not found in Acceptance Criteria`);
      }
    }
  }

  // (adv-c) Technical Notes section > 10 lines
  const techNotes = extractSection(content, 'Technical Notes');
  if (techNotes !== null) {
    const techLines = techNotes.split('\n').filter((l) => l.trim().length > 0);
    if (techLines.length > 10) {
      advisory.push(`Technical Notes section too long (${techLines.length} non-empty lines, limit 10)`);
    }
  }

  // (adv-d) More than 12 requirements
  if (seenIds.size > 12) {
    advisory.push(`Too many requirements (${seenIds.size}, limit 12)`);
  }

  // ── Auto-mode escalation ─────────────────────────────────────────────
  if (mode === 'auto') {
    hard.push(...advisory.splice(0, advisory.length));
  }

  return { hard, advisory };
}

/**
 * Extract the content of a named ## section (up to the next ## or EOF).
 * Returns null if the section is not found.
 */
function extractSection(content, sectionName) {
  const lines = content.split('\n');
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    const headerMatch = line.match(/^## \s*(.+)/);
    if (headerMatch) {
      if (capturing) break; // hit the next section
      if (headerMatch[1].trim().toLowerCase() === sectionName.toLowerCase()) {
        capturing = true;
      }
      continue;
    }
    if (capturing) {
      captured.push(line);
    }
  }

  return capturing ? captured.join('\n') : null;
}

// ── CLI entry point ──────────────────────────────────────────────────────
if (require.main === module) {
  const fs = require('fs');

  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: df-spec-lint.js <spec-file.md>');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const mode = process.argv.includes('--auto') ? 'auto' : 'interactive';
  const result = validateSpec(content, { mode });

  if (result.hard.length > 0) {
    console.error('HARD invariant failures:');
    for (const msg of result.hard) {
      console.error(`  [FAIL] ${msg}`);
    }
  }

  if (result.advisory.length > 0) {
    console.warn('Advisory warnings:');
    for (const msg of result.advisory) {
      console.warn(`  [WARN] ${msg}`);
    }
  }

  if (result.hard.length === 0 && result.advisory.length === 0) {
    console.log('All checks passed.');
  }

  process.exit(result.hard.length > 0 ? 1 : 0);
}

module.exports = { validateSpec };
