#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow implement protocol injector
 *
 * PreToolUse hook: fires before the Agent tool executes. When the Agent
 * prompt looks like a /df:execute-spawned task, the hook appends three
 * structured blocks to the prompt:
 *   - CONTEXT: Impact       — callers discovered via LSP `findReferences`
 *   - CONTEXT: Existing Types — exported symbols via LSP `documentSymbol`
 *   - CONTEXT: Tool Prohibition — the exact prohibition literal required
 *     by AC-4.
 *
 * When the LSP path returns nothing for every queried file, the hook falls
 * back to a grep-style approximation via `runPhase1` from the shared
 * symbol-extract library (AC-7 graceful degradation).
 *
 * Detection signals (any of):
 *   - prompt contains `.deepflow/worktrees/{slug}` path
 *   - prompt contains a global task id `T{N}:` marker with a `Files:` list
 *   - prompt explicitly declares `TASK_STATUS:` contract near the bottom
 *
 * Dedup: presence of `<!-- df-implement-protocol-injected -->` aborts.
 *
 * Failure policy: ANY error — malformed JSON, LSP crash, fs errors, timeouts —
 * results in a silent exit 0 with empty stdout (fail-open, REQ-4/AC-6).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readStdinIfMain } = require('./lib/hook-stdin');
const { runPhase1 } = require('./lib/symbol-extract');

const INJECTION_MARKER = '<!-- df-implement-protocol-injected -->';
const PROHIBITION_LITERAL =
  'Read ONLY these files. No Grep/Glob exploration. Bash only for build/test/git.';

// Per-hook caps (AC-7 budget). The budget is a hard ceiling on total lines
// appended, split roughly 60/40 between Impact and Types blocks.
const MAX_TOTAL_LINES = 120;
const MAX_IMPACT_LINES = 60;
const MAX_TYPES_LINES = 40;
const MAX_FILES = 10;
const LSP_TIMEOUT_MS = 1500;

// LSP SymbolKind values we keep as "types" for the Existing Types block.
//   5  = Class
//   10 = Enum
//   11 = Interface
//   26 = TypeAlias
const TYPE_KINDS = new Set([5, 10, 11, 26]);
const KIND_NAME = { 5: 'class', 10: 'enum', 11: 'interface', 26: 'type' };

// ────────────────────────────────────────────────────────────────────────────
// Prompt marker detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the prompt looks like a /df:execute-spawned task.
 *
 * Accepts any of:
 *   - reference to `.deepflow/worktrees/<slug>` (task worktree preamble)
 *   - a `T{N}:` task id marker paired with a `Files:` listing
 *   - the explicit `TASK_STATUS:` closing contract used by execute.md
 */
function parsePromptMarkers(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;

  const hasWorktree = /\.deepflow\/worktrees\/[A-Za-z0-9_\-./]+/.test(prompt);
  const hasTaskId = /\bT\d+\s*:/.test(prompt);
  const hasFilesList = /\bFiles:\s*\S/.test(prompt);
  const hasTaskStatus = /TASK_STATUS\s*:/.test(prompt);

  // Require some combination that's specific to /df:execute tasks.
  if (hasWorktree && (hasFilesList || hasTaskStatus)) return true;
  if (hasTaskId && hasFilesList) return true;
  if (hasTaskStatus && hasFilesList) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Files: list extraction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse the task `Files:` list from the prompt.
 * Tolerates both comma-separated and newline-separated values. Caps at
 * MAX_FILES entries.
 */
function parseFilesList(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];
  const lines = prompt.split('\n');
  const files = [];

  for (let i = 0; i < lines.length; i++) {
    // Accept `Files:` anywhere on the line — the /df:execute single-line
    // template is `{task_id}: {desc}  Files: {files}  Spec: {spec}`.
    const m = lines[i].match(/(?:^|[\s.])Files:\s*(.*)$/);
    if (!m) continue;

    // Inline files on the same line. A trailing ` Spec:` / ` Blocked by:` /
    // ` Impact:` etc. terminates the list.
    let inline = m[1].trim();
    const stopIdx = inline.search(/\s+(?:Spec|Blocked by|Impact|Deps|Notes):\s/);
    if (stopIdx >= 0) inline = inline.slice(0, stopIdx).trim();

    if (inline) {
      inline.split(',').forEach((p) => {
        const v = p.trim().replace(/^[`"']|[`"']$/g, '');
        if (v && /^[A-Za-z0-9_./\\\-]+$/.test(v)) files.push(v);
      });
    }

    // Continuation lines: subsequent bullets / paths until a blank line or a
    // non-path-looking line. Only used when Files: was the last thing on its
    // line (no inline content consumed the list already).
    if (files.length === 0 || !/Spec:|Blocked by:|Impact:/.test(m[0])) {
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (!ln.trim()) break;
        // Stop on another section header.
        if (/^\s*[A-Za-z_][A-Za-z0-9_ -]*:\s*\S/.test(ln)) break;
        // Accept bullet or bare path entries.
        const entry = ln.replace(/^\s*[-*]\s+/, '').trim();
        if (!entry) break;
        if (/[^A-Za-z0-9_./\\\- ,]/.test(entry)) break;
        entry.split(',').forEach((p) => {
          const v = p.trim().replace(/^[`"']|[`"']$/g, '');
          if (v) files.push(v);
        });
      }
    }
    break;
  }

  // De-dup while preserving order, cap at MAX_FILES.
  const seen = new Set();
  const unique = [];
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    unique.push(f);
    if (unique.length >= MAX_FILES) break;
  }
  return unique;
}

/**
 * Resolve each entry against the worktree cwd; keep only regular files.
 */
function resolveFiles(files, cwd) {
  const abs = [];
  for (const f of files) {
    const p = path.isAbsolute(f) ? f : path.join(cwd, f);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) abs.push(p);
    } catch (_) {
      // Missing file — skip silently; it may be a file the task will create.
    }
  }
  return abs;
}

// ────────────────────────────────────────────────────────────────────────────
// LSP shell-out helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Locate bin/lsp-query.js relative to the project root. Prefer the per-repo
 * copy, fall back to the worktree's own hooks dir parent.
 */
function findLspQueryCli(cwd) {
  const candidates = [
    path.join(cwd, 'bin', 'lsp-query.js'),
    path.join(__dirname, '..', 'bin', 'lsp-query.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * Invoke `node bin/lsp-query.js` synchronously with a short budget.
 * Always returns an array (possibly empty). Never throws.
 */
function runLspCli(cli, cwd, args) {
  try {
    const out = execFileSync('node', [cli, ...args], {
      cwd,
      timeout: LSP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    const parsed = JSON.parse((out || '[]').trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * documentSymbol — returns a flat list of { name, kind, selectionRange }.
 * Supports both hierarchical DocumentSymbol[] and flat SymbolInformation[].
 */
function queryDocumentSymbols(cli, cwd, absFile) {
  const raw = runLspCli(cli, cwd, ['--op', 'documentSymbol', '--file', absFile]);
  const flat = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.name === 'string' && typeof node.kind === 'number') {
      // DocumentSymbol has `selectionRange` + `range`; SymbolInformation has `location.range`.
      const sel = node.selectionRange || (node.location && node.location.range) || node.range;
      flat.push({ name: node.name, kind: node.kind, selectionRange: sel || null });
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  raw.forEach(visit);
  return flat;
}

/**
 * findReferences — returns an array of { uri, range } (LSP Location shape).
 */
function queryReferences(cli, cwd, absFile, line, char) {
  const raw = runLspCli(cli, cwd, [
    '--op', 'findReferences',
    '--file', absFile,
    '--line', String(line),
    '--char', String(char),
  ]);
  return raw.filter((r) => r && typeof r.uri === 'string' && r.range);
}

// ────────────────────────────────────────────────────────────────────────────
// Block builders
// ────────────────────────────────────────────────────────────────────────────

function relFromCwd(absOrUri, cwd) {
  let p = absOrUri || '';
  if (p.startsWith('file://')) p = p.slice('file://'.length);
  try {
    const rel = path.relative(cwd, p);
    return rel && !rel.startsWith('..') ? rel : p;
  } catch (_) {
    return p;
  }
}

/**
 * Build the Impact block lines. `callers` is a flat list of
 * { callerPath, callerLine, symbolName, symbolPath }.
 */
function buildImpactLines(callers, cwd) {
  const lines = [];
  lines.push('--- CONTEXT: Impact ---');
  if (callers.length === 0) {
    lines.push('Callers found: (none discovered)');
    return lines;
  }
  lines.push('Callers found:');

  // Dedup by `callerPath:callerLine -> symbolName`.
  const seen = new Set();
  for (const c of callers) {
    const key = `${c.callerPath}:${c.callerLine}|${c.symbolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = relFromCwd(c.callerPath, cwd);
    lines.push(`- ${rel}:${c.callerLine} — uses ${c.symbolName}`);
    // +2 because header lines already consumed 2 slots.
    if (lines.length >= MAX_IMPACT_LINES) {
      lines.push('... (truncated)');
      break;
    }
  }
  return lines;
}

/**
 * Build the Existing Types block lines. `types` is a flat list of
 * { name, kind, path, startLine, endLine }.
 */
function buildTypesLines(types, cwd) {
  const lines = [];
  lines.push('--- CONTEXT: Existing Types ---');
  if (types.length === 0) {
    lines.push('(no exported types discovered)');
    return lines;
  }
  for (const t of types) {
    const rel = relFromCwd(t.path, cwd);
    const kindLabel = KIND_NAME[t.kind] || 'symbol';
    const range =
      Number.isInteger(t.startLine) && Number.isInteger(t.endLine) && t.endLine >= t.startLine
        ? `${t.startLine}-${t.endLine}`
        : `${t.startLine || '?'}`;
    lines.push(`- ${kindLabel} ${t.name} (${rel}:${range})`);
    if (lines.length >= MAX_TYPES_LINES) {
      lines.push('... (truncated)');
      break;
    }
  }
  return lines;
}

function buildProhibitionLines() {
  return ['--- CONTEXT: Tool Prohibition ---', PROHIBITION_LITERAL];
}

/**
 * Assemble full injection text. Enforces MAX_TOTAL_LINES hard cap.
 */
function buildInjectionBlock({ callers, types, cwd }) {
  const out = [];
  out.push(INJECTION_MARKER);
  out.push(...buildImpactLines(callers, cwd));
  out.push('');
  out.push(...buildTypesLines(types, cwd));
  out.push('');
  out.push(...buildProhibitionLines());

  if (out.length > MAX_TOTAL_LINES) {
    return out.slice(0, MAX_TOTAL_LINES - 1).concat(['... (truncated)']).join('\n');
  }
  return out.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Collector: per-file LSP sweep with global line budget
// ────────────────────────────────────────────────────────────────────────────

function collectLspData(absFiles, cwd) {
  const cli = findLspQueryCli(cwd);
  const callers = [];
  const types = [];
  let anyLspSymbolFound = false;
  let budgetRemaining = MAX_TOTAL_LINES;

  if (!cli) return { callers, types, anyLspSymbolFound, usedLsp: false };

  for (const abs of absFiles) {
    if (budgetRemaining <= 0) break;

    const symbols = queryDocumentSymbols(cli, cwd, abs);
    if (symbols.length > 0) anyLspSymbolFound = true;

    const typeSymbols = symbols.filter((s) => TYPE_KINDS.has(s.kind));

    for (const sym of typeSymbols) {
      if (budgetRemaining <= 0) break;
      const sel = sym.selectionRange || {};
      const startLine = sel.start && Number.isInteger(sel.start.line) ? sel.start.line + 1 : 0;
      const endLine = sel.end && Number.isInteger(sel.end.line) ? sel.end.line + 1 : startLine;
      const startChar = sel.start && Number.isInteger(sel.start.character) ? sel.start.character : 0;

      types.push({
        name: sym.name,
        kind: sym.kind,
        path: abs,
        startLine,
        endLine,
      });
      budgetRemaining--;

      if (budgetRemaining <= 0) break;

      // findReferences is 0-indexed; convert back to 0-indexed line for the query.
      const refs = queryReferences(cli, cwd, abs, Math.max(0, startLine - 1), startChar);
      for (const r of refs) {
        if (budgetRemaining <= 0) break;
        const callerPath = (r.uri || '').replace(/^file:\/\//, '');
        // Skip self-references that land inside the same declaration line.
        const callerLine =
          r.range && r.range.start && Number.isInteger(r.range.start.line)
            ? r.range.start.line + 1
            : 0;
        if (callerPath === abs && callerLine === startLine) continue;
        callers.push({
          callerPath,
          callerLine,
          symbolName: sym.name,
          symbolPath: abs,
        });
        budgetRemaining--;
      }
    }
  }

  return { callers, types, anyLspSymbolFound, usedLsp: true };
}

/**
 * Fallback: regex-based symbol extraction when the LSP path yields nothing
 * useful. Produces type-like entries sourced from runPhase1, scoped to the
 * task's files.
 */
function collectFallbackData(absFiles, cwd) {
  const types = [];
  const typeKindStrings = new Set(['class', 'interface', 'type', 'enum', 'struct', 'trait']);

  for (const abs of absFiles) {
    const rel = path.relative(cwd, abs);
    // runPhase1 filters by substring match against the query. Use the file's
    // basename so it keeps anything defined in that file.
    const base = path.basename(abs, path.extname(abs));
    const { symbols } = runPhase1(base, cwd);
    for (const s of symbols) {
      if (s.filepath !== abs && path.relative(cwd, s.filepath) !== rel) continue;
      if (!typeKindStrings.has(s.kind)) continue;
      // Map back to LSP-ish kind number for rendering uniformity.
      let kind = 5; // class default
      if (s.kind === 'interface') kind = 11;
      else if (s.kind === 'type') kind = 26;
      else if (s.kind === 'enum') kind = 10;
      types.push({
        name: s.name,
        kind,
        path: abs,
        startLine: s.line,
        endLine: s.line,
      });
      if (types.length >= MAX_TYPES_LINES) break;
    }
    if (types.length >= MAX_TYPES_LINES) break;
  }

  return { callers: [], types, anyLspSymbolFound: false, usedLsp: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────────────

function main(payload) {
  const { tool_name, tool_input, cwd } = payload || {};
  if (tool_name !== 'Agent') return null;
  if (!tool_input || typeof tool_input !== 'object') return null;

  const originalPrompt = tool_input.prompt || '';
  if (!parsePromptMarkers(originalPrompt)) return null;

  // AC-10: dedup guard
  if (originalPrompt.includes(INJECTION_MARKER)) return null;

  const effectiveCwd = cwd || process.cwd();

  const files = parseFilesList(originalPrompt);
  if (files.length === 0) return null;

  const absFiles = resolveFiles(files, effectiveCwd);
  if (absFiles.length === 0) return null;

  // 1) LSP path.
  let data = collectLspData(absFiles, effectiveCwd);

  // 2) Fallback (AC-7): when LSP returned zero symbols across all files.
  if (!data.anyLspSymbolFound) {
    const fb = collectFallbackData(absFiles, effectiveCwd);
    // Merge: prefer any LSP callers (none when fallback kicks in) + fallback types.
    data = {
      callers: data.callers,
      types: fb.types.length ? fb.types : data.types,
      usedLsp: false,
      anyLspSymbolFound: false,
    };
  }

  // If we have literally nothing to say beyond the prohibition, we still
  // emit — the prohibition is load-bearing (AC-4). The Impact/Types blocks
  // degrade gracefully to "(none discovered)".
  const injection = buildInjectionBlock({
    callers: data.callers,
    types: data.types,
    cwd: effectiveCwd,
  });
  const updatedPrompt = `${originalPrompt}\n\n${injection}`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...tool_input,
        prompt: updatedPrompt,
      },
    },
  };
}

readStdinIfMain(module, (payload) => {
  try {
    const result = main(payload);
    if (result) {
      process.stdout.write(JSON.stringify(result));
    }
  } catch (_) {
    // AC-6: fail-open on ANY error — malformed input, fs errors, LSP crash.
  }
});

module.exports = {
  main,
  parsePromptMarkers,
  parseFilesList,
  resolveFiles,
  findLspQueryCli,
  queryDocumentSymbols,
  queryReferences,
  collectLspData,
  collectFallbackData,
  buildImpactLines,
  buildTypesLines,
  buildProhibitionLines,
  buildInjectionBlock,
  INJECTION_MARKER,
  PROHIBITION_LITERAL,
  TYPE_KINDS,
  KIND_NAME,
  MAX_TOTAL_LINES,
  MAX_IMPACT_LINES,
  MAX_TYPES_LINES,
  MAX_FILES,
};
