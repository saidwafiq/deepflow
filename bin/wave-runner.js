#!/usr/bin/env node
/**
 * deepflow wave-runner
 * Parses PLAN.md, resolves dependency DAG, outputs tasks grouped by execution wave.
 *
 * Usage:
 *   node bin/wave-runner.js [--plan <path>] [--recalc --failed T{N}[,T{N}...]] [--json]
 *
 * Output (plain text):
 *   Wave 1: T1 — description, T4 — description
 *   Wave 2: T2 — description
 *   ...
 *
 * Output (--json): JSON array of task objects with wave number included.
 *
 * Exit codes: 0=success, 1=parse error
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { plan: 'PLAN.md', recalc: false, failed: [], json: false };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--plan' && argv[i + 1]) {
      args.plan = argv[++i];
    } else if (arg === '--recalc') {
      args.recalc = true;
    } else if (arg === '--failed' && argv[i + 1]) {
      // Accept comma-separated: --failed T3,T5 or space-separated: --failed T3 --failed T5
      const raw = argv[++i];
      args.failed.push(...raw.split(',').map(s => s.trim()).filter(Boolean));
    } else if (arg === '--json') {
      args.json = true;
    }
    i++;
  }
  return args;
}

// ---------------------------------------------------------------------------
// PLAN.md parser
// ---------------------------------------------------------------------------

/**
 * Extract pending tasks from PLAN.md text.
 * Returns array of { id, description, blockedBy: string[], model, files, effort, spec }
 *
 * Recognises lines like:
 *   - [ ] **T5**: Some description
 *   - [ ] **T5** [TAG]: Some description
 *
 * And subsequent annotation lines (order-independent):
 *   - Blocked by: T3, T7
 *   - Model: sonnet
 *   - Files: path/to/file.js, other/file.ts
 *   - Effort: high
 *
 * Spec name is extracted from the nearest preceding `### {spec-name}` header.
 */
function parsePlan(text) {
  const lines = text.split('\n');
  const tasks = [];
  let current = null;
  let currentSpec = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track ### section headers as spec names
    const specMatch = line.match(/^###\s+(.+)/);
    if (specMatch) {
      currentSpec = specMatch[1].trim();
      continue;
    }

    // Match pending task header: - [ ] **T{N}**...
    const taskMatch = line.match(/^\s*-\s+\[\s+\]\s+\*\*T(\d+)\*\*(?:\s+\[[^\]]*\])?[:\s]*(.*)/);
    if (taskMatch) {
      const rest = taskMatch[2].trim();

      // Extract inline blocked-by (from " | Blocked by: T1, T2")
      let inlineBlockedBy = [];
      let descPart = rest;
      const blockedInlineMatch = rest.match(/\s*\|\s*Blocked\s+by:\s+(.+)$/i);
      if (blockedInlineMatch) {
        descPart = rest.substring(0, rest.length - blockedInlineMatch[0].length).trim();
        inlineBlockedBy = blockedInlineMatch[1]
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(s => /^T\d+$/.test(s));
      }

      // Extract inline model/effort (from " — model/effort")
      let inlineModel = null;
      let inlineEffort = null;
      const modelInlineMatch = descPart.match(/\s*\u2014\s*(haiku|sonnet|opus)\/(low|medium|high)\s*$/i);
      if (modelInlineMatch) {
        descPart = descPart.substring(0, descPart.length - modelInlineMatch[0].length).trim();
        inlineModel = modelInlineMatch[1].toLowerCase();
        inlineEffort = modelInlineMatch[2].toLowerCase();
      }

      current = {
        id: `T${taskMatch[1]}`,
        num: parseInt(taskMatch[1], 10),
        description: descPart,
        blockedBy: inlineBlockedBy,
        model: inlineModel,
        files: null,
        effort: inlineEffort,
        spec: currentSpec,
      };
      tasks.push(current);
      continue;
    }

    // Match completed task — reset current so we don't attach annotations to wrong task
    const doneMatch = line.match(/^\s*-\s+\[x\]\s+/i);
    if (doneMatch) {
      current = null;
      continue;
    }

    if (current) {
      // Match "Blocked by:" annotation — only apply if inline parsing found no deps
      const blockedMatch = line.match(/^\s+-\s+Blocked\s+by:\s+(.+)/i);
      if (blockedMatch) {
        if (current.blockedBy.length === 0) {
          const deps = blockedMatch[1]
            .split(/[,\s]+/)
            .map(s => s.trim())
            .filter(s => /^T\d+$/.test(s));
          current.blockedBy.push(...deps);
        }
        continue;
      }

      // Match "Model:" annotation — only apply if inline parsing found no model
      const modelMatch = line.match(/^\s+-\s+Model:\s+(.+)/i);
      if (modelMatch) {
        if (current.model === null) {
          current.model = modelMatch[1].trim();
        }
        continue;
      }

      // Match "Files:" annotation — always apply (no inline equivalent)
      const filesMatch = line.match(/^\s+-\s+Files:\s+(.+)/i);
      if (filesMatch) {
        if (current.files === null) {
          current.files = filesMatch[1].trim();
        }
        continue;
      }

      // Match "Effort:" annotation — only apply if inline parsing found no effort
      const effortMatch = line.match(/^\s+-\s+Effort:\s+(.+)/i);
      if (effortMatch) {
        if (current.effort === null) {
          current.effort = effortMatch[1].trim();
        }
        continue;
      }
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// DAG → waves (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Topological sort into waves.
 * Tasks with no unmet deps form wave 1; their dependents (once all deps resolved) form wave 2, etc.
 *
 * @param {Array} tasks — full task list (all pending)
 * @param {Set<string>} stuckIds — IDs to treat as "not ready" regardless of deps
 * @returns {Array<Array>} waves — each element is an array of task objects
 */
function buildWaves(tasks, stuckIds) {
  // Index by id for quick lookup
  const byId = new Map(tasks.map(t => [t.id, t]));

  // Only consider deps that actually exist in the pending task list
  // (completed tasks are already satisfied by definition)
  // For stuck tasks: they remain unresolved, blocking dependents
  const pendingIds = new Set(tasks.map(t => t.id));

  // Compute in-degree considering only pending→pending edges
  // Stuck tasks have their in-degree treated as unresolvable
  const inDeg = new Map();
  const dependents = new Map(); // id → list of tasks that depend on it

  for (const t of tasks) {
    if (!inDeg.has(t.id)) inDeg.set(t.id, 0);
    if (!dependents.has(t.id)) dependents.set(t.id, []);

    for (const dep of t.blockedBy) {
      if (pendingIds.has(dep)) {
        // dep is still pending — this is a real blocking edge
        inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1);
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(t.id);
      }
      // If dep is not in pending list (i.e., completed), edge is already satisfied
    }
  }

  // Mark stuck tasks: treat as if they can never be resolved
  // Their transitive dependents will not appear in any wave
  const blocked = new Set(stuckIds);

  // BFS to find all transitive dependents of stuck tasks
  const stuckQueue = [...stuckIds].filter(id => pendingIds.has(id));
  const visited = new Set(stuckQueue);
  let qi = 0;
  while (qi < stuckQueue.length) {
    const sid = stuckQueue[qi++];
    for (const dep of (dependents.get(sid) || [])) {
      if (!visited.has(dep)) {
        visited.add(dep);
        blocked.add(dep);
        stuckQueue.push(dep);
      }
    }
  }

  // Kahn's BFS for remaining (non-blocked) tasks
  const waves = [];
  // Ready = in-degree 0 and not blocked
  let ready = tasks.filter(t => !blocked.has(t.id) && inDeg.get(t.id) === 0);

  // Sort deterministically within each wave by task number
  ready.sort((a, b) => a.num - b.num);

  const resolved = new Set();

  while (ready.length > 0) {
    waves.push([...ready]);
    const nextReady = [];

    for (const t of ready) {
      resolved.add(t.id);
      for (const depId of (dependents.get(t.id) || [])) {
        if (blocked.has(depId)) continue;
        const newDeg = (inDeg.get(depId) || 0) - 1;
        inDeg.set(depId, newDeg);
        if (newDeg === 0) {
          nextReady.push(byId.get(depId));
        }
      }
    }

    nextReady.sort((a, b) => a.num - b.num);
    ready = nextReady;
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

/**
 * Format waves as a JSON array of task objects, each with a `wave` field.
 * Fields: id, description, model, files, effort, blockedBy, spec, wave
 */
function formatWavesJson(waves) {
  const result = [];
  for (let i = 0; i < waves.length; i++) {
    const waveNum = i + 1;
    for (const t of waves[i]) {
      result.push({
        id: t.id,
        description: t.description || null,
        model: t.model || null,
        files: t.files || null,
        effort: t.effort || null,
        blockedBy: t.blockedBy,
        spec: t.spec || null,
        wave: waveNum,
      });
    }
  }
  return JSON.stringify(result, null, 2);
}

function formatWaves(waves) {
  if (waves.length === 0) {
    return '(no pending tasks)';
  }

  const lines = [];
  for (let i = 0; i < waves.length; i++) {
    const waveNum = i + 1;
    const taskParts = waves[i].map(t => {
      const desc = t.description ? ` — ${t.description}` : '';
      return `${t.id}${desc}`;
    });
    lines.push(`Wave ${waveNum}: ${taskParts.join(', ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  // Resolve plan path: relative to cwd
  const planPath = path.resolve(process.cwd(), args.plan);

  if (!fs.existsSync(planPath)) {
    process.stderr.write(`wave-runner: PLAN.md not found at ${planPath}\n`);
    process.exit(1);
  }

  let text;
  try {
    text = fs.readFileSync(planPath, 'utf8');
  } catch (err) {
    process.stderr.write(`wave-runner: failed to read ${planPath}: ${err.message}\n`);
    process.exit(1);
  }

  let tasks;
  try {
    tasks = parsePlan(text);
  } catch (err) {
    process.stderr.write(`wave-runner: parse error: ${err.message}\n`);
    process.exit(1);
  }

  const stuckIds = new Set(args.recalc ? args.failed : []);

  const waves = buildWaves(tasks, stuckIds);
  const output = args.json ? formatWavesJson(waves) : formatWaves(waves);

  process.stdout.write(output + '\n');
  process.exit(0);
}

main();
