#!/usr/bin/env node
/**
 * @file bin/migrate-legacy-plan.js
 * @description Best-effort migrator from the legacy AI-loop layout
 *              (PLAN.md + .deepflow/plans/doing-{spec}.md per-spec mini-plans)
 *              to the curator-pattern layout where tasks live inline in the
 *              spec under `## Tasks (curated)`.
 *
 * Per specs/deprecate-plan-auto.md REQ-9 — converts each `doing-{spec}.md`
 * mini-plan into a curated `## Tasks (curated)` block appended to
 * `specs/doing-{spec}.md` (or `specs/{spec}.md` if no doing- exists yet).
 *
 * Best-effort:
 *   - Files / ACs / Steps from the legacy task become the Slice / Subagent
 *     prompt.
 *   - Blocked by edges carry over.
 *   - Context bundles are emitted as placeholders. THE CURATOR (you, when
 *     editing the spec) MUST populate these before /df:execute can run —
 *     subagents are forced-fed file content via the bundle and have no
 *     Read/Grep/Glob (per specs/subagent-toolset-restriction.md).
 *
 * Usage:
 *   node bin/migrate-legacy-plan.js                   # migrate all doing-* plans
 *   node bin/migrate-legacy-plan.js --spec NAME       # migrate one
 *   node bin/migrate-legacy-plan.js --plans-dir DIR   # override .deepflow/plans
 *   node bin/migrate-legacy-plan.js --specs-dir DIR   # override specs/
 *   node bin/migrate-legacy-plan.js --dry-run         # print intended writes
 *
 * Exits 0 if at least one spec was updated or already migrated; 1 on error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CURATED_HEADER = '## Tasks (curated)';

function parseArgs(argv) {
  const args = { spec: null, plansDir: null, specsDir: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--spec') args.spec = argv[++i];
    else if (a === '--plans-dir') args.plansDir = argv[++i];
    else if (a === '--specs-dir') args.specsDir = argv[++i];
  }
  return args;
}

function listLegacyPlans(plansDir) {
  if (!fs.existsSync(plansDir)) return [];
  return fs
    .readdirSync(plansDir)
    .filter((f) => f.startsWith('doing-') && f.endsWith('.md'))
    .map((f) => ({
      file: path.join(plansDir, f),
      specName: f.slice('doing-'.length, -'.md'.length),
    }));
}

function findSpecFile(specsDir, specName) {
  for (const prefix of ['doing-', '', 'done-']) {
    const candidate = path.join(specsDir, `${prefix}${specName}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Slice between `## Tasks` and the next `## ` heading (or EOF).
 * Avoids JS-regex's lack of `\z` by composing two anchored matches.
 */
function extractTasksBody(planContent) {
  const startMatch = planContent.match(/^## Tasks\s*$/m);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  const tail = planContent.slice(startIdx);
  const nextSection = tail.match(/^## /m);
  return nextSection ? tail.slice(0, nextSection.index) : tail;
}

/**
 * Capture the indented step list under `- Steps:` — terminates at the next
 * `- WORD:` field (siblings are Model / Effort / Blocked by) or end of block.
 */
function extractStepsBlock(taskBlock) {
  const startMatch = taskBlock.match(/^\s+-\s+Steps:\s*$/m);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  const tail = taskBlock.slice(startIdx);
  const nextField = tail.match(/^\s+-\s+\w+:/m);
  return nextField ? tail.slice(0, nextField.index) : tail;
}

/**
 * Parse a legacy `## Tasks` block into structured task objects.
 * Returns [{ id, title, reqRefs, files, acs, steps, blockedBy, parallel }, ...].
 */
function parseLegacyTasks(planContent) {
  const body = extractTasksBody(planContent);
  if (body === null) return [];

  const tasks = [];
  // Split on `- [ ] **TN**` headers; each task is one such block.
  const taskBlocks = body.split(/(?=^- \[[ x]\] \*\*T\d+\*\*)/m).filter((b) => b.trim());

  for (const block of taskBlocks) {
    const headerMatch = block.match(
      /^- \[[ x]\] \*\*T(\d+)\*\*(\s*\[P\])?\s*:\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/m
    );
    if (!headerMatch) continue;

    const id = `T${headerMatch[1]}`;
    const parallel = !!headerMatch[2];
    const title = headerMatch[3].trim();
    const reqRefs = (headerMatch[4] || '')
      .split(/[,\s]+/)
      .filter((s) => /^REQ-\d+/.test(s));

    const fieldVal = (label) => {
      const re = new RegExp(`^\\s+-\\s+${label}:\\s*(.+)$`, 'm');
      const m = block.match(re);
      return m ? m[1].trim() : null;
    };

    const files = (fieldVal('Files') || '')
      .split(',')
      .map((s) => s.replace(/`/g, '').trim())
      .filter(Boolean);
    const acs = (fieldVal('ACs') || '')
      .split(/[,\s]+/)
      .filter((s) => /^AC-\d+/.test(s));

    const stepsBody = extractStepsBlock(block);
    const steps = stepsBody
      ? stepsBody
          .split('\n')
          .map((l) => l.replace(/^\s+\d+\.\s*/, '').trim())
          .filter(Boolean)
      : [];

    const blockedByRaw = fieldVal('Blocked by');
    const blockedBy =
      blockedByRaw && blockedByRaw.toLowerCase() !== 'none'
        ? blockedByRaw
            .split(/[,\s]+/)
            .filter((s) => /^T\d+$/.test(s))
        : [];

    tasks.push({ id, title, reqRefs, files, acs, steps, blockedBy, parallel });
  }

  return tasks;
}

function renderCuratedTask(task) {
  const lines = [];
  lines.push(`### ${task.id}: ${task.title}`);

  if (task.files.length > 0) {
    lines.push(`**Slice:** ${task.files.join(', ')}`);
  } else {
    lines.push('**Slice:** <!-- TODO: list the files this task changes -->');
  }

  if (task.blockedBy.length > 0) {
    lines.push(`**Parallel:** Blocked by: ${task.blockedBy.join(', ')}`);
  } else if (task.parallel) {
    lines.push('**Parallel:** [P]');
  } else {
    lines.push('**Parallel:** <!-- [P] if disjoint from siblings, else "Blocked by: TN" -->');
  }

  lines.push('**Context bundle:**');
  lines.push('<!-- TODO (curator): replace this placeholder with inline file');
  lines.push('     content for every file the subagent must read. The curator');
  lines.push('     pattern force-feeds context — subagents have no Read/Grep/Glob.');
  lines.push("     Bundle each file in a fenced block titled '# file: <path>'. -->");

  lines.push('**Subagent prompt:**');
  if (task.steps.length > 0) {
    lines.push('> ' + task.steps.map((s) => s.replace(/\n/g, ' ')).join('\n> '));
  } else {
    lines.push(`> ${task.title}`);
  }
  if (task.acs.length > 0) {
    lines.push(`> Covers: ${task.acs.join(', ')}.`);
  }
  if (task.reqRefs.length > 0) {
    lines.push(`> REQ refs: ${task.reqRefs.join(', ')}.`);
  }
  lines.push(
    '> CRITICAL: do not use Read/Grep/Glob. Everything you need is in the bundle above.'
  );
  lines.push(
    '> If something is missing, output `CONTEXT_INSUFFICIENT: <file>` and stop.'
  );

  return lines.join('\n');
}

function buildCuratedSection(tasks, specName) {
  const out = [];
  out.push(CURATED_HEADER);
  out.push('');
  out.push(
    `<!-- Migrated from legacy .deepflow/plans/doing-${specName}.md by bin/migrate-legacy-plan.js.`
  );
  out.push(
    '     Review every Slice / Parallel / Context bundle before running /df:execute.'
  );
  out.push(
    '     Context bundles are placeholders — the curator must populate inline file content. -->'
  );
  out.push('');
  for (const t of tasks) {
    out.push(renderCuratedTask(t));
    out.push('');
  }
  return out.join('\n');
}

function migrateOne({ specName, planFile, specsDir, dryRun }) {
  const specFile = findSpecFile(specsDir, specName);
  if (!specFile) {
    return {
      specName,
      status: 'skipped',
      reason: `no specs/{,doing-,done-}${specName}.md found`,
    };
  }

  const specContent = fs.readFileSync(specFile, 'utf8');
  if (specContent.includes(CURATED_HEADER)) {
    return { specName, status: 'already-migrated', specFile };
  }

  const planContent = fs.readFileSync(planFile, 'utf8');
  const tasks = parseLegacyTasks(planContent);
  if (tasks.length === 0) {
    return {
      specName,
      status: 'skipped',
      reason: `legacy plan ${planFile} has no parseable ## Tasks section`,
    };
  }

  const section = buildCuratedSection(tasks, specName);
  const newContent = specContent.replace(/\s*$/, '') + '\n\n' + section + '\n';

  if (dryRun) {
    return { specName, status: 'dry-run', specFile, taskCount: tasks.length, preview: section };
  }

  fs.writeFileSync(specFile, newContent, 'utf8');
  return { specName, status: 'migrated', specFile, taskCount: tasks.length };
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const plansDir = args.plansDir || path.join(repoRoot, '.deepflow', 'plans');
  const specsDir = args.specsDir || path.join(repoRoot, 'specs');

  let plans = listLegacyPlans(plansDir);
  if (args.spec) {
    plans = plans.filter((p) => p.specName === args.spec);
    if (plans.length === 0) {
      process.stderr.write(
        `[migrate-legacy-plan] no doing-${args.spec}.md found under ${plansDir}\n`
      );
      process.exit(1);
    }
  }

  if (plans.length === 0) {
    process.stdout.write(
      `[migrate-legacy-plan] no legacy plans found under ${plansDir} — nothing to migrate.\n`
    );
    return 0;
  }

  let migrated = 0;
  let alreadyDone = 0;
  let skipped = 0;

  for (const { specName, file } of plans) {
    const result = migrateOne({
      specName,
      planFile: file,
      specsDir,
      dryRun: args.dryRun,
    });
    if (result.status === 'migrated') {
      migrated++;
      process.stdout.write(
        `[migrate-legacy-plan] migrated ${result.taskCount} task(s) → ${path.relative(repoRoot, result.specFile)}\n`
      );
    } else if (result.status === 'dry-run') {
      process.stdout.write(
        `[migrate-legacy-plan] (dry-run) would migrate ${result.taskCount} task(s) → ${path.relative(repoRoot, result.specFile)}\n`
      );
      process.stdout.write('--- begin preview ---\n' + result.preview + '\n--- end preview ---\n');
    } else if (result.status === 'already-migrated') {
      alreadyDone++;
      process.stdout.write(
        `[migrate-legacy-plan] ${path.relative(repoRoot, result.specFile)} already has ${CURATED_HEADER} — skipped\n`
      );
    } else {
      skipped++;
      process.stderr.write(
        `[migrate-legacy-plan] SKIP ${specName}: ${result.reason}\n`
      );
    }
  }

  process.stdout.write(
    `\n[migrate-legacy-plan] ${migrated} migrated, ${alreadyDone} already-curated, ${skipped} skipped.\n`
  );
  if (migrated > 0) {
    process.stdout.write(
      '[migrate-legacy-plan] NEXT: review each spec\'s ## Tasks (curated) section.\n'
    );
    process.stdout.write(
      '[migrate-legacy-plan]   Context bundles are TODO placeholders — populate inline file content before /df:execute.\n'
    );
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`[migrate-legacy-plan] error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseLegacyTasks, renderCuratedTask, buildCuratedSection };
