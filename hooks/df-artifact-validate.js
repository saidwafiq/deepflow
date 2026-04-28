#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * @file df-artifact-validate.js
 * @description Artifact existence validator for the 5-artifact chain.
 *
 * Resolves every file path, symbol ref, task ID, and edge ID inside:
 *   - .deepflow/maps/{spec}/sketch.md
 *   - .deepflow/maps/{spec}/impact.md
 *   - PLAN.md (or .deepflow/plans/{spec}.md)
 *   - .deepflow/maps/{spec}/findings.md
 *   - .deepflow/maps/{spec}/verify-result.json
 *   - specs/doing-{spec}.md
 *
 * Emits per-check rows as machine-parseable JSON:
 *   { artifact, kind, ref, status: "ok"|"missing" }
 *
 * Hard-fails (exit code 1) when any existence violation is found.
 * The offending reference appears in the JSON evidence field.
 *
 * REQ-1: Existence checks (AC-1) — hard-fail with evidence
 * REQ-4: Enforcement mode — existence violations always hard-fail
 * REQ-5: Results schema — { artifact, checks[], drift?, exit_code }
 * REQ-6: Hook integration — PostToolUse, mirrors df-spec-lint.js pattern
 * REQ-7: Skip-on-missing — absent artifacts emit skipped rows, exit 0
 * REQ-8: Symmetry with verify — predicates imported from hooks/lib/artifact-predicates.js
 * REQ-9: Config thresholds (existence enforcement always "hard" per REQ-4)
 *
 * Usage (PostToolUse hook): reads JSON payload from stdin
 * Usage (CLI):   node df-artifact-validate.js --spec <spec-name> [--repo <path>]
 * Usage (module): const { validateArtifacts } = require('./df-artifact-validate');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');
const {
  checkReferenceExists,
  extractTaskIds,
  checkBlockerResolves,
  extractBlockerRefs,
  extractEdgeIds,
  extractPlanSlices,
  normalizeFilePath,
} = require('./lib/artifact-predicates');

// ── Artifact kinds ────────────────────────────────────────────────────────────

/** The 5-artifact chain: artifact key → filename under .deepflow/maps/{spec}/ */
const ARTIFACT_FILES = {
  'sketch.md': 'sketch.md',
  'impact.md': 'impact.md',
  'PLAN.md': 'PLAN.md',
  'findings.md': 'findings.md',
  'verify-result.json': 'verify-result.json',
};

// ── Reference extractors per artifact kind ────────────────────────────────────

/**
 * Extract file path references from a sketch.md artifact.
 * sketch.md may contain:
 *   - `likely_files:` YAML list entries
 *   - `modules:` list entries
 *   - `entry_points:` list entries
 *   - Markdown list items that look like file paths
 *
 * @param {string} content - Raw content of sketch.md
 * @returns {Array<{kind: string, ref: string}>}
 */
function extractSketchRefs(content) {
  const refs = [];
  const seen = new Set();

  function addRef(kind, ref) {
    const norm = normalizeFilePath(ref.trim());
    if (!norm || seen.has(`${kind}:${norm}`)) return;
    seen.add(`${kind}:${norm}`);
    refs.push({ kind, ref: norm });
  }

  const lines = content.split('\n');

  for (const line of lines) {
    // YAML-style list under likely_files / modules / entry_points
    // e.g.:   - hooks/df-artifact-validate.js
    const listItemMatch = line.match(/^\s{0,6}-\s+`?([^\s`#]+)`?\s*(?:#.*)?$/);
    if (listItemMatch) {
      const candidate = listItemMatch[1].trim();
      // Only include if it looks like a file path (has extension or path separator)
      if (/\.\w{1,8}$/.test(candidate) || candidate.includes('/')) {
        addRef('file_path', candidate);
      }
    }

    // Inline likely_files / modules keys: `likely_files: src/a.js, src/b.js`
    const inlineListMatch = line.match(/^(?:likely_files|modules|entry_points|touched_modules|files?):\s*(.+)$/i);
    if (inlineListMatch) {
      const items = inlineListMatch[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => s && /\.\w{1,8}$/.test(s));
      for (const item of items) {
        addRef('file_path', item);
      }
    }
  }

  return refs;
}

/**
 * Extract file path / edge references from an impact.md artifact.
 * Delegates to artifact-predicates extractEdgeIds, then adds explicit
 * file-path patterns from list items.
 *
 * @param {string} content - Raw content of impact.md
 * @param {string} impactPath - Absolute path to impact.md (for extractEdgeIds)
 * @returns {Array<{kind: string, ref: string}>}
 */
function extractImpactRefs(content, impactPath) {
  const refs = [];
  const seen = new Set();

  function addRef(kind, ref) {
    const norm = normalizeFilePath(ref.trim());
    if (!norm || seen.has(`${kind}:${norm}`)) return;
    seen.add(`${kind}:${norm}`);
    refs.push({ kind, ref: norm });
  }

  // Use shared predicate to extract edge IDs
  const edgeIds = extractEdgeIds(impactPath);
  for (const edge of edgeIds) {
    addRef('edge_id', edge);
  }

  // Also scan for explicit file path patterns in list items
  const lines = content.split('\n');
  for (const line of lines) {
    const listItemMatch = line.match(/^\s*[-*]\s+`?([^\s`#]+\.[a-z]{1,8})`?\s*(?:#.*)?$/i);
    if (listItemMatch) {
      const candidate = listItemMatch[1].trim();
      if (candidate.includes('/') || /\.\w{1,8}$/.test(candidate)) {
        addRef('file_path', candidate);
      }
    }
  }

  return refs;
}

/**
 * Extract references from a PLAN.md artifact:
 *   - Task IDs (from blocker references: "Blocked by: T{n}")
 *   - File path references (from "Files:" entries)
 *   - Edge ID references (from "Impact edges:" entries)
 *
 * @param {string} content - Raw PLAN.md content
 * @param {string} planPath - Absolute path (for task ID extraction)
 * @returns {Array<{kind: string, ref: string}>}
 */
function extractPlanRefs(content, planPath) {
  const refs = [];
  const seen = new Set();

  function addRef(kind, ref) {
    const norm = kind === 'task_id' ? ref.trim() : normalizeFilePath(ref.trim());
    if (!norm || seen.has(`${kind}:${norm}`)) return;
    seen.add(`${kind}:${norm}`);
    refs.push({ kind, ref: norm });
  }

  // Extract blocker references: "Blocked by: T1, T2"
  const blockerRefs = extractBlockerRefs(content);
  for (const { blockerRef } of blockerRefs) {
    addRef('task_id', blockerRef);
  }

  // Extract file path references from "Files:" entries
  const filesPattern = /^\s*-?\s*Files?:\s*(.+)$/gim;
  let m;
  while ((m = filesPattern.exec(content)) !== null) {
    const items = m[1]
      .split(/[,\s]+/)
      .map((s) => s.replace(/`/g, '').trim())
      .filter((s) => s && /\.\w{1,8}$/.test(s));
    for (const item of items) {
      addRef('file_path', item);
    }
  }

  // Extract "Impact edges:" references
  const edgesPattern = /^\s*-?\s*Impact\s+edges?:\s*(.+)$/gim;
  while ((m = edgesPattern.exec(content)) !== null) {
    const items = m[1]
      .split(/[,\s]+/)
      .map((s) => s.replace(/`/g, '').trim())
      .filter((s) => s && (s.includes('/') || /\.\w{1,8}$/.test(s)));
    for (const item of items) {
      addRef('edge_id', item);
    }
  }

  // Extract Slice: entries
  const slicePattern = /^\s*-?\s*Slice:\s*(.+)$/gim;
  while ((m = slicePattern.exec(content)) !== null) {
    const items = m[1]
      .split(/[,\s]+/)
      .map((s) => s.replace(/`/g, '').trim())
      .filter((s) => s && /\.\w{1,8}$/.test(s));
    for (const item of items) {
      addRef('file_path', item);
    }
  }

  return refs;
}

/**
 * Extract references from findings.md:
 *   - files_read entries (file paths)
 *   - Any explicit file path list items
 *
 * @param {string} content - Raw findings.md content
 * @returns {Array<{kind: string, ref: string}>}
 */
function extractFindingsRefs(content) {
  const refs = [];
  const seen = new Set();

  function addRef(kind, ref) {
    const norm = normalizeFilePath(ref.trim());
    if (!norm || seen.has(`${kind}:${norm}`)) return;
    seen.add(`${kind}:${norm}`);
    refs.push({ kind, ref: norm });
  }

  const lines = content.split('\n');
  for (const line of lines) {
    // files_read: entries
    const filesReadMatch = line.match(/^\s*-?\s*files_read:\s*(.+)$/i);
    if (filesReadMatch) {
      const items = filesReadMatch[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => s && /\.\w{1,8}$/.test(s));
      for (const item of items) {
        addRef('file_path', item);
      }
      continue;
    }

    // YAML list item that looks like a file path
    const listItemMatch = line.match(/^\s{2,}-\s+`?([^\s`#]+\.[a-z]{1,8})`?\s*(?:#.*)?$/i);
    if (listItemMatch) {
      const candidate = listItemMatch[1].trim();
      if (candidate.includes('/')) {
        addRef('file_path', candidate);
      }
    }
  }

  return refs;
}

/**
 * Extract references from verify-result.json:
 *   - file references in checks[] evidence
 *   - spec name references
 *
 * @param {string} content - Raw JSON content
 * @returns {Array<{kind: string, ref: string}>}
 */
function extractVerifyResultRefs(content) {
  const refs = [];
  const seen = new Set();

  function addRef(kind, ref) {
    const norm = normalizeFilePath(ref.trim());
    if (!norm || seen.has(`${kind}:${norm}`)) return;
    seen.add(`${kind}:${norm}`);
    refs.push({ kind, ref: norm });
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    // Not valid JSON — can't extract refs
    return refs;
  }

  // Extract file paths from checks[].evidence
  if (Array.isArray(parsed.checks)) {
    for (const check of parsed.checks) {
      if (check && typeof check.evidence === 'string') {
        // Extract file-path-like strings from evidence text
        const pathMatches = check.evidence.match(/[\w./][\w./\-]*\.[a-z]{1,8}/g) || [];
        for (const p of pathMatches) {
          if (p.includes('/') && !p.startsWith('//')) {
            addRef('file_path', p);
          }
        }
      }
    }
  }

  // Extract spec reference
  if (parsed.spec && typeof parsed.spec === 'string') {
    addRef('symbol_ref', parsed.spec);
  }

  return refs;
}

/**
 * Extract references from a spec file (specs/doing-{spec}.md):
 *   - likely_files entries in frontmatter or Requirements section
 *   - File paths in Technical Notes
 *
 * @param {string} content - Raw spec content
 * @returns {Array<{kind: string, ref: string}>}
 */
function extractSpecRefs(content) {
  const refs = [];
  const seen = new Set();

  function addRef(kind, ref) {
    const norm = normalizeFilePath(ref.trim());
    if (!norm || seen.has(`${kind}:${norm}`)) return;
    seen.add(`${kind}:${norm}`);
    refs.push({ kind, ref: norm });
  }

  const lines = content.split('\n');
  for (const line of lines) {
    // likely_files: src/a.js, src/b.js
    const likelyFilesMatch = line.match(/^\s*-?\s*likely_files?:\s*(.+)$/i);
    if (likelyFilesMatch) {
      const items = likelyFilesMatch[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => s && /\.\w{1,8}$/.test(s));
      for (const item of items) {
        addRef('file_path', item);
      }
      continue;
    }

    // YAML-style list items with file extensions
    const listItemMatch = line.match(/^\s{0,4}-\s+`?([^\s`#]+\.[a-z]{1,8})`?\s*(?:#.*)?$/i);
    if (listItemMatch) {
      const candidate = listItemMatch[1].trim();
      if (candidate.includes('/')) {
        addRef('file_path', candidate);
      }
    }
  }

  return refs;
}

// ── Cross-consistency helpers ─────────────────────────────────────────────────

/**
 * Extract module/file entries listed under `modules:`, `touched_modules:`,
 * or `likely_files:` sections in a sketch.md file.
 *
 * @param {string} content - Raw sketch.md content
 * @returns {string[]} Normalized file/module paths
 */
function extractSketchModules(content) {
  const modules = new Set();
  const lines = content.split('\n');

  let inModulesSection = false;

  for (const line of lines) {
    // Detect YAML-block headings: "modules:", "touched_modules:", "likely_files:"
    const sectionMatch = line.match(/^(modules|touched_modules|likely_files|entry_points)\s*:/i);
    if (sectionMatch) {
      inModulesSection = true;
      // Check for inline value: "modules: foo.js, bar.js"
      const inlineVal = line.replace(/^[^:]+:\s*/, '').trim();
      if (inlineVal) {
        for (const item of inlineVal.split(/[,\s]+/).map((s) => s.replace(/`/g, '').trim())) {
          if (item && (/\.\w{1,8}$/.test(item) || item.includes('/'))) {
            modules.add(normalizeFilePath(item));
          }
        }
      }
      continue;
    }

    // If inside a section, collect list items
    if (inModulesSection) {
      const listMatch = line.match(/^\s{0,6}-\s+`?([^\s`#]+)`?\s*(?:#.*)?$/);
      if (listMatch) {
        const candidate = listMatch[1].trim();
        if (/\.\w{1,8}$/.test(candidate) || candidate.includes('/')) {
          modules.add(normalizeFilePath(candidate));
        }
      } else if (line.trim() === '' || /^\S/.test(line)) {
        // Blank line or new top-level key ends the section
        inModulesSection = false;
      }
    }
  }

  return [...modules];
}

/**
 * Extract per-task `Slice:` entries from PLAN.md content.
 * Returns an array of { taskId, slices[] } objects.
 *
 * @param {string} content - Raw PLAN.md content
 * @returns {Array<{taskId: string, slices: string[]}>}
 */
function extractTaskSlices(content) {
  if (!content) return [];

  const results = [];
  const lines = content.split('\n');
  let currentTaskId = null;
  let currentSlices = [];

  function flushTask() {
    if (currentTaskId && currentSlices.length > 0) {
      results.push({ taskId: currentTaskId, slices: [...currentSlices] });
    }
  }

  for (const line of lines) {
    // Detect task header: - [ ] **T25**: ...
    const taskMatch = line.match(/^\s*[-*]\s+\[.\]\s+\*\*T(\d+)\*\*/);
    if (taskMatch) {
      flushTask();
      currentTaskId = `T${taskMatch[1]}`;
      currentSlices = [];
    }

    // Detect "Slice: ..." or "  - Slice: ..."
    const sliceMatch = line.match(/^\s*-?\s+Slice:\s*(.+)$/i);
    if (sliceMatch && currentTaskId) {
      const items = sliceMatch[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => s && (/\.\w{1,8}$/.test(s) || s.includes('/')));
      for (const item of items) {
        currentSlices.push(normalizeFilePath(item));
      }
    }
  }

  flushTask();
  return results;
}

/**
 * Extract per-task `Impact edges:` entries from PLAN.md content.
 * Returns an array of { taskId, edgeIds[] } objects.
 *
 * @param {string} content - Raw PLAN.md content
 * @returns {Array<{taskId: string, edgeIds: string[]}>}
 */
function extractTaskImpactEdges(content) {
  if (!content) return [];

  const results = [];
  const lines = content.split('\n');
  let currentTaskId = null;
  let currentEdgeIds = [];

  function flushTask() {
    if (currentTaskId && currentEdgeIds.length > 0) {
      results.push({ taskId: currentTaskId, edgeIds: [...currentEdgeIds] });
    }
  }

  for (const line of lines) {
    const taskMatch = line.match(/^\s*[-*]\s+\[.\]\s+\*\*T(\d+)\*\*/);
    if (taskMatch) {
      flushTask();
      currentTaskId = `T${taskMatch[1]}`;
      currentEdgeIds = [];
    }

    // Detect "Impact edges: ..." or "  - Impact edges: ..."
    const edgesMatch = line.match(/^\s*-?\s+Impact\s+edges?:\s*(.+)$/i);
    if (edgesMatch && currentTaskId) {
      const items = edgesMatch[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => s && (/\.\w{1,8}$/.test(s) || s.includes('/')));
      for (const item of items) {
        currentEdgeIds.push(normalizeFilePath(item));
      }
    }
  }

  flushTask();
  return results;
}

/**
 * Load artifact_validation config from .deepflow/config.yaml.
 * Returns defaults when file is absent or keys are missing.
 *
 * @param {string} repoRoot
 * @returns {{
 *   enforcement: { existence: string, consistency: string, drift: string },
 *   drift_thresholds: { jaccard_max: number, likely_files_min_pct: number, out_of_scope_max: number }
 * }}
 */
function loadArtifactValidationConfig(repoRoot) {
  const defaults = {
    enforcement: {
      existence: 'hard',
      consistency: 'advisory',
      drift: 'advisory',
    },
    drift_thresholds: {
      jaccard_max: 0.4,
      likely_files_min_pct: 50,
      out_of_scope_max: 3,
    },
  };

  const configPath = path.join(repoRoot, '.deepflow', 'config.yaml');
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return defaults;
  }

  // Minimal regex-based YAML parsing (no external dependency)
  function extractYamlValue(text, keyPath) {
    // keyPath like "artifact_validation.enforcement.consistency"
    const keys = keyPath.split('.');
    let pos = 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const re = new RegExp(`^(\\s*)${key}\\s*:(.*)$`, 'm');
      const m = re.exec(text.slice(pos));
      if (!m) return null;
      pos += m.index + m[0].length;
      if (i === keys.length - 1) {
        // Last key — return inline value
        const inlineVal = m[2].trim().replace(/^['"]|['"]$/g, '').replace(/#.*$/, '').trim();
        return inlineVal || null;
      }
    }
    return null;
  }

  const consistencyEnforcement = extractYamlValue(content, 'artifact_validation.enforcement.consistency');
  const driftEnforcement = extractYamlValue(content, 'artifact_validation.enforcement.drift');
  const existenceEnforcement = extractYamlValue(content, 'artifact_validation.enforcement.existence');

  const jaccardMax = extractYamlValue(content, 'artifact_validation.drift_thresholds.jaccard_max');
  const likelyFilesMinPct = extractYamlValue(content, 'artifact_validation.drift_thresholds.likely_files_min_pct');
  const outOfScopeMax = extractYamlValue(content, 'artifact_validation.drift_thresholds.out_of_scope_max');

  const cfg = JSON.parse(JSON.stringify(defaults)); // deep clone defaults

  if (consistencyEnforcement && ['hard', 'advisory', 'off'].includes(consistencyEnforcement)) {
    cfg.enforcement.consistency = consistencyEnforcement;
  }
  if (driftEnforcement && ['hard', 'advisory', 'off'].includes(driftEnforcement)) {
    cfg.enforcement.drift = driftEnforcement;
  }
  if (existenceEnforcement && ['hard', 'advisory', 'off'].includes(existenceEnforcement)) {
    cfg.enforcement.existence = existenceEnforcement;
  }

  if (jaccardMax !== null) {
    const v = parseFloat(jaccardMax);
    if (!Number.isNaN(v) && v >= 0 && v <= 1) cfg.drift_thresholds.jaccard_max = v;
  }
  if (likelyFilesMinPct !== null) {
    const v = parseFloat(likelyFilesMinPct);
    if (!Number.isNaN(v) && v >= 0 && v <= 100) cfg.drift_thresholds.likely_files_min_pct = v;
  }
  if (outOfScopeMax !== null) {
    const v = parseFloat(outOfScopeMax);
    if (!Number.isNaN(v) && v >= 0) cfg.drift_thresholds.out_of_scope_max = v;
  }

  return cfg;
}

/**
 * Run REQ-2 cross-consistency checks across the artifact set.
 *
 * Checks (all emit advisory rows — enforcement level decides exit code):
 *   (a) sketch.modules ⊆ impact.modules — every sketch module must appear in impact edges
 *   (b) PLAN task Slice: ∈ impact edges — each Slice entry must appear in impact.md
 *   (c) PLAN task `Impact edges:` present in impact.md — each listed edge must exist
 *   (d) Blocker resolution — each `Blocked by: T{n}` must resolve to a known task ID
 *   (e) findings.md files_read scoping — files_read entries should align with declared paths
 *
 * @param {object} artifacts  - Map of artifact name → { path, content, exists }
 * @param {Set<string>} taskIds - Known task IDs from PLAN.md
 * @returns {Array<{artifact, kind, ref, status: "advisory"|"skipped", evidence, taskId?, missingEdge?}>}
 */
function checkCrossConsistency(artifacts, taskIds) {
  const rows = [];

  const sketchArtifact = artifacts['sketch.md'];
  const impactArtifact = artifacts['impact.md'];
  const planArtifact = artifacts['PLAN.md'];
  const findingsArtifact = artifacts['findings.md'];

  // ── (a) sketch.modules ⊆ impact.modules ────────────────────────────────────
  if (!sketchArtifact || !sketchArtifact.exists) {
    rows.push({
      artifact: 'sketch.md',
      kind: 'consistency',
      ref: 'sketch.modules ⊆ impact.modules',
      status: 'skipped',
      evidence: 'sketch.md not available — skipping sketch⊆impact check',
    });
  } else if (!impactArtifact || !impactArtifact.exists) {
    rows.push({
      artifact: 'impact.md',
      kind: 'consistency',
      ref: 'sketch.modules ⊆ impact.modules',
      status: 'skipped',
      evidence: 'impact.md not available — skipping sketch⊆impact check',
    });
  } else {
    const sketchModules = extractSketchModules(sketchArtifact.content);
    const impactEdges = extractEdgeIds(impactArtifact.path);
    const impactEdgeSet = new Set(impactEdges.map((e) => normalizeFilePath(e)));

    for (const mod of sketchModules) {
      const norm = normalizeFilePath(mod);
      // Match by exact path, basename, or path suffix
      const inImpact =
        impactEdgeSet.has(norm) ||
        [...impactEdgeSet].some(
          (e) =>
            e.endsWith('/' + norm) ||
            norm.endsWith('/' + e) ||
            path.basename(e) === path.basename(norm)
        );

      if (inImpact) {
        rows.push({
          artifact: 'sketch.md',
          kind: 'consistency',
          ref: mod,
          status: 'ok',
          evidence: `sketch module "${mod}" present in impact.md edges`,
        });
      } else {
        rows.push({
          artifact: 'sketch.md',
          kind: 'consistency',
          ref: mod,
          status: 'advisory',
          evidence: `sketch module "${mod}" not found in impact.md edges — sketch⊆impact violation`,
          missingEdge: mod,
        });
      }
    }

    if (sketchModules.length === 0) {
      rows.push({
        artifact: 'sketch.md',
        kind: 'consistency',
        ref: 'sketch.modules ⊆ impact.modules',
        status: 'ok',
        evidence: 'No modules listed in sketch.md — check vacuously passes',
      });
    }
  }

  // ── (b) PLAN Slice: ∈ impact edges ─────────────────────────────────────────
  if (!planArtifact || !planArtifact.exists) {
    rows.push({
      artifact: 'PLAN.md',
      kind: 'consistency',
      ref: 'Slice ∈ impact edges',
      status: 'skipped',
      evidence: 'PLAN.md not available — skipping Slice∈impact check',
    });
  } else if (!impactArtifact || !impactArtifact.exists) {
    rows.push({
      artifact: 'PLAN.md',
      kind: 'consistency',
      ref: 'Slice ∈ impact edges',
      status: 'skipped',
      evidence: 'impact.md not available — skipping Slice∈impact check',
    });
  } else {
    const taskSlices = extractTaskSlices(planArtifact.content);
    const impactEdges = extractEdgeIds(impactArtifact.path);
    const impactEdgeSet = new Set(impactEdges.map((e) => normalizeFilePath(e)));

    if (taskSlices.length === 0) {
      rows.push({
        artifact: 'PLAN.md',
        kind: 'consistency',
        ref: 'Slice ∈ impact edges',
        status: 'ok',
        evidence: 'No Slice: entries found in PLAN.md — check vacuously passes',
      });
    }

    for (const { taskId, slices } of taskSlices) {
      for (const slice of slices) {
        const norm = normalizeFilePath(slice);
        const inImpact =
          impactEdgeSet.has(norm) ||
          [...impactEdgeSet].some(
            (e) =>
              e.endsWith('/' + norm) ||
              norm.endsWith('/' + e) ||
              path.basename(e) === path.basename(norm)
          );

        if (inImpact) {
          rows.push({
            artifact: 'PLAN.md',
            kind: 'consistency',
            ref: slice,
            status: 'ok',
            evidence: `${taskId} Slice "${slice}" present in impact.md edges`,
            taskId,
          });
        } else {
          rows.push({
            artifact: 'PLAN.md',
            kind: 'consistency',
            ref: slice,
            status: 'advisory',
            evidence: `${taskId} Slice "${slice}" not found in impact.md edges — Slice∈impact violation`,
            taskId,
            missingEdge: slice,
          });
        }
      }
    }
  }

  // ── (c) Impact edges: entries present in impact.md ──────────────────────────
  if (!planArtifact || !planArtifact.exists) {
    rows.push({
      artifact: 'PLAN.md',
      kind: 'consistency',
      ref: 'Impact edges present in impact.md',
      status: 'skipped',
      evidence: 'PLAN.md not available — skipping Impact edges presence check',
    });
  } else if (!impactArtifact || !impactArtifact.exists) {
    rows.push({
      artifact: 'PLAN.md',
      kind: 'consistency',
      ref: 'Impact edges present in impact.md',
      status: 'skipped',
      evidence: 'impact.md not available — skipping Impact edges presence check',
    });
  } else {
    const taskImpactEdges = extractTaskImpactEdges(planArtifact.content);
    const impactEdges = extractEdgeIds(impactArtifact.path);
    const impactEdgeSet = new Set(impactEdges.map((e) => normalizeFilePath(e)));

    if (taskImpactEdges.length === 0) {
      rows.push({
        artifact: 'PLAN.md',
        kind: 'consistency',
        ref: 'Impact edges present in impact.md',
        status: 'ok',
        evidence: 'No "Impact edges:" entries found in PLAN.md — check vacuously passes',
      });
    }

    for (const { taskId, edgeIds } of taskImpactEdges) {
      for (const edgeId of edgeIds) {
        const norm = normalizeFilePath(edgeId);
        const inImpact =
          impactEdgeSet.has(norm) ||
          [...impactEdgeSet].some(
            (e) =>
              e.endsWith('/' + norm) ||
              norm.endsWith('/' + e) ||
              path.basename(e) === path.basename(norm)
          );

        if (inImpact) {
          rows.push({
            artifact: 'PLAN.md',
            kind: 'consistency',
            ref: edgeId,
            status: 'ok',
            evidence: `${taskId} "Impact edges: ${edgeId}" present in impact.md`,
            taskId,
          });
        } else {
          rows.push({
            artifact: 'PLAN.md',
            kind: 'consistency',
            ref: edgeId,
            status: 'advisory',
            evidence: `${taskId} "Impact edges: ${edgeId}" not found in impact.md — missing edge`,
            taskId,
            missingEdge: edgeId,
          });
        }
      }
    }
  }

  // ── (d) Blocker resolution — Blocked by: T{n} resolves ─────────────────────
  if (!planArtifact || !planArtifact.exists) {
    rows.push({
      artifact: 'PLAN.md',
      kind: 'consistency',
      ref: 'Blocked by: resolution',
      status: 'skipped',
      evidence: 'PLAN.md not available — skipping blocker resolution check',
    });
  } else if (taskIds.size === 0) {
    rows.push({
      artifact: 'PLAN.md',
      kind: 'consistency',
      ref: 'Blocked by: resolution',
      status: 'skipped',
      evidence: 'No task IDs in PLAN.md — skipping blocker resolution check',
    });
  } else {
    const blockerRefs = extractBlockerRefs(planArtifact.content);

    if (blockerRefs.length === 0) {
      rows.push({
        artifact: 'PLAN.md',
        kind: 'consistency',
        ref: 'Blocked by: resolution',
        status: 'ok',
        evidence: 'No "Blocked by:" entries in PLAN.md — check vacuously passes',
      });
    }

    for (const { taskId, blockerRef } of blockerRefs) {
      const resolves = checkBlockerResolves(blockerRef, taskIds);
      if (resolves) {
        rows.push({
          artifact: 'PLAN.md',
          kind: 'consistency',
          ref: blockerRef,
          status: 'ok',
          evidence: `${taskId} blocker ${blockerRef} resolves to a known task in PLAN.md`,
          taskId,
        });
      } else {
        rows.push({
          artifact: 'PLAN.md',
          kind: 'consistency',
          ref: blockerRef,
          status: 'advisory',
          evidence: `${taskId} "Blocked by: ${blockerRef}" — dangling blocker: ${blockerRef} not defined in PLAN.md`,
          taskId,
        });
      }
    }
  }

  // ── (e) findings.md files_read scoped to declared paths ─────────────────────
  if (!findingsArtifact || !findingsArtifact.exists) {
    rows.push({
      artifact: 'findings.md',
      kind: 'consistency',
      ref: 'files_read scoping',
      status: 'skipped',
      evidence: 'findings.md not available — skipping files_read scope check',
    });
  } else {
    // Build the declared scope: impact edges ∪ PLAN Files entries
    const declaredScope = new Set();

    if (impactArtifact && impactArtifact.exists) {
      for (const e of extractEdgeIds(impactArtifact.path)) {
        declaredScope.add(normalizeFilePath(e));
      }
    }

    if (planArtifact && planArtifact.exists) {
      // Extract all Files: entries from PLAN
      const filesPattern = /^\s*-?\s*Files?:\s*(.+)$/gim;
      let m;
      while ((m = filesPattern.exec(planArtifact.content)) !== null) {
        const items = m[1]
          .split(/[,\s]+/)
          .map((s) => s.replace(/`/g, '').trim())
          .filter((s) => s && /\.\w{1,8}$/.test(s));
        for (const item of items) {
          declaredScope.add(normalizeFilePath(item));
        }
      }
    }

    // Extract files_read from findings.md
    const filesReadPattern = /^\s*-?\s*files_read:\s*(.+)$/gim;
    let m;
    let hasFilesRead = false;
    while ((m = filesReadPattern.exec(findingsArtifact.content)) !== null) {
      hasFilesRead = true;
      const items = m[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => s && (/\.\w{1,8}$/.test(s) || s.includes('/')));
      for (const fileRead of items) {
        const norm = normalizeFilePath(fileRead);
        if (declaredScope.size === 0) {
          // No declared scope available — cannot check scoping
          rows.push({
            artifact: 'findings.md',
            kind: 'consistency',
            ref: fileRead,
            status: 'skipped',
            evidence: `files_read "${fileRead}" — no declared scope (impact.md + PLAN.md) to validate against`,
          });
        } else {
          const inScope =
            declaredScope.has(norm) ||
            [...declaredScope].some(
              (s) =>
                s.endsWith('/' + norm) ||
                norm.endsWith('/' + s) ||
                path.basename(s) === path.basename(norm)
            );

          if (inScope) {
            rows.push({
              artifact: 'findings.md',
              kind: 'consistency',
              ref: fileRead,
              status: 'ok',
              evidence: `findings files_read "${fileRead}" is within declared scope (impact + plan paths)`,
            });
          } else {
            rows.push({
              artifact: 'findings.md',
              kind: 'consistency',
              ref: fileRead,
              status: 'advisory',
              evidence: `findings files_read "${fileRead}" is outside declared scope (not in impact.md edges or PLAN Files:)`,
            });
          }
        }
      }
    }

    if (!hasFilesRead) {
      rows.push({
        artifact: 'findings.md',
        kind: 'consistency',
        ref: 'files_read scoping',
        status: 'ok',
        evidence: 'No files_read entries in findings.md — check vacuously passes',
      });
    }
  }

  return rows;
}

// ── Main validation logic ─────────────────────────────────────────────────────

/**
 * Perform existence checks for a single artifact file.
 *
 * Returns an array of per-check rows, each:
 *   { artifact: string, kind: string, ref: string, status: "ok"|"missing"|"skipped", evidence: string }
 *
 * @param {string} artifactName  - Short name of the artifact (e.g. "sketch.md")
 * @param {string} artifactPath  - Absolute path to the artifact file
 * @param {string} repoRoot      - Absolute path to repository root
 * @param {Set<string>} taskIds  - Known task IDs from PLAN.md (for task_id resolution)
 * @param {boolean} isSkipped    - When true, artifact is missing → emit skipped rows
 * @returns {Array<{artifact, kind, ref, status, evidence}>}
 */
function checkArtifactExistence(artifactName, artifactPath, repoRoot, taskIds, isSkipped) {
  if (isSkipped) {
    return [{
      artifact: artifactName,
      kind: 'artifact_file',
      ref: artifactPath,
      status: 'skipped',
      evidence: `Artifact ${artifactName} does not exist yet — upstream stage has not run`,
    }];
  }

  const content = fs.readFileSync(artifactPath, 'utf8');
  const rows = [];

  // Extract refs based on artifact type
  let refs = [];
  const base = path.basename(artifactName).toLowerCase();

  if (base === 'sketch.md') {
    refs = extractSketchRefs(content);
  } else if (base === 'impact.md') {
    refs = extractImpactRefs(content, artifactPath);
  } else if (base === 'plan.md') {
    refs = extractPlanRefs(content, artifactPath);
  } else if (base === 'findings.md') {
    refs = extractFindingsRefs(content);
  } else if (base === 'verify-result.json') {
    refs = extractVerifyResultRefs(content);
  } else {
    // Spec file or other — extract generic refs
    refs = extractSpecRefs(content);
  }

  for (const { kind, ref } of refs) {
    if (!ref) continue;

    let status;
    let evidence;

    if (kind === 'task_id') {
      // Validate task ID against known task IDs from PLAN.md.
      // Dangling blockers are advisory (not hard-fail) per REQ-2(d) and AC-3.
      // The cross-consistency check also covers this with per-task context.
      const resolves = taskIds.size > 0
        ? checkBlockerResolves(ref, taskIds)
        : false;

      if (resolves) {
        status = 'ok';
        evidence = `Task ID ${ref} found in PLAN.md`;
      } else if (taskIds.size === 0) {
        status = 'skipped';
        evidence = `PLAN.md not available to validate task ID ${ref}`;
      } else {
        // Advisory — not missing — per REQ-4 (consistency advisory by default) + AC-3
        status = 'advisory';
        evidence = `Task ID ${ref} not defined in PLAN.md — dangling blocker reference`;
      }
    } else if (kind === 'file_path' || kind === 'edge_id') {
      // File path / edge ID — use direct fs.existsSync (no grep fallback).
      // Grep would false-positive by finding the ref text inside artifact files.
      const absolutePath = path.isAbsolute(ref)
        ? ref
        : path.join(repoRoot, ref);

      if (fs.existsSync(absolutePath)) {
        status = 'ok';
        evidence = `File exists: ${absolutePath}`;
      } else {
        status = 'missing';
        evidence = `"${ref}" not found at ${absolutePath}`;
      }
    } else {
      // symbol_ref — use full LSP + grep resolution
      const result = checkReferenceExists(ref, repoRoot);
      status = result.exists ? 'ok' : 'missing';
      evidence = result.exists
        ? `Resolved via ${result.method}: ${result.evidence}`
        : result.evidence;
    }

    rows.push({
      artifact: artifactName,
      kind,
      ref,
      status,
      evidence,
    });
  }

  // If no refs were extracted, emit an informational row
  if (rows.length === 0) {
    rows.push({
      artifact: artifactName,
      kind: 'artifact_file',
      ref: artifactPath,
      status: 'ok',
      evidence: `Artifact ${artifactName} exists; no resolvable references found`,
    });
  }

  return rows;
}

/**
 * Validate all artifacts for a given spec.
 *
 * Artifacts checked:
 *   - .deepflow/maps/{spec}/sketch.md
 *   - .deepflow/maps/{spec}/impact.md
 *   - PLAN.md (or .deepflow/plans/{spec}.md)
 *   - .deepflow/maps/{spec}/findings.md
 *   - .deepflow/maps/{spec}/verify-result.json
 *   - specs/doing-{spec}.md
 *
 * @param {string} specName  - Spec name (without doing-/done- prefix)
 * @param {string} repoRoot  - Absolute path to repository root
 * @param {object} [opts]    - Options
 * @param {'interactive'|'auto'} [opts.mode]  - 'auto' escalates advisories to hard (REQ-4, AC-5)
 * @returns {{
 *   checks: Array<{artifact, kind, ref, status, evidence}>,
 *   hardFails: Array<{artifact, kind, ref, status, evidence}>,
 *   exit_code: 0|1
 * }}
 */
function validateArtifacts(specName, repoRoot, opts = {}) {
  const { mode = 'interactive' } = opts;

  const mapsDir = path.join(repoRoot, '.deepflow', 'maps', specName);
  const allChecks = [];

  // ── Load config ───────────────────────────────────────────────────────────
  const config = loadArtifactValidationConfig(repoRoot);

  // ── Locate PLAN.md ────────────────────────────────────────────────────────
  // Search order: {repoRoot}/PLAN.md, .deepflow/plans/doing-{spec}.md, .deepflow/plans/{spec}.md
  let planPath = null;
  const planCandidates = [
    path.join(repoRoot, 'PLAN.md'),
    path.join(repoRoot, '.deepflow', 'plans', `doing-${specName}.md`),
    path.join(repoRoot, '.deepflow', 'plans', `${specName}.md`),
    path.join(repoRoot, '.deepflow', 'plans', `done-${specName}.md`),
  ];
  for (const candidate of planCandidates) {
    if (fs.existsSync(candidate)) {
      planPath = candidate;
      break;
    }
  }

  // Extract task IDs from PLAN.md for blocker reference validation
  let taskIds = new Set();
  if (planPath) {
    taskIds = extractTaskIds(planPath);
  }

  // ── Locate artifact paths ─────────────────────────────────────────────────

  const sketchPath = path.join(mapsDir, 'sketch.md');
  const sketchExists = fs.existsSync(sketchPath);

  const impactPath = path.join(mapsDir, 'impact.md');
  const impactExists = fs.existsSync(impactPath);

  const findingsPath = path.join(mapsDir, 'findings.md');
  const findingsExists = fs.existsSync(findingsPath);

  const verifyResultPath = path.join(mapsDir, 'verify-result.json');
  const verifyResultExists = fs.existsSync(verifyResultPath);

  // Spec file: specs/doing-{spec}.md
  const specFileCandidates = [
    path.join(repoRoot, 'specs', `doing-${specName}.md`),
    path.join(repoRoot, 'specs', `${specName}.md`),
    path.join(repoRoot, 'specs', `done-${specName}.md`),
  ];
  let specFilePath = null;
  for (const c of specFileCandidates) {
    if (fs.existsSync(c)) { specFilePath = c; break; }
  }

  // ── Build artifacts map for cross-consistency checks ──────────────────────
  // Read content for existing artifacts so we can pass to checkCrossConsistency
  function safeReadFile(filePath) {
    try { return fs.readFileSync(filePath, 'utf8'); } catch (_) { return ''; }
  }

  const artifactsMap = {
    'sketch.md': {
      path: sketchPath,
      exists: sketchExists,
      content: sketchExists ? safeReadFile(sketchPath) : '',
    },
    'impact.md': {
      path: impactPath,
      exists: impactExists,
      content: impactExists ? safeReadFile(impactPath) : '',
    },
    'PLAN.md': {
      path: planPath || path.join(repoRoot, 'PLAN.md'),
      exists: !!planPath,
      content: planPath ? safeReadFile(planPath) : '',
    },
    'findings.md': {
      path: findingsPath,
      exists: findingsExists,
      content: findingsExists ? safeReadFile(findingsPath) : '',
    },
  };

  // ── Check each artifact existence ─────────────────────────────────────────

  // 1. Spec file: specs/doing-{spec}.md
  const specArtifactName = `specs/doing-${specName}.md`;
  const specIsSkipped = !specFilePath;
  allChecks.push(
    ...checkArtifactExistence(
      specArtifactName,
      specFilePath || specArtifactName,
      repoRoot,
      taskIds,
      specIsSkipped
    )
  );

  // 2. sketch.md
  allChecks.push(
    ...checkArtifactExistence(
      'sketch.md',
      sketchPath,
      repoRoot,
      taskIds,
      !sketchExists
    )
  );

  // 3. impact.md
  allChecks.push(
    ...checkArtifactExistence(
      'impact.md',
      impactPath,
      repoRoot,
      taskIds,
      !impactExists
    )
  );

  // 4. PLAN.md
  const planIsSkipped = !planPath;
  allChecks.push(
    ...checkArtifactExistence(
      'PLAN.md',
      planPath || path.join(repoRoot, 'PLAN.md'),
      repoRoot,
      taskIds,
      planIsSkipped
    )
  );

  // 5. findings.md
  allChecks.push(
    ...checkArtifactExistence(
      'findings.md',
      findingsPath,
      repoRoot,
      taskIds,
      !findingsExists
    )
  );

  // 6. verify-result.json
  allChecks.push(
    ...checkArtifactExistence(
      'verify-result.json',
      verifyResultPath,
      repoRoot,
      taskIds,
      !verifyResultExists
    )
  );

  // ── REQ-2: Cross-consistency checks ──────────────────────────────────────
  if (config.enforcement.consistency !== 'off') {
    const consistencyRows = checkCrossConsistency(artifactsMap, taskIds);
    allChecks.push(...consistencyRows);
  }

  // ── Classify failures ─────────────────────────────────────────────────────
  // Existence violations always hard-fail (REQ-4)
  const existenceHardFails = allChecks.filter((c) => c.status === 'missing');

  // Consistency advisories: hard-fail in auto mode (REQ-4, AC-5)
  const consistencyAdvisories = allChecks.filter(
    (c) => c.kind === 'consistency' && c.status === 'advisory'
  );
  const consistencyHardFails =
    mode === 'auto' && config.enforcement.consistency !== 'off'
      ? consistencyAdvisories
      : [];

  const hardFails = [...existenceHardFails, ...consistencyHardFails];

  return {
    checks: allChecks,
    hardFails,
    exit_code: hardFails.length > 0 ? 1 : 0,
  };
}

/**
 * Write results JSON to .deepflow/results/validate-{spec}-{artifact}.json
 *
 * Schema (REQ-5):
 * {
 *   artifact: string,
 *   checks: [{family, name, status, evidence}],
 *   exit_code: 0|1
 * }
 *
 * @param {string} specName
 * @param {string} artifactName
 * @param {Array}  checks
 * @param {number} exitCode
 * @param {string} repoRoot
 */
function writeResultsJson(specName, artifactName, checks, exitCode, repoRoot) {
  const resultsDir = path.join(repoRoot, '.deepflow', 'results');
  try {
    fs.mkdirSync(resultsDir, { recursive: true });
    const safeArtifact = artifactName.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const filename = `validate-${specName}-${safeArtifact}.json`;
    const resultPath = path.join(resultsDir, filename);

    // Map internal check rows to REQ-5 schema
    // family: 'consistency' for cross-consistency rows, 'existence' for reference checks
    const schemaChecks = checks.map((c) => ({
      family: c.kind === 'consistency' ? 'consistency' : 'existence',
      name: `${c.kind}:${c.ref}`,
      status: c.status === 'ok' ? 'pass'
        : c.status === 'missing' ? 'fail'
        : c.status === 'advisory' ? 'warn'
        : c.status, // skipped → 'skipped'
      evidence: c.evidence,
    }));

    const result = {
      artifact: artifactName,
      checks: schemaChecks,
      exit_code: exitCode,
    };

    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) {
    // Non-fatal — result file write failure does not block validation
  }
}

/**
 * Detect the spec name from a hook payload or environment.
 *
 * For PostToolUse payloads, the edited file path is used to detect which spec
 * is being updated (by matching `.deepflow/maps/{spec}/` or `specs/doing-{spec}`).
 *
 * @param {object} payload - Claude Code PostToolUse payload
 * @param {string} repoRoot - Absolute path to repository root
 * @returns {string|null} Detected spec name, or null if not detectable
 */
function detectSpecName(payload, repoRoot) {
  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolInput.file_path || toolInput.path || '';

  if (!filePath) return null;

  // Match: .deepflow/maps/{spec}/sketch.md etc.
  const mapsMatch = filePath.match(/\.deepflow\/maps\/([^/]+)\//);
  if (mapsMatch) return mapsMatch[1];

  // Match: specs/doing-{spec}.md or specs/{spec}.md
  const specMatch = filePath.match(/specs\/(?:doing-|done-)?([^/]+)\.md$/);
  if (specMatch) return specMatch[1];

  // Match: .deepflow/plans/doing-{spec}.md
  const planMatch = filePath.match(/\.deepflow\/plans\/(?:doing-|done-)?([^/]+)\.md$/);
  if (planMatch) return planMatch[1];

  return null;
}

/**
 * Check whether the edited file is one of the 5 artifacts (or a spec file).
 *
 * @param {object} payload - Claude Code PostToolUse payload
 * @returns {boolean}
 */
function isArtifactFile(payload) {
  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolInput.file_path || toolInput.path || '';
  if (!filePath) return false;

  // Match artifacts inside .deepflow/maps/{spec}/ — all 5 artifact types
  if (/\.deepflow\/maps\/[^/]+\//.test(filePath)) return true;

  // Spec file: specs/doing-*.md or specs/done-*.md (but not src/commands/df/*.md)
  if (/(?:^|\/)specs\/(?:doing-|done-)?[^/]+\.md$/.test(filePath)) return true;

  // Top-level PLAN.md (not inside src/commands)
  if (/(?:^|\/)PLAN\.md$/.test(filePath) && !/src\/commands/.test(filePath)) return true;

  return false;
}

// ── CLI / Hook entry point ────────────────────────────────────────────────────

/**
 * Format check rows for human-readable output (one JSON line per row).
 *
 * @param {Array} checks
 * @param {string} label
 */
function printChecks(checks, label) {
  if (checks.length === 0) return;
  process.stderr.write(`\n[df-artifact-validate] ${label}:\n`);
  for (const row of checks) {
    process.stderr.write(JSON.stringify(row) + '\n');
  }
}

/**
 * Main CLI handler.
 *
 * @param {string[]} args - process.argv.slice(2)
 */
function runCli(args) {
  const specIdx = args.indexOf('--spec');
  const repoIdx = args.indexOf('--repo');
  const autoMode = args.includes('--auto');

  const specName = specIdx !== -1 ? args[specIdx + 1] : null;
  const repoRoot = repoIdx !== -1 ? args[repoIdx + 1] : process.cwd();

  if (!specName) {
    process.stderr.write('[df-artifact-validate] Usage: df-artifact-validate.js --spec <name> [--repo <path>] [--auto]\n');
    process.exit(1);
  }

  const mode = autoMode ? 'auto' : 'interactive';
  const { checks, hardFails, exit_code } = validateArtifacts(specName, repoRoot, { mode });

  // Emit all rows to stdout as machine-parseable JSON (one per line)
  for (const row of checks) {
    process.stdout.write(JSON.stringify(row) + '\n');
  }

  // Write per-artifact results files (REQ-5)
  const artifactNames = [...new Set(checks.map((c) => c.artifact))];
  for (const artifactName of artifactNames) {
    const artifactChecks = checks.filter((c) => c.artifact === artifactName);
    writeResultsJson(specName, artifactName, artifactChecks, exit_code, repoRoot);
  }

  // Emit advisory rows to stderr even when not hard-failing (REQ-2, REQ-4)
  const advisories = checks.filter((c) => c.status === 'advisory');
  if (advisories.length > 0) {
    process.stderr.write('\n[df-artifact-validate] CONSISTENCY ADVISORIES:\n');
    for (const row of advisories) {
      const taskNote = row.taskId ? ` [task=${row.taskId}]` : '';
      const edgeNote = row.missingEdge ? ` missing-edge=${JSON.stringify(row.missingEdge)}` : '';
      process.stderr.write(`  artifact=${row.artifact} ref=${JSON.stringify(row.ref)}${taskNote}${edgeNote}\n`);
      process.stderr.write(`  evidence: ${row.evidence}\n`);
    }
    if (mode !== 'auto') {
      process.stderr.write(`[df-artifact-validate] ${advisories.length} consistency advisory(s) — warning only (use --auto to escalate)\n`);
    }
  }

  if (hardFails.length > 0) {
    const existFails = hardFails.filter((c) => c.status === 'missing');
    const consFails = hardFails.filter((c) => c.status === 'advisory');
    if (existFails.length > 0) {
      process.stderr.write('\n[df-artifact-validate] EXISTENCE VIOLATIONS (hard-fail):\n');
      for (const row of existFails) {
        process.stderr.write(`  artifact=${row.artifact} kind=${row.kind} ref=${JSON.stringify(row.ref)}\n`);
        process.stderr.write(`  evidence: ${row.evidence}\n`);
      }
    }
    if (consFails.length > 0) {
      process.stderr.write('\n[df-artifact-validate] CONSISTENCY VIOLATIONS (auto-mode escalation):\n');
      for (const row of consFails) {
        process.stderr.write(`  artifact=${row.artifact} ref=${JSON.stringify(row.ref)}\n`);
        process.stderr.write(`  evidence: ${row.evidence}\n`);
      }
    }
    process.stderr.write(`\n[df-artifact-validate] ${hardFails.length} violation(s) found — blocking\n`);
    process.exit(1);
  }

  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const passed = checks.filter((c) => c.status === 'ok').length;
  process.stderr.write(`[df-artifact-validate] ${passed} ok, ${skipped} skipped, ${advisories.length} advisory, 0 hard violations\n`);
  process.exit(0);
}

/**
 * PostToolUse hook handler.
 * Called when Claude Code writes/edits a file. Checks if the file is one of
 * the 5 artifacts and runs existence validation for the detected spec.
 *
 * @param {object} payload - Claude Code PostToolUse JSON payload
 */
function hookHandler(payload) {
  // Skip if not an artifact file
  if (!isArtifactFile(payload)) {
    return;
  }

  const repoRoot = process.cwd();
  const specName = detectSpecName(payload, repoRoot);

  if (!specName) {
    // Cannot determine spec — skip silently
    return;
  }

  const mode = (payload && payload.mode) === 'auto' ? 'auto' : 'interactive';
  const { checks, hardFails, exit_code } = validateArtifacts(specName, repoRoot, { mode });

  // Emit machine-parseable rows to stdout
  for (const row of checks) {
    process.stdout.write(JSON.stringify(row) + '\n');
  }

  // Write per-artifact results files (REQ-5)
  const artifactNames = [...new Set(checks.map((c) => c.artifact))];
  for (const artifactName of artifactNames) {
    const artifactChecks = checks.filter((c) => c.artifact === artifactName);
    writeResultsJson(specName, artifactName, artifactChecks, exit_code, repoRoot);
  }

  // Emit advisory rows to stderr (non-hard in interactive mode)
  const advisories = checks.filter((c) => c.status === 'advisory');
  if (advisories.length > 0) {
    process.stderr.write('\n[df-artifact-validate] CONSISTENCY ADVISORIES:\n');
    for (const row of advisories) {
      process.stderr.write(`  ${JSON.stringify(row)}\n`);
    }
  }

  if (hardFails.length > 0) {
    process.stderr.write('\n[df-artifact-validate] VIOLATIONS (hard-fail):\n');
    for (const row of hardFails) {
      process.stderr.write(`  ${JSON.stringify(row)}\n`);
    }
    process.exit(1);
  }
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
  validateArtifacts,
  checkArtifactExistence,
  checkCrossConsistency,
  extractSketchRefs,
  extractSketchModules,
  extractImpactRefs,
  extractPlanRefs,
  extractFindingsRefs,
  extractVerifyResultRefs,
  extractSpecRefs,
  extractTaskSlices,
  extractTaskImpactEdges,
  loadArtifactValidationConfig,
  detectSpecName,
  isArtifactFile,
  writeResultsJson,
};

// ── Entry point ───────────────────────────────────────────────────────────────

// CLI mode: node df-artifact-validate.js --spec <name> [--repo <path>]
if (require.main === module) {
  const args = process.argv.slice(2);

  // Check if invoked as CLI (has --spec flag) or as PostToolUse hook (stdin)
  if (args.includes('--spec')) {
    runCli(args);
  } else {
    // PostToolUse hook mode — read JSON from stdin
    readStdinIfMain(module, hookHandler);
  }
}
