#!/usr/bin/env node
/**
 * deepflow plan-consolidator
 * Reads mini-plan files from a directory, renumbers T-ids globally, detects
 * cross-spec file conflicts, and outputs a consolidated tasks section to stdout.
 *
 * Usage:
 *   node bin/plan-consolidator.js --plans-dir .deepflow/plans/
 *
 * Output: consolidated tasks markdown (tasks section only) to stdout
 * Input mini-plan files are NEVER modified.
 *
 * Exit codes: 0=success, 1=error
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { plansDir: null, specsDir: null };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--plans-dir' && argv[i + 1]) {
      args.plansDir = argv[++i];
    } else if (arg === '--specs-dir' && argv[i + 1]) {
      args.specsDir = argv[++i];
    }
    i++;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Mini-plan parser
// ---------------------------------------------------------------------------

/**
 * Parse tasks from a single mini-plan file.
 * Returns array of { localId, num, description, tags, blockedBy, files, rawLines }
 *
 * Recognises task header lines like:
 *   - [ ] **T1**: description
 *   - [ ] **T1** [tag]: description
 *
 * And annotation lines immediately following (indented):
 *   - Files: file1, file2
 *   - Blocked by: T1, T2
 */
function parseMiniPlan(text) {
  const lines = text.split('\n');
  const tasks = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match pending task header: - [ ] **T{N}**...
    const taskMatch = line.match(/^\s*-\s+\[\s+\]\s+\*\*T(\d+)\*\*(\s+\[[^\]]*\])?[:\s]*(.*)/);
    if (taskMatch) {
      current = {
        localId: `T${taskMatch[1]}`,
        num: parseInt(taskMatch[1], 10),
        description: taskMatch[3].trim(),
        tags: taskMatch[2] ? taskMatch[2].trim() : '',
        blockedBy: [],   // local T-ids
        files: [],
        rawLine: line,   // original header line (for reference)
      };
      tasks.push(current);
      continue;
    }

    // Completed task — reset current so annotations don't bleed
    const doneMatch = line.match(/^\s*-\s+\[x\]\s+/i);
    if (doneMatch) {
      current = null;
      continue;
    }

    if (current) {
      // Match "Blocked by:" annotation
      const blockedMatch = line.match(/^\s+-\s+Blocked\s+by:\s+(.+)/i);
      if (blockedMatch) {
        const deps = blockedMatch[1]
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(s => /^T\d+$/.test(s));
        current.blockedBy.push(...deps);
        continue;
      }

      // Match "Files:" annotation
      const filesMatch = line.match(/^\s+-\s+Files?:\s+(.+)/i);
      if (filesMatch) {
        const fileList = filesMatch[1]
          .split(/,\s*/)
          .map(s => s.trim())
          .filter(Boolean);
        current.files.push(...fileList);
        continue;
      }
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Cross-spec file-conflict detection
// ---------------------------------------------------------------------------

/**
 * Given a list of spec entries { specName, tasks }, build a map of
 * filename → [specName, ...] for files touched by more than one spec.
 *
 * Returns Map<filename, string[]>
 */
function detectFileConflicts(specEntries) {
  // Map: filename → set of spec names that touch it
  const fileToSpecs = new Map();

  for (const { specName, tasks } of specEntries) {
    for (const task of tasks) {
      for (const file of task.files) {
        if (!fileToSpecs.has(file)) fileToSpecs.set(file, new Set());
        fileToSpecs.get(file).add(specName);
      }
    }
  }

  // Keep only files touched by 2+ specs
  const conflicts = new Map();
  for (const [file, specs] of fileToSpecs) {
    if (specs.size > 1) {
      conflicts.set(file, [...specs]);
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Consolidate all spec entries into a globally renumbered task list.
 *
 * Rules:
 * - T-ids are renumbered globally in spec-file order, then task-num order.
 * - "Blocked by" references within a spec are remapped to global ids
 *   (chain-only: no cross-spec blocking is added).
 * - Cross-spec file conflicts get [file-conflict: {filename}] annotations
 *   on the tasks that touch conflicted files.
 *
 * Returns array of consolidated task objects:
 *   { globalId, specName, description, tags, blockedBy (global), files, conflictAnnotations }
 */
function consolidate(specEntries, fileConflicts) {
  let globalCounter = 0;
  const consolidated = [];

  for (const { specName, tasks } of specEntries) {
    // Build local→global id map for this spec
    const localToGlobal = new Map();
    for (const task of tasks) {
      globalCounter++;
      localToGlobal.set(task.localId, `T${globalCounter}`);
    }

    for (const task of tasks) {
      const globalId = localToGlobal.get(task.localId);

      // Remap blocked-by to global ids (chain-only: only remap refs that exist
      // in this spec's local map; cross-spec refs are silently dropped)
      const globalBlockedBy = task.blockedBy
        .filter(dep => localToGlobal.has(dep))
        .map(dep => localToGlobal.get(dep));

      // Detect which of this task's files are in conflict
      const conflictAnnotations = task.files
        .filter(f => fileConflicts.has(f))
        .map(f => `[file-conflict: ${f}]`);

      consolidated.push({
        globalId,
        specName,
        description: task.description,
        tags: task.tags,
        blockedBy: globalBlockedBy,
        files: task.files,
        conflictAnnotations,
      });
    }
  }

  return consolidated;
}

// ---------------------------------------------------------------------------
// Output formatter
// ---------------------------------------------------------------------------

/**
 * Render consolidated tasks as PLAN.md-compatible markdown.
 * Groups tasks under ### doing-{specName} headings with a details reference line.
 * One line per task — no sub-bullets. Files omitted (live in mini-plans only).
 * Compatible with wave-runner's parsePlan regex (see wave-runner.js parsePlan).
 */
function formatConsolidated(consolidated) {
  if (consolidated.length === 0) {
    return '## Tasks\n\n(no tasks found)\n';
  }

  const lines = ['## Tasks\n'];
  let lastSpec = null;

  for (const task of consolidated) {
    if (task.specName !== lastSpec) {
      // Close previous spec with trailing blank line (already added after last task)
      const doingName = `doing-${task.specName}`;
      const planPath = `.deepflow/plans/${doingName}.md`;
      lines.push(`### ${doingName}\n`);
      lines.push(`> Details: [\`${planPath}\`](${planPath})\n`);
      lastSpec = task.specName;
    }

    // Task header line — one line, no sub-bullets
    const tagPart = task.tags ? ` ${task.tags}` : '';
    // Append conflict annotations to description if any
    const conflictPart = task.conflictAnnotations.length > 0
      ? ' ' + task.conflictAnnotations.join(' ')
      : '';
    const descPart = (task.description + conflictPart).trim();
    const headerDesc = descPart ? `: ${descPart}` : '';

    // Blocked by suffix — omit entirely when empty
    const blockedSuffix = task.blockedBy.length > 0
      ? ` | Blocked by: ${task.blockedBy.join(', ')}`
      : '';

    lines.push(`- [ ] **${task.globalId}**${tagPart}${headerDesc}${blockedSuffix}`);
  }

  // Trailing newline after last task
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  if (!args.plansDir) {
    process.stderr.write('plan-consolidator: --plans-dir <path> is required\n');
    process.exit(1);
  }

  const plansDir = path.resolve(process.cwd(), args.plansDir);

  if (!fs.existsSync(plansDir)) {
    process.exit(0);
  }

  // Collect mini-plan files: doing-{name}.md, sorted alphabetically for determinism
  let entries;
  try {
    entries = fs.readdirSync(plansDir)
      .filter(f => f.startsWith('doing-') && f.endsWith('.md'))
      .sort();
  } catch (err) {
    process.stderr.write(`plan-consolidator: failed to read plans dir: ${err.message}\n`);
    process.exit(1);
  }

  // Stale-filter: when --specs-dir is set, remove mini-plans whose corresponding
  // spec file does not exist in specsDir
  if (args.specsDir) {
    const specsDir = path.resolve(process.cwd(), args.specsDir);
    entries = entries.filter(filename => {
      const specPath = path.join(specsDir, filename);
      if (!fs.existsSync(specPath)) {
        process.stderr.write(
          `plan-consolidator: skipping stale mini-plan ${filename} (no matching spec in ${args.specsDir})\n`
        );
        return false;
      }
      return true;
    });
  }

  if (entries.length === 0) {
    process.stdout.write('## Tasks\n\n(no mini-plan files found in ' + plansDir + ')\n');
    process.exit(0);
  }

  // Parse each mini-plan (read-only — files are never modified)
  const specEntries = [];
  for (const filename of entries) {
    const filePath = path.join(plansDir, filename);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(`plan-consolidator: failed to read ${filePath}: ${err.message}\n`);
      process.exit(1);
    }

    // Derive spec name from filename: doing-{name}.md → {name}
    const specName = filename.replace(/^doing-/, '').replace(/\.md$/, '');
    const tasks = parseMiniPlan(text);
    specEntries.push({ specName, tasks, filePath });
  }

  // Detect cross-spec file conflicts (read phase complete — no more file I/O on inputs)
  const fileConflicts = detectFileConflicts(specEntries);

  if (fileConflicts.size > 0) {
    process.stderr.write(
      `plan-consolidator: ${fileConflicts.size} file conflict(s) detected:\n`
    );
    for (const [file, specs] of fileConflicts) {
      process.stderr.write(`  ${file}: ${specs.join(', ')}\n`);
    }
  }

  // Consolidate: renumber T-ids globally, remap blocking, annotate conflicts
  const consolidated = consolidate(specEntries, fileConflicts);

  // Render and emit to stdout
  const output = formatConsolidated(consolidated);
  process.stdout.write(output);
  process.exit(0);
}

main();
