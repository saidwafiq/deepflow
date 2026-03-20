/**
 * Tests for plan-cleanup spec (T49, T50).
 *
 * T49 — Verifies verify.md Post-Verification step 6 (Clean PLAN.md):
 *   1. Step 6 exists in Post-Verification section
 *   2. Describes finding spec section by name stem
 *   3. Describes deleting through next ### or EOF
 *   4. Describes recalculating Summary table
 *   5. Describes deleting PLAN.md entirely if empty
 *   6. Describes skip silently behavior
 *   7. Output message includes "Cleaned PLAN.md"
 *
 * T50 — Verifies execute.md step 8.2 reword:
 *   1. Step 8.2 references verify handling cleanup
 *   2. Step 8.2 does NOT contain old "Remove spec's ENTIRE section" wording
 *   3. Step 8.2 does NOT contain "Recalculate Summary table" (moved to verify)
 *
 * Uses Node.js built-in node:test to match project conventions (see bin/install.test.js).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// T49: verify.md Post-Verification step 6 — Clean PLAN.md
// ---------------------------------------------------------------------------

describe('T49 — verify.md Post-Verification step 6: Clean PLAN.md', () => {
  const verifyPath = path.join(ROOT, 'src', 'commands', 'df', 'verify.md');

  it('Post-Verification section exists', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(
      content,
      /Post-Verification/,
      'verify.md should have a Post-Verification section'
    );
  });

  it('step 6 exists in Post-Verification', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    // Match a numbered step 6 in the Post-Verification section
    const postVerification = content.match(/Post-Verification[\s\S]*$/);
    assert.ok(postVerification, 'Should have Post-Verification section');
    assert.match(
      postVerification[0],
      /6\.\s+\*\*Clean PLAN\.md/,
      'Step 6 should be "Clean PLAN.md" in Post-Verification'
    );
  });

  it('step 6 describes finding spec section by name stem', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('name stem'),
      'Step 6 should describe matching by name stem'
    );
  });

  it('step 6 describes stripping doing-/done- prefix', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('doing-') && postVerification.includes('done-'),
      'Step 6 should mention stripping doing-/done- prefix'
    );
  });

  it('step 6 describes deleting through next ### or EOF', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('### ') || postVerification.includes('next `### `'),
      'Step 6 should describe deletion boundary at next ### header'
    );
    assert.ok(
      postVerification.includes('EOF'),
      'Step 6 should mention EOF as an alternative boundary'
    );
  });

  it('step 6 describes recalculating Summary table', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('Recalculate Summary') || postVerification.includes('Summary table'),
      'Step 6 should describe recalculating the Summary table'
    );
  });

  it('step 6 describes deleting PLAN.md if no spec sections remain', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('delete PLAN.md entirely') || postVerification.includes('no spec sections remain'),
      'Step 6 should describe deleting PLAN.md when empty'
    );
  });

  it('step 6 describes skip silently if missing', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('Skip silently') || postVerification.includes('silently'),
      'Step 6 should describe skipping silently when PLAN.md missing or section gone'
    );
  });

  it('output message includes "Cleaned PLAN.md"', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.ok(
      content.includes('Cleaned PLAN.md'),
      'Output message should include "Cleaned PLAN.md"'
    );
  });

  it('step 6 mentions recount of ### headers and task counts', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerification.includes('recount') || postVerification.includes('spec count'),
      'Step 6 should mention recounting spec headers for summary'
    );
  });

  it('steps 1-5 still exist and precede step 6', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    const postVerification = content.match(/Post-Verification[\s\S]*$/)[0];
    // Check that steps 1 through 5 exist in order before step 6
    const step1Pos = postVerification.indexOf('1. **Discover worktree');
    const step6Pos = postVerification.indexOf('6. **Clean PLAN.md');
    assert.ok(step1Pos >= 0, 'Step 1 should exist');
    assert.ok(step6Pos >= 0, 'Step 6 should exist');
    assert.ok(step1Pos < step6Pos, 'Step 1 should come before step 6');
  });
});

// ---------------------------------------------------------------------------
// T50: execute.md step 8.2 reword — cleanup delegated to verify
// ---------------------------------------------------------------------------

describe('T50 — execute.md step 8.2 delegates PLAN.md cleanup to verify', () => {
  const executePath = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

  it('execute.md exists', () => {
    assert.equal(
      fs.existsSync(executePath),
      true,
      'execute.md must exist at src/commands/df/execute.md'
    );
  });

  it('step 8.2 exists', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    assert.ok(
      content.includes('8.2'),
      'execute.md should contain step 8.2'
    );
  });

  it('step 8.2 references verify handling the cleanup', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    // Find step 8.2 content
    const step82Match = content.match(/8\.2[\s\S]*?(?=\n---|\n###|\n\*\*8\.3|\Z)/);
    assert.ok(step82Match, 'Should have step 8.2 content');
    const step82 = step82Match[0];
    assert.ok(
      step82.includes('verify') || step82.includes('df:verify'),
      'Step 8.2 should reference verify handling the cleanup'
    );
  });

  it('step 8.2 does NOT contain "Remove spec\'s ENTIRE section" wording', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    assert.ok(
      !content.includes("Remove spec's ENTIRE section"),
      'execute.md should not contain old wording "Remove spec\'s ENTIRE section"'
    );
  });

  it('step 8.2 does NOT contain direct "Recalculate Summary table" instruction', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    // The old wording in execute.md had "Recalculate Summary table" as a direct instruction
    // Now it should delegate to verify. Check that execute.md doesn't have this as an action item.
    const lines = content.split('\n');
    const step82Start = lines.findIndex(l => l.includes('8.2'));
    if (step82Start >= 0) {
      // Check the next few lines after 8.2 for old wording
      const step82Lines = lines.slice(step82Start, step82Start + 5).join('\n');
      assert.ok(
        !step82Lines.includes('Recalculate Summary table'),
        'Step 8.2 should not directly instruct to recalculate Summary table — verify handles it'
      );
    }
  });

  it('step 8.2 mentions "handled by verify"', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    assert.ok(
      content.includes('handled by verify'),
      'Step 8.2 should explicitly say cleanup is "handled by verify"'
    );
  });

  it('step 8.1 still references df:verify for merge', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    assert.ok(
      content.includes('df:verify'),
      'Step 8.1/8.2 section should still reference df:verify'
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-file consistency: verify step 6 and execute step 8.2 agree
// ---------------------------------------------------------------------------

describe('Cross-file: verify step 6 and execute step 8.2 are consistent', () => {
  const verifyPath = path.join(ROOT, 'src', 'commands', 'df', 'verify.md');
  const executePath = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

  it('verify.md has the actual cleanup logic (step 6)', () => {
    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.ok(
      content.includes('Clean PLAN.md'),
      'verify.md should contain the actual "Clean PLAN.md" step'
    );
  });

  it('execute.md defers to verify (no inline cleanup logic)', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    // execute.md should NOT have detailed PLAN.md cleanup instructions
    assert.ok(
      !content.includes('Delete from header through'),
      'execute.md should not contain detailed PLAN.md deletion instructions'
    );
    assert.ok(
      !content.includes('delete PLAN.md entirely'),
      'execute.md should not contain instruction to delete PLAN.md entirely'
    );
  });

  it('execute step 8.2 mentions "step 6" or "verify" for the delegation', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    // The reworded step should reference verify's step
    assert.ok(
      content.includes('verify') && content.includes('step 6'),
      'execute.md step 8.2 should reference "verify" and "step 6"'
    );
  });
});
