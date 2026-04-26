#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: deepflow
/**
 * deepflow validate-tasks-gates hook
 * Gates PLAN.md writes with deterministic checks:
 *   Gate A — granularity (verb count, file count, LOC budget)
 *   Gate B — blocking-edge validity (cycles, dangling refs, reverse-order edges)
 *   Gate C — test co-location (embedded tests, paired test-first, no deferral)
 *
 * Usage (hook):  stdin JSON PreToolUse event → stdout permissionDecision JSON
 * Usage (module): const { parsePlan, gateA, gateB, gateC } = require('./df-validate-tasks-gates');
 */

'use strict';

const { readStdinIfMain } = require('./lib/hook-stdin');

// ── Tunable constants (implementation contract for AC-1 and AC-2) ────────────
const LOC_BUDGET = 150;   // AC-2: max estimated LOC per task
const MAX_FILES  = 1;     // AC-2: max target files per task
const MAX_VERBS  = 1;     // AC-1: max action verbs in task title

// ── Verb whitelist used by Gate A ─────────────────────────────────────────────
// Common action verbs that indicate units of work. A title containing more than
// MAX_VERBS of these (when joined by "and"/"then"/",") signals a compound task.
const ACTION_VERBS = [
  'implement', 'add', 'create', 'write', 'build', 'scaffold', 'generate',
  'update', 'refactor', 'fix', 'remove', 'delete', 'migrate', 'extract',
  'replace', 'rename', 'move', 'test', 'verify', 'validate', 'configure',
  'integrate', 'connect', 'wire', 'deploy', 'expose', 'parse', 'emit',
  'register', 'enable', 'disable', 'support', 'extend', 'convert',
];

// ── Tests: none whitelist (Gate C) ───────────────────────────────────────────
const TESTS_NONE_WHITELIST = [
  'pure refactor',
  'doc edit',
  'config-only',
  'generated code',
];

// ── PLAN.md path matcher ──────────────────────────────────────────────────────
const PLAN_FILE_RE = /(?:^|\/)PLAN\.md$/;

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse PLAN.md content into an array of task records.
 *
 * Each record:
 *   {
 *     id: 'T1',
 *     num: 1,
 *     title: string,
 *     files: string[],    // parsed from "Files: ..." line
 *     loc: number|null,   // parsed from "LOC: ..." line
 *     tests: string|null, // raw value after "Tests: "
 *     blockedBy: string[] // e.g. ['T1', 'T2']
 *   }
 *
 * Handles both `## T1:` and `- [ ] **T1**:` header styles.
 */
function parsePlan(content) {
  const lines = content.split('\n');
  const tasks = [];
  let current = null;

  // Regex to detect a task header in either format:
  //   ## T1: title
  //   - [ ] **T1**: title   or   - [x] **T1**: title
  const TASK_HEADER_RE = /^(?:#{1,3}\s+\*{0,2}(T\d+)\*{0,2}[:\s]|[-*]\s+\[[ x]\]\s+\*{0,2}(T\d+)\*{0,2}[:\s])(.*)/i;

  for (const line of lines) {
    const hm = line.match(TASK_HEADER_RE);
    if (hm) {
      // Push previous task before starting a new one
      if (current) tasks.push(current);
      const rawId = (hm[1] || hm[2]).toUpperCase();
      const num = parseInt(rawId.replace('T', ''), 10);
      const title = (hm[3] || '').replace(/\*+/g, '').trim();
      current = { id: rawId, num, title, files: [], loc: null, tests: null, blockedBy: [] };
      continue;
    }

    if (!current) continue;

    // Files: field
    const filesM = line.match(/^\s*-?\s*Files:\s*(.+)/i);
    if (filesM) {
      // Split on comma, trim whitespace, filter empties
      current.files = filesM[1].split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }

    // LOC: field
    const locM = line.match(/^\s*-?\s*LOC:\s*(\d+)/i);
    if (locM) {
      current.loc = parseInt(locM[1], 10);
      continue;
    }

    // Tests: field — capture full value after "Tests:"
    const testsM = line.match(/^\s*-?\s*Tests:\s*(.+)/i);
    if (testsM) {
      current.tests = testsM[1].trim();
      continue;
    }

    // Blocked by: field — extract all T\d+ references
    const blockedM = line.match(/^\s*-?\s*Blocked\s+by:\s*(.+)/i);
    if (blockedM) {
      const raw = blockedM[1];
      // 'none' means no blockers
      if (/^\s*none\s*$/i.test(raw)) {
        current.blockedBy = [];
      } else {
        current.blockedBy = (raw.match(/T\d+/gi) || []).map(t => t.toUpperCase());
      }
      continue;
    }
  }

  if (current) tasks.push(current);
  return tasks;
}

// ── Gate A — Granularity ──────────────────────────────────────────────────────

/**
 * Count action verbs in a task title.
 * Splits on common compound connectors (and, then, comma) before counting.
 */
function countVerbs(title) {
  const lower = title.toLowerCase();
  // Split title on connectors to isolate clauses, then count verb hits per clause
  const clauses = lower.split(/\s+(?:and|then|&)\s+|,\s*/);
  const verbsFound = [];
  for (const clause of clauses) {
    for (const verb of ACTION_VERBS) {
      // Match verb as a whole word at the start of a clause or following whitespace
      const verbRe = new RegExp(`(?:^|\\s)${verb}(?:s|d|ed|ing)?(?:\\s|$)`);
      if (verbRe.test(clause) && !verbsFound.includes(verb)) {
        verbsFound.push(verb);
      }
    }
  }
  return verbsFound.length;
}

/**
 * Gate A: granularity checks.
 * Returns array of violation objects (empty = pass).
 */
function gateA(tasks) {
  const violations = [];

  for (const task of tasks) {
    // A-VERB: title contains more than MAX_VERBS action verbs
    const verbCount = countVerbs(task.title);
    if (verbCount > MAX_VERBS) {
      violations.push({
        gate: 'A-VERB',
        taskId: task.id,
        reason: `Title contains ${verbCount} action verbs (max ${MAX_VERBS}): "${task.title}"`,
        suggestion: `Split "${task.id}" into separate tasks, one verb per task.`,
      });
    }

    // A-SCOPE: more than MAX_FILES files or LOC > LOC_BUDGET
    if (task.files.length > MAX_FILES) {
      violations.push({
        gate: 'A-SCOPE',
        taskId: task.id,
        reason: `Task declares ${task.files.length} files (max ${MAX_FILES}): ${task.files.join(', ')}`,
        suggestion: `Split "${task.id}" so each task touches at most ${MAX_FILES} file(s).`,
      });
    }
    if (task.loc !== null && task.loc > LOC_BUDGET) {
      violations.push({
        gate: 'A-SCOPE',
        taskId: task.id,
        reason: `Task estimates ${task.loc} LOC (budget ${LOC_BUDGET})`,
        suggestion: `Break "${task.id}" into smaller tasks each under ${LOC_BUDGET} LOC.`,
      });
    }
  }

  return violations;
}

// ── Gate B — Edge Validation ──────────────────────────────────────────────────

/**
 * Gate B: blocking-edge validity.
 * Checks for cycles (B-CYCLE), dangling references (B-DANGLING),
 * and reverse-order edges (B-REVERSE).
 * Returns array of violation objects.
 */
function gateB(tasks) {
  const violations = [];
  const taskIds = new Set(tasks.map(t => t.id));

  // B-DANGLING: blocker references a task id that does not exist
  for (const task of tasks) {
    for (const blocker of task.blockedBy) {
      if (!taskIds.has(blocker)) {
        violations.push({
          gate: 'B-DANGLING',
          taskId: task.id,
          reason: `"Blocked by: ${blocker}" references a task that does not exist`,
          suggestion: `Remove or correct the reference to ${blocker} in ${task.id}.`,
        });
      }
    }
  }

  // B-REVERSE: Tn blocked by Tm where m > n (higher number blocks lower)
  for (const task of tasks) {
    for (const blocker of task.blockedBy) {
      if (!taskIds.has(blocker)) continue; // already reported as dangling
      const blockerNum = parseInt(blocker.replace('T', ''), 10);
      if (blockerNum > task.num) {
        violations.push({
          gate: 'B-REVERSE',
          taskId: task.id,
          reason: `${task.id} (index ${task.num}) is blocked by ${blocker} (index ${blockerNum}), which has a higher task number`,
          suggestion: `Reorder tasks so ${blocker} comes before ${task.id}, or renumber them.`,
        });
      }
    }
  }

  // B-CYCLE: detect cycles using Kahn's topological sort algorithm
  // Build adjacency list: task → tasks it blocks (reverse of blockedBy)
  const inDegree = {};
  const dependents = {}; // dependents[T] = list of tasks that T must complete before
  for (const task of tasks) {
    inDegree[task.id] = inDegree[task.id] || 0;
    dependents[task.id] = dependents[task.id] || [];
  }
  for (const task of tasks) {
    for (const blocker of task.blockedBy) {
      if (!taskIds.has(blocker)) continue; // skip dangling
      dependents[blocker].push(task.id);
      inDegree[task.id] = (inDegree[task.id] || 0) + 1;
    }
  }

  const queue = tasks.filter(t => (inDegree[t.id] || 0) === 0).map(t => t.id);
  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    processed++;
    for (const dependent of (dependents[current] || [])) {
      inDegree[dependent]--;
      if (inDegree[dependent] === 0) {
        queue.push(dependent);
      }
    }
  }

  if (processed < tasks.length) {
    // Nodes remaining in the graph after Kahn's are part of cycles
    const cycleMembers = tasks
      .filter(t => (inDegree[t.id] || 0) > 0)
      .map(t => t.id);
    violations.push({
      gate: 'B-CYCLE',
      taskId: cycleMembers.join(', '),
      reason: `Cycle detected in "Blocked by" graph among tasks: ${cycleMembers.join(', ')}`,
      suggestion: `Break the cycle by removing one of the blocking edges between: ${cycleMembers.join(', ')}.`,
    });
  }

  return violations;
}

// ── Gate C — Test Co-location ─────────────────────────────────────────────────

/**
 * Determine whether a task is a production-code task (not pure test/spike/doc).
 * Production tasks are those that touch .js/.ts/.go/.py etc. source files,
 * but not exclusively test files.
 */
function isProductionTask(task) {
  if (task.files.length === 0) return false;
  const testFileRe = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|\.test\.js$/i;
  const hasNonTest = task.files.some(f => !testFileRe.test(f));
  return hasNonTest;
}

/**
 * Gate C: test co-location checks.
 * Returns array of violation objects.
 */
function gateC(tasks) {
  const violations = [];
  const taskIds = new Set(tasks.map(t => t.id));

  // Build a set of tasks that are test-first tasks (all files are test files)
  // and collect which production tasks they block (via dependents)
  const testFirstTaskIds = new Set();
  for (const task of tasks) {
    if (task.files.length === 0) continue;
    const testFileRe = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|\.test\.js$/i;
    const allTest = task.files.every(f => testFileRe.test(f));
    if (allTest) testFirstTaskIds.add(task.id);
  }

  for (const task of tasks) {
    if (!isProductionTask(task)) continue;

    const testsVal = task.tests;

    // C-DEFERRED: "Tests: in another task" (any deferral variant) — always reject
    if (testsVal !== null) {
      const lower = testsVal.toLowerCase();
      if (
        lower.includes('in another task') ||
        lower.includes('deferred') ||
        lower.includes('separate task') ||
        lower.includes('later') ||
        lower.includes('tbd') ||
        lower.includes('todo')
      ) {
        violations.push({
          gate: 'C-DEFERRED',
          taskId: task.id,
          reason: `Tests deferred: "${testsVal}" — deferring test co-location is not allowed`,
          suggestion: `Add an embedded Tests: block or pair ${task.id} with a test-first task using "Blocked by: T{test-task-id}".`,
        });
        continue;
      }

      // Tests: none — require whitelist justification
      if (/^none\b/i.test(testsVal)) {
        const justification = testsVal.replace(/^none[:\s-]*/i, '').trim().toLowerCase();
        const whitelisted = TESTS_NONE_WHITELIST.some(w => justification.includes(w));
        if (!whitelisted) {
          violations.push({
            gate: 'C-WHITELIST',
            taskId: task.id,
            reason: `Tests: none requires a whitelisted justification. Got: "${testsVal}"`,
            suggestion: `Use one of: ${TESTS_NONE_WHITELIST.map(w => `"${w}"`).join(', ')}.`,
          });
        }
        continue;
      }

      // Tests: <value> that is not "none" and not deferred — treat as embedded, accept
      // (e.g. "Tests: hooks/validate-tasks-gates.test.js" or "Tests: T3")
      continue;
    }

    // No Tests: field at all — check if paired with a test-first task via Blocked by
    const pairedWithTestFirst = task.blockedBy.some(
      blocker => taskIds.has(blocker) && testFirstTaskIds.has(blocker)
    );
    if (!pairedWithTestFirst) {
      violations.push({
        gate: 'C-DEFERRED',
        taskId: task.id,
        reason: `Production task has no Tests: field and is not blocked by a test-first task`,
        suggestion: `Add "Tests: <test-file>" or pair ${task.id} with a test-first task using "Blocked by: T{test-task-id}".`,
      });
    }
  }

  return violations;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

/**
 * Run all gates against parsed PLAN.md content.
 * Returns { violations: [...], allow: boolean }
 */
function validatePlan(content) {
  const tasks = parsePlan(content);
  const violations = [
    ...gateA(tasks),
    ...gateB(tasks),
    ...gateC(tasks),
  ];
  return { violations, allow: violations.length === 0 };
}

// ── Hook entry point ──────────────────────────────────────────────────────────
if (require.main === module) {
  readStdinIfMain(module, (data) => {
    const toolName = data.tool_name || '';
    // Only gate Write, Edit, and MultiEdit operations
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return;

    const filePath = (data.tool_input && data.tool_input.file_path) || '';
    if (!PLAN_FILE_RE.test(filePath)) return;

    // Read the content that will be written (for Write) or the existing file
    // For a PreToolUse hook we validate the proposed content in tool_input
    const content = (data.tool_input && (data.tool_input.content || data.tool_input.new_string)) || '';
    if (!content) return;

    const result = validatePlan(content);

    if (!result.allow) {
      const output = JSON.stringify({
        permissionDecision: 'deny',
        denyReason: `PLAN.md gate violations detected`,
        violations: result.violations,
      });
      process.stdout.write(output + '\n');
    } else {
      const output = JSON.stringify({
        permissionDecision: 'allow',
      });
      process.stdout.write(output + '\n');
    }
  });
}

module.exports = {
  parsePlan,
  gateA,
  gateB,
  gateC,
  validatePlan,
  // Export constants for tests
  LOC_BUDGET,
  MAX_FILES,
  MAX_VERBS,
  TESTS_NONE_WHITELIST,
  PLAN_FILE_RE,
};
