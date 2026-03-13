#!/usr/bin/env node
/**
 * deepflow invariant checker
 * Checks implementation diffs against spec invariants.
 *
 * Usage (CLI):   node df-invariant-check.js --invariants <spec-file.md> <diff-file>
 * Usage (module): const { checkInvariants } = require('./df-invariant-check');
 *
 * REQ-6: CLI mode — parse args, read files, exit non-zero on hard failures
 * REQ-7: Output format — `${file}:${line}: [${TAG}] ${description}`, capped at 15 lines
 * REQ-9: Auto-mode escalation — advisory items promoted to hard when mode === 'auto'
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { extractSection } = require('./df-spec-lint');

// ── LSP availability check (REQ-5, AC-11) ────────────────────────────────────

/**
 * Language server detection rules.
 * Each entry maps a set of indicator files/patterns to a language server binary
 * and its install instructions.
 */
const LSP_DETECTION_RULES = [
  {
    indicators: ['tsconfig.json'],
    fileExtensions: ['.ts', '.tsx'],
    binary: 'typescript-language-server',
    installCmd: 'npm install -g typescript-language-server',
  },
  {
    indicators: ['jsconfig.json', 'package.json'],
    fileExtensions: ['.js', '.jsx', '.mjs', '.cjs'],
    binary: 'typescript-language-server',
    installCmd: 'npm install -g typescript-language-server',
  },
  {
    indicators: ['pyrightconfig.json'],
    fileExtensions: ['.py'],
    binary: 'pyright',
    installCmd: 'npm install -g pyright',
  },
  {
    indicators: ['Cargo.toml'],
    fileExtensions: ['.rs'],
    binary: 'rust-analyzer',
    installCmd: 'rustup component add rust-analyzer',
  },
  {
    indicators: ['go.mod'],
    fileExtensions: ['.go'],
    binary: 'gopls',
    installCmd: 'go install golang.org/x/tools/gopls@latest',
  },
];

/**
 * Detect the appropriate language server for the given project root.
 * Checks for indicator files first, then falls back to file extensions in the diff.
 *
 * @param {string} projectRoot - Absolute path to the project root directory
 * @param {string[]} diffFilePaths - List of file paths from the diff
 * @returns {{ binary: string, installCmd: string } | null}
 */
function detectLanguageServer(projectRoot, diffFilePaths) {
  for (const rule of LSP_DETECTION_RULES) {
    // Check for indicator files in the project root
    for (const indicator of rule.indicators) {
      try {
        fs.accessSync(path.join(projectRoot, indicator));
        return { binary: rule.binary, installCmd: rule.installCmd };
      } catch (_) {
        // File not present, continue
      }
    }
    // Check for matching file extensions in the diff
    if (rule.fileExtensions && diffFilePaths.some((f) => rule.fileExtensions.some((ext) => f.endsWith(ext)))) {
      return { binary: rule.binary, installCmd: rule.installCmd };
    }
  }
  return null;
}

/**
 * Check whether a binary is available on the system PATH.
 *
 * @param {string} binary - Binary name to check
 * @returns {boolean}
 */
function isBinaryAvailable(binary) {
  try {
    execSync(`which ${binary}`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Check LSP availability for the project.
 * Auto-detects the appropriate language server based on project files and the diff,
 * then verifies the binary is present on PATH.
 *
 * @param {string} projectRoot - Absolute path to the project root directory
 * @param {string[]} diffFilePaths - List of file paths from the diff (used for extension-based detection)
 * @returns {{ available: boolean, binary: string | null, installCmd: string | null, message: string | null }}
 */
function checkLspAvailability(projectRoot, diffFilePaths) {
  const detected = detectLanguageServer(projectRoot, diffFilePaths);

  if (!detected) {
    // No language server detected for this project type — not a hard failure
    return { available: true, binary: null, installCmd: null, message: null };
  }

  const available = isBinaryAvailable(detected.binary);
  if (!available) {
    return {
      available: false,
      binary: detected.binary,
      installCmd: detected.installCmd,
      message:
        `LSP binary "${detected.binary}" not found on PATH. ` +
        `Install it with: ${detected.installCmd}`,
    };
  }

  return { available: true, binary: detected.binary, installCmd: null, message: null };
}

// ── Valid violation tags (REQ-7) ──────────────────────────────────────────────
const TAGS = {
  MOCK: 'MOCK',               // Production code contains mock/stub placeholders
  MISSING_TEST: 'MISSING_TEST', // Changed code has no corresponding test coverage
  HARDCODED: 'HARDCODED',     // Hardcoded values that should be configurable
  STUB: 'STUB',               // Incomplete stub left in production code
  PHANTOM: 'PHANTOM',         // Reference to non-existent symbol/file/function
  SCOPE_GAP: 'SCOPE_GAP',     // Implementation goes beyond or falls short of spec scope
};

// ── Diff parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a unified diff string into a structured list of file changes.
 *
 * @param {string} diff - Raw unified diff text
 * @returns {Array<{ file: string, hunks: Array<{ startLine: number, lines: Array<{ lineNo: number, content: string }> }> }>}
 */
function parseDiff(diff) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let newLineNo = 0;

  for (const line of diff.split('\n')) {
    // New file header: "+++ b/path/to/file" or "+++ path/to/file"
    if (line.startsWith('+++ ')) {
      const filePath = line.slice(4).replace(/^[ab]\//, '');
      currentFile = { file: filePath, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    // Skip "---" lines (old file header)
    if (line.startsWith('--- ')) {
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch && currentFile) {
      newLineNo = parseInt(hunkMatch[1], 10);
      currentHunk = { startLine: newLineNo, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      // Added line
      currentHunk.lines.push({ lineNo: newLineNo, content: line.slice(1) });
      newLineNo++;
    } else if (line.startsWith('-')) {
      // Removed line — does not advance new-file line numbers
    } else if (line.startsWith(' ')) {
      // Context line
      newLineNo++;
    }
  }

  return files;
}

// ── Task-type helpers (REQ-8) ─────────────────────────────────────────────────

/**
 * Classify a file path as a test file or a production file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return (
    /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
    /^tests?\//.test(filePath) ||
    /\/__tests__\//.test(filePath)
  );
}

// ── Placeholder check functions (T4-T8 will implement these) ─────────────────
//
// Each check function receives:
//   - files: parsed diff (output of parseDiff())
//   - specContent: raw spec markdown string
//   - taskType: 'bootstrap' | 'spike' | 'implementation'
//
// Each function returns an array of violation objects:
//   { file: string, line: number, tag: string, description: string }

/**
 * T4 placeholder: Check for mock/stub markers left in production code.
 * Looks for patterns like TODO, FIXME, console.log, mock(), stub() in added lines.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkMocks(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  // REQ-8: taskType filtering
  //   bootstrap: skip mock detection entirely for test files
  //   spike: only check production files (skip test files)
  //   implementation: check all files
  let filesToCheck = files;
  if (taskType === 'bootstrap') {
    filesToCheck = files.filter((f) => !isTestFile(f.file));
  } else if (taskType === 'spike') {
    filesToCheck = files.filter((f) => !isTestFile(f.file));
  }

  // REQ-1: Detect mock usage patterns in production (non-test) files
  const MOCK_PATTERNS = [
    /\bjest\.fn\s*\(/,
    /\bvi\.fn\s*\(/,
    /\bsinon\.stub\s*\(/,
    /=\s*mock\s*\(/,
    /\bjest\.mock\s*\(/,
    /\bvi\.mock\s*\(/,
    /\bsinon\.mock\s*\(/,
    /\bjest\.spyOn\s*\(/,
    /\bcreateMock\s*\(/,
    /\bmockImplementation\s*\(/,
  ];

  const violations = [];

  for (const fileObj of filesToCheck) {
    for (const hunk of fileObj.hunks) {
      for (const addedLine of hunk.lines) {
        for (const pattern of MOCK_PATTERNS) {
          if (pattern.test(addedLine.content)) {
            violations.push({
              file: fileObj.file,
              line: addedLine.lineNo,
              tag: TAGS.MOCK,
              description: `Mock pattern found: ${pattern}`,
            });
            break; // Only report one violation per line
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Assertion patterns used to count meaningful assertions in test code.
 * Covers Jest, Chai, Node assert, and other common assertion styles.
 */
const ASSERTION_PATTERNS = [
  /\bexpect\s*\(/,
  /\bassert\s*\(/,
  /\bassert\./,
  /\bassert_eq\s*\(/,
  /\bassertEqual\s*\(/,
  /\bassertThat\s*\(/,
  /\bshould\./,
  /\.should\b/,
  /\.to\./,
  /\.toBe\s*\(/,
  /\.toEqual\s*\(/,
  /\.toHave\w*\s*\(/,
  /\.toContain\s*\(/,
  /\.toThrow\s*\(/,
  /\.toMatch\s*\(/,
];

/**
 * Count assertion calls in an array of source lines.
 * Each line is checked against all ASSERTION_PATTERNS; a line may only count once.
 *
 * @param {string[]} lines - Source lines to scan
 * @returns {number} Total number of lines containing at least one assertion
 */
function countAssertions(lines) {
  let count = 0;
  for (const line of lines) {
    if (ASSERTION_PATTERNS.some((p) => p.test(line))) {
      count++;
    }
  }
  return count;
}

/**
 * Extract the lines belonging to test blocks (describe/it/test) that mention a
 * given REQ-N identifier from a flat array of source lines.
 *
 * Strategy: find every line that contains the reqId, then walk outward to capture
 * the surrounding block delimited by matching braces.  We keep a simple brace-depth
 * counter so nested blocks are included.
 *
 * @param {string[]} lines - All source lines (added lines from test files)
 * @param {string} reqId - e.g. "REQ-3"
 * @returns {string[]} Lines that are part of blocks mentioning the reqId
 */
function extractReqTestBlockLines(lines, reqId) {
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(reqId)) continue;

    // Walk backwards to find the opening of the nearest enclosing describe/it/test block
    let blockStart = i;
    for (let j = i; j >= 0; j--) {
      if (/\b(describe|it|test)\s*\(/.test(lines[j])) {
        blockStart = j;
        break;
      }
    }

    // Walk forward from blockStart, tracking brace depth to find the end of the block
    let depth = 0;
    let started = false;
    for (let k = blockStart; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      result.push(lines[k]);
      if (started && depth === 0) break;
    }
  }

  return result;
}

/**
 * Check that every REQ-N identifier in the spec has at least one mention
 * in the added lines of a test file in the diff (REQ-2), and that those test
 * references include at least 2 assertion calls (AC-5).
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkMissingTests(files, specContent, taskType) {
  // REQ-8: taskType filtering
  //   spike: skip entirely (spikes don't require test coverage)
  //   bootstrap: skip (bootstrapping doesn't need tests yet)
  //   implementation: enforce
  if (taskType === 'spike' || taskType === 'bootstrap') {
    return [];
  }

  const violations = [];

  // Extract the Requirements section and collect all REQ-N identifiers
  const reqSection = extractSection(specContent, 'Requirements');
  if (!reqSection) return violations;

  const reqPattern = /REQ-\d+[a-z]?/g;
  const allReqIds = new Set(reqSection.match(reqPattern) || []);
  if (allReqIds.size === 0) return violations;

  // Identify test files in the diff
  const isTestFilePath = (filePath) =>
    /\.test\.js$/.test(filePath) ||
    /\.spec\.js$/.test(filePath) ||
    /(^|\/)test(s)?\//.test(filePath);

  // Collect added lines (with file context) from test files in the diff
  const testFiles = files.filter((f) => isTestFilePath(f.file));
  const allTestLines = testFiles.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.content)));
  const testFileContent = allTestLines.join('\n');

  // For each REQ-N: check existence then assertion count
  for (const reqId of allReqIds) {
    if (!testFileContent.includes(reqId)) {
      // Zero test references — existing behavior
      violations.push({
        file: 'spec',
        line: 1,
        tag: TAGS.MISSING_TEST,
        description: `${reqId} has no test reference in diff`,
      });
    } else {
      // Has at least one test reference — count assertions in the relevant test blocks
      const blockLines = extractReqTestBlockLines(allTestLines, reqId);
      const assertionCount = countAssertions(blockLines);
      if (assertionCount < 2) {
        violations.push({
          file: 'spec',
          line: 1,
          tag: TAGS.MISSING_TEST,
          description: `${reqId} has test reference but only ${assertionCount} assertion(s) (minimum 2 required)`,
        });
      }
    }
  }

  return violations;
}

/**
 * Check for stub returns and TODO/FIXME/HACK markers left in production code.
 * Detects patterns like `return null`, `return []`, `throw new Error('not implemented')`,
 * and comment markers that indicate incomplete work.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkStubsAndTodos(files, specContent, taskType) {
  // REQ-8: taskType filtering
  //   spike: skip TODO/FIXME/HACK detection (spikes are exploratory)
  //   implementation: all checks enforced
  const violations = [];

  const stubReturnPattern = /\breturn\s+(null|undefined|\[\]|\{\})\s*;?\s*$/;
  const notImplementedPattern = /throw\s+new\s+Error\s*\(\s*['"]not implemented['"]\s*\)/i;
  const todoCommentPattern = /\/\/\s*(TODO|FIXME|HACK)\b/i;

  for (const fileEntry of files) {
    for (const hunk of fileEntry.hunks) {
      for (const { lineNo, content } of hunk.lines) {
        if (taskType !== 'spike' && todoCommentPattern.test(content)) {
          violations.push({
            file: fileEntry.file,
            line: lineNo,
            tag: TAGS.STUB,
            description: `TODO/FIXME/HACK comment found: ${content.trim()}`,
          });
        } else if (notImplementedPattern.test(content)) {
          violations.push({
            file: fileEntry.file,
            line: lineNo,
            tag: TAGS.STUB,
            description: `Stub return found: ${content.trim()}`,
          });
        } else if (stubReturnPattern.test(content)) {
          violations.push({
            file: fileEntry.file,
            line: lineNo,
            tag: TAGS.STUB,
            description: `Stub return found: ${content.trim()}`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * REQ-3: Check for hardcoded values that should be configurable.
 * Parses spec for requirements containing "configurable" or "dynamic", then
 * scans added diff lines for numeric/string literals assigned to module-level
 * constants or returned directly.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkHardcoded(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  const violations = [];

  // Step 1: Parse spec Requirements section for REQ-Ns that mention
  // "configurable" or "dynamic" (case-insensitive).
  const reqSection = extractSection(specContent, 'Requirements');
  if (!reqSection) return violations;

  // Split into individual requirement lines/blocks. Each REQ-N block starts
  // with a REQ-N identifier and may span multiple lines until the next REQ-N
  // or end of section.
  const reqBlockPattern = /\*\*?(REQ-\d+[a-z]?)\b.*?\*\*?[^]*?(?=\*\*?REQ-\d+|$)/gi;
  const configurableReqs = new Set();

  let m;
  while ((m = reqBlockPattern.exec(reqSection)) !== null) {
    const block = m[0];
    if (/configurable|dynamic/i.test(block)) {
      // Extract the REQ-N identifier from this block
      const idMatch = block.match(/REQ-\d+[a-z]?/i);
      if (idMatch) {
        configurableReqs.add(idMatch[0]);
      }
    }
  }

  // Fallback: also scan line-by-line for simpler markdown formats
  for (const line of reqSection.split('\n')) {
    if (/configurable|dynamic/i.test(line)) {
      const idMatch = line.match(/REQ-\d+[a-z]?/i);
      if (idMatch) {
        configurableReqs.add(idMatch[0]);
      }
    }
  }

  // If no "configurable" or "dynamic" requirements exist in spec, nothing to check.
  if (configurableReqs.size === 0) return violations;

  // Step 2: Scan added diff lines for patterns indicating hardcoded literals
  // in module-level constant assignments or direct returns.
  //
  // Patterns we consider "hardcoded":
  //   - Module-level const/let/var assignment with a numeric literal:
  //       const MAX_RETRIES = 42;
  //       const BASE_URL = "https://example.com";
  //   - Direct return of a literal (not trivially safe like 0, 1, -1, true, false, ""):
  //       return 3000;
  //       return "https://api.example.com";
  //
  // Safe literals that are excluded (common, non-configurable values):
  //   Numbers: 0, 1, -1, 2, 100, null
  //   Strings: '', "", true, false

  const SAFE_NUMERIC_LITERALS = new Set(['0', '1', '-1', '2', '100', '-0']);
  const SAFE_STRING_LITERALS = new Set(['""', "''", '``', '"true"', '"false"', "'true'", "'false'"]);

  // Matches: const/let/var NAME = <literal>;  (module-level, not indented heavily)
  // We consider lines with <=2 leading spaces as module-level.
  const MODULE_CONST_PATTERN =
    /^[ \t]{0,2}(?:const|let|var)\s+[A-Z_][A-Z0-9_]*\s*=\s*(.+?)\s*;?\s*$/;

  // Matches: return <literal>;
  const RETURN_LITERAL_PATTERN =
    /^\s*return\s+(.+?)\s*;?\s*$/;

  // Numeric literal (integer or float, optional sign)
  const NUMERIC_LITERAL_RE = /^-?\d+(\.\d+)?$/;

  // String literal (single, double, or template quotes — no interpolation)
  const STRING_LITERAL_RE = /^(['"`])[^'"`]*\1$/;

  for (const fileObj of files) {
    // Skip test files — hardcoded values in tests are expected
    if (isTestFile(fileObj.file)) continue;

    for (const hunk of fileObj.hunks) {
      for (const { lineNo, content } of hunk.lines) {
        let literal = null;
        let context = null;

        const constMatch = MODULE_CONST_PATTERN.exec(content);
        if (constMatch) {
          literal = constMatch[1].trim();
          context = 'module-level constant';
        } else {
          const returnMatch = RETURN_LITERAL_PATTERN.exec(content);
          if (returnMatch) {
            literal = returnMatch[1].trim();
            context = 'direct return';
          }
        }

        if (!literal) continue;

        // Determine if literal is a numeric or string literal
        const isNumeric = NUMERIC_LITERAL_RE.test(literal);
        const isString = STRING_LITERAL_RE.test(literal);

        if (!isNumeric && !isString) continue;

        // Skip safe/trivial literals
        if (isNumeric && SAFE_NUMERIC_LITERALS.has(literal)) continue;
        if (isString && SAFE_STRING_LITERALS.has(literal)) continue;

        // This is a meaningful hardcoded literal in a file modified under
        // a spec that requires configurability/dynamic behavior.
        const reqList = [...configurableReqs].join(', ');
        violations.push({
          file: fileObj.file,
          line: lineNo,
          tag: TAGS.HARDCODED,
          description: `Hardcoded literal ${literal} in ${context}; spec requires configurable/dynamic values (${reqList})`,
        });
      }
    }
  }

  return violations;
}

/**
 * REQ-4c: Check for phantom imports — a file imports a module that is new in the
 * diff and that new module exports only stub symbols (return null, return [], etc.).
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkPhantoms(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  const violations = [];

  // Collect the set of new files introduced in this diff (files with added lines but
  // recognisable as new — heuristic: first hunk starts at line 1).
  const newFiles = new Set();
  for (const fileObj of files) {
    if (fileObj.hunks.length > 0 && fileObj.hunks[0].startLine === 1) {
      newFiles.add(fileObj.file);
    }
  }

  if (newFiles.size === 0) return violations;

  // For each new file, determine whether it exports only stub symbols.
  // A stub export is one whose only added non-blank, non-comment body line is a
  // stub return: `return null`, `return []`, `return {}`, `return undefined`,
  // or a `throw new Error('not implemented')`.
  const STUB_EXPORT_PATTERN =
    /\breturn\s+(null|undefined|\[\]|\{\})\s*;?\s*$|\bthrow\s+new\s+Error\s*\(\s*['"]not implemented['"]\s*\)/i;
  const EXPORT_DECL_PATTERN =
    /\bmodule\.exports\b|\bexport\s+(default|function|const|let|var|class)\b/;

  const stubOnlyFiles = new Set();
  for (const newFile of newFiles) {
    const fileObj = files.find((f) => f.file === newFile);
    if (!fileObj) continue;

    const addedLines = fileObj.hunks.flatMap((h) => h.lines.map((l) => l.content));
    const hasExport = addedLines.some((l) => EXPORT_DECL_PATTERN.test(l));
    if (!hasExport) continue; // not a module with explicit exports — skip

    const substantiveLines = addedLines.filter(
      (l) => l.trim() !== '' && !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)
    );
    const allStubs = substantiveLines.every(
      (l) => STUB_EXPORT_PATTERN.test(l) || EXPORT_DECL_PATTERN.test(l) ||
             /^\s*[\{\}()\[\],;]/.test(l) || /^\s*(function|const|let|var|class|module)\b/.test(l)
    );
    if (allStubs) {
      stubOnlyFiles.add(newFile);
    }
  }

  if (stubOnlyFiles.size === 0) return violations;

  // Patterns to extract the imported path from require() or import … from '…'
  const REQUIRE_PATTERN = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const IMPORT_PATTERN = /^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/;

  for (const fileObj of files) {
    for (const hunk of fileObj.hunks) {
      for (const { lineNo, content } of hunk.lines) {
        // Check require() calls
        let m;
        REQUIRE_PATTERN.lastIndex = 0;
        while ((m = REQUIRE_PATTERN.exec(content)) !== null) {
          const importedPath = m[1];
          for (const stubFile of stubOnlyFiles) {
            if (stubFile.endsWith(importedPath) || stubFile.endsWith(`${importedPath}.js`)) {
              violations.push({
                file: fileObj.file,
                line: lineNo,
                tag: TAGS.PHANTOM,
                description: `Imports "${importedPath}" which is a new file with only stub exports`,
              });
            }
          }
        }

        // Check ES import statements
        const im = IMPORT_PATTERN.exec(content);
        if (im) {
          const importedPath = im[1];
          for (const stubFile of stubOnlyFiles) {
            if (stubFile.endsWith(importedPath) || stubFile.endsWith(`${importedPath}.js`)) {
              violations.push({
                file: fileObj.file,
                line: lineNo,
                tag: TAGS.PHANTOM,
                description: `Imports "${importedPath}" which is a new file with only stub exports`,
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

/**
 * REQ-4d: Check edit_scope coverage — every file or glob listed under an
 * `edit_scope` section in the spec must appear in the total diff.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkScopeGaps(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  const violations = [];

  // Try to extract an edit_scope section from the spec (various heading names).
  const SCOPE_SECTION_NAMES = ['edit_scope', 'edit scope', 'scope', 'files'];
  let scopeSection = null;
  for (const name of SCOPE_SECTION_NAMES) {
    scopeSection = extractSection(specContent, name);
    if (scopeSection) break;
  }

  // If no dedicated section, look for inline `edit_scope:` YAML-style block.
  if (!scopeSection) {
    const inlineMatch = specContent.match(/edit_scope\s*:\s*\n((?:\s*-\s*.+\n?)+)/i);
    if (inlineMatch) {
      scopeSection = inlineMatch[1];
    }
  }

  if (!scopeSection) return violations;

  // Extract the listed paths / globs from the section.
  // Accepts lines like: `- path/to/file.js`, `* path`, `path/to/file` (bare).
  const SCOPE_ITEM_PATTERN = /^\s*[-*]\s+(.+?)\s*$|^\s{2,}(\S.+?)\s*$/gm;
  const scopeItems = [];
  let m;
  while ((m = SCOPE_ITEM_PATTERN.exec(scopeSection)) !== null) {
    const item = (m[1] || m[2] || '').trim();
    if (item) scopeItems.push(item);
  }

  if (scopeItems.length === 0) return violations;

  // Build the set of files touched in the diff.
  const diffFilePaths = new Set(files.map((f) => f.file));

  for (const scopeItem of scopeItems) {
    // Convert glob wildcards to a simple regex for matching.
    const escaped = scopeItem
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex meta-chars (but NOT * or ?)
      .replace(/\\\*/g, '.*')               // re-un-escape our * → .*
      .replace(/\\\?/g, '.');               // ? → .
    const pattern = new RegExp(`(^|/)${escaped}($|/)`);

    const touched = [...diffFilePaths].some((p) => pattern.test(p) || p === scopeItem);
    if (!touched) {
      violations.push({
        file: 'spec',
        line: 1,
        tag: TAGS.SCOPE_GAP,
        description: `edit_scope entry "${scopeItem}" was not touched in the diff`,
      });
    }
  }

  return violations;
}

/**
 * REQ-4a: Check for mock covering implementation gap — a test file mocks module X
 * but module X has no non-test changes in the total diff.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkMockCoveringGap(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  const violations = [];

  // Patterns that identify mock/jest.mock/vi.mock/require + module references.
  // We capture the module path string from jest.mock('…') / vi.mock('…').
  const JEST_MOCK_PATTERN = /(?:jest|vi)\.mock\s*\(\s*['"]([^'"]+)['"]/g;

  // Collect production (non-test) file paths in the diff.
  const prodFilePaths = new Set(
    files.filter((f) => !isTestFile(f.file)).map((f) => f.file)
  );

  // Scan test files for mock declarations.
  for (const fileObj of files) {
    if (!isTestFile(fileObj.file)) continue;

    for (const hunk of fileObj.hunks) {
      for (const { lineNo, content } of hunk.lines) {
        JEST_MOCK_PATTERN.lastIndex = 0;
        let m;
        while ((m = JEST_MOCK_PATTERN.exec(content)) !== null) {
          const mockedPath = m[1];
          // Check if any production file in the diff matches the mocked module path.
          const hasProductionChange = [...prodFilePaths].some(
            (p) => p.endsWith(mockedPath) || p.endsWith(`${mockedPath}.js`) || p.endsWith(`${mockedPath}.ts`)
          );
          if (!hasProductionChange) {
            violations.push({
              file: fileObj.file,
              line: lineNo,
              tag: TAGS.MOCK,
              description: `mock covers implementation gap: "${mockedPath}" is mocked in tests but has no production changes in diff`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * REQ-4b: Check for REQ-N identifiers that appear only in test files but not
 * in production source files in the diff.
 *
 * @param {Array} files - Parsed diff files
 * @param {string} specContent - Raw spec markdown
 * @param {string} taskType - Task type
 * @returns {Array<{ file: string, line: number, tag: string, description: string }>}
 */
function checkReqOnlyInTests(files, specContent, taskType) { // eslint-disable-line no-unused-vars
  // Only meaningful for implementation tasks.
  if (taskType === 'spike' || taskType === 'bootstrap') return [];

  const violations = [];

  // Collect REQ-N identifiers mentioned in added lines of test files.
  const REQ_PATTERN = /REQ-\d+[a-z]?/g;

  const reqsInTests = new Map(); // reqId → { file, line } of first occurrence
  for (const fileObj of files) {
    if (!isTestFile(fileObj.file)) continue;
    for (const hunk of fileObj.hunks) {
      for (const { lineNo, content } of hunk.lines) {
        let m;
        REQ_PATTERN.lastIndex = 0;
        while ((m = REQ_PATTERN.exec(content)) !== null) {
          const reqId = m[0];
          if (!reqsInTests.has(reqId)) {
            reqsInTests.set(reqId, { file: fileObj.file, line: lineNo });
          }
        }
      }
    }
  }

  if (reqsInTests.size === 0) return violations;

  // Collect all REQ-N identifiers mentioned in added lines of production files.
  const reqsInProd = new Set();
  for (const fileObj of files) {
    if (isTestFile(fileObj.file)) continue;
    for (const hunk of fileObj.hunks) {
      for (const { content } of hunk.lines) {
        let m;
        REQ_PATTERN.lastIndex = 0;
        while ((m = REQ_PATTERN.exec(content)) !== null) {
          reqsInProd.add(m[0]);
        }
      }
    }
  }

  // Emit a violation for each REQ-N present only in tests but not in production.
  for (const [reqId, loc] of reqsInTests) {
    if (!reqsInProd.has(reqId)) {
      violations.push({
        file: loc.file,
        line: loc.line,
        tag: TAGS.SCOPE_GAP,
        description: `${reqId} appears only in test files, not in production source`,
      });
    }
  }

  return violations;
}

// ── Output formatting (REQ-7) ─────────────────────────────────────────────────

/**
 * Format a single violation into the canonical output string.
 *
 * @param {{ file: string, line: number, tag: string, description: string }} violation
 * @returns {string} Formatted as `${file}:${line}: [${TAG}] ${description}`
 */
function formatViolation(violation) {
  return `${violation.file}:${violation.line}: [${violation.tag}] ${violation.description}`;
}

/**
 * Format checkInvariants results into printable output lines.
 * Caps output at 15 violation lines; appends a summary if truncated.
 *
 * @param {{ hard: Array, advisory: Array }} results
 * @returns {string[]} Lines ready for printing
 */
function formatOutput(results) {
  const MAX_LINES = 15;
  const lines = [];

  const allViolations = [
    ...results.hard.map((v) => ({ ...v, severity: 'HARD' })),
    ...results.advisory.map((v) => ({ ...v, severity: 'ADVISORY' })),
  ];

  const total = allViolations.length;
  const shown = allViolations.slice(0, MAX_LINES);

  for (const v of shown) {
    lines.push(formatViolation(v));
  }

  if (total > MAX_LINES) {
    const remaining = total - MAX_LINES;
    lines.push(`... and ${remaining} more invariant violation${remaining === 1 ? '' : 's'}`);
  }

  return lines;
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Check implementation diffs against spec invariants.
 *
 * @param {string} diff - Raw unified diff text
 * @param {string} specContent - Raw spec markdown content
 * @param {object} opts
 * @param {'interactive'|'auto'} opts.mode - 'auto' promotes advisory to hard (REQ-9)
 * @param {'bootstrap'|'spike'|'implementation'} opts.taskType - Affects which checks apply
 * @param {string} [opts.projectRoot] - Project root for LSP detection (defaults to process.cwd())
 * @returns {{ hard: Array<{ file: string, line: number, tag: string, description: string }>,
 *             advisory: Array<{ file: string, line: number, tag: string, description: string }> }}
 */
function checkInvariants(diff, specContent, opts = {}) {
  const { mode = 'interactive', taskType = 'implementation', projectRoot = process.cwd() } = opts;

  const hard = [];
  const advisory = [];

  // Parse the diff into structured file/hunk/line data
  const files = parseDiff(diff);

  // ── REQ-5, AC-11: LSP availability check ────────────────────────────────
  const diffFilePaths = files.map((f) => f.file);
  const lspCheck = checkLspAvailability(projectRoot, diffFilePaths);
  if (!lspCheck.available) {
    hard.push({
      file: 'lsp',
      line: 0,
      tag: 'LSP_UNAVAILABLE',
      description: lspCheck.message,
    });
  }

  // ── Run placeholder checks (T4-T8 will fill these in) ───────────────────
  // Hard invariant checks: failures block the commit/task
  const mockViolations = checkMocks(files, specContent, taskType);
  hard.push(...mockViolations);

  const stubViolations = checkStubsAndTodos(files, specContent, taskType);
  hard.push(...stubViolations);

  // REQ-4c: phantom imports (new files with only stub exports)
  const phantomViolations = checkPhantoms(files, specContent, taskType);
  hard.push(...phantomViolations);

  // REQ-4d: edit_scope coverage
  const scopeGapViolations = checkScopeGaps(files, specContent, taskType);
  hard.push(...scopeGapViolations);

  // Hard invariant: REQ-2 requires hard fail when any REQ-N has zero test references
  const missingTestViolations = checkMissingTests(files, specContent, taskType);
  hard.push(...missingTestViolations);

  const hardcodedViolations = checkHardcoded(files, specContent, taskType);
  advisory.push(...hardcodedViolations);

  // REQ-4a: mock covering implementation gap
  const mockGapViolations = checkMockCoveringGap(files, specContent, taskType);
  hard.push(...mockGapViolations);

  // REQ-4b: REQ-N only in tests, not in production source
  const reqOnlyInTestsViolations = checkReqOnlyInTests(files, specContent, taskType);
  hard.push(...reqOnlyInTestsViolations);

  // ── Auto-mode escalation (REQ-9) ─────────────────────────────────────────
  // In auto mode (non-interactive CI/hook runs), all advisory items are promoted
  // to hard failures so the pipeline blocks on any violation.
  if (mode === 'auto') {
    hard.push(...advisory.splice(0, advisory.length));
  }

  return { hard, advisory };
}

// ── CLI entry point (REQ-6) ───────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse --invariants <spec-path> <diff-file>
  const invariantsIdx = args.indexOf('--invariants');
  if (invariantsIdx === -1 || args.length < invariantsIdx + 3) {
    console.error('Usage: df-invariant-check.js --invariants <spec-file.md> <diff-file>');
    console.error('');
    console.error('Options:');
    console.error('  --invariants <spec-file.md> <diff-file>   Run invariant checks');
    console.error('  --auto                                     Auto mode (advisory => hard)');
    console.error('  --task-type <bootstrap|spike|implementation>  Task type (default: implementation)');
    process.exit(1);
  }

  const specPath = args[invariantsIdx + 1];
  const diffPath = args[invariantsIdx + 2];
  const mode = args.includes('--auto') ? 'auto' : 'interactive';

  const taskTypeIdx = args.indexOf('--task-type');
  const taskType = taskTypeIdx !== -1 ? args[taskTypeIdx + 1] : 'implementation';

  let specContent, diff;
  try {
    specContent = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    console.error(`Error reading spec file "${specPath}": ${err.message}`);
    process.exit(1);
  }

  try {
    diff = fs.readFileSync(diffPath, 'utf8');
  } catch (err) {
    console.error(`Error reading diff file "${diffPath}": ${err.message}`);
    process.exit(1);
  }

  const results = checkInvariants(diff, specContent, { mode, taskType });
  const outputLines = formatOutput(results);

  if (results.hard.length > 0) {
    console.error('HARD invariant failures:');
    for (const line of outputLines.filter((_, i) => i < results.hard.length)) {
      console.error(`  ${line}`);
    }
  }

  if (results.advisory.length > 0) {
    console.warn('Advisory warnings:');
    for (const v of results.advisory) {
      console.warn(`  ${formatViolation(v)}`);
    }
  }

  if (results.hard.length === 0 && results.advisory.length === 0) {
    console.log('All invariant checks passed.');
  } else if (outputLines.length > 0) {
    // Print formatted output (respects 15-line cap)
    for (const line of outputLines) {
      if (results.hard.some((v) => formatViolation(v) === line)) {
        console.error(line);
      } else {
        console.warn(line);
      }
    }
  }

  process.exit(results.hard.length > 0 ? 1 : 0);
}

module.exports = {
  checkInvariants,
  checkLspAvailability,
  detectLanguageServer,
  isBinaryAvailable,
  formatOutput,
  formatViolation,
  parseDiff,
  TAGS,
  checkMockCoveringGap,
  checkReqOnlyInTests,
  checkPhantoms,
  checkScopeGaps,
};
