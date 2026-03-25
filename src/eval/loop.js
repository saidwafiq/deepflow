'use strict';

/**
 * Karpathy loop orchestrator for df:eval.
 *
 * Implements the core eval loop: mutate → commit → guard → measure → keep/revert.
 * Worktree-isolated, git-as-memory, single target metric decides.
 *
 * AC-1:  Guard failure auto-reverts before metric comparison (status:guard_fail)
 * AC-2:  Target improvement keeps; regression reverts (status:kept / status:reverted)
 * AC-3:  Secondary metrics in commit message, never decide
 * AC-6:  Runs indefinitely until Ctrl+C; --loop N caps at N iterations
 * AC-7:  Reverts via git revert (not reset)
 * AC-12: All experiments on worktree-isolated branch
 * AC-13: Commit before verify for clean rollback
 * AC-15: Loop terminates on Ctrl+C or --loop N
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buildMutatorPrompt } = require('./mutator-prompt');
const { collectMetrics } = require('./metric-collector');
const { commitExperiment, revertExperiment, getExperimentHistory } = require('./git-memory');

/**
 * Create a worktree-isolated branch for the eval session.
 * AC-12: All experiments on worktree-isolated branch.
 *
 * @param {string} repoRoot  - Root of the main git repo
 * @param {string} skillName - Skill being evaluated (used in branch name)
 * @returns {{ branch: string, worktreePath: string }}
 */
function createEvalWorktree(repoRoot, skillName) {
  const timestamp = Date.now();
  const branch = `eval/${skillName}/${timestamp}`;
  const worktreeBase = path.join(repoRoot, '.deepflow', 'worktrees');

  // Ensure worktree base exists
  fs.mkdirSync(worktreeBase, { recursive: true });

  const worktreePath = path.join(worktreeBase, `eval-${skillName}-${timestamp}`);

  // Create orphan branch from current HEAD
  execSync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  return { branch, worktreePath };
}

/**
 * Remove a worktree and optionally its branch.
 *
 * @param {string} repoRoot
 * @param {string} worktreePath
 */
function removeEvalWorktree(repoRoot, worktreePath) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (_) {
    // best-effort cleanup
  }
}

/**
 * Run the guard check (build + test commands from config).
 * AC-1, AC-5: Guard = fixture tests via configured test command.
 *
 * @param {string} cwd          - Working directory to run commands in
 * @param {object} config       - Config with build_command / test_command
 * @returns {{ passed: boolean, output: string }}
 */
function runGuardCheck(cwd, config) {
  const commands = [];
  if (config.build_command) commands.push(config.build_command);
  if (config.test_command) commands.push(config.test_command);

  if (commands.length === 0) {
    return { passed: true, output: '(no guard commands configured)' };
  }

  const fullCommand = commands.join(' && ');
  try {
    const output = execSync(fullCommand, {
      cwd,
      stdio: 'pipe',
      timeout: 120_000, // 2 minute timeout for guard
    }).toString();
    return { passed: true, output };
  } catch (err) {
    return { passed: false, output: err.stderr?.toString() || err.message };
  }
}

/**
 * Compare a target metric between baseline and current.
 * Returns delta percentage and whether it improved.
 *
 * For metrics where "higher is better" (cache_ratio), improvement = current > baseline.
 * For metrics where "lower is better" (total_tokens, wall_time, context_burn),
 * improvement = current < baseline.
 *
 * @param {string} metricName
 * @param {number} baseline
 * @param {number} current
 * @returns {{ delta: number, improved: boolean }}
 */
function compareMetric(metricName, baseline, current) {
  // Guard against zero baseline
  const delta = baseline !== 0
    ? ((current - baseline) / Math.abs(baseline)) * 100
    : current === 0 ? 0 : 100;

  // "Lower is better" metrics
  const lowerIsBetter = ['total_tokens', 'wall_time', 'context_burn'];

  const improved = lowerIsBetter.includes(metricName)
    ? current < baseline
    : current > baseline;

  return { delta: Math.round(delta * 100) / 100, improved };
}

/**
 * Format secondary metrics for the commit message.
 * AC-3: Secondary metrics in commit message but never trigger keep/revert.
 *
 * @param {object} metrics       - Full metrics object
 * @param {string} targetMetric  - Primary metric name (excluded from secondaries)
 * @param {string[]} secondaryMetrics - List of secondary metric names
 * @returns {string}
 */
function formatSecondaries(metrics, targetMetric, secondaryMetrics) {
  if (!secondaryMetrics || secondaryMetrics.length === 0) return '';

  return secondaryMetrics
    .filter((m) => m !== targetMetric && metrics[m] != null)
    .map((m) => `${m}=${metrics[m]}`)
    .join(' ');
}

/**
 * Extract the skill name from a skill file path.
 * e.g. "skills/atomic-commits/SKILL.md" → "atomic-commits"
 *
 * @param {string} skillPath
 * @returns {string}
 */
function extractSkillName(skillPath) {
  const parts = skillPath.replace(/\\/g, '/').split('/');
  // Try to find the directory name before SKILL.md
  const skillIdx = parts.findIndex((p) => /^SKILL\.md$/i.test(p));
  if (skillIdx > 0) return parts[skillIdx - 1];
  // Fallback: use filename without extension
  return path.basename(skillPath, path.extname(skillPath));
}

/**
 * Run the Karpathy eval loop.
 *
 * @param {object} options
 * @param {string}   options.repoRoot        - Git repo root
 * @param {string}   options.skillPath       - Path to skill file (relative to repo root)
 * @param {string}   options.benchDir        - Path to benchmark directory
 * @param {string}   options.target          - Primary metric name (e.g. "cache_ratio")
 * @param {string}   options.hypothesis      - Mutation hypothesis
 * @param {number}   [options.maxIterations=Infinity] - --loop N cap (AC-6, AC-15)
 * @param {string[]} [options.secondaryMetrics=[]]    - Secondary metric names (AC-3)
 * @param {object}   [options.config={}]     - Project config (build_command, test_command)
 * @param {Function} [options.mutateSkill]   - Async function that receives prompt and returns new skill content
 * @param {Function} [options.onIteration]   - Callback per iteration for logging
 * @returns {Promise<{ iterations: number, kept: number, reverted: number, guardFails: number, branch: string }>}
 */
async function runEvalLoop({
  repoRoot,
  skillPath,
  benchDir,
  target,
  hypothesis,
  maxIterations = Infinity,
  secondaryMetrics = [],
  config = {},
  mutateSkill,
  onIteration,
}) {
  const skillName = extractSkillName(skillPath);
  const absoluteSkillPath = path.isAbsolute(skillPath)
    ? skillPath
    : path.join(repoRoot, skillPath);

  // AC-12: Create worktree-isolated branch
  const { branch, worktreePath } = createEvalWorktree(repoRoot, skillName);

  const worktreeSkillPath = path.join(
    worktreePath,
    path.relative(repoRoot, absoluteSkillPath)
  );

  const deepflowDir = path.join(worktreePath, '.deepflow');

  const stats = { iterations: 0, kept: 0, reverted: 0, guardFails: 0, branch };

  // Track abort signal for Ctrl+C (AC-6, AC-15)
  let aborted = false;
  const abortHandler = () => { aborted = true; };
  process.on('SIGINT', abortHandler);

  try {
    // Collect baseline metrics before the loop starts
    let baselineMetrics = await collectMetrics(deepflowDir);

    // AC-6: Loop until Ctrl+C or --loop N reached
    while (!aborted && stats.iterations < maxIterations) {
      stats.iterations++;
      const iterNum = stats.iterations;

      // --- Step 1: Build mutator prompt (T7) ---
      const currentSkillContent = fs.readFileSync(worktreeSkillPath, 'utf8');
      const historyStr = getExperimentHistory({ cwd: worktreePath, skillName });
      const historyEntries = historyStr === '(no experiment history)'
        ? []
        : historyStr.split('\n');

      const prompt = buildMutatorPrompt({
        skillContent: currentSkillContent,
        hypothesis,
        history: historyEntries,
      });

      // --- Step 2: Spawn agent to mutate skill file (full replacement) ---
      let newSkillContent;
      try {
        newSkillContent = await mutateSkill(prompt);
      } catch (err) {
        // Mutator failure — log and continue to next iteration
        if (onIteration) {
          onIteration({ iteration: iterNum, status: 'mutator_error', error: err.message });
        }
        continue;
      }

      // Write mutated skill file
      fs.writeFileSync(worktreeSkillPath, newSkillContent, 'utf8');

      // --- Step 3: Commit experiment BEFORE verify (AC-13) ---
      // Use placeholder values; will amend after metrics if kept
      const experimentHash = commitExperiment({
        cwd: worktreePath,
        skillName,
        hypothesis,
        target,
        value: 'pending',
        delta: '0',
        status: 'pending',
        secondaries: '',
      });

      // --- Step 4: Run guard check ---
      const guardResult = runGuardCheck(worktreePath, config);

      // --- Step 5: Guard fail → revert, log guard_fail, next iteration (AC-1) ---
      if (!guardResult.passed) {
        revertExperiment({ cwd: worktreePath });
        stats.guardFails++;

        // Amend the experiment commit message is not possible since we reverted.
        // The revert commit captures the guard_fail state in history.
        // Log a guard_fail experiment for git-as-memory
        commitExperiment({
          cwd: worktreePath,
          skillName,
          hypothesis,
          target,
          value: 'N/A',
          delta: '0',
          status: 'guard_fail',
          secondaries: '',
        });

        if (onIteration) {
          onIteration({
            iteration: iterNum,
            status: 'guard_fail',
            guardOutput: guardResult.output,
            hash: experimentHash,
          });
        }
        continue;
      }

      // --- Step 6: Collect metrics (T6) (AC-16) ---
      const startTs = Date.now() - 120_000; // approximate window
      const endTs = Date.now();
      const currentMetrics = await collectMetrics(deepflowDir, startTs, endTs);

      // --- Step 7: Compare target metric (AC-2) ---
      const baselineValue = baselineMetrics[target] || 0;
      const currentValue = currentMetrics[target] || 0;
      const { delta, improved } = compareMetric(target, baselineValue, currentValue);

      // AC-3: Format secondary metrics (never decide)
      const secondariesStr = formatSecondaries(currentMetrics, target, secondaryMetrics);

      let status;
      if (improved) {
        // Target improved → keep (AC-2: status:kept)
        status = 'kept';
        stats.kept++;

        // Update baseline to the new best
        baselineMetrics = currentMetrics;

        // The experiment commit is already in place; record a kept marker
        commitExperiment({
          cwd: worktreePath,
          skillName,
          hypothesis,
          target,
          value: currentValue,
          delta: delta.toString(),
          status: 'kept',
          secondaries: secondariesStr,
        });
      } else {
        // Target regression → revert (AC-2: status:reverted, AC-7: git revert)
        status = 'reverted';
        stats.reverted++;

        revertExperiment({ cwd: worktreePath });

        // Record the reverted experiment result
        commitExperiment({
          cwd: worktreePath,
          skillName,
          hypothesis,
          target,
          value: currentValue,
          delta: delta.toString(),
          status: 'reverted',
          secondaries: secondariesStr,
        });
      }

      if (onIteration) {
        onIteration({
          iteration: iterNum,
          status,
          target,
          value: currentValue,
          delta,
          secondaries: secondariesStr,
          hash: experimentHash,
        });
      }
    }
  } finally {
    // Clean up SIGINT handler
    process.removeListener('SIGINT', abortHandler);
  }

  return stats;
}

module.exports = {
  runEvalLoop,
  // exported for testing / composition
  createEvalWorktree,
  removeEvalWorktree,
  runGuardCheck,
  compareMetric,
  formatSecondaries,
  extractSkillName,
};
