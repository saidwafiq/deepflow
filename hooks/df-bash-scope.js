#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-tool: Bash
// @hook-owner: deepflow
/**
 * df-bash-scope — per-agent Bash command scope enforcement.
 *
 * PreToolUse hook: identifies the active deepflow sub-agent via two-tier inference
 * (T106 cwd-branch + T108 transcript-walk in agent-role.js) and applies per-agent
 * SCOPES (T105 bash-scopes.js).
 *
 * Precedence: denyOverride beats allow.
 *   1. If command matches ANY denyOverride pattern → block.
 *   2. Else if command matches ANY allow pattern → exit 0 (permit).
 *   3. Default → block (scope closed by default).
 *
 * Pass-through cases (exit 0 silently, no stdout):
 *   - role === null  → orchestrator-level Bash; governed by global allowlist.
 *   - SCOPES[role] absent → unknown agent; defensive pass-through.
 *
 * AC-8: coexistence with df-bash-worktree-guard is by design — both hooks
 * fire independently on the same Bash invocation. Either may block. No
 * coordination needed.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { readStdinIfMain } = require('./lib/hook-stdin');
const { inferAgentRole } = require('./lib/agent-role');
const { SCOPES, CURATOR_PATH_DENY, READ_STYLE_VERBS, READ_STYLE_VERB_DENY, SEARCH_TOOL_DENY, INTERPRETER_EVAL_DENY, extractReadStyleFileArgs, splitCommandSegments } = require('./lib/bash-scopes');

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Append one structured line to .deepflow/bash-telemetry.jsonl if the
 * directory already exists. Never creates the directory.
 *
 * @param {string} repoRoot  Absolute path to main repo root (or best-effort cwd).
 * @param {{ role: string|null, command: string, decision: string, reason?: string }} entry
 */
function appendTelemetry(repoRoot, entry) {
  try {
    const dir = path.join(repoRoot, '.deepflow');
    if (!fs.existsSync(dir)) return;
    const logPath = path.join(dir, 'bash-telemetry.jsonl');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (_) {
    // Silently swallow — telemetry must never block.
  }
}

// ---------------------------------------------------------------------------
// Block output helpers
// ---------------------------------------------------------------------------

/**
 * Emit a block decision to stdout and exit 0.
 * Claude Code reads stdout JSON; exit code is not used for decisions.
 *
 * @param {string} message  Human-readable reason string (one line).
 */
function block(message) {
  process.stdout.write(JSON.stringify({ decision: 'block', message }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Test a command string against an array of RegExp patterns.
 * Returns true on first match.
 */
function matchesAny(patterns, cmd) {
  return patterns.some(re => re.test(cmd));
}

/**
 * Extract the first token from a shell command for display in error messages.
 * Strips leading whitespace; stops at the first whitespace or end-of-string.
 * Handles commands like `cd /foo && git commit` by returning just `git`.
 *
 * Strategy: strip compound prefixes (cd ..., env ...) to find the real first
 * meaningful token. For block messages we just want the most recognisable token.
 */
function firstToken(cmd) {
  // Remove leading whitespace then grab up to first whitespace.
  const trimmed = cmd.trim();
  const m = trimmed.match(/^(\S+)/);
  return m ? m[1] : trimmed;
}

// ---------------------------------------------------------------------------
// Main hook logic
// ---------------------------------------------------------------------------

/**
 * True when cwd is inside any `.deepflow/worktrees/<x>/` path — i.e. a
 * curator-pattern execution worktree (shared `curator-active`, probe
 * sub-worktrees, or any future worktree under that root).
 *
 * Used to apply the curator-only path block independently of role
 * inference, since `df/curator-active` doesn't carry the per-task probe
 * suffix that `inferAgentRoleFromCwd` keys on.
 */
function isCuratorWorktree(cwd) {
  if (!cwd) return false;
  const marker = path.sep + path.join('.deepflow', 'worktrees') + path.sep;
  return cwd.includes(marker);
}

// ---------------------------------------------------------------------------
// Layer 1.5: Slice-aware read guard helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the main repo root from a worktree cwd using git --git-common-dir.
 * Returns null on any error.
 *
 * @param {string} cwd  Absolute path to the worktree.
 * @returns {string|null}  Absolute repo root path or null.
 */
function resolveRepoRoot(cwd) {
  try {
    const { execSync } = require('child_process');
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const absCommonDir = path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(cwd, commonDir);
    return path.dirname(absCommonDir);
  } catch (_) {
    return null;
  }
}

/**
 * Load the active slice JSON for the current subagent, if present.
 *
 * Contract (T1): `.deepflow/active-slice/<task_id>.json`
 * Shape: `{"task_id": string, "slice": string[], "written_at": string}`
 *
 * Picks the file with the latest mtime when multiple files exist.
 * Returns null when the directory does not exist, no files are present,
 * or any JSON parse error occurs.
 *
 * @param {string} repoRoot  Absolute path to main repo root.
 * @returns {{ task_id: string, slice: string[] }|null}
 */
function loadActiveSlice(repoRoot) {
  try {
    const sliceDir = path.join(repoRoot, '.deepflow', 'active-slice');
    if (!fs.existsSync(sliceDir)) return null;

    const entries = fs.readdirSync(sliceDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const full = path.join(sliceDir, f);
        try {
          const stat = fs.statSync(full);
          return { full, mtimeMs: stat.mtimeMs };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    if (entries.length === 0) return null;

    // Pick the file with the latest mtime
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = entries[0].full;

    const raw = fs.readFileSync(latest, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.slice)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Normalise a file path argument for slice comparison.
 *
 * Strategy: resolve relative to cwd; then take just the basename-relative
 * portion that the slice entries might use. Slice entries are relative paths
 * (e.g. "src/foo.ts", "hooks/bar.js"). We compare by:
 *   1. Exact match on the raw file arg.
 *   2. Suffix match: slice entry is a suffix of the resolved absolute path
 *      (handles slice entries like "src/foo.ts" matching "/abs/repo/src/foo.ts").
 *
 * @param {string} fileArg   Raw file argument from the command (may be relative or absolute).
 * @param {string[]} slice   Array of slice path strings.
 * @param {string} cwd       Working directory for relative resolution.
 * @returns {boolean}  True when fileArg refers to a path within the slice.
 */
function isFileInSlice(fileArg, slice, cwd) {
  if (!fileArg || !Array.isArray(slice) || slice.length === 0) return false;

  // Attempt absolute resolution for proper suffix matching
  let absArg;
  try {
    absArg = path.isAbsolute(fileArg) ? fileArg : path.resolve(cwd, fileArg);
  } catch (_) {
    absArg = null;
  }

  for (const entry of slice) {
    if (!entry) continue;
    // Exact match on raw arg
    if (fileArg === entry) return true;
    // Normalised path comparison
    if (absArg) {
      // The slice entry may be a relative path from repo root; check if absArg
      // ends with the normalised slice entry.
      const normEntry = entry.replace(/\\/g, '/');
      const normAbs = absArg.replace(/\\/g, '/');
      if (normAbs === normEntry) return true;
      if (normAbs.endsWith('/' + normEntry)) return true;
    }
  }
  return false;
}

/**
 * Layer 1.5: slice-aware read guard.
 *
 * When a df-implement subagent runs a read-style command (cat, head, tail, …)
 * against a file that is NOT in the active slice, block it with an informative
 * message naming the slice and the CONTEXT_INSUFFICIENT escape hatch.
 *
 * Pass-through conditions (exit without blocking):
 *   - role is not 'df-implement'
 *   - no active slice found
 *   - command first segment is not a read-style verb (non-destructive check)
 *   - command is a heredoc (no file arg)
 *   - all file args are within the active slice
 *
 * @param {string}   cmd       Raw command string.
 * @param {string}   role      Inferred agent role (or null).
 * @param {string}   cwd       Working directory from payload.
 * @returns {{ blocked: boolean, message?: string }}
 */
function checkSliceGuard(cmd, role, cwd) {
  // Only applies to df-implement
  if (role !== 'df-implement') return { blocked: false };

  // Resolve repo root so we can load the active slice
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return { blocked: false };

  const sliceData = loadActiveSlice(repoRoot);
  if (!sliceData || !sliceData.slice || sliceData.slice.length === 0) {
    return { blocked: false };
  }

  const { task_id, slice } = sliceData;

  // Split on `|`, `&&`, `;`, `||` — examine EVERY logical command segment.
  // Closes the `cd worktree && cat secret` bypass: the chained `cat` is now
  // its own segment and gets inspected even though it isn't first.
  const segments = splitCommandSegments(cmd);

  for (const seg of segments) {
    const firstToken = seg.trimStart().split(/\s+/)[0] || '';
    if (!READ_STYLE_VERBS.has(firstToken)) continue;

    // Extract file args (handles heredocs → returns [])
    const fileArgs = extractReadStyleFileArgs(seg);
    if (fileArgs.length === 0) continue; // heredoc or no file arg

    for (const fileArg of fileArgs) {
      if (!isFileInSlice(fileArg, slice, cwd)) {
        const sliceList = slice.join(', ');
        const message =
          `df-bash-scope: \`${firstToken} ${fileArg}\` is outside the active slice for task ${task_id}. ` +
          `Active slice: [${sliceList}]. ` +
          `Reading files outside the slice burns cache tokens unnecessarily. ` +
          `If you genuinely need this file, emit "CONTEXT_INSUFFICIENT: ${fileArg}" on its own line and stop — ` +
          `the curator will add it to the slice and re-spawn you with the file's content in your bundle.`;
        return { blocked: true, message };
      }
    }
  }

  return { blocked: false };
}

/**
 * Layer 1.4: interpreter-eval block.
 *
 * Inside curator worktrees, deny `python -c`, `node -e`, `ruby -e`, `perl -e`,
 * `deno eval`, `bun -e`, `bash -c`, `sh -c`, `zsh -c`, `awk '...getline...'`.
 * These forms let a subagent read arbitrary files via interpreter file APIs
 * (`open(p).read()`, `fs.readFileSync(p)`, `File.read(p)`) — fully bypassing
 * the slice guard, which only inspects shell read verbs.
 *
 * Pass-through: scripts run with explicit file paths (`python script.py`,
 * `node script.js`) are NOT blocked — those are normal task execution.
 *
 * @param {string} cmd  Raw command string.
 * @param {string} cwd  Working directory from payload.
 * @returns {{ blocked: boolean, message?: string }}
 */
function checkInterpreterEval(cmd, cwd) {
  if (!isCuratorWorktree(cwd)) return { blocked: false };
  for (const re of INTERPRETER_EVAL_DENY) {
    if (re.test(cmd)) {
      const message =
        `df-bash-scope: interpreter-eval forms (\`python -c\`, \`node -e\`, \`bash -c\`, etc.) are forbidden inside curator worktrees. ` +
        `These bypass the slice guard by reading files via interpreter APIs (\`open(p).read()\`, \`fs.readFileSync(p)\`). ` +
        `Use the Read/Edit/Write tools for file operations, or emit "CONTEXT_INSUFFICIENT: <path>" if you need a file outside your slice — ` +
        `the curator will augment your bundle and re-spawn.`;
      return { blocked: true, message };
    }
  }
  return { blocked: false };
}

readStdinIfMain(module, (payload) => {
  // Defensive: only act on Bash tool calls.
  if (!payload || payload.tool_name !== 'Bash') return;

  const cmd = (payload.tool_input && payload.tool_input.command) || '';
  if (!cmd) return;

  const cwd = payload.cwd || process.cwd();

  // Layer 1: Curator-only path block — fires for ANY subagent running inside
  // a `.deepflow/worktrees/*` path, independent of role inference. This
  // protects the curator pattern's bundle-isolation invariant: subagents
  // must not reach beyond their inline bundle into orchestrator-only
  // artefacts (specs/**, .deepflow/maps/**, decisions, checkpoint, config,
  // CLAUDE.md). Role inference returns null for `df/curator-active` (no
  // per-task probe suffix), so this layer is the primary enforcement.
  if (isCuratorWorktree(cwd) && matchesAny(CURATOR_PATH_DENY, cmd)) {
    const message =
      `df-bash-scope: subagent cannot read curator-only artefacts (specs/, .deepflow/maps/, decisions, checkpoint, config, CLAUDE.md). ` +
      `These are orchestrator inputs — your bundle is the only context source. ` +
      `If you need a file outside your bundle, emit "CONTEXT_INSUFFICIENT: <path>" on its own line and stop; ` +
      `the curator will augment your bundle and re-spawn.`;
    appendTelemetry(cwd, { role: 'curator-worktree', command: cmd, decision: 'block', reason: 'curator-path' });
    block(message);
    return;
  }

  // Layer 1.4: Interpreter-eval block — fires inside curator worktrees,
  // independent of role inference. Closes the `python -c "open(...).read()"`
  // bypass that evades the slice guard (which only inspects shell read verbs).
  const interpGuard = checkInterpreterEval(cmd, cwd);
  if (interpGuard.blocked) {
    appendTelemetry(cwd, { role: 'curator-worktree', command: cmd, decision: 'block', reason: 'interpreter-eval' });
    block(interpGuard.message);
    return;
  }


  // Layer 2: Per-role scope check (Tier 1 cwd-branch inference for probe-T{N} worktrees).
  let role;
  try {
    role = inferAgentRole(payload);
  } catch (_) {
    // inferAgentRole is already guarded, but be extra safe.
    role = null;
  }

  // Layer 1.6: curator-active shared-worktree read/search block.
  // Role inference returns null for `df/curator-active` (no per-task probe
  // suffix), but impl-class subagents (df-implement/test/integration/optimize)
  // DO run there per execute.md §6. Without this layer, `cat foo.go`,
  // `head -100 bar.go`, and `grep -n pattern src/` slip through to silent
  // pass-through, defeating the inline-bundle contract. Build/test runners
  // (go test, python script.py, npm test) are NOT blocked — those are
  // legitimate task execution. Gated on `role === null` so df-spike /
  // df-spike-platform in probe sub-worktrees keep their exploration scope.
  if (role === null && isCuratorWorktree(cwd)) {
    if (matchesAny(READ_STYLE_VERB_DENY, cmd) || matchesAny(SEARCH_TOOL_DENY, cmd)) {
      const token = firstToken(cmd);
      const message =
        `df-bash-scope: \`${token}\` is forbidden inside curator-active. ` +
        `Subagents receive full file content INLINE in the task prompt — shell file reads/searches burn cache tokens and violate the inline-bundle contract. ` +
        `If a needed file is missing from your bundle, emit "CONTEXT_INSUFFICIENT: <path>" on its own line and stop; the curator will augment your bundle and re-spawn.`;
      appendTelemetry(cwd, { role: 'curator-worktree', command: cmd, decision: 'block', reason: `curator-worktree-read:${token}` });
      block(message);
      return;
    }
  }

  // Orchestrator-level Bash or non-df branch → pass-through silently.
  if (role === null) {
    appendTelemetry(cwd, { role: null, command: cmd, decision: 'pass-through', reason: 'orchestrator-or-unknown-cwd' });
    return;
  }

  // Layer 1.5: Slice-aware read guard — fires between curator-path block (Layer 1)
  // and per-role scope check (Layer 2). Prevents df-implement from reading files
  // outside its active slice, reducing unnecessary cache token consumption.
  const sliceGuard = checkSliceGuard(cmd, role, cwd);
  if (sliceGuard.blocked) {
    appendTelemetry(cwd, { role, command: cmd, decision: 'block', reason: 'slice-guard' });
    block(sliceGuard.message);
    return; // unreachable — block() exits, but makes logic explicit.
  }

  const scope = SCOPES[role];

  // Unknown role (future agent not yet in SCOPES) → defensive pass-through.
  if (!scope) {
    appendTelemetry(cwd, { role, command: cmd, decision: 'pass-through', reason: 'role-not-in-scopes' });
    return;
  }

  const { allow, denyOverride } = scope;

  // Step 1: denyOverride beats allow.
  if (denyOverride.length > 0 && matchesAny(denyOverride, cmd)) {
    const token = firstToken(cmd);

    // Distinguish curator-path leak (informational, points to escape hatch)
    // from generic denyOverride (operational scope violation).
    const isCuratorLeak = matchesAny(CURATOR_PATH_DENY, cmd);
    const message = isCuratorLeak
      ? `df-bash-scope: ${role} cannot read curator-only artefacts (specs/, .deepflow/maps/, decisions, checkpoint, config, CLAUDE.md). ` +
        `These are orchestrator inputs — your bundle is the only context source. ` +
        `If you need a file outside your bundle, emit "CONTEXT_INSUFFICIENT: <path>" on its own line and stop; ` +
        `the curator will augment your bundle and re-spawn.`
      : `df-bash-scope: \`${token}\` is outside ${role} scope. ` +
        `Command blocked by denyOverride rule.`;

    const reason = isCuratorLeak ? `curator-path:${token}` : `denyOverride:${token}`;
    appendTelemetry(cwd, { role, command: cmd, decision: 'block', reason });
    block(message);
    return; // unreachable — block() exits, but makes logic explicit.
  }

  // Step 2: allow list.
  if (allow.length > 0 && matchesAny(allow, cmd)) {
    appendTelemetry(cwd, { role, command: cmd, decision: 'allow' });
    return; // exit 0 via readStdinIfMain
  }

  // Step 3: default deny — command is not in allow list and not in denyOverride.
  const token = firstToken(cmd);
  const defaultDenyMsg =
    `df-bash-scope: \`${token}\` is not in the ${role} allow-list. ` +
    `Use only the commands permitted for this agent role.`;

  appendTelemetry(cwd, { role, command: cmd, decision: 'block', reason: `default-deny:${token}` });
  block(defaultDenyMsg);
});

// ---------------------------------------------------------------------------
// Exports (for unit tests — T112)
// ---------------------------------------------------------------------------

module.exports = {
  matchesAny,
  firstToken,
  appendTelemetry,
  loadActiveSlice,
  isFileInSlice,
  checkSliceGuard,
};
