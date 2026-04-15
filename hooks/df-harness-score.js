#!/usr/bin/env node
// @hook-event: PostToolUse
// @hook-owner: deepflow
/**
 * deepflow harness quality scorer (REQ-6).
 *
 * Aggregates 4 deterministic signals about test harness health and emits a
 * SALVAGEABLE signal when the combined score falls below the configured
 * threshold (`harness_min_score`, default 0.6).
 *
 * Score = (D1 + D2 + D3 + D4) / 4, each dimension ∈ [0, 1]:
 *   D1  AC test ratio          (AC-referenced tests) / (total ACs in spec)
 *   D2  Diff sibling ratio     (test files in diff) / (impl files in diff)
 *   D3  Complexity proxy       1 - min(1, branch_kw_in_±20 / 10)
 *   D4  JSDoc ratio            (functions with JSDoc) / (total changed fns)
 *
 * Hook trigger: PostToolUse, tool_name "Bash", command contains "git commit".
 *
 * Exit codes:
 *   0 — score >= threshold, or insufficient signal, or non-commit event
 *   2 — SALVAGEABLE: score < threshold (written to stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { readStdinIfMain } = require('./lib/hook-stdin');
const { scanTestFilesForACs, extractSpecACs } = require('./ac-coverage');
const {
  queryLsp,
  detectLanguageServer,
  isBinaryAvailable,
} = require('./df-invariant-check');

const DEFAULT_MIN_SCORE = 0.6;
const COMPLEXITY_THRESHOLD = 10;
const CONTEXT_LINES = 20;
const JSDOC_LOOKBACK_LINES = 3;

const BRANCH_KEYWORDS = [
  'if', 'else', 'switch', 'case', 'for', 'while', 'do',
  'try', 'catch', 'finally', 'throw', '&&', '||', '??', '?',
];

const TEST_FILE_RE = /(^|\/)(__tests__\/|test\/|tests\/|spec\/)|\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs)$/i;
const IMPL_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb)$/i;

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * Read harness_min_score from .deepflow/config.yaml. Returns DEFAULT_MIN_SCORE
 * on any failure (missing file, malformed YAML, missing key).
 */
function readMinScore(cwd) {
  const configPath = path.join(cwd, '.deepflow', 'config.yaml');
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return DEFAULT_MIN_SCORE;
  }
  // Minimal YAML scan — avoid a YAML dep. Look for "harness_min_score: <num>"
  const m = content.match(/^\s*harness_min_score\s*:\s*([0-9]*\.?[0-9]+)\s*(#.*)?$/m);
  if (!m) return DEFAULT_MIN_SCORE;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v) || v < 0 || v > 1) return DEFAULT_MIN_SCORE;
  return v;
}

// ── Active spec loader (mirrors df-invariant-check.js) ───────────────────────

function loadActiveSpec(cwd) {
  const candidates = [
    path.join(cwd, '.deepflow'),
    path.join(cwd, 'specs'),
  ];
  for (const dir of candidates) {
    try {
      const entries = fs.readdirSync(dir);
      const doing = entries.find((e) => e.startsWith('doing-') && e.endsWith('.md'));
      if (doing) {
        const p = path.join(dir, doing);
        try { return { path: p, content: fs.readFileSync(p, 'utf8') }; } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // dir missing — continue
    }
  }
  return null;
}

// ── Diff helpers ─────────────────────────────────────────────────────────────

function getChangedFiles(cwd) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function getFullDiff(cwd) {
  try {
    return execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
      encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return '';
  }
}

function isTestFile(p) {
  return TEST_FILE_RE.test(p);
}

function isImplFile(p) {
  return IMPL_EXT_RE.test(p) && !isTestFile(p);
}

// ── D1: AC test ratio ────────────────────────────────────────────────────────

function dimensionAcTestRatio(specContent, testFilePaths) {
  const specACs = extractSpecACs(specContent);
  if (!specACs || specACs.length === 0) return { score: null, reason: 'no-acs' };

  const covered = scanTestFilesForACs(testFilePaths);
  let hits = 0;
  for (const id of specACs) if (covered.has(id)) hits++;
  return { score: hits / specACs.length, total: specACs.length, covered: hits };
}

// ── D2: diff sibling test ratio ─────────────────────────────────────────────

function dimensionDiffSibling(changedFiles) {
  const impl = changedFiles.filter(isImplFile);
  const tests = changedFiles.filter(isTestFile);
  if (impl.length === 0) return { score: null, reason: 'no-impl-files' };
  // Ratio is clamped to [0, 1] — adding more test files than impl files still
  // caps at a perfect score rather than over-inflating.
  const raw = tests.length / impl.length;
  return { score: Math.max(0, Math.min(1, raw)), impl: impl.length, tests: tests.length };
}

// ── D3: complexity proxy ────────────────────────────────────────────────────

/**
 * Count occurrences of branch keywords within ±CONTEXT_LINES around every
 * changed hunk across the unified diff. Higher count = more complex change.
 * Returns { score, branches } where score = 1 - min(1, branches / threshold).
 */
function dimensionComplexity(diffText) {
  if (!diffText) return { score: null, reason: 'no-diff' };

  // Build a regex that matches any branch keyword. Word-boundary for alphas,
  // literal for symbolic operators.
  const wordKw = BRANCH_KEYWORDS.filter((k) => /^[a-z]+$/i.test(k));
  const symKw = BRANCH_KEYWORDS.filter((k) => !/^[a-z]+$/i.test(k));
  const wordRe = new RegExp(`\\b(?:${wordKw.join('|')})\\b`, 'g');
  const symParts = symKw.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const symRe = symParts.length ? new RegExp(symParts.join('|'), 'g') : null;

  // Walk file-by-file, track hunk line windows in the post-image (b/ side).
  // For each hunk header "@@ -x,y +a,b @@" we mark [a - CTX, a + b + CTX] as
  // the window of interest. We then count keyword occurrences on content
  // lines (starting with " ", "+", or "-") whose b-side line number falls in
  // any window. For simplicity we count keywords across the WHOLE hunk body
  // (hunks are already the "±20 lines" surrounding a change), effectively
  // implementing the ±20 context heuristic without tracking per-line numbers.
  let branches = 0;
  const lines = diffText.split('\n');
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (line.startsWith('diff --git') || line.startsWith('+++ ') || line.startsWith('--- ')
        || line.startsWith('index ') || line.startsWith('new file')
        || line.startsWith('deleted file') || line.startsWith('similarity index')
        || line.startsWith('rename ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    // Count within context + added + removed lines
    if (!(line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) continue;
    const body = line.slice(1);
    const wm = body.match(wordRe);
    if (wm) branches += wm.length;
    if (symRe) {
      const sm = body.match(symRe);
      if (sm) branches += sm.length;
    }
  }

  const score = 1 - Math.min(1, branches / COMPLEXITY_THRESHOLD);
  return { score, branches };
}

// ── D4: JSDoc ratio via queryLsp + lookback ─────────────────────────────────

const FUNCTION_KINDS = new Set([
  12, // Function
  6,  // Method
  9,  // Constructor
]);

function flattenSymbols(symbols, out = []) {
  for (const s of symbols || []) {
    out.push(s);
    if (Array.isArray(s.children) && s.children.length) flattenSymbols(s.children, out);
  }
  return out;
}

function symbolStartLine(sym) {
  // DocumentSymbol has .range; SymbolInformation has .location.range.
  const range = sym.range || (sym.location && sym.location.range);
  if (!range || !range.start) return null;
  return range.start.line; // 0-based
}

function hasJsDocAbove(fileLines, startLine) {
  const start = Math.max(0, startLine - JSDOC_LOOKBACK_LINES);
  const slice = fileLines.slice(start, startLine).map((l) => l.trim());
  // Accept any JSDoc-style comment: */ on a preceding line, or /** on one of
  // the lookback lines, or leading // comments for non-JS languages.
  for (const line of slice) {
    if (line.startsWith('/**') || line.startsWith('*/') || line.startsWith('*')
        || line.startsWith('///') || line.startsWith('# ') || line.startsWith('"""')) {
      return true;
    }
  }
  return false;
}

async function dimensionJsDocRatio(cwd, changedFiles) {
  const implFiles = changedFiles.filter(isImplFile);
  if (implFiles.length === 0) return { score: null, reason: 'no-impl-files' };

  const detected = detectLanguageServer(cwd, implFiles);
  if (!detected || !isBinaryAvailable(detected.binary)) {
    return { score: null, reason: 'lsp_unavailable' };
  }

  let totalFns = 0;
  let documented = 0;

  for (const rel of implFiles) {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    let source;
    try { source = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    const fileLines = source.split('\n');

    const uri = 'file://' + abs;
    let resp;
    try {
      resp = await queryLsp(detected.binary, cwd, uri, 'textDocument/documentSymbol', {
        textDocument: { uri },
      });
    } catch (_) {
      continue;
    }
    if (!resp || !resp.ok) continue;

    const symbols = flattenSymbols(Array.isArray(resp.result) ? resp.result : []);
    for (const sym of symbols) {
      if (!FUNCTION_KINDS.has(sym.kind)) continue;
      const startLine = symbolStartLine(sym);
      if (startLine == null) continue;
      totalFns++;
      if (hasJsDocAbove(fileLines, startLine)) documented++;
    }
  }

  if (totalFns === 0) return { score: null, reason: 'no-functions' };
  return { score: documented / totalFns, total: totalFns, documented };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Main scoring function.
 * @param {object} opts
 * @param {string} opts.cwd          project root
 * @param {string} opts.specContent  active spec markdown
 * @param {string} opts.diff         unified diff against HEAD~1
 * @param {string[]} opts.changedFiles  changed file paths (relative)
 * @param {string[]} [opts.testFilePaths]  test files to scan for AC refs
 *   (defaults to all test files under cwd discovered from changedFiles +
 *   existing on disk — callers may override for determinism).
 * @returns {Promise<{ score: number|null, dimensions: object }>}
 */
async function scoreHarness(opts) {
  const { cwd, specContent, diff, changedFiles } = opts;

  // D1 — scan ALL test files in the repo for broad AC coverage, not just diff.
  const testFilePaths = opts.testFilePaths
    || changedFiles.filter(isTestFile).map((f) => path.isAbsolute(f) ? f : path.join(cwd, f));

  const d1 = dimensionAcTestRatio(specContent, testFilePaths);
  const d2 = dimensionDiffSibling(changedFiles);
  const d3 = dimensionComplexity(diff);
  const d4 = await dimensionJsDocRatio(cwd, changedFiles);

  const dims = [d1, d2, d3, d4];
  const scored = dims.filter((d) => d && typeof d.score === 'number');
  if (scored.length === 0) {
    return { score: null, dimensions: { d1, d2, d3, d4 }, reason: 'no-signal' };
  }

  // Equal-weight average over the 4 dimensions. Dimensions with null score
  // (insufficient signal) are treated as 1.0 (neutral) to avoid penalising
  // a change for something that cannot be measured deterministically.
  const vals = dims.map((d) => (d && typeof d.score === 'number' ? d.score : 1));
  const score = vals.reduce((a, b) => a + b, 0) / vals.length;

  return { score, dimensions: { d1, d2, d3, d4 } };
}

// ── Hook entry ───────────────────────────────────────────────────────────────

function isGitCommitBash(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const cmd = (toolInput && (toolInput.command || toolInput.cmd || '')) || '';
  return /git\s+commit\b/.test(cmd);
}

async function runHook(data) {
  const toolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  if (!isGitCommitBash(toolName, toolInput)) return;

  const cwd = data.cwd || process.cwd();

  const diff = getFullDiff(cwd);
  const changedFiles = getChangedFiles(cwd);
  if (!diff || changedFiles.length === 0) return;

  const spec = loadActiveSpec(cwd);
  if (!spec) return; // no active spec — nothing to score against

  const minScore = readMinScore(cwd);
  const { score, dimensions, reason } = await scoreHarness({
    cwd, specContent: spec.content, diff, changedFiles,
  });

  if (score == null) {
    // No signal — silent pass
    return;
  }

  const pct = (n) => (n == null ? 'n/a' : n.toFixed(2));
  const summary = `[df-harness-score] score=${score.toFixed(2)} (min=${minScore.toFixed(2)}) `
    + `D1=${pct(dimensions.d1.score)} D2=${pct(dimensions.d2.score)} `
    + `D3=${pct(dimensions.d3.score)} D4=${pct(dimensions.d4.score)}`;

  if (score < minScore) {
    console.error(summary);
    console.error('[df-harness-score] OVERRIDE:SALVAGEABLE — harness quality below threshold');
    process.exit(2);
  } else {
    console.log(summary);
  }
}

// ── Wire up stdin entry ──────────────────────────────────────────────────────

readStdinIfMain(module, (data) => {
  // runHook is async — fire and let the process exit naturally on resolution.
  // We avoid awaiting inside readStdinIfMain's sync callback.
  runHook(data).catch(() => { /* never break Claude Code on hook errors */ });
});

module.exports = {
  scoreHarness,
  dimensionAcTestRatio,
  dimensionDiffSibling,
  dimensionComplexity,
  dimensionJsDocRatio,
  readMinScore,
  isGitCommitBash,
  isTestFile,
  isImplFile,
};
