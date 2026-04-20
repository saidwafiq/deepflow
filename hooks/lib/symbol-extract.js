'use strict';

const fs = require('fs');
const path = require('path');

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
 *
 * @param {string} cwd   - Project root.
 * @param {object} os    - Node os module (injected for testability).
 */
function findProtocol(cwd, os) {
  const _os = os || require('os');
  const candidates = [
    path.join(cwd, 'templates', 'explore-protocol.md'),
    path.join(_os.homedir(), '.claude', 'templates', 'explore-protocol.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  PATTERNS,
  PATTERN_GENERIC,
  EXTENSION_MAP,
  isNoisePath,
  walkDir,
  runPhase1,
  findProtocol,
};
