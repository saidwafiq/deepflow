#!/usr/bin/env node
/**
 * deepflow ratchet
 * Mechanical health-check gate with auto-revert on failure.
 *
 * Usage: node bin/ratchet.js [--task T{N}] [--worktree PATH] [--snapshot PATH]
 *
 * Outputs exactly one JSON line to stdout:
 *   {"result":"PASS"}
 *   {"result":"FAIL","stage":"build","log":"..."}
 *   {"result":"SALVAGEABLE","stage":"lint","log":"..."}
 *
 * Exit codes: 0=PASS, 1=FAIL, 2=SALVAGEABLE
 * On FAIL: executes `git revert HEAD --no-edit` before exiting.
 * On PASS + --task T{N}: updates PLAN.md [ ] → [x] and appends commit hash.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Git / path helpers
// ---------------------------------------------------------------------------

function gitCommonDir(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function mainRepoRoot(cwd) {
  const commonDir = gitCommonDir(cwd);
  if (!commonDir) return cwd;
  // --git-common-dir returns absolute path for worktrees, relative for normal repos
  const absCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(cwd, commonDir);
  // common dir is <repo>/.git for normal repos, <repo>/.git/worktrees/<name> for worktrees
  // Walk up until we find a directory that is not inside .git
  return path.resolve(absCommonDir, '..', '..').replace(/[/\\]\.git.*$/, '') ||
    path.dirname(absCommonDir);
}

// ---------------------------------------------------------------------------
// Config loading (simple regex, consistent with bin/install.js style)
// ---------------------------------------------------------------------------

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.deepflow', 'config.yaml');
  const cfg = {};
  if (!fs.existsSync(configPath)) return cfg;

  const text = fs.readFileSync(configPath, 'utf8');

  const keys = ['build_command', 'test_command', 'typecheck_command', 'lint_command'];
  for (const key of keys) {
    const m = text.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
    if (m) cfg[key] = m[1].trim();
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Snapshot: read auto-snapshot.txt and absolutize paths
// ---------------------------------------------------------------------------

function loadSnapshotFiles(repoRoot, resolveBase = repoRoot) {
  const snapshotPath = path.join(repoRoot, '.deepflow', 'auto-snapshot.txt');
  if (!fs.existsSync(snapshotPath)) return [];

  return fs.readFileSync(snapshotPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(rel => path.join(resolveBase, rel));
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

function detectProjectType(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(repoRoot, 'pyproject.toml'))) return 'python';
  if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(repoRoot, 'go.mod'))) return 'go';
  return 'unknown';
}

function hasNpmScript(repoRoot, scriptName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return !!(pkg.scripts && pkg.scripts[scriptName]);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command builders per project type
// ---------------------------------------------------------------------------

function buildCommands(repoRoot, projectType, snapshotFiles, cfg) {
  const cmds = {};

  if (projectType === 'node') {
    // build
    if (cfg.build_command) {
      cmds.build = cfg.build_command;
    } else if (hasNpmScript(repoRoot, 'build')) {
      cmds.build = 'npm run build';
    }
    // test — always use snapshot files, never test-discovery flags
    if (cfg.test_command) {
      cmds.test = cfg.test_command;
    } else if (snapshotFiles.length > 0) {
      cmds.test = ['node', '--test', ...snapshotFiles];
    }
    // typecheck
    if (cfg.typecheck_command) {
      cmds.typecheck = cfg.typecheck_command;
    } else {
      // only add if tsc is available
      cmds.typecheck = 'npx tsc --noEmit';
    }
    // lint
    if (cfg.lint_command) {
      cmds.lint = cfg.lint_command;
    } else if (hasNpmScript(repoRoot, 'lint')) {
      cmds.lint = 'npm run lint';
    }

  } else if (projectType === 'python') {
    // build: skip
    if (cfg.build_command) cmds.build = cfg.build_command;
    // test
    if (cfg.test_command) {
      cmds.test = cfg.test_command;
    } else if (snapshotFiles.length > 0) {
      cmds.test = ['pytest', ...snapshotFiles];
    } else {
      cmds.test = 'pytest';
    }
    // typecheck
    if (cfg.typecheck_command) {
      cmds.typecheck = cfg.typecheck_command;
    } else {
      cmds.typecheck = 'mypy .';
    }
    // lint
    if (cfg.lint_command) {
      cmds.lint = cfg.lint_command;
    } else {
      cmds.lint = 'ruff check .';
    }

  } else if (projectType === 'rust') {
    cmds.build = cfg.build_command || 'cargo build';
    cmds.test = cfg.test_command || 'cargo test';
    // typecheck: skip (cargo build covers it)
    if (cfg.typecheck_command) cmds.typecheck = cfg.typecheck_command;
    cmds.lint = cfg.lint_command || 'cargo clippy';

  } else if (projectType === 'go') {
    cmds.build = cfg.build_command || 'go build ./...';
    // go test doesn't work well with individual file paths — use packages
    cmds.test = cfg.test_command || 'go test ./...';
    // typecheck: skip
    if (cfg.typecheck_command) cmds.typecheck = cfg.typecheck_command;
    cmds.lint = cfg.lint_command || 'go vet ./...';

  } else {
    // unknown: only use config overrides
    if (cfg.build_command) cmds.build = cfg.build_command;
    if (cfg.test_command) cmds.test = cfg.test_command;
    if (cfg.typecheck_command) cmds.typecheck = cfg.typecheck_command;
    if (cfg.lint_command) cmds.lint = cfg.lint_command;
  }

  return cmds;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

// Parse a string command into [executable, ...args] safely
function parseCommand(cmd) {
  // Very simple tokenizer — handles quoted strings and plain tokens
  const tokens = [];
  let current = '';
  let inQuote = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ') {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Run a command (string or array). Returns { ok, log }.
 * Captures stdout+stderr combined for the log.
 */
function runCommand(cmd, cwd) {
  const args = Array.isArray(cmd) ? cmd : parseCommand(cmd);
  const [exe, ...rest] = args;

  const result = spawnSync(exe, rest, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const log = ((result.stdout || '') + (result.stderr || '')).trim();

  if (result.error) {
    // executable not found / not available — treat as skip
    return { ok: null, log: result.error.message };
  }

  return { ok: result.status === 0, log };
}

/**
 * Check if an executable is available on PATH.
 */
function commandExists(exe) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Auto-revert
// ---------------------------------------------------------------------------

function autoRevert(cwd) {
  try {
    spawnSync('git', ['revert', 'HEAD', '--no-edit'], {
      cwd,
      stdio: 'ignore',
    });
  } catch (_) {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Health-check stages in order
// ---------------------------------------------------------------------------

const STAGE_ORDER = ['build', 'test', 'typecheck', 'lint', 'contract', 'scope'];

// Stages where failure is SALVAGEABLE (not FAIL)
const SALVAGEABLE_STAGES = new Set(['lint', 'contract']);

// ---------------------------------------------------------------------------
// REQ-1 + REQ-8: Contract stage
// ---------------------------------------------------------------------------

/**
 * Parse `Produces: path::Symbol` entries from PLAN.md.
 * Returns array of { file, symbol } entries.
 */
function parseProducesFromPlan(planPath) {
  if (!fs.existsSync(planPath)) return [];
  const text = fs.readFileSync(planPath, 'utf8');
  const entries = [];
  // Match: Produces: <path>::<Symbol>   (tolerant to leading whitespace & markdown bullets)
  const re = /Produces:\s*([^\s:`]+)::([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    entries.push({ file: m[1].trim(), symbol: m[2].trim() });
  }
  return entries;
}

/**
 * Verify that a symbol exists in a file.
 * Tries LSP documentSymbols first (if available); falls back to regex grep.
 * Returns true if found, false otherwise.
 */
async function verifySymbolExists(absFilePath, symbol, projectRoot) {
  // LSP-first — try to use queryLsp from df-invariant-check if present
  try {
    const invariantPath = path.join(projectRoot, 'hooks', 'df-invariant-check.js');
    if (fs.existsSync(invariantPath)) {
      // eslint-disable-next-line global-require
      const inv = require(invariantPath);
      if (typeof inv.queryLsp === 'function' && typeof inv.detectLanguageServer === 'function') {
        const detected = inv.detectLanguageServer(projectRoot, [absFilePath]);
        if (detected && detected.binary) {
          const fileUri = 'file://' + absFilePath;
          const res = await inv.queryLsp(
            detected.binary,
            projectRoot,
            fileUri,
            'textDocument/documentSymbol',
            { textDocument: { uri: fileUri } }
          );
          if (res && res.ok && Array.isArray(res.result)) {
            const names = flattenSymbolNames(res.result);
            if (names.includes(symbol)) return true;
            // LSP gave a definitive (empty/non-matching) result — do NOT fall
            // back to regex when we have an authoritative answer. But if
            // the list is empty, treat as inconclusive → fallback.
            if (names.length > 0) return false;
          }
        }
      }
    }
  } catch (_) {
    // LSP unavailable — fall back
  }

  // Regex fallback: scan file for \bsymbol\b
  try {
    if (!fs.existsSync(absFilePath)) return false;
    const src = fs.readFileSync(absFilePath, 'utf8');
    const safe = escapeRegExp(symbol);
    return new RegExp(`\\b${safe}\\b`).test(src);
  } catch (_) {
    return false;
  }
}

function flattenSymbolNames(symbols) {
  const names = [];
  const walk = (arr) => {
    for (const s of arr || []) {
      if (s && typeof s.name === 'string') names.push(s.name);
      if (s && Array.isArray(s.children)) walk(s.children);
    }
  };
  walk(symbols);
  return names;
}

/**
 * Count AC-N references across snapshot test files.
 */
function countAcRefsInSnapshot(snapshotFiles) {
  let count = 0;
  const pattern = /\bAC-\d+\b/g;
  for (const f of snapshotFiles) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      const matches = src.match(pattern);
      if (matches) count += matches.length;
    } catch (_) {
      // skip unreadable
    }
  }
  return count;
}

/**
 * Run the contract stage.
 * @returns {Promise<{ ok: boolean, salvageable?: boolean, log: string }>}
 *   - ok:true → PASS (continue / exit success)
 *   - ok:false, salvageable:true → SALVAGEABLE (exit 2, no revert)
 *   - ok:false → FAIL
 *   - If no Produces: entries at all, returns ok:true (no-op).
 */
async function runContractStage(repoRoot, cwd, snapshotFiles) {
  // Locate PLAN.md — prefer worktree cwd, fall back to repo root
  let planPath = path.join(cwd, 'PLAN.md');
  if (!fs.existsSync(planPath)) planPath = path.join(repoRoot, 'PLAN.md');

  const entries = parseProducesFromPlan(planPath);
  if (entries.length === 0) {
    return { ok: true, log: 'contract: no Produces: entries — skipped' };
  }

  // Verify each declared symbol exists
  const missing = [];
  for (const { file, symbol } of entries) {
    const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
    const found = await verifySymbolExists(absPath, symbol, repoRoot);
    if (!found) missing.push(`${file}::${symbol}`);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      salvageable: true,
      log: `contract: declared symbols not found: ${missing.join(', ')}`,
    };
  }

  // Ratchet PASS + zero AC test references in snapshot → SALVAGEABLE
  const acRefs = countAcRefsInSnapshot(snapshotFiles);
  if (acRefs === 0) {
    return {
      ok: false,
      salvageable: true,
      log: 'contract: zero AC-N references found in ratchet snapshot test files',
    };
  }

  return { ok: true, log: `contract: ${entries.length} symbols verified, ${acRefs} AC refs` };
}

// ---------------------------------------------------------------------------
// REQ-N: Scope stage — verify git diff against task's declared Files:
// ---------------------------------------------------------------------------

/**
 * Parse the Files: list for a specific task from PLAN.md text.
 * Returns [] if task not found or has no Files: declaration.
 */
function extractTaskFilesFromPlan(planText, taskId) {
  const lines = planText.split('\n');

  // Find the task header line containing **T{N}**
  let taskLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`**${taskId}**`)) {
      taskLineIdx = i;
      break;
    }
  }
  if (taskLineIdx === -1) return [];

  // Task block ends at the next task line (- [ ] or - [x])
  let blockEnd = lines.length;
  for (let i = taskLineIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s*\[[ xX~]\]/.test(lines[i])) {
      blockEnd = i;
      break;
    }
  }

  const block = lines.slice(taskLineIdx, blockEnd);
  for (const line of block) {
    const m = line.match(/^\s*-?\s*Files:\s*(.+)$/i);
    if (m) {
      return m[1]
        .split(',')
        .map(s => s.trim().replace(/^[`"']|[`"']$/g, ''))
        .filter(s => s.length > 0 && !/^\{.*\}$/.test(s) && !/^\[.*\]$/.test(s));
    }
  }
  return [];
}

/**
 * Scope stage: compare files changed on this branch vs main against
 * the task's declared Files: list in PLAN.md.
 *
 * Returns { ok: true } when in scope or skipped (no taskId / no Files: / diff fails).
 * Returns { ok: false, salvageable: true, log } when out-of-scope files are found.
 */
function runScopeStage(repoRoot, cwd, taskId) {
  if (!taskId) return { ok: true, log: 'scope: no --task specified — skipped' };

  // All files changed on this branch relative to main
  const diffResult = spawnSync(
    'git', ['diff', '--name-only', 'main...HEAD'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (diffResult.error || diffResult.status !== 0) {
    return { ok: true, log: 'scope: git diff failed — skipped' };
  }

  const changedFiles = (diffResult.stdout || '').trim().split('\n').filter(f => f.length > 0);
  if (changedFiles.length === 0) return { ok: true, log: 'scope: no changed files' };

  // Load PLAN.md — prefer worktree cwd, fall back to repo root
  let planPath = path.join(cwd, 'PLAN.md');
  if (!fs.existsSync(planPath)) planPath = path.join(repoRoot, 'PLAN.md');
  if (!fs.existsSync(planPath)) return { ok: true, log: 'scope: no PLAN.md — skipped' };

  const planText = fs.readFileSync(planPath, 'utf8');
  const declaredFiles = extractTaskFilesFromPlan(planText, taskId);
  if (declaredFiles.length === 0) {
    return { ok: true, log: `scope: no Files: declared for ${taskId} — skipped` };
  }

  // Flexible match: exact path, path suffix, or basename (handles repo-relative vs absolute)
  const outOfScope = changedFiles.filter(changed => {
    const changedBase = path.basename(changed);
    return !declaredFiles.some(declared => {
      const rel = declared.replace(/^\.\//, '');
      const base = path.basename(rel);
      return (
        changed === rel ||
        changed.endsWith('/' + rel) ||
        rel.endsWith('/' + changed) ||
        (changedBase === base && (changed.endsWith(rel) || rel.endsWith(changed)))
      );
    });
  });

  if (outOfScope.length === 0) {
    return { ok: true, log: `scope: all ${changedFiles.length} changed file(s) in scope` };
  }

  return {
    ok: false,
    salvageable: true,
    log: `scope: ${outOfScope.length} out-of-scope file(s): ${outOfScope.join(', ')} — declared: ${declaredFiles.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const args = { task: null, worktree: null, snapshot: null, stage: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task' && argv[i + 1]) {
      args.task = argv[++i];
    } else if (argv[i] === '--worktree' && argv[i + 1]) {
      args.worktree = argv[++i];
    } else if (argv[i] === '--snapshot' && argv[i + 1]) {
      args.snapshot = argv[++i];
    } else if (argv[i] === '--stage' && argv[i + 1]) {
      args.stage = argv[++i];
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// PLAN.md updater
// ---------------------------------------------------------------------------

function updatePlanMd(repoRoot, taskId, cwd) {
  const planPath = path.join(repoRoot, 'PLAN.md');
  if (!fs.existsSync(planPath)) return;

  let hash = '';
  try {
    hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    // best-effort
  }

  const text = fs.readFileSync(planPath, 'utf8');
  const safeTaskId = escapeRegExp(taskId);
  // Match lines like: - [ ] **T54** ...
  const re = new RegExp(`(^.*- \\[ \\].*\\*\\*${safeTaskId}\\*\\*.*)`, 'm');
  const updated = text.replace(re, (line) => {
    let result = line.replace('- [ ]', '- [x]');
    if (hash) result += ` (${hash})`;
    return result;
  });

  if (updated !== text) {
    fs.writeFileSync(planPath, updated, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const cwd = cliArgs.worktree || process.cwd();
  const repoRoot = mainRepoRoot(cwd);

  const cfg = loadConfig(repoRoot);
  const projectType = detectProjectType(repoRoot);
  let snapshotFiles = loadSnapshotFiles(repoRoot, cwd);
  const cmds = buildCommands(repoRoot, projectType, snapshotFiles, cfg);
  // --snapshot flag overrides the snapshot-derived test command
  if (cliArgs.snapshot && fs.existsSync(cliArgs.snapshot)) {
    const snapFiles = fs.readFileSync(cliArgs.snapshot, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l.length > 0)
      .map(rel => path.isAbsolute(rel) ? rel : path.join(cwd, rel));
    if (snapFiles.length > 0) {
      snapshotFiles = snapFiles;
      if (projectType === 'node' && !cfg.test_command) {
        cmds.test = ['node', '--test', ...snapFiles];
      }
    }
  }

  // --stage filter: run only the specified stage
  const stageFilter = cliArgs.stage;
  if (stageFilter && !STAGE_ORDER.includes(stageFilter)) {
    process.stdout.write(JSON.stringify({ result: 'FAIL', stage: stageFilter, log: `unknown stage: ${stageFilter}` }) + '\n');
    process.exit(1);
  }

  for (const stage of STAGE_ORDER) {
    if (stageFilter && stage !== stageFilter) continue;

    // Contract stage is implemented in-process (no external command)
    if (stage === 'contract') {
      const res = await runContractStage(repoRoot, cwd, snapshotFiles);
      if (res.ok) continue;
      if (res.salvageable) {
        process.stdout.write(JSON.stringify({ result: 'SALVAGEABLE', stage, log: res.log }) + '\n');
        process.exit(2);
      }
      autoRevert(cwd);
      process.stdout.write(JSON.stringify({ result: 'FAIL', stage, log: res.log }) + '\n');
      process.exit(1);
    }

    // Scope stage: compare git diff against task's declared Files: (always SALVAGEABLE)
    if (stage === 'scope') {
      const res = runScopeStage(repoRoot, cwd, cliArgs.task);
      if (res.ok) continue;
      process.stdout.write(JSON.stringify({ result: 'SALVAGEABLE', stage, log: res.log }) + '\n');
      process.exit(2);
    }

    const cmd = cmds[stage];
    if (!cmd) continue; // stage not applicable

    // For string commands, check if the primary executable exists
    if (typeof cmd === 'string') {
      const exe = parseCommand(cmd)[0];
      // npx is always available if npm is; skip existence check for npx
      if (exe !== 'npx' && !commandExists(exe)) continue;
    }

    const { ok, log } = runCommand(cmd, cwd);

    if (ok === null) {
      // executable spawning error — skip stage
      continue;
    }

    if (!ok) {
      if (SALVAGEABLE_STAGES.has(stage)) {
        process.stdout.write(JSON.stringify({ result: 'SALVAGEABLE', stage, log }) + '\n');
        process.exit(2);
      } else {
        autoRevert(cwd);
        process.stdout.write(JSON.stringify({ result: 'FAIL', stage, log }) + '\n');
        process.exit(1);
      }
    }
  }

  process.stdout.write(JSON.stringify({ result: 'PASS' }) + '\n');
  if (cliArgs.task) {
    updatePlanMd(repoRoot, cliArgs.task, cwd);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ result: 'FAIL', stage: 'internal', log: String(err && err.stack || err) }) + '\n');
  process.exit(1);
});
