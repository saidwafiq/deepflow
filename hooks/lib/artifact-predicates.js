#!/usr/bin/env node
/**
 * @file artifact-predicates.js
 * @description Shared predicates for artifact validation and verification.
 * Factored from src/commands/df/verify.md L0/L1 logic (REQ-8, AC-9).
 *
 * Consumed by:
 *   - hooks/df-artifact-validate.js  (artifact pre-stage validation)
 *   - df:verify command runner       (L0/L1 post-implementation verification)
 *
 * Invariants:
 *   - LSP resolution via bin/lsp-query.js with 1500ms timeout (workspaceSymbol op)
 *   - Grep fallback when LSP unavailable or returns no results
 *   - Glob support via shell find (Node >=16 compatible, no external deps)
 *   - All set operations (intersection, union, jaccard, difference) are pure functions
 *   - Drift metric keys (jaccard_below, likely_files_coverage_pct, out_of_scope_count)
 *     are the canonical cross-spec contract with spike-gate REQ-4 — do not rename
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// ── Constants ────────────────────────────────────────────────────────────────

/** LSP query timeout in ms (spec Technical Notes: "1500ms timeout") */
const LSP_TIMEOUT_MS = 1500;

// ── Set operations (pure, no side effects) ───────────────────────────────────

/**
 * Compute the intersection of two iterables as a Set.
 *
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {Set<string>}
 */
function intersection(a, b) {
  const setB = b instanceof Set ? b : new Set(b);
  const result = new Set();
  for (const item of a) {
    if (setB.has(item)) result.add(item);
  }
  return result;
}

/**
 * Compute the union of two iterables as a Set.
 *
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {Set<string>}
 */
function union(a, b) {
  const result = new Set(a);
  for (const item of b) result.add(item);
  return result;
}

/**
 * Compute the set difference A \ B (items in A but not in B).
 *
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {Set<string>}
 */
function setDifference(a, b) {
  const setB = b instanceof Set ? b : new Set(b);
  const result = new Set();
  for (const item of a) {
    if (!setB.has(item)) result.add(item);
  }
  return result;
}

/**
 * Compute Jaccard distance between two sets:
 *   jaccardBelow = 1 − |A ∩ B| / |A ∪ B|
 *
 * Returns 0 when both sets are empty (identical empty sets → no divergence).
 * Returns 1 when sets are completely disjoint and non-empty.
 *
 * This is the canonical `drift.jaccard_below` metric consumed by spike-gate REQ-4.
 * Do NOT rename the returned property.
 *
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {number} Value in [0, 1]; higher = more divergence
 */
function computeJaccardBelow(a, b) {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const inter = intersection(setA, setB);
  const uni = union(setA, setB);
  return 1 - inter.size / uni.size;
}

// ── Drift metric functions ────────────────────────────────────────────────────

/**
 * Compute `drift.likely_files_coverage_pct`:
 *   (count of likelyFiles whose normalized form appears in planSlices) / total * 100
 *
 * A likelyFile is "covered" when any PLAN task Slice: entry matches it
 * (by basename or path suffix, to tolerate path prefix differences).
 *
 * @param {string[]} likelyFiles   - Files from sketch/spec likely_files
 * @param {string[]} planSlices    - Files listed under Slice: in PLAN tasks
 * @returns {number}  Percentage [0, 100]; higher = more coverage
 */
function computeLikelyFilesCoveragePct(likelyFiles, planSlices) {
  if (!likelyFiles || likelyFiles.length === 0) return 100; // vacuously covered
  const sliceSet = new Set(planSlices.map((f) => normalizeFilePath(f)));
  let covered = 0;
  for (const lf of likelyFiles) {
    const norm = normalizeFilePath(lf);
    // Match by exact normalized form, basename, or suffix
    if (
      sliceSet.has(norm) ||
      [...sliceSet].some(
        (s) => s.endsWith('/' + norm) || norm.endsWith('/' + s) || path.basename(s) === path.basename(norm)
      )
    ) {
      covered++;
    }
  }
  return (covered / likelyFiles.length) * 100;
}

/**
 * Compute `drift.out_of_scope_count`:
 *   count of PLAN task Files entries not present in impact.md edges
 *
 * @param {string[]} planFiles   - Files listed under Files: in PLAN tasks
 * @param {string[]} impactEdges - Edge file paths extracted from impact.md
 * @returns {number} Count of out-of-scope PLAN files
 */
function computeOutOfScopeCount(planFiles, impactEdges) {
  if (!planFiles || planFiles.length === 0) return 0;
  const edgeSet = new Set(impactEdges.map((f) => normalizeFilePath(f)));
  let count = 0;
  for (const pf of planFiles) {
    const norm = normalizeFilePath(pf);
    // A file is "out of scope" only if no impact edge matches it by any form
    const inEdges =
      edgeSet.has(norm) ||
      [...edgeSet].some(
        (e) => e.endsWith('/' + norm) || norm.endsWith('/' + e) || path.basename(e) === path.basename(norm)
      );
    if (!inEdges) count++;
  }
  return count;
}

// ── Glob support ─────────────────────────────────────────────────────────────

/**
 * Expand a glob pattern to matching file paths.
 * Uses shell `find` to avoid external npm dependencies and to stay Node >=16 compatible.
 *
 * Returns an empty array on any error (fail-open).
 *
 * @param {string} pattern  - Glob pattern (e.g. "hooks/**\/*.js", "src/commands/*.md")
 * @param {string} cwd      - Working directory for the expansion
 * @returns {string[]}      - Matched relative file paths (empty on no match or error)
 */
function expandGlob(pattern, cwd = process.cwd()) {
  // Fast path: no wildcard characters → check existence directly
  if (!/[*?[\]{}]/.test(pattern)) {
    const abs = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
    return fs.existsSync(abs) ? [pattern] : [];
  }

  // Convert glob to a find-compatible command:
  //   ** → recursive search
  //   *  → single-level wildcard
  try {
    // Use shell glob expansion via ls -d (POSIX, available everywhere)
    // Pipe through tr to get one path per line, then strip cwd prefix
    const result = execSync(`ls -d ${escapeShellArg(pattern)} 2>/dev/null || true`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });
    return result
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Normalize a file path for comparison:
 * - Strip leading "./"
 * - Normalize consecutive slashes
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizeFilePath(filePath) {
  if (!filePath) return '';
  return filePath.replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

/**
 * Escape a shell argument for use inside single quotes.
 * Only safe for simple patterns — not for arbitrary user input.
 *
 * @param {string} arg
 * @returns {string}
 */
function escapeShellArg(arg) {
  // For glob patterns we want shell expansion, so we return the pattern as-is
  // (surrounded by no quotes) for simple patterns. The caller uses it inside
  // execSync with shell: true (the default for execSync).
  return arg;
}

// ── LSP + grep reference resolution ──────────────────────────────────────────

/**
 * Resolve a symbol or file reference using LSP (workspaceSymbol) with a 1500ms timeout,
 * falling back to grep.
 *
 * Resolution order:
 *   1. File existence via fs.existsSync (fastest; handles most references)
 *   2. Glob expansion (handles wildcard references)
 *   3. LSP workspaceSymbol query via bin/lsp-query.js (1500ms budget)
 *   4. grep across .js/.ts/.md files (fallback when LSP unavailable)
 *
 * @param {string} reference   - File path, glob, or symbol name
 * @param {string} repoRoot    - Absolute path to repository root
 * @param {number} [timeout]   - LSP timeout in ms (default: 1500)
 * @returns {{ exists: boolean, method: 'fs'|'glob'|'lsp'|'grep'|'none', evidence: string }}
 */
function checkReferenceExists(reference, repoRoot, timeout = LSP_TIMEOUT_MS) {
  if (!reference || !repoRoot) {
    return { exists: false, method: 'none', evidence: 'Empty reference or repoRoot' };
  }

  // ── 1. Direct file existence ─────────────────────────────────────────────
  const absolutePath = path.isAbsolute(reference)
    ? reference
    : path.join(repoRoot, reference);

  if (fs.existsSync(absolutePath)) {
    return { exists: true, method: 'fs', evidence: absolutePath };
  }

  // ── 2. Glob expansion ────────────────────────────────────────────────────
  if (/[*?[\]{}]/.test(reference)) {
    const matches = expandGlob(reference, repoRoot);
    if (matches.length > 0) {
      return { exists: true, method: 'glob', evidence: matches[0] };
    }
    // Glob with wildcards that matched nothing → not found (don't fall through to LSP)
    return { exists: false, method: 'none', evidence: `Glob "${reference}" matched no files` };
  }

  // ── 3. LSP workspaceSymbol query ─────────────────────────────────────────
  const lspQueryPath = path.join(repoRoot, 'bin', 'lsp-query.js');
  if (fs.existsSync(lspQueryPath)) {
    try {
      const lspResult = execFileSync(
        process.execPath, // node
        [lspQueryPath, '--op', 'workspaceSymbol', '--query', reference, '--cwd', repoRoot],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: timeout + 500, // give a buffer over LSP's internal budget
        }
      );

      if (lspResult && lspResult.trim() && lspResult.trim() !== '[]') {
        // lsp-query emits a compact JSON array; non-empty means symbol found
        let parsed;
        try { parsed = JSON.parse(lspResult.trim()); } catch (_) { parsed = null; }
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];
          const loc = (first && first.location)
            ? `${first.location.uri || ''}:${(first.location.range && first.location.range.start) ? first.location.range.start.line : ''}`
            : JSON.stringify(first).slice(0, 80);
          return { exists: true, method: 'lsp', evidence: loc };
        }
      }
    } catch (_) {
      // LSP timed out or failed — fall through to grep
    }
  }

  // ── 4. Grep fallback ─────────────────────────────────────────────────────
  try {
    // Escape the reference for grep: treat as a literal string
    const escapedRef = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const grepResult = execSync(
      `grep -r --include="*.js" --include="*.ts" --include="*.md" -l "${escapedRef}" .`,
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      }
    );

    if (grepResult && grepResult.trim()) {
      const firstFile = grepResult.trim().split('\n')[0];
      return { exists: true, method: 'grep', evidence: `found in ${firstFile}` };
    }
  } catch (_) {
    // grep returned non-zero (no matches) or timed out
  }

  return { exists: false, method: 'none', evidence: `"${reference}" not found via fs, lsp, or grep` };
}

// ── Build check (L0 equivalent) ───────────────────────────────────────────────

/**
 * Check if build command passes (L0 equivalent from verify.md).
 *
 * @param {string} buildCommand - Build command to execute
 * @param {string} [cwd]        - Working directory (defaults to process.cwd())
 * @returns {{ pass: boolean, output: string }}
 */
function checkBuildPasses(buildCommand, cwd = process.cwd()) {
  if (!buildCommand) {
    return { pass: true, output: 'No build command configured' };
  }

  try {
    const output = execSync(buildCommand, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300000, // 5 min
    });
    return { pass: true, output };
  } catch (error) {
    const stderr = error.stderr || error.stdout || error.message || '';
    const lines = stderr.split('\n');
    const lastLines = lines.slice(-30).join('\n');
    return { pass: false, output: lastLines };
  }
}

// ── Scope coverage check (L1 equivalent) ─────────────────────────────────────

/**
 * Check if all planned files appear in the worktree diff against the base branch (L1 equivalent).
 *
 * @param {string[]} plannedFiles  - Files from PLAN.md Files: entries
 * @param {string}   worktreePath  - Path to the worktree
 * @param {string}   [baseBranch]  - Base branch to diff against (default: "main")
 * @returns {{ pass: boolean, missing: string[], present: string[] }}
 */
function checkScopeCoverage(plannedFiles, worktreePath, baseBranch = 'main') {
  if (!plannedFiles || plannedFiles.length === 0) {
    return { pass: true, missing: [], present: [] };
  }

  let diffOutput;
  try {
    diffOutput = execSync(`git diff ${baseBranch}...HEAD --name-only`, {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (_) {
    return { pass: false, missing: plannedFiles, present: [] };
  }

  const changedFiles = new Set(
    diffOutput
      .split('\n')
      .map((line) => normalizeFilePath(line.trim()))
      .filter(Boolean)
  );

  const missing = [];
  const present = [];

  for (const planned of plannedFiles) {
    const norm = normalizeFilePath(planned);
    if (changedFiles.has(norm)) {
      present.push(planned);
    } else {
      missing.push(planned);
    }
  }

  return { pass: missing.length === 0, missing, present };
}

// ── Task ID extraction ────────────────────────────────────────────────────────

/**
 * Extract all task IDs defined in a PLAN.md file.
 * Matches lines like:  `- [ ] **T25**: ...`  or  `- [x] **T25**: ...`
 *
 * @param {string} planPath - Absolute path to PLAN.md (or any plan file)
 * @returns {Set<string>}   Set of task IDs (e.g., {"T1", "T25"})
 */
function extractTaskIds(planPath) {
  if (!planPath || !fs.existsSync(planPath)) {
    return new Set();
  }

  const content = fs.readFileSync(planPath, 'utf8');
  // Matches: - [ ] **T25**: or - [x] **T25** [TAG]:
  const taskIdPattern = /^[-*]\s+\[.\]\s+\*\*T(\d+)\*\*/gm;
  const ids = new Set();

  let match;
  while ((match = taskIdPattern.exec(content)) !== null) {
    ids.add(`T${match[1]}`);
  }

  return ids;
}

/**
 * Check if a blocker reference (e.g. "T99") resolves to a known task ID.
 *
 * @param {string}      blockerRef   - Task ID string, e.g. "T99"
 * @param {Set<string>} validTaskIds - Set of known IDs from extractTaskIds()
 * @returns {boolean}
 */
function checkBlockerResolves(blockerRef, validTaskIds) {
  return validTaskIds.has(blockerRef);
}

// ── Edge ID extraction ────────────────────────────────────────────────────────

/**
 * Extract edge IDs (file paths) from an impact.md file.
 *
 * Impact files list edges in sections like "## Modules" or "## Edges" with
 * list items such as:  `- src/hooks/df-artifact-validate.js`
 *
 * Also captures bare file paths in code blocks and `Files:` lists.
 *
 * @param {string} impactPath - Absolute path to impact.md
 * @returns {string[]}        Array of file paths (deduplicated)
 */
function extractEdgeIds(impactPath) {
  if (!impactPath || !fs.existsSync(impactPath)) {
    return [];
  }

  const content = fs.readFileSync(impactPath, 'utf8');
  const edges = new Set();

  // Pattern 1: markdown list items that look like file paths
  //   - hooks/lib/artifact-predicates.js
  //   - `src/commands/df/verify.md`
  const listItemPattern = /^[-*]\s+`?([^\s`]+\.[a-z]{1,6})`?\s*$/gm;
  let m;
  while ((m = listItemPattern.exec(content)) !== null) {
    edges.add(normalizeFilePath(m[1]));
  }

  // Pattern 2: "Files:" or "Slice:" colon-delimited lists (inline or multi-line)
  //   Files: hooks/df-artifact-validate.js, hooks/lib/artifact-predicates.js
  const colonListPattern = /(?:Files|Slice|Edges|Modules):\s*([^\n]+)/gi;
  while ((m = colonListPattern.exec(content)) !== null) {
    const items = m[1].split(/[,\s]+/).map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
    for (const item of items) {
      if (/\.\w{1,6}$/.test(item)) edges.add(normalizeFilePath(item));
    }
  }

  // Pattern 3: bare file paths in code fences (``` blocks)
  const codeFencePattern = /```[^\n]*\n([\s\S]*?)```/g;
  while ((m = codeFencePattern.exec(content)) !== null) {
    const block = m[1];
    const pathPattern = /[\w./][\w./\-]*\.[a-z]{1,6}/g;
    let pm;
    while ((pm = pathPattern.exec(block)) !== null) {
      const candidate = pm[0];
      if (candidate.includes('/') && !candidate.startsWith('//')) {
        edges.add(normalizeFilePath(candidate));
      }
    }
  }

  return [...edges];
}

// ── PLAN.md parsing helpers ───────────────────────────────────────────────────

/**
 * Extract all `Files:` entries from PLAN.md tasks in a given spec section.
 * Returns a flat list of file paths from all tasks.
 *
 * Handles single-line format:
 *   Files: hooks/df-artifact-validate.js, hooks/lib/artifact-predicates.js
 * And YAML-list format:
 *   - Files: `hooks/df-artifact-validate.js`
 *
 * @param {string}      planContent - Raw content of PLAN.md
 * @param {string|null} [specName]  - Optional spec section name to filter by
 * @returns {string[]}
 */
function extractPlanFiles(planContent, specName = null) {
  if (!planContent) return [];

  const files = new Set();
  let content = planContent;

  // If specName provided, try to scope to just that spec section
  if (specName) {
    const specSection = extractPlanSpecSection(planContent, specName);
    if (specSection) content = specSection;
  }

  // Match "Files: ..." lines (possibly with backtick-quoted items)
  const filesPattern = /^\s*-\s+Files:\s*(.+)$/gm;
  let m;
  while ((m = filesPattern.exec(content)) !== null) {
    const items = m[1].split(/[,\s]+/).map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
    for (const item of items) {
      if (item && /\.\w{1,6}$/.test(item)) files.add(normalizeFilePath(item));
    }
  }

  // Match top-level "Files: ..." (without leading "- ")
  const topLevelFilesPattern = /^  Files:\s*(.+)$/gm;
  while ((m = topLevelFilesPattern.exec(content)) !== null) {
    const items = m[1].split(/[,\s]+/).map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
    for (const item of items) {
      if (item && /\.\w{1,6}$/.test(item)) files.add(normalizeFilePath(item));
    }
  }

  return [...files];
}

/**
 * Extract all `Slice:` entries from PLAN.md tasks (files the task will touch).
 *
 * @param {string}      planContent - Raw content of PLAN.md
 * @param {string|null} [specName]  - Optional spec section name to filter by
 * @returns {string[]}
 */
function extractPlanSlices(planContent, specName = null) {
  if (!planContent) return [];

  const slices = new Set();
  let content = planContent;

  if (specName) {
    const specSection = extractPlanSpecSection(planContent, specName);
    if (specSection) content = specSection;
  }

  const slicePattern = /^\s*-\s+Slice:\s*(.+)$/gm;
  let m;
  while ((m = slicePattern.exec(content)) !== null) {
    const items = m[1].split(/[,\s]+/).map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
    for (const item of items) {
      if (item && /\.\w{1,6}$/.test(item)) slices.add(normalizeFilePath(item));
    }
  }

  return [...slices];
}

/**
 * Extract the `### {specName}` section body from PLAN.md.
 * Returns null if the section is not found.
 *
 * @param {string} planContent
 * @param {string} specName - Name without doing-/done- prefix
 * @returns {string|null}
 */
function extractPlanSpecSection(planContent, specName) {
  if (!planContent || !specName) return null;

  const stem = specName.replace(/^(doing-|done-)/, '');
  const lines = planContent.split('\n');
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (capturing) break; // next section
      const sectionName = line.replace(/^###\s+/, '').trim();
      if (
        sectionName === stem ||
        sectionName === `doing-${stem}` ||
        sectionName === `done-${stem}`
      ) {
        capturing = true;
      }
      continue;
    }
    if (capturing) captured.push(line);
  }

  return capturing ? captured.join('\n') : null;
}

// ── Blocker reference extraction ──────────────────────────────────────────────

/**
 * Extract all `Blocked by: T{n}` references from a PLAN.md section.
 *
 * @param {string} planContent - Raw PLAN.md content (or section)
 * @returns {Array<{taskId: string, blockerRef: string}>}
 *   Each entry pairs a task that has a blocker with the referenced blocker ID.
 */
function extractBlockerRefs(planContent) {
  if (!planContent) return [];

  const results = [];
  const lines = planContent.split('\n');
  let currentTaskId = null;

  for (const line of lines) {
    // Detect task header: - [ ] **T25**: ...
    const taskMatch = line.match(/^\s*[-*]\s+\[.\]\s+\*\*T(\d+)\*\*/);
    if (taskMatch) {
      currentTaskId = `T${taskMatch[1]}`;
    }

    // Detect "Blocked by: T1, T2" on same line or subsequent indented lines
    const blockerMatch = line.match(/Blocked by:\s*(.+)/i);
    if (blockerMatch && currentTaskId) {
      const refs = blockerMatch[1]
        .split(/[,\s]+/)
        .map((r) => r.trim())
        .filter((r) => /^T\d+$/.test(r));
      for (const ref of refs) {
        results.push({ taskId: currentTaskId, blockerRef: ref });
      }
    }

    // PLAN.md format: task body line "  - Blocked by: T1"
    const indentedBlocker = line.match(/^\s+-\s+Blocked by:\s*(.+)/i);
    if (indentedBlocker && currentTaskId) {
      const refs = indentedBlocker[1]
        .split(/[,\s]+/)
        .map((r) => r.trim())
        .filter((r) => /^T\d+$/.test(r));
      for (const ref of refs) {
        results.push({ taskId: currentTaskId, blockerRef: ref });
      }
    }
  }

  return results;
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
  // Set operations (canonical drift primitives)
  intersection,
  union,
  setDifference,
  computeJaccardBelow,

  // Drift metric computation (canonical names — do not rename)
  computeLikelyFilesCoveragePct,
  computeOutOfScopeCount,

  // Glob support
  expandGlob,
  normalizeFilePath,

  // Reference resolution (LSP-first, grep fallback)
  checkReferenceExists,
  LSP_TIMEOUT_MS,

  // Build / scope (L0/L1 equivalents from verify.md)
  checkBuildPasses,
  checkScopeCoverage,

  // Task-ID and blocker resolution
  extractTaskIds,
  checkBlockerResolves,
  extractBlockerRefs,

  // PLAN.md parsing
  extractPlanFiles,
  extractPlanSlices,
  extractPlanSpecSection,

  // Artifact content parsing
  extractEdgeIds,
};
