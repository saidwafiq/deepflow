#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow codebase-map staleness detector
 * PostToolUse hook: fires after Edit/Write tool executes.
 *
 * When a file listed in any artifact's frontmatter `hashes:` map is modified,
 * this hook recomputes the sha256 of the touched file and prepends a `[STALE] `
 * marker to the first line of every affected artifact whose recorded hash no
 * longer matches.
 *
 * Artifact location: .deepflow/codebase/*.md
 * Frontmatter shape (YAML-ish, parsed with simple regex):
 *   ---
 *   sources:
 *     - "src/**"
 *   hashes:
 *     src/commands/df/map.md: <sha256hex>
 *     package.json: <sha256hex>
 *   ---
 *
 * Exits silently (code 0) on all errors — never blocks tool execution.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readStdinIfMain } = require('./lib/hook-stdin');

// ── Constants ────────────────────────────────────────────────────────────────

const CODEBASE_DIR = path.join('.deepflow', 'codebase');
const STALE_MARKER = '[STALE] ';
const ARTIFACTS = ['STACK.md', 'ARCHITECTURE.md', 'CONVENTIONS.md', 'STRUCTURE.md', 'TESTING.md', 'INTEGRATIONS.md'];

// ── Hash utilities ───────────────────────────────────────────────────────────

/**
 * Compute sha256 hex digest of a file's content.
 * Returns null if the file cannot be read.
 *
 * @param {string} filePath - Absolute path to the file.
 * @returns {string|null}
 */
function sha256File(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (_) {
    return null;
  }
}

// ── Frontmatter parser ───────────────────────────────────────────────────────

/**
 * Parse the YAML frontmatter `hashes:` block from an artifact.
 *
 * The frontmatter is delimited by `---` lines. The `hashes:` block is a
 * YAML mapping of relative file paths to sha256 hex strings. We parse it
 * with simple line-by-line regex — no external YAML library needed.
 *
 * Returns an object: { [relativePath]: sha256hex } or {} on parse failure.
 *
 * @param {string} content - Raw artifact file content.
 * @returns {{ hashes: Object<string,string>, hashesStart: number, hashesEnd: number }}
 *   hashesStart / hashesEnd are the line indices (0-based) of the first and
 *   last lines of the hashes block, for reference (currently unused but kept
 *   for future in-place update support).
 */
function parseArtifactHashes(content) {
  const lines = content.split('\n');
  const result = {};

  // Locate opening `---`
  if (lines[0].trim() !== '---') {
    return { hashes: result, hashesStart: -1, hashesEnd: -1 };
  }

  // Locate closing `---`
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    return { hashes: result, hashesStart: -1, hashesEnd: -1 };
  }

  // Find `hashes:` key inside frontmatter
  let inHashes = false;
  let hashesStart = -1;
  let hashesEnd = -1;

  for (let i = 1; i < closingIdx; i++) {
    const line = lines[i];

    // Top-level `hashes:` key (no leading spaces)
    if (/^hashes:\s*$/.test(line)) {
      inHashes = true;
      hashesStart = i;
      continue;
    }

    if (inHashes) {
      // Indented mapping entry: `  path/to/file.js: sha256hex`
      const m = line.match(/^\s{2,}(.+?):\s*([0-9a-f]{64})\s*$/);
      if (m) {
        result[m[1].trim()] = m[2];
        hashesEnd = i;
        continue;
      }
      // Another top-level key — hashes block ended
      if (/^\S/.test(line) && line.trim() !== '') {
        inHashes = false;
      }
    }
  }

  return { hashes: result, hashesStart, hashesEnd };
}

// ── Stale marker operations ──────────────────────────────────────────────────

/**
 * Check whether an artifact file already has the `[STALE] ` marker on its
 * first non-frontmatter-delimiter line.
 *
 * @param {string} content - Raw artifact content.
 * @returns {boolean}
 */
function isAlreadyStale(content) {
  // The marker is prepended to the very first line of the file
  return content.startsWith(STALE_MARKER);
}

/**
 * Prepend `[STALE] ` to the first line of an artifact file.
 * Idempotent: does nothing if already marked.
 *
 * @param {string} artifactPath - Absolute path to the artifact.
 */
function markArtifactStale(artifactPath) {
  try {
    const content = fs.readFileSync(artifactPath, 'utf8');
    if (isAlreadyStale(content)) {
      return; // already marked
    }
    fs.writeFileSync(artifactPath, STALE_MARKER + content, 'utf8');
  } catch (_) {
    // Never throw — staleness marking is best-effort
  }
}

// ── Core staleness detection ─────────────────────────────────────────────────

/**
 * Given a touched file path (absolute or relative), inspect every artifact
 * under `.deepflow/codebase/` and mark stale any artifact whose `hashes:`
 * entry for that file no longer matches the file's current sha256.
 *
 * If the `.deepflow/codebase/` directory does not exist, exits silently.
 *
 * @param {string} touchedFile - Absolute path to the file that was written/edited.
 * @param {string} cwd         - Working directory (project root).
 */
function detectAndMarkStaleness(touchedFile, cwd) {
  const codemapDir = path.join(cwd, CODEBASE_DIR);

  // Nothing to do if artifacts haven't been generated yet
  if (!fs.existsSync(codemapDir)) {
    return;
  }

  // Compute current hash for the touched file
  const currentHash = sha256File(touchedFile);
  if (currentHash === null) {
    // File unreadable (e.g. deleted) — compute hash as absent sentinel
    // We still check artifacts that tracked this path and mark stale if hash existed
  }

  // Normalise to repo-relative path for frontmatter lookup
  const relTouched = path.relative(cwd, touchedFile);

  for (const artifactName of ARTIFACTS) {
    const artifactPath = path.join(codemapDir, artifactName);
    if (!fs.existsSync(artifactPath)) {
      continue;
    }

    let artifactContent;
    try {
      artifactContent = fs.readFileSync(artifactPath, 'utf8');
    } catch (_) {
      continue;
    }

    // Strip leading [STALE] marker for frontmatter parsing
    const contentForParsing = isAlreadyStale(artifactContent)
      ? artifactContent.slice(STALE_MARKER.length)
      : artifactContent;

    const { hashes } = parseArtifactHashes(contentForParsing);

    // Check whether this artifact tracks the touched file
    // Try both the relative path and normalised variants
    const trackedHash = hashes[relTouched] || hashes[touchedFile];

    if (trackedHash === undefined) {
      // This artifact doesn't track the touched file — leave it untouched
      continue;
    }

    // Compare recorded hash with current hash
    if (currentHash === null || currentHash !== trackedHash) {
      markArtifactStale(artifactPath);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

readStdinIfMain(module, (data) => {
  try {
    const toolName = data.tool_name || '';

    // Only care about file-mutation tools
    if (toolName !== 'Write' && toolName !== 'Edit') {
      return;
    }

    const filePath = (data.tool_input && data.tool_input.file_path) || '';
    if (!filePath) {
      return;
    }

    const cwd = data.cwd || process.cwd();

    // Resolve to absolute path
    const absFilePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);

    // Never mark artifact files themselves as stale (avoid infinite loops)
    const codemapDir = path.join(cwd, CODEBASE_DIR);
    if (absFilePath.startsWith(codemapDir + path.sep) || absFilePath === codemapDir) {
      return;
    }

    detectAndMarkStaleness(absFilePath, cwd);
  } catch (_) {
    // Never break Claude Code on hook errors.
  }
});

module.exports = {
  sha256File,
  parseArtifactHashes,
  isAlreadyStale,
  markArtifactStale,
  detectAndMarkStaleness,
};
