#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow spike-gate schema validator
 * PostToolUse hook: validates YAML frontmatter of experiment result files written
 * to `.deepflow/experiments/*.md` (excluding `*--active.md`, which are mutable
 * in-progress scratchpads) against the REQ-5 schema.
 *
 * Validates on ANY Write/Edit to `.deepflow/experiments/*.md`
 * EXCEPT paths ending in `--active.md` (carve-out: in-progress scratchpads).
 *
 * REQ-5 required frontmatter keys:
 *   hypothesis    — string (non-empty)
 *   inputs_hash   — string (non-empty, typically "sha256:<hex>")
 *   command       — string (non-empty)
 *   exit_code     — integer (0–255)
 *   assertions    — array of { metric, expected, observed, pass }
 *   status        — string ∈ { pass, fail, inconclusive }
 *
 * Optional:
 *   suggested_patches — array of { target, op, value }
 *
 * Cross-check: filename status segment MUST equal frontmatter `status:` value.
 * The filename convention is `{topic}--{hypothesis-slug}--{status}.md`.
 *
 * On schema violation:
 *   - Emits a JSON error line to stderr with { hook, error_code, offending_key, message }
 *   - Exits with code 2
 *
 * Pass-through (exit 0) when:
 *   - tool_name is not Write or Edit
 *   - file_path does not match .deepflow/experiments/*.md
 *   - file_path ends in --active.md (carve-out)
 *   - parsed frontmatter is absent (no YAML block) — file may be a template stub
 *   - any parse/IO error — never break tool execution in non-deepflow projects
 *
 * Mirrors df-experiment-immutable.js dispatch shape.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_NAME = 'df-spike-validate';

/** Valid values for the `status` frontmatter key (REQ-5). */
const VALID_STATUS = new Set(['pass', 'fail', 'inconclusive']);

/** Required top-level frontmatter keys (REQ-5). */
const REQUIRED_KEYS = ['hypothesis', 'inputs_hash', 'command', 'exit_code', 'assertions', 'status'];

// ---------------------------------------------------------------------------
// Path matchers
// ---------------------------------------------------------------------------

/**
 * Returns true if the path matches the experiments directory pattern:
 *   .deepflow/experiments/<something>.md
 * Works with both absolute and relative paths.
 */
function isExperimentMd(filePath) {
  const normalised = filePath.replace(/\\/g, '/');
  return /(?:^|\/)\.deepflow\/experiments\/[^/]+\.md$/.test(normalised);
}

/**
 * Returns true for paths explicitly exempt from schema validation:
 *   - *--active.md  (in-progress scratchpads)
 */
function isCarvedOut(filePath) {
  return filePath.endsWith('--active.md');
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, no external deps)
// ---------------------------------------------------------------------------

/**
 * Extract raw YAML frontmatter content from a markdown string.
 * Returns the text between the first `---` delimiters, or null if absent.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractFrontmatter(content) {
  // Frontmatter block: must start at the very beginning of the file
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

/**
 * Minimal YAML parser for the frontmatter shape used in experiment files.
 *
 * Handles:
 *   - Simple scalars:    key: value
 *   - Quoted scalars:    key: "value" | key: 'value'
 *   - Integers:          exit_code: 0
 *   - Block sequences:   key:\n  - item1\n  - item2
 *   - Inline sequences:  key: [a, b, c]
 *   - Mapping items:     - field: value\n    field2: value2
 *   - Comment lines:     # ...  (skipped)
 *   - Template stubs:    key: "{placeholder}" → treated as non-empty string
 *
 * Returns a plain object. Throws on structural errors only (not on value format).
 *
 * @param {string} yaml
 * @returns {object}
 */
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and comment lines
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      i++;
      continue;
    }

    // Top-level key: value
    const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2].trim();

    // Inline sequence: key: [...]
    if (rest.startsWith('[')) {
      result[key] = parseInlineSequence(rest);
      i++;
      continue;
    }

    // Quoted scalar
    if (rest.startsWith('"') || rest.startsWith("'")) {
      result[key] = unquote(rest);
      i++;
      continue;
    }

    // Empty value → block sequence follows (look ahead for `  - ` items)
    if (rest === '' || rest === null) {
      i++;
      const items = [];
      while (i < lines.length) {
        const itemLine = lines[i];
        // Block sequence item at 2-space indent
        const itemMatch = itemLine.match(/^  - (.*)/);
        if (itemMatch) {
          const itemValue = itemMatch[1].trim();
          // Could be a mapping item opener or a scalar
          if (itemValue === '' || isKeyValuePair(itemValue)) {
            // Parse multi-line mapping item
            const mapping = {};
            if (isKeyValuePair(itemValue)) {
              const [k, v] = splitKeyValue(itemValue);
              mapping[k] = coerce(v);
            }
            i++;
            // Collect continuation lines (4-space indent for nested keys)
            while (i < lines.length) {
              const contLine = lines[i];
              const contMatch = contLine.match(/^    ([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)/);
              if (contMatch) {
                mapping[contMatch[1]] = coerce(contMatch[2].trim());
                i++;
              } else if (/^\s*$/.test(contLine) || /^\s*#/.test(contLine)) {
                i++;
              } else {
                break;
              }
            }
            items.push(mapping);
          } else {
            // Plain scalar item
            items.push(coerce(itemValue));
            i++;
          }
          continue;
        }
        // Non-item line — end of block sequence
        break;
      }
      result[key] = items.length > 0 ? items : [];
      continue;
    }

    // Plain scalar (number, bool, or unquoted string)
    result[key] = coerce(rest);
    i++;
  }

  return result;
}

/**
 * Parse an inline YAML sequence: `[a, "b", 3]`
 * Returns an array. No nesting support (experiments don't use nested inline seqs).
 *
 * @param {string} s
 * @returns {Array}
 */
function parseInlineSequence(s) {
  const inner = s.replace(/^\[/, '').replace(/\].*$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((item) => coerce(item.trim()));
}

/**
 * Test whether a string looks like a YAML key: value pair.
 * @param {string} s
 * @returns {boolean}
 */
function isKeyValuePair(s) {
  return /^[A-Za-z_][A-Za-z0-9_-]*:\s/.test(s) || /^[A-Za-z_][A-Za-z0-9_-]*:$/.test(s);
}

/**
 * Split a `key: value` string into [key, value].
 * @param {string} s
 * @returns {[string, string]}
 */
function splitKeyValue(s) {
  const idx = s.indexOf(':');
  if (idx === -1) return [s, ''];
  return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
}

/**
 * Remove surrounding quotes from a scalar string.
 * @param {string} s
 * @returns {string}
 */
function unquote(s) {
  const m = s.match(/^(['"])(.*)\1$/);
  return m ? m[2] : s;
}

/**
 * Coerce a raw YAML scalar string to JS primitive.
 * @param {string} s
 * @returns {string|number|boolean|null}
 */
function coerce(s) {
  const stripped = unquote(s);
  if (stripped === 'true') return true;
  if (stripped === 'false') return false;
  if (stripped === 'null' || stripped === '~') return null;
  if (/^-?\d+$/.test(stripped)) return parseInt(stripped, 10);
  if (/^-?\d+\.\d+$/.test(stripped)) return parseFloat(stripped);
  return stripped;
}

// ---------------------------------------------------------------------------
// Schema validation (REQ-5)
// ---------------------------------------------------------------------------

/**
 * Emit a structured JSON error to stderr and exit 2.
 *
 * @param {string} errorCode  - machine-readable code (e.g. "missing_required_key")
 * @param {string} offendingKey - the frontmatter key that failed
 * @param {string} message    - human-readable description
 */
function deny(errorCode, offendingKey, message) {
  const payload = {
    hook: HOOK_NAME,
    error_code: errorCode,
    offending_key: offendingKey,
    message,
  };
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(2);
}

/**
 * Extract the filename status segment from a path following the convention:
 *   {topic}--{hypothesis-slug}--{status}.md
 *
 * Returns the last `--`-delimited segment before `.md`, or null if pattern
 * does not match (file may not follow the convention yet — pass through).
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function extractFilenameStatus(filePath) {
  const basename = path.basename(filePath, '.md');
  const parts = basename.split('--');
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

/**
 * Validate an experiment file's frontmatter against the REQ-5 schema.
 * Calls deny() (exits 2) on first violation.
 *
 * @param {object} fm       - parsed frontmatter object
 * @param {string} filePath - the experiment file path (for cross-checks)
 */
function validateSchema(fm, filePath) {
  // 1. Required keys must all be present and non-null/undefined
  for (const key of REQUIRED_KEYS) {
    if (fm[key] === undefined || fm[key] === null) {
      deny(
        'missing_required_key',
        key,
        `[${HOOK_NAME}] Missing required frontmatter key "${key}" in "${filePath}". ` +
        `Required keys per REQ-5: ${REQUIRED_KEYS.join(', ')}.`
      );
    }
  }

  // 2. `hypothesis` must be a non-empty string
  if (typeof fm.hypothesis !== 'string' || fm.hypothesis.trim() === '') {
    deny(
      'invalid_value',
      'hypothesis',
      `[${HOOK_NAME}] "hypothesis" must be a non-empty string in "${filePath}".`
    );
  }

  // 3. `inputs_hash` must be a non-empty string
  if (typeof fm.inputs_hash !== 'string' || fm.inputs_hash.trim() === '') {
    deny(
      'invalid_value',
      'inputs_hash',
      `[${HOOK_NAME}] "inputs_hash" must be a non-empty string in "${filePath}".`
    );
  }

  // 4. `command` must be a non-empty string
  if (typeof fm.command !== 'string' || fm.command.trim() === '') {
    deny(
      'invalid_value',
      'command',
      `[${HOOK_NAME}] "command" must be a non-empty string in "${filePath}".`
    );
  }

  // 5. `exit_code` must be an integer in [0, 255]
  if (
    typeof fm.exit_code !== 'number' ||
    !Number.isInteger(fm.exit_code) ||
    fm.exit_code < 0 ||
    fm.exit_code > 255
  ) {
    deny(
      'invalid_value',
      'exit_code',
      `[${HOOK_NAME}] "exit_code" must be an integer in [0, 255] in "${filePath}". ` +
      `Got: ${JSON.stringify(fm.exit_code)}.`
    );
  }

  // 6. `assertions` must be an array (possibly empty for template stubs; non-empty preferred)
  if (!Array.isArray(fm.assertions)) {
    deny(
      'invalid_value',
      'assertions',
      `[${HOOK_NAME}] "assertions" must be an array in "${filePath}". ` +
      `Got: ${JSON.stringify(fm.assertions)}.`
    );
  }

  // 7. Each assertion must have { metric, expected, observed, pass }
  const ASSERTION_KEYS = ['metric', 'expected', 'observed', 'pass'];
  for (let idx = 0; idx < fm.assertions.length; idx++) {
    const assertion = fm.assertions[idx];
    if (typeof assertion !== 'object' || assertion === null || Array.isArray(assertion)) {
      deny(
        'invalid_assertion',
        'assertions',
        `[${HOOK_NAME}] "assertions[${idx}]" must be a mapping object in "${filePath}".`
      );
    }
    for (const ak of ASSERTION_KEYS) {
      if (assertion[ak] === undefined || assertion[ak] === null) {
        deny(
          'missing_assertion_key',
          'assertions',
          `[${HOOK_NAME}] "assertions[${idx}].${ak}" is missing in "${filePath}".`
        );
      }
    }
    if (typeof assertion.pass !== 'boolean') {
      deny(
        'invalid_assertion',
        'assertions',
        `[${HOOK_NAME}] "assertions[${idx}].pass" must be a boolean in "${filePath}". ` +
        `Got: ${JSON.stringify(assertion.pass)}.`
      );
    }
  }

  // 8. `status` must be one of the valid values
  if (!VALID_STATUS.has(fm.status)) {
    deny(
      'invalid_status',
      'status',
      `[${HOOK_NAME}] "status" must be one of {${[...VALID_STATUS].join(', ')}} in "${filePath}". ` +
      `Got: ${JSON.stringify(fm.status)}.`
    );
  }

  // 9. `suggested_patches` (optional) — if present, must be an array of { target, op, value }
  if (fm.suggested_patches !== undefined && fm.suggested_patches !== null) {
    if (!Array.isArray(fm.suggested_patches)) {
      deny(
        'invalid_value',
        'suggested_patches',
        `[${HOOK_NAME}] "suggested_patches" must be an array when present in "${filePath}". ` +
        `Got: ${JSON.stringify(fm.suggested_patches)}.`
      );
    }
    const PATCH_KEYS = ['target', 'op', 'value'];
    for (let idx = 0; idx < fm.suggested_patches.length; idx++) {
      const patch = fm.suggested_patches[idx];
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        deny(
          'invalid_patch',
          'suggested_patches',
          `[${HOOK_NAME}] "suggested_patches[${idx}]" must be a mapping object in "${filePath}".`
        );
      }
      for (const pk of PATCH_KEYS) {
        if (patch[pk] === undefined || patch[pk] === null) {
          deny(
            'missing_patch_key',
            'suggested_patches',
            `[${HOOK_NAME}] "suggested_patches[${idx}].${pk}" is missing in "${filePath}".`
          );
        }
      }
    }
  }

  // 10. Cross-check: filename status segment must equal frontmatter status
  const filenameStatus = extractFilenameStatus(filePath);
  if (filenameStatus !== null && filenameStatus !== fm.status) {
    deny(
      'status_mismatch',
      'status',
      `[${HOOK_NAME}] Filename status segment "${filenameStatus}" does not match ` +
      `frontmatter "status: ${fm.status}" in "${filePath}". ` +
      `The filename convention is {topic}--{hypothesis-slug}--{status}.md and ` +
      `the status segment MUST equal the frontmatter status value.`
    );
  }
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

readStdinIfMain(module, (data) => {
  const toolName = data.tool_name || '';

  // Only validate Write and Edit operations
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return;
  }

  const filePath = (data.tool_input && data.tool_input.file_path) || '';
  const cwd = data.cwd || process.cwd();

  if (!filePath) {
    return;
  }

  // Must match .deepflow/experiments/*.md pattern
  if (!isExperimentMd(filePath)) {
    return;
  }

  // *--active.md files are in-progress scratchpads — always pass through
  if (isCarvedOut(filePath)) {
    return;
  }

  // Resolve absolute path for reading
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);

  // Read the file content that was just written/edited
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (_) {
    // Cannot read the file (e.g. new file being written, not yet on disk) — pass through
    return;
  }

  // Extract frontmatter block
  const frontmatterRaw = extractFrontmatter(content);
  if (frontmatterRaw === null) {
    // No frontmatter block — could be a partial write or template stub; pass through
    return;
  }

  // Template stubs (all placeholder values) — pass through gracefully
  // Detect by presence of `"{` or `{` patterns indicating unfilled template
  if (/\{[^}]+\}/.test(frontmatterRaw) && frontmatterRaw.includes('"{"')) {
    return;
  }

  // Parse frontmatter
  let fm;
  try {
    fm = parseSimpleYaml(frontmatterRaw);
  } catch (_) {
    // Parse failure — pass through to avoid breaking tool execution
    return;
  }

  // Validate against REQ-5 schema
  validateSchema(fm, filePath);
});

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

module.exports = {
  isExperimentMd,
  isCarvedOut,
  extractFrontmatter,
  parseSimpleYaml,
  extractFilenameStatus,
  validateSchema,
  VALID_STATUS,
  REQUIRED_KEYS,
};
