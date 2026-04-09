#!/usr/bin/env node
// @hook-event: PreToolUse
/**
 * deepflow explore protocol injector
 * PreToolUse hook: fires before the Agent tool executes.
 * When subagent_type is "Explore", appends the search protocol from
 * templates/explore-protocol.md to the agent prompt via updatedInput.
 *
 * Protocol source resolution (first match wins):
 *   1. {cwd}/templates/explore-protocol.md  (repo checkout)
 *   2. ~/.claude/templates/explore-protocol.md  (installed copy)
 *
 * Phase 1: globs source files and extracts symbols via inline regex — no subprocess,
 * no model calls. Results are filtered to strip noise paths and injected as
 * structured context for Phase 2.
 *
 * Exits silently (code 0) on all errors — never blocks tool execution (REQ-8).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinIfMain } = require('./lib/hook-stdin');

/**
 * Regex patterns per language extension for symbol extraction.
 * Spike-validated against JS/TS/Python/Go/Rust codebases.
 */
const PATTERNS = {
  '.js':  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+(\w+)/gm,
  '.ts':  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+(\w+)/gm,
  '.py':  /^(?:async\s+)?(?:def|class)\s+(\w+)/gm,
  '.go':  /^(?:func(?:\s*\([^)]*\))?\s+(\w+)|type\s+(\w+)\s+(?:struct|interface|func))/gm,
  '.rs':  /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|type|mod)\s+(\w+)/gm,
};

/**
 * Generic fallback pattern for unknown extensions.
 * Covers the most common declaration keywords across languages.
 */
const PATTERN_GENERIC = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|def|fn|struct|enum|trait|type|interface|mod)\s+(\w+)/gm;

/**
 * Map extensions that share a pattern with a canonical key.
 */
const EXTENSION_MAP = {
  '.jsx':  '.js',
  '.tsx':  '.ts',
  '.mjs':  '.js',
  '.cjs':  '.js',
};

/**
 * Path filter — returns true if the filepath should be excluded.
 * Strips node_modules, .claude/worktrees, dist, .git, vendor,
 * __pycache__, .next, and build directories.
 */
function isNoisePath(filepath) {
  return /(node_modules|\.claude\/worktrees|\/dist\/|\.git\/|\/vendor\/|__pycache__|\/\.next\/|\/build\/)/.test(filepath);
}

/**
 * Recursively walk a directory, yielding absolute file paths.
 * Silently skips unreadable directories.
 */
function* walkDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isNoisePath(full + '/')) yield* walkDir(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Run Phase 1: glob source files and extract symbols via inline regex.
 * Returns { symbols: [{name, kind, line, filepath}], hit: boolean }.
 * No subprocess, no model calls — pure Node.js (AC-1).
 *
 * @param {string} query  - The explore prompt used for substring filtering (AC-15).
 * @param {string} cwd    - Project root to walk.
 */
function runPhase1(query, cwd) {
  const queryLower = query.toLowerCase();
  const symbols = [];

  try {
    for (const filepath of walkDir(cwd)) {
      if (isNoisePath(filepath)) continue;

      const ext = path.extname(filepath).toLowerCase();
      const canonExt = EXTENSION_MAP[ext] || ext;
      const pattern = PATTERNS[canonExt] || PATTERN_GENERIC;

      // AC-15: filter by substring match on file path
      const filepathLower = filepath.toLowerCase();
      const pathMatches = filepathLower.includes(queryLower);

      let content;
      try {
        content = fs.readFileSync(filepath, 'utf8');
      } catch (_) {
        continue;
      }

      const lines = content.split('\n');
      // Reset lastIndex before each use of the shared regex
      const re = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = re.exec(content)) !== null) {
        // Capture group 1 is always the symbol name (Go uses group 2 for type decls)
        const name = m[1] || m[2];
        if (!name) continue;

        // AC-15: filter by substring match on symbol name or file path
        const nameLower = name.toLowerCase();
        if (!nameLower.includes(queryLower) && !pathMatches) continue;

        // Compute 1-based line number from the match offset
        const before = content.slice(0, m.index);
        const line = before.split('\n').length;

        // Derive kind from the matched keyword
        const matchedText = m[0];
        let kind = 'symbol';
        if (/\bclass\b/.test(matchedText)) kind = 'class';
        else if (/\bfunction\b|\bfn\b|\bdef\b|\bfunc\b/.test(matchedText)) kind = 'function';
        else if (/\binterface\b/.test(matchedText)) kind = 'interface';
        else if (/\btype\b/.test(matchedText)) kind = 'type';
        else if (/\benum\b/.test(matchedText)) kind = 'enum';
        else if (/\bstruct\b/.test(matchedText)) kind = 'struct';
        else if (/\btrait\b/.test(matchedText)) kind = 'trait';
        else if (/\bmod\b/.test(matchedText)) kind = 'module';
        else if (/\bimpl\b/.test(matchedText)) kind = 'impl';

        symbols.push({ name, kind, line, filepath });
      }
    }
  } catch (_) {
    // Fail-open: return whatever was gathered so far
  }

  return { symbols, hit: symbols.length > 0 };
}

/**
 * Locate the explore-protocol.md template.
 * Prefers project-local copy, falls back to installed global copy.
 */
function findProtocol(cwd) {
  const candidates = [
    path.join(cwd, 'templates', 'explore-protocol.md'),
    path.join(os.homedir(), '.claude', 'templates', 'explore-protocol.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

readStdinIfMain(module, (payload) => {
  try {
    const { tool_name, tool_input, cwd } = payload;

    // Only intercept Agent calls with subagent_type "Explore"
    if (tool_name !== 'Agent') {
      return;
    }
    const subagentType = (tool_input.subagent_type || '').toLowerCase();
    if (subagentType !== 'explore') {
      return;
    }

    const effectiveCwd = cwd || process.cwd();

    // --- Deduplication guard (AC-8) ---
    // If the prompt already carries injected markers, skip re-injection entirely.
    const existingPrompt = tool_input.prompt || '';
    if (
      existingPrompt.includes('Search Protocol (auto-injected') ||
      existingPrompt.includes('LSP Phase')
    ) {
      return;
    }

    const protocolPath = findProtocol(effectiveCwd);
    const originalPrompt = existingPrompt;

    // --- Phase 1: inline regex symbol extraction (AC-1, AC-7, AC-9) ---
    const { symbols, hit: phase1Hit } = runPhase1(originalPrompt, effectiveCwd);

    let updatedPrompt;

    if (phase1Hit) {
      // Phase 1 succeeded — inject symbol locations + protocol (requires template)
      if (!protocolPath) {
        // No template found and Phase 1 succeeded — allow without modification
        return;
      }
      const protocol = fs.readFileSync(protocolPath, 'utf8').trim();

      // AC-3: Format each symbol as `filepath:line -- name (kind)`
      const locationLines = symbols
        .map((s) => `${s.filepath}:${s.line} -- ${s.name} (${s.kind})`)
        .join('\n');
      const phase1Block =
        '\n\n---\n## [LSP Phase -- locations found]\n\n' +
        locationLines +
        '\n\nRead ONLY these ranges. Do not use Grep, Glob, or Bash.';

      updatedPrompt =
        `${originalPrompt}${phase1Block}\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\n${protocol}`;
    } else {
      // Phase 1 empty — fall back to static template injection (AC-5)
      if (!protocolPath) {
        // AC-6: no template and regex found nothing — exit silently with no modification
        return;
      }
      const protocol = fs.readFileSync(protocolPath, 'utf8').trim();

      // Inject static template only, with auto-injected marker so dedup guard fires next time
      updatedPrompt =
        `${originalPrompt}\n\n---\n## Search Protocol (auto-injected — MUST follow)\n\n${protocol}`;
    }

    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...tool_input,
          prompt: updatedPrompt,
        },
      },
    };

    // --- Metrics logging (fail-open) ---
    // Log phase 1 hit rate to explore-metrics.jsonl.
    // Wraps in try/catch so metrics failures never block hook execution.
    try {
      const metricsDir = path.join(effectiveCwd, '.deepflow');
      const metricsPath = path.join(metricsDir, 'explore-metrics.jsonl');
      if (!fs.existsSync(metricsDir)) {
        fs.mkdirSync(metricsDir, { recursive: true });
      }
      const metricsEntry = {
        timestamp: new Date().toISOString(),
        query: originalPrompt,
        phase1_hit: phase1Hit,
        // tool_calls intentionally omitted: PreToolUse hooks fire before tool execution,
        // so actual tool call counts are not observable here without a PostToolUse hook.
      };
      fs.appendFileSync(metricsPath, JSON.stringify(metricsEntry) + '\n', 'utf8');
    } catch (_) {
      // Metrics logging failure is silent — never blocks execution (REQ-8).
    }

    process.stdout.write(JSON.stringify(result));
  } catch (_) {
    // AC-10: catch ALL errors — malformed JSON, missing tool_input, filesystem errors, etc.
    // Always exit 0; never block tool execution (REQ-8).
  }
});
