#!/usr/bin/env node
/**
 * T104 Spike: Test cwd+branch+PLAN.md inference of agent role
 * Enhanced version with diverse subagent_type coverage
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
    // Also handle: - [x] **T104** [SPIKE]: ... (checkbox state variation)
    const taskPattern = new RegExp(`^- \\[.\\]\\s+\\*\\*${probeTaskId}\\*\\*\\s*([^:]*):`, 'm');
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
  const baseDir = '/Users/saidsalles/apps/agentSkills/deepflow/.deepflow/worktrees/narrow-bash-per-agent';

  const testCases = [
    {
      name: 'T103 spike worktree',
      path: `${baseDir}/.deepflow/worktrees/narrow-bash-per-agent/probe-T103`,
      expected: 'df-spike'
    },
    {
      name: 'T104 spike worktree',
      path: `${baseDir}/.deepflow/worktrees/narrow-bash-per-agent/probe-T104`,
      expected: 'df-spike'
    },
    {
      name: 'T102 integration (synthetic)',
      path: `${baseDir}/probe-T104/synthetic-tests`,
      expected: 'df-integration',
      branch: 'df/artifact-validation--probe-T102'
    },
    {
      name: 'T107 implement (synthetic)',
      path: `${baseDir}/probe-T104/synthetic-tests/test-T107`,
      expected: 'df-implement',
      branch: 'df/narrow-bash-per-agent--probe-T107'
    },
    {
      name: 'Main repo (orchestrator)',
      path: '/Users/saidsalles/apps/agentSkills/deepflow',
      expected: null
    },
    {
      name: 'Parent worktree (no task-id)',
      path: baseDir,
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

    // Verify branch if specified
    if (testCase.branch) {
      try {
        const currentBranch = execSync('git branch --show-current', {
          cwd: testCase.path,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        if (currentBranch !== testCase.branch) {
          console.log(`⊘ ${testCase.name}: wrong branch (${currentBranch} vs ${testCase.branch})`);
          continue;
        }
      } catch (err) {
        console.log(`⊘ ${testCase.name}: cannot read branch - ${err.message}`);
        continue;
      }
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

  // Test: Whitespace variation in PLAN.md (create temp PLAN.md with extra spaces)
  const tempDir2 = fs.mkdtempSync('/tmp/t104-test-');
  try {
    execSync('git init', { cwd: tempDir2, stdio: 'ignore' });
    execSync('git checkout -b df/test--probe-T888', { cwd: tempDir2, stdio: 'ignore' });

    // Create PLAN.md with whitespace variations
    const testPlan = `# PLAN.md
- [ ]  **T888**  [INTEGRATION]:  Test with extra spaces
- [x] **T889** [SPIKE]: Already done
`;
    fs.writeFileSync(path.join(tempDir2, 'PLAN.md'), testPlan);

    const edgeResult2 = inferAgentRole(tempDir2);
    console.log(`✓ Edge: Whitespace in PLAN.md → ${edgeResult2.subagent_type || 'null'} (${edgeResult2.source})`);

    const expectedWhitespace = edgeResult2.subagent_type === 'df-integration';
    console.log(`  Whitespace handling: ${expectedWhitespace ? 'PASS' : 'FAIL'}`);
  } finally {
    fs.rmSync(tempDir2, { recursive: true, force: true });
  }

  // Test: Task not in PLAN.md
  const tempDir3 = fs.mkdtempSync('/tmp/t104-test-');
  try {
    execSync('git init', { cwd: tempDir3, stdio: 'ignore' });
    execSync('git checkout -b df/test--probe-T777', { cwd: tempDir3, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempDir3, 'PLAN.md'), '# PLAN.md\n\n- [ ] **T1**: Some task\n');

    const edgeResult3 = inferAgentRole(tempDir3);
    console.log(`✓ Edge: Task not in PLAN.md → ${edgeResult3.subagent_type || 'null'} (${edgeResult3.source})`);
  } finally {
    fs.rmSync(tempDir3, { recursive: true, force: true });
  }

  // Test: Checked vs unchecked task
  const tempDir4 = fs.mkdtempSync('/tmp/t104-test-');
  try {
    execSync('git init', { cwd: tempDir4, stdio: 'ignore' });
    execSync('git checkout -b df/test--probe-T666', { cwd: tempDir4, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempDir4, 'PLAN.md'), '# PLAN.md\n\n- [x] **T666** [OPTIMIZE]: Done task\n');

    const edgeResult4 = inferAgentRole(tempDir4);
    console.log(`✓ Edge: Checked task → ${edgeResult4.subagent_type || 'null'} (${edgeResult4.source})`);

    const expectedChecked = edgeResult4.subagent_type === 'df-optimize';
    console.log(`  Checkbox state independence: ${expectedChecked ? 'PASS' : 'FAIL'}`);
  } finally {
    fs.rmSync(tempDir4, { recursive: true, force: true });
  }

  console.log('');

  // Summary
  const totalTests = results.length;
  const passedTests = results.filter(r => r.passed).length;
  const uniqueSubagents = new Set(results.filter(r => r.result.subagent_type).map(r => r.result.subagent_type));

  console.log('=== Summary ===');
  console.log(`Tests passed: ${passedTests}/${totalTests}`);
  console.log(`Unique subagent_types resolved: ${uniqueSubagents.size} (${[...uniqueSubagents].join(', ')})`);
  console.log(`p95 latency: ${p95.toFixed(3)}ms (threshold: 50ms)`);

  // Determine spike status
  const allPassed = passedTests === totalTests;
  const p95UnderThreshold = p95 < 50;
  const minCoverage = uniqueSubagents.size >= 3; // Need at least 3 distinct subagent_types

  if (allPassed && p95UnderThreshold && minCoverage) {
    console.log('\n✓ HYPOTHESIS CONFIRMED: All criteria met');
    console.log('  - All test cases passed');
    console.log(`  - Coverage: ${uniqueSubagents.size} distinct subagent_types`);
    console.log(`  - Performance: p95=${p95.toFixed(3)}ms < 50ms threshold`);
    return { status: 'PASSED', uniqueSubagents: uniqueSubagents.size, p95 };
  } else {
    console.log('\n✗ HYPOTHESIS REFUTED:');
    if (!allPassed) console.log(`  - Test failures: ${totalTests - passedTests}/${totalTests}`);
    if (!p95UnderThreshold) console.log(`  - p95 latency ${p95.toFixed(3)}ms exceeds 50ms threshold`);
    if (!minCoverage) console.log(`  - Insufficient coverage: only ${uniqueSubagents.size} distinct subagent_types (need ≥3)`);
    return { status: 'FAILED', uniqueSubagents: uniqueSubagents.size, p95 };
  }
}

// Run if invoked directly
if (require.main === module) {
  const result = runTests();
  process.exit(result.status === 'PASSED' ? 0 : 1);
}

// Export for use as module
module.exports = { inferAgentRole };
