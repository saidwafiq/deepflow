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
      // Validate task ID against known task IDs from PLAN.md
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
        status = 'missing';
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

  // ── Check each artifact ───────────────────────────────────────────────────

  // 1. Spec file: specs/doing-{spec}.md
  const specFileCandidates = [
    path.join(repoRoot, 'specs', `doing-${specName}.md`),
    path.join(repoRoot, 'specs', `${specName}.md`),
    path.join(repoRoot, 'specs', `done-${specName}.md`),
  ];
  let specFilePath = null;
  for (const c of specFileCandidates) {
    if (fs.existsSync(c)) { specFilePath = c; break; }
  }
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
  const sketchPath = path.join(mapsDir, 'sketch.md');
  const sketchExists = fs.existsSync(sketchPath);
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
  const impactPath = path.join(mapsDir, 'impact.md');
  const impactExists = fs.existsSync(impactPath);
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
  const findingsPath = path.join(mapsDir, 'findings.md');
  const findingsExists = fs.existsSync(findingsPath);
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
  const verifyResultPath = path.join(mapsDir, 'verify-result.json');
  const verifyResultExists = fs.existsSync(verifyResultPath);
  allChecks.push(
    ...checkArtifactExistence(
      'verify-result.json',
      verifyResultPath,
      repoRoot,
      taskIds,
      !verifyResultExists
    )
  );

  // ── Classify failures ─────────────────────────────────────────────────────
  // Existence violations always hard-fail (REQ-4)
  const hardFails = allChecks.filter((c) => c.status === 'missing');

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
    const schemaChecks = checks.map((c) => ({
      family: 'existence',
      name: `${c.kind}:${c.ref}`,
      status: c.status === 'ok' ? 'pass' : c.status === 'missing' ? 'fail' : c.status,
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

  if (hardFails.length > 0) {
    process.stderr.write('\n[df-artifact-validate] EXISTENCE VIOLATIONS (hard-fail):\n');
    for (const row of hardFails) {
      process.stderr.write(`  artifact=${row.artifact} kind=${row.kind} ref=${JSON.stringify(row.ref)}\n`);
      process.stderr.write(`  evidence: ${row.evidence}\n`);
    }
    process.stderr.write(`\n[df-artifact-validate] ${hardFails.length} existence violation(s) found — blocking\n`);
    process.exit(1);
  }

  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const passed = checks.filter((c) => c.status === 'ok').length;
  process.stderr.write(`[df-artifact-validate] ${passed} ok, ${skipped} skipped, 0 violations\n`);
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

  if (hardFails.length > 0) {
    process.stderr.write('\n[df-artifact-validate] EXISTENCE VIOLATIONS:\n');
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
  extractSketchRefs,
  extractImpactRefs,
  extractPlanRefs,
  extractFindingsRefs,
  extractVerifyResultRefs,
  extractSpecRefs,
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
