#!/usr/bin/env node
/**
 * @file artifact-predicates.js
 * @description Shared predicates for artifact validation and verification
 * Factored from src/commands/df/verify.md L0/L1 logic
 * Consumed by: hooks/df-artifact-validate.js AND df:verify command runner
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

/**
 * Check if build command passes (L0 equivalent)
 * @param {string} buildCommand - Build command to execute
 * @param {string} cwd - Working directory
 * @returns {{pass: boolean, output: string}}
 */
function checkBuildPasses(buildCommand, cwd = process.cwd()) {
  if (!buildCommand) {
    return { pass: true, output: 'No build command configured' };
  }

  try {
    const output = execSync(buildCommand, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300000, // 5min
    });
    return { pass: true, output };
  } catch (error) {
    const stderr = error.stderr || error.stdout || error.message;
    const lines = stderr.split('\n');
    const lastLines = lines.slice(-30).join('\n');
    return { pass: false, output: lastLines };
  }
}

/**
 * Check if all planned files exist in git diff (L1 equivalent)
 * @param {string[]} plannedFiles - Files from PLAN.md Files: entries
 * @param {string} worktreePath - Path to worktree
 * @param {string} baseBranch - Base branch to diff against (default: main)
 * @returns {{pass: boolean, missing: string[], present: string[]}}
 */
function checkScopeCoverage(plannedFiles, worktreePath, baseBranch = 'main') {
  if (!plannedFiles || plannedFiles.length === 0) {
    return { pass: true, missing: [], present: [] };
  }

  let diffOutput;
  try {
    diffOutput = execSync(`git diff ${baseBranch}...HEAD --name-only`, {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    // If diff fails (e.g., worktree doesn't exist), treat as no files changed
    return { pass: false, missing: plannedFiles, present: [] };
  }

  const changedFiles = diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const missing = [];
  const present = [];

  for (const planned of plannedFiles) {
    if (changedFiles.includes(planned)) {
      present.push(planned);
    } else {
      missing.push(planned);
    }
  }

  return {
    pass: missing.length === 0,
    missing,
    present,
  };
}

/**
 * Check if a file/symbol exists via LSP or fallback
 * @param {string} reference - File path or symbol reference
 * @param {string} repoRoot - Repository root
 * @param {number} timeout - LSP timeout in ms (default: 1500)
 * @returns {{exists: boolean, method: 'fs'|'lsp'|'grep', evidence: string}}
 */
function checkReferenceExists(reference, repoRoot, timeout = 1500) {
  // File existence check
  const absolutePath = path.isAbsolute(reference)
    ? reference
    : path.join(repoRoot, reference);

  if (fs.existsSync(absolutePath)) {
    return { exists: true, method: 'fs', evidence: absolutePath };
  }

  // Symbol reference check via LSP (if bin/lsp-query.js exists)
  const lspPath = path.join(repoRoot, 'bin/lsp-query.js');
  if (fs.existsSync(lspPath)) {
    try {
      const lspResult = execSync(
        `node "${lspPath}" --symbol "${reference}" --timeout ${timeout}`,
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: timeout + 500,
        }
      );

      if (lspResult && lspResult.trim()) {
        return { exists: true, method: 'lsp', evidence: lspResult.trim() };
      }
    } catch (error) {
      // LSP failed, fall through to grep
    }
  }

  // Grep fallback
  try {
    const grepResult = execSync(
      `grep -r "${reference}" --include="*.js" --include="*.ts" --include="*.md" .`,
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      }
    );

    if (grepResult && grepResult.trim()) {
      return { exists: true, method: 'grep', evidence: 'Found in codebase' };
    }
  } catch (error) {
    // Grep failed or no matches
  }

  return { exists: false, method: 'none', evidence: 'Not found' };
}

/**
 * Resolve task IDs from PLAN.md
 * @param {string} planPath - Path to PLAN.md
 * @returns {Set<string>} Set of task IDs (e.g., 'T1', 'T23')
 */
function extractTaskIds(planPath) {
  if (!fs.existsSync(planPath)) {
    return new Set();
  }

  const content = fs.readFileSync(planPath, 'utf8');
  const taskIdPattern = /^- \[.\] \*\*T(\d+)\*\*/gm;
  const ids = new Set();

  let match;
  while ((match = taskIdPattern.exec(content)) !== null) {
    ids.add(`T${match[1]}`);
  }

  return ids;
}

/**
 * Check if a blocker reference resolves
 * @param {string} blockerRef - e.g., 'T99'
 * @param {Set<string>} validTaskIds - Set of valid task IDs
 * @returns {boolean}
 */
function checkBlockerResolves(blockerRef, validTaskIds) {
  return validTaskIds.has(blockerRef);
}

module.exports = {
  checkBuildPasses,
  checkScopeCoverage,
  checkReferenceExists,
  extractTaskIds,
  checkBlockerResolves,
};
