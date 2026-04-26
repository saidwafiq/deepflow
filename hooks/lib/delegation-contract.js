'use strict';

/**
 * delegation-contract — fenced-YAML contract loader for deepflow agent delegation.
 *
 * Parses `src/agents/DELEGATION.md`, extracting per-agent contract blocks
 * (one ```yaml fenced block per ## agent-name section).
 *
 * Exports:
 *   findDelegationMd(cwd)               → string|null  absolute path to DELEGATION.md or null
 *   extractBlocks(markdown)             → Array<{agent, raw}>  raw YAML text per agent
 *   parseSimpleYaml(raw)                → Object  flat key→value|string[] map
 *   loadContract(filePath)              → Map<agentName, ContractEntry>
 *   validatePrompt(agentName, prompt, contractMap) → ValidationResult
 *
 * ContractEntry: {
 *   allowedInputs:        string[],   // values from allowed-inputs field
 *   forbiddenInputs:      string[],   // values from forbidden-inputs field
 *   requiredOutputSchema: string[],   // values from required-output-schema field
 * }
 *
 * ValidationResult: {
 *   ok:          boolean,
 *   violations:  Array<{rule: string, detail: string}>,
 * }
 *
 * Design constraints (from spec):
 *   - Zero external dependencies — Node built-ins only (fs, path, os).
 *   - Never throws — always returns a safe value on malformed input.
 *   - Regex: /^##\s+([^\n]+)\n+```yaml\n([\s\S]+?)```/gm  (spike-validated).
 *
 * @module delegation-contract
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// DELEGATION.md resolution
// ---------------------------------------------------------------------------

/**
 * Locate DELEGATION.md for a given cwd. Resolution order (first match wins):
 *   1. {cwd}/src/agents/DELEGATION.md
 *   2. ~/.claude/src/agents/DELEGATION.md   (installed copy)
 *
 * @param {string} [cwd]
 * @returns {string|null} Absolute path or null when not found.
 */
function findDelegationMd(cwd) {
  const effectiveCwd = cwd || process.cwd();
  const candidates = [
    path.join(effectiveCwd, 'src', 'agents', 'DELEGATION.md'),
    path.join(os.homedir(), '.claude', 'src', 'agents', 'DELEGATION.md'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // silently skip unreadable paths
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fenced-block extraction
// ---------------------------------------------------------------------------

/**
 * Regex that matches one agent section: a level-2 heading followed by a
 * ```yaml fenced block. Spike-validated pattern.
 */
const AGENT_BLOCK_RE = /^##\s+([^\n]+)\n+```yaml\n([\s\S]+?)```/gm;

/**
 * Extract all agent contract blocks from a DELEGATION.md string.
 *
 * @param {string} markdown
 * @returns {Array<{agent: string, raw: string}>}
 */
function extractBlocks(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];
  const blocks = [];
  let m;
  AGENT_BLOCK_RE.lastIndex = 0; // reset stateful regex
  while ((m = AGENT_BLOCK_RE.exec(markdown)) !== null) {
    blocks.push({
      agent: m[1].trim(),
      raw: m[2],
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Zero-dep YAML parser (flat keys + string[] values only)
// ---------------------------------------------------------------------------

/**
 * Parse a simple YAML string with flat key:value and key:[array] structure.
 *
 * Supported syntax:
 *   key: scalar value
 *   key:
 *     - item one
 *     - item two
 *
 * Does NOT support:
 *   - Quoted strings containing ":" or "[" characters (edge case, not needed)
 *   - Nested objects beyond one level
 *   - Multi-line scalars
 *
 * @param {string} raw  Raw YAML text (content inside the fenced block).
 * @returns {Object}    Plain object with string or string[] values.
 */
function parseSimpleYaml(raw) {
  if (!raw || typeof raw !== 'string') return {};
  const result = {};
  const lines = raw.split('\n');
  let currentKey = null;
  let inArray = false;

  for (const line of lines) {
    // Skip blank lines and YAML comments
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;

    // Detect array item (leading whitespace + dash)
    if (/^\s+-\s+/.test(line)) {
      if (currentKey !== null && inArray) {
        const item = line.replace(/^\s+-\s+/, '').trim();
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(item);
      }
      continue;
    }

    // Detect key: value  OR  key: (followed by array)
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)/);
    if (keyMatch) {
      currentKey = keyMatch[1].trim();
      const val = keyMatch[2].trim();
      if (val === '' || val === '|' || val === '>') {
        // Expect array items on following lines
        result[currentKey] = [];
        inArray = true;
      } else if (val.startsWith('[')) {
        // Inline array: [item1, item2]
        const inner = val.replace(/^\[|\]$/g, '').trim();
        result[currentKey] = inner ? inner.split(',').map(s => s.trim()).filter(Boolean) : [];
        inArray = false;
      } else {
        result[currentKey] = val;
        inArray = false;
      }
      continue;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Contract loading
// ---------------------------------------------------------------------------

/**
 * Load and parse a DELEGATION.md file, returning a Map from agent name to
 * ContractEntry. Returns an empty Map on any error (fail-open contract).
 *
 * @param {string} filePath  Absolute path to DELEGATION.md.
 * @returns {Map<string, {allowedInputs: string[], forbiddenInputs: string[], requiredOutputSchema: string[]}>}
 */
function loadContract(filePath) {
  const contractMap = new Map();
  try {
    const markdown = fs.readFileSync(filePath, 'utf8');
    const blocks = extractBlocks(markdown);
    for (const { agent, raw } of blocks) {
      const parsed = parseSimpleYaml(raw);
      // Normalise each field to a string[] — tolerate missing or scalar values.
      const toArray = (v) => {
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'string') return [v];
        return [];
      };
      contractMap.set(agent, {
        allowedInputs: toArray(parsed['allowed-inputs']),
        forbiddenInputs: toArray(parsed['forbidden-inputs']),
        requiredOutputSchema: toArray(parsed['required-output-schema']),
      });
    }
  } catch (_) {
    // Fail-open: return empty map so hook does not block on missing contract.
  }
  return contractMap;
}

// ---------------------------------------------------------------------------
// Prompt validation
// ---------------------------------------------------------------------------

/**
 * Validate a Task prompt against the loaded contract for a named agent.
 *
 * Checks:
 *   1. Each pattern in `forbiddenInputs` must NOT match the prompt (case-insensitive).
 *   2. Each pattern in `allowedInputs` that ends with ":" (a required field marker)
 *      MUST appear in the prompt. Non-field items are informational and not enforced.
 *
 * Returns { ok: true, violations: [] } when:
 *   - The agent is not found in the contract (unknown agents pass through).
 *   - The contract map is empty.
 *
 * @param {string} agentName
 * @param {string} prompt
 * @param {Map<string, object>} contractMap  Result of loadContract().
 * @returns {{ ok: boolean, violations: Array<{rule: string, detail: string}> }}
 */
function validatePrompt(agentName, prompt, contractMap) {
  const clean = { ok: true, violations: [] };

  if (!contractMap || !(contractMap instanceof Map)) return clean;
  if (!contractMap.has(agentName)) return clean;

  const entry = contractMap.get(agentName);
  const text = typeof prompt === 'string' ? prompt : '';
  const violations = [];

  // --- Check forbidden inputs ---
  for (const pattern of entry.forbiddenInputs) {
    if (!pattern) continue;
    try {
      // Treat each forbidden-input string as a case-insensitive substring pattern.
      const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(text)) {
        violations.push({
          rule: `forbidden-input:${pattern}`,
          detail: `Prompt contains forbidden pattern "${pattern}" for agent ${agentName}`,
        });
      }
    } catch (_) {
      // Regex construction failed — skip pattern silently.
    }
  }

  // --- Check required allowed inputs ---
  // Convention: allowed-input entries that end with ":" denote required field
  // markers that must appear verbatim in the prompt (e.g. "task-description:").
  for (const input of entry.allowedInputs) {
    if (!input || !input.endsWith(':')) continue;
    const fieldName = input; // e.g. "task-description:"
    if (!text.includes(fieldName)) {
      violations.push({
        rule: `required-input:${fieldName}`,
        detail: `Prompt is missing required field "${fieldName}" for agent ${agentName}`,
      });
    }
  }

  return violations.length === 0
    ? { ok: true, violations: [] }
    : { ok: false, violations };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  findDelegationMd,
  extractBlocks,
  parseSimpleYaml,
  loadContract,
  validatePrompt,
};
