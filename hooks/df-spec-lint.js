#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow spec linter
 * Validates spec files against hard invariants and advisory checks.
 *
 * Usage (CLI):   node df-spec-lint.js <spec-file.md>
 * Usage (module): const { validateSpec } = require('./df-spec-lint');
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse YAML frontmatter from the top of a markdown file.
 * Detects an opening `---` on line 1 and a closing `---` on a subsequent line.
 * Supports simple `key: value` pairs only (no full YAML parsing needed).
 *
 * @param {string} content - Raw file content.
 * @returns {{ frontmatter: Object, body: string }}
 */
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') {
    return { frontmatter: {}, body: content };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    // No closing marker — treat entire file as body, no frontmatter
    return { frontmatter: {}, body: content };
  }

  const frontmatter = {};
  for (let i = 1; i < closingIndex; i++) {
    const m = lines[i].match(/^([^:]+):\s*(.*)$/);
    if (m) {
      frontmatter[m[1].trim()] = m[2].trim();
    }
  }

  const body = lines.slice(closingIndex + 1).join('\n');
  return { frontmatter, body };
}

// Each entry: [canonical name, ...aliases that also satisfy the requirement]
const REQUIRED_SECTIONS = [
  ['Objective', 'overview', 'goal', 'goals', 'summary'],
  ['Requirements', 'functional requirements'],
  ['Constraints', 'tech constraints', 'technical constraints'],
  ['Out of Scope', 'out of scope (mvp)', 'non-goals', 'exclusions'],
  ['Acceptance Criteria'],
  ['Technical Notes', 'architecture notes', 'architecture', 'tech notes', 'implementation notes'],
];

// ── Spec layers (onion model) ───────────────────────────────────────────
// Each layer defines sections that must ALL be present (cumulative with prior layers).
// The computed layer is the highest where all cumulative sections exist.
//
// L0: Problem defined        → spikes only
// L1: Requirements known     → targeted spikes
// L2: Verifiable             → implementation tasks
// L3: Fully constrained      → full impact analysis + optimize tasks
const LAYER_DEFINITIONS = [
  { layer: 0, sections: ['Objective'] },
  { layer: 1, sections: ['Requirements'] },
  { layer: 2, sections: ['Acceptance Criteria'] },
  { layer: 3, sections: ['Constraints', 'Out of Scope', 'Technical Notes'] },
];

/**
 * Compute the spec layer from its content.
 * Returns the highest layer (0–3) where ALL cumulative required sections are present.
 * Returns -1 if not even L0 (no Objective).
 */
function computeLayer(content) {
  const headersFound = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^##\s+(.+)/i);
    if (m) {
      const raw = m[1].trim().replace(/^\d+\.\s*/, '');
      headersFound.push(raw.toLowerCase());
    }
  }

  // Inline *AC: lines satisfy the Acceptance Criteria requirement
  const hasInlineAC = /\*AC[:.]/.test(content);

  let currentLayer = -1;
  for (const { layer, sections } of LAYER_DEFINITIONS) {
    const allPresent = sections.every((section) => {
      // Find the REQUIRED_SECTIONS entry for aliases
      const entry = REQUIRED_SECTIONS.find(
        ([canonical]) => canonical.toLowerCase() === section.toLowerCase()
      );
      const allNames = entry
        ? [entry[0], ...entry.slice(1)].map((n) => n.toLowerCase())
        : [section.toLowerCase()];

      if (section === 'Acceptance Criteria' && hasInlineAC) return true;
      return headersFound.some((h) => allNames.includes(h));
    });
    if (allPresent) {
      currentLayer = layer;
    } else {
      break; // layers are cumulative — can't skip
    }
  }
  return currentLayer;
}

/**
 * Validate a spec's content against hard invariants and advisory checks.
 *
 * @param {string} content  - The raw markdown content of the spec file.
 * @param {object} opts
 * @param {'interactive'|'auto'} opts.mode
 * @param {string|null} opts.filename - Optional filename (basename) used for stem validation.
 * @returns {{ hard: string[], advisory: string[] }}
 */
function validateSpec(content, { mode = 'interactive', specsDir = null, filename = null } = {}) {
  const hard = [];
  const advisory = [];

  // ── Spec filename stem validation ────────────────────────────────────
  if (filename !== null) {
    let stem = path.basename(filename, '.md');
    stem = stem.replace(/^(doing-|done-)/, '');
    const SAFE_STEM = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    if (!SAFE_STEM.test(stem)) {
      hard.push(`Spec filename stem contains unsafe characters: "${stem}"`);
    }
  }

  // ── Frontmatter: parse and validate derives-from ─────────────────────
  const { frontmatter } = parseFrontmatter(content);
  if (frontmatter['derives-from'] !== undefined) {
    const ref = frontmatter['derives-from'];
    if (specsDir) {
      // Probe candidate filenames: exact, done- prefix, and plain name
      const candidates = [
        `${ref}.md`,
        `done-${ref}.md`,
        `${ref}`,
      ];
      const exists = candidates.some((f) => fs.existsSync(path.join(specsDir, f)));
      if (!exists) {
        advisory.push(`derives-from references unknown spec: "${ref}" (not found in specs dir)`);
      }
    }
  }

  const layer = computeLayer(content);

  // ── (a) Required sections (layer-aware) ──────────────────────────────
  // Hard-fail only for sections required by the CURRENT layer.
  // Missing sections beyond the current layer are advisory (hints to deepen).
  const headersFound = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^##\s+(.+)/i);
    if (m) {
      // Strip leading numbering like "1.", "2.", "3." from headers
      const raw = m[1].trim().replace(/^\d+\.\s*/, '');
      headersFound.push(raw);
    }
  }

  // Collect all sections required up to the current layer
  const layerRequiredSections = new Set();
  for (const { layer: l, sections } of LAYER_DEFINITIONS) {
    if (l <= layer) {
      for (const s of sections) layerRequiredSections.add(s.toLowerCase());
    }
  }

  for (const [canonical, ...aliases] of REQUIRED_SECTIONS) {
    const allNames = [canonical, ...aliases].map((n) => n.toLowerCase());
    const found = headersFound.some((h) => allNames.includes(h.toLowerCase()));
    if (!found) {
      // Inline *AC: lines satisfy the Acceptance Criteria requirement
      if (canonical === 'Acceptance Criteria' && /\*AC[:.]/.test(content)) continue;
      if (layerRequiredSections.has(canonical.toLowerCase())) {
        hard.push(`Missing required section: "## ${canonical}"`);
      } else {
        advisory.push(`Missing section for deeper layer: "## ${canonical}"`);
      }
    }
  }

  // ── (b) Check that requirements have REQ-N identifiers ──────────────
  // Requirements can be formatted as:
  //   - List items:  "- REQ-1: ..." or "- **REQ-1** — ..."
  //   - Paragraphs:  "**REQ-1 — Title**"
  // We verify that at least one REQ-N identifier exists in the section.
  // Sub-bullets (detail items) are not flagged.
  const reqSection = extractSection(content, 'Requirements');
  if (reqSection !== null) {
    const hasReqIds = /REQ-\d+/.test(reqSection);
    if (!hasReqIds) {
      hard.push('Requirements section has no REQ-N identifiers');
    }
  }

  // ── (c) Acceptance Criteria ────────────────────────────────────────
  // Accept either a dedicated ## Acceptance Criteria section with checkboxes,
  // or inline *AC: lines within the requirements section.
  const acSection = extractSection(content, 'Acceptance Criteria');
  const hasInlineAC = /\*AC[:.]/.test(content);
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
  } else if (!hasInlineAC) {
    // No dedicated section and no inline ACs — already flagged by missing section check
  }

  // ── (d) No duplicate REQ-N IDs ──────────────────────────────────────
  const reqIdPattern = /\*{0,2}(REQ-\d+[a-z]?)\*{0,2}\s*(?:[:\u2014]|—)/g;
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

  // (adv-a) Line count > 200
  const lineCount = content.split('\n').length;
  if (lineCount > 200) {
    advisory.push(`Spec exceeds 200 lines (${lineCount} lines)`);
  }

  // (adv-b) Orphaned REQ-N IDs not referenced in Acceptance Criteria
  // Skip this check when ACs are inline within requirements
  if (reqSection !== null && acSection !== null) {
    const reqIds = [];
    const reqLinePattern = /\*{0,2}(REQ-\d+[a-z]?)\*{0,2}\s*[:\u2014-]/g;
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

  // (adv-d) More than 20 requirements
  if (seenIds.size > 20) {
    advisory.push(`Too many requirements (${seenIds.size}, limit 20)`);
  }

  // (adv-e) Dependencies reference existing specs
  const depsSection = extractSection(content, 'Dependencies');
  if (depsSection !== null) {
    const depLines = depsSection.split('\n');
    for (const line of depLines) {
      const depMatch = line.match(/depends_on:\s*(.+)/);
      if (depMatch) {
        const specName = depMatch[1].trim();
        if (specsDir) {
          const specPath = path.join(specsDir, `${specName}.md`);
          if (!fs.existsSync(specPath)) {
            advisory.push(`Dependency not found: "${specName}" (no file specs/${specName}.md)`);
          }
        }
      }
    }
  }

  // ── Auto-mode escalation ─────────────────────────────────────────────
  if (mode === 'auto') {
    hard.push(...advisory.splice(0, advisory.length));
  }

  return { layer, hard, advisory };
}

/**
 * Extract the content of a named ## section (up to the next ## or EOF).
 * Returns null if the section is not found.
 */
function extractSection(content, sectionName) {
  // Find the matching aliases for this section name
  const entry = REQUIRED_SECTIONS.find(
    ([canonical]) => canonical.toLowerCase() === sectionName.toLowerCase()
  );
  const allNames = entry
    ? [entry[0], ...entry.slice(1)].map((n) => n.toLowerCase())
    : [sectionName.toLowerCase()];

  const lines = content.split('\n');
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      if (capturing) break; // hit the next section
      const normalized = headerMatch[1].trim().replace(/^\d+\.\s*/, '').toLowerCase();
      if (allNames.includes(normalized)) {
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
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: df-spec-lint.js <spec-file.md>');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const mode = process.argv.includes('--auto') ? 'auto' : 'interactive';
  const specsDir = path.resolve(path.dirname(filePath));
  const result = validateSpec(content, { mode, specsDir, filename: path.basename(filePath) });

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

  console.log(`Spec layer: L${result.layer} (${['problem defined', 'requirements known', 'verifiable', 'fully constrained'][result.layer] || 'incomplete'})`);

  process.exit(result.hard.length > 0 ? 1 : 0);
}

module.exports = { validateSpec, extractSection, computeLayer, parseFrontmatter };
