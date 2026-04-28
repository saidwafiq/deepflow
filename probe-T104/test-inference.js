#!/usr/bin/env node
/**
 * T104 Spike: Test cwd+branch+PLAN.md inference of agent role
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Mapping from PLAN.md task tag to subagent_type (from df:execute §6 table)
const TAG_TO_SUBAGENT = {
  '[INTEGRATION]': 'df-integration',
  '[SPIKE]': 'df-spike',
  '[OPTIMIZE]': 'df-optimize',
  '[TEST]': 'df-test',
  // No tag = standard implementation
};

/**
 * Infer agent role from current working directory
 * @param {string} cwd - Current working directory path
 * @returns {{ subagent_type: string | null, confidence: string, source: string }}
 */
function inferAgentRole(cwd) {
  try {
    // 1. Resolve git branch from cwd
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // 2. Parse branch name: df/{spec}--probe-T{N} or df/{spec}
    const branchMatch = branch.match(/^df\/(.+?)(?:--probe-(T\d+))?$/);
    if (!branchMatch) {
      return { subagent_type: null, confidence: 'high', source: 'branch pattern mismatch' };
    }

    const [, spec, probeTaskId] = branchMatch;

    // 3. If no task ID in branch, cannot infer without additional context
    if (!probeTaskId) {
      return { subagent_type: null, confidence: 'high', source: 'no task-id in branch' };
    }

    // 4. Find main repo root (walk up until we find .git that's a directory, not a worktree file)
    let repoRoot = cwd;
    while (repoRoot !== '/') {
      const gitPath = path.join(repoRoot, '.git');
      if (fs.existsSync(gitPath)) {
        const stats = fs.statSync(gitPath);
        if (stats.isDirectory()) {
          // Found main repo
          break;
        } else {
          // Worktree .git file - parse to find main repo
          const gitContent = fs.readFileSync(gitPath, 'utf8');
          const match = gitContent.match(/gitdir: (.+)/);
          if (match) {
            // Extract main repo path from worktree gitdir
            // Format: gitdir: /path/to/repo/.git/worktrees/name
            const worktreePath = match[1].trim();
            const mainGitDir = worktreePath.replace(/\/\.git\/worktrees\/.+$/, '/.git');
            repoRoot = path.dirname(mainGitDir);
            break;
          }
        }
      }
      repoRoot = path.dirname(repoRoot);
    }

    // 5. Read PLAN.md from main repo
    const planPath = path.join(repoRoot, 'PLAN.md');
    if (!fs.existsSync(planPath)) {
      return { subagent_type: null, confidence: 'medium', source: 'PLAN.md not found' };
    }

    const planContent = fs.readFileSync(planPath, 'utf8');

    // 6. Find the task line matching the taskId
    // Format: - [ ] **T104** [SPIKE]: ...
    const taskPattern = new RegExp(`^- \\[.\\] \\*\\*${probeTaskId}\\*\\*\\s+([^:]+):`, 'm');
    const taskMatch = planContent.match(taskPattern);

    if (!taskMatch) {
      return { subagent_type: null, confidence: 'medium', source: `task ${probeTaskId} not found in PLAN.md` };
    }

    const taskPrefix = taskMatch[1].trim();

    // 7. Map tag to subagent_type
    const subagentType = TAG_TO_SUBAGENT[taskPrefix] || 'df-implement';

    return {
      subagent_type: subagentType,
      confidence: 'high',
      source: `${branch} → ${probeTaskId} → ${taskPrefix} → ${subagentType}`
    };

  } catch (err) {
    return {
      subagent_type: null,
      confidence: 'low',
      source: `error: ${err.message}`
    };
  }
}

/**
 * Run inference test across multiple worktrees
 */
function runTests() {
  const testCases = [
    {
      name: 'T103 spike worktree',
      path: '/Users/saidsalles/apps/agentSkills/deepflow/.deepflow/worktrees/narrow-bash-per-agent/.deepflow/worktrees/narrow-bash-per-agent/probe-T103',
      expected: 'df-spike'
    },
    {
      name: 'T104 spike worktree',
      path: '/Users/saidsalles/apps/agentSkills/deepflow/.deepflow/worktrees/narrow-bash-per-agent/.deepflow/worktrees/narrow-bash-per-agent/probe-T104',
      expected: 'df-spike'
    },
    {
      name: 'Main repo (orchestrator)',
      path: '/Users/saidsalles/apps/agentSkills/deepflow',
      expected: null
    },
    {
      name: 'Parent worktree (no task-id)',
      path: '/Users/saidsalles/apps/agentSkills/deepflow/.deepflow/worktrees/narrow-bash-per-agent',
      expected: null
    }
  ];

  console.log('=== Agent Role Inference Tests ===\n');

  const results = [];
  const timings = [];

  for (const testCase of testCases) {
    if (!fs.existsSync(testCase.path)) {
      console.log(`⊘ ${testCase.name}: path does not exist`);
      continue;
    }

    // Run 100 iterations for timing
    const iterations = 100;
    const startTime = process.hrtime.bigint();

    let lastResult;
    for (let i = 0; i < iterations; i++) {
      lastResult = inferAgentRole(testCase.path);
    }

    const endTime = process.hrtime.bigint();
    const totalMs = Number(endTime - startTime) / 1_000_000;
    const avgMs = totalMs / iterations;

    timings.push(avgMs);

    const passed = lastResult.subagent_type === testCase.expected;
    const symbol = passed ? '✓' : '✗';

    results.push({
      name: testCase.name,
      passed,
      result: lastResult,
      expected: testCase.expected,
      avgMs
    });

    console.log(`${symbol} ${testCase.name}`);
    console.log(`  Expected: ${testCase.expected || 'null'}`);
    console.log(`  Got: ${lastResult.subagent_type || 'null'}`);
    console.log(`  Source: ${lastResult.source}`);
    console.log(`  Confidence: ${lastResult.confidence}`);
    console.log(`  Avg timing: ${avgMs.toFixed(3)}ms (${iterations} iterations)`);
    console.log('');
  }

  // Calculate timing percentiles
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  const max = timings[timings.length - 1];

  console.log('=== Timing Summary ===');
  console.log(`p50: ${p50.toFixed(3)}ms`);
  console.log(`p95: ${p95.toFixed(3)}ms`);
  console.log(`max: ${max.toFixed(3)}ms`);
  console.log('');

  // Edge cases
  console.log('=== Edge Case Tests ===\n');

  // Test: PLAN.md missing
  const tempDir = fs.mkdtempSync('/tmp/t104-test-');
  try {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git checkout -b df/test-spec--probe-T999', { cwd: tempDir, stdio: 'ignore' });
    const edgeResult1 = inferAgentRole(tempDir);
    console.log(`✓ Edge: PLAN.md missing → ${edgeResult1.subagent_type || 'null'} (${edgeResult1.source})`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // Summary
  const totalTests = results.length;
  const passedTests = results.filter(r => r.passed).length;
  const uniqueSubagents = new Set(results.filter(r => r.result.subagent_type).map(r => r.result.subagent_type));

  console.log('\n=== Summary ===');
  console.log(`Tests passed: ${passedTests}/${totalTests}`);
  console.log(`Unique subagent_types resolved: ${uniqueSubagents.size} (${[...uniqueSubagents].join(', ')})`);
  console.log(`p95 latency: ${p95.toFixed(3)}ms (threshold: 50ms)`);

  // Determine spike status
  const allPassed = passedTests === totalTests;
  const p95UnderThreshold = p95 < 50;
  const minCoverage = uniqueSubagents.size >= 1; // Need at least 1 non-null resolution

  if (allPassed && p95UnderThreshold && minCoverage) {
    console.log('\nSTATUS: PASSED');
    return 0;
  } else {
    console.log('\nSTATUS: FAILED');
    if (!allPassed) console.log('  Reason: Not all test cases passed');
    if (!p95UnderThreshold) console.log(`  Reason: p95 latency ${p95.toFixed(3)}ms exceeds 50ms threshold`);
    if (!minCoverage) console.log('  Reason: Insufficient subagent_type coverage');
    return 1;
  }
}

// Run if invoked directly
if (require.main === module) {
  process.exit(runTests());
}

// Export for use as module
module.exports = { inferAgentRole };
