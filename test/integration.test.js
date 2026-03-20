/**
 * Integration tests for auto-verify and plan-cleanup specs.
 *
 * These tests are COMPLEMENTARY to:
 *   - test/auto-verify.test.js (T45/T46/T48 unit tests)
 *   - test/auto-verify-execute.test.js (T47 execute.md unit tests)
 *   - test/plan-cleanup.test.js (T49/T50 unit tests)
 *
 * They verify acceptance criteria end-to-end across all three changed files
 * (verify.md, execute.md, config-template.yaml) without duplicating unit-level checks.
 *
 * Uses Node.js built-in node:test (CommonJS) to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERIFY_PATH = path.join(ROOT, 'src', 'commands', 'df', 'verify.md');
const EXECUTE_PATH = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');
const CONFIG_PATH = path.join(ROOT, 'templates', 'config-template.yaml');
const PLAN_PATH = path.join(ROOT, 'src', 'commands', 'df', 'plan.md');

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// ===========================================================================
// Auto-Verify Spec — Integration AC Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// AC-1: Frontend framework + browser_assertions + browser_verify absent → L5 runs
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-1: L5 runs automatically when all conditions met', () => {
  it('verify.md step 1 auto-detect proceeds to Steps 2-6 when both conditions met', () => {
    const content = readFile(VERIFY_PATH);
    // "Both conditions met → proceed to Steps 2–6" confirms L5 runs
    assert.ok(
      content.includes('Both conditions met') && content.includes('proceed to Steps 2'),
      'When both frontend + browser_assertions present and config absent, L5 should proceed'
    );
  });

  it('absent config triggers auto-detect (not skip)', () => {
    const content = readFile(VERIFY_PATH);
    // absent → auto-detect (not skip)
    assert.match(
      content,
      /absent.*auto-detect/is,
      'absent config should trigger auto-detect, not skip'
    );
  });

  it('auto-detect checks package.json deps/devDeps for frontend framework', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('deps or devDeps') || content.includes('deps') && content.includes('devDeps'),
      'Should check both deps and devDeps in package.json'
    );
  });

  it('auto-detect checks browser_assertions block scoped to current spec in PLAN.md', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('browser_assertions:') && content.includes('scoped to the current spec'),
      'Should check browser_assertions block scoped to current spec'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2: Frontend framework + no browser_assertions + browser_verify absent → L5 skipped with reason
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-2: L5 skipped with reason when no browser_assertions', () => {
  it('skip reason logged when frontend present but no browser_assertions', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('no browser_assertions in PLAN.md'),
      'Skip reason "no browser_assertions in PLAN.md" must be logged'
    );
  });

  it('skip outcome is dash-style (skipped, not failed)', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('L5 — (no browser_assertions in PLAN.md)'),
      'Outcome should be L5 dash (skip), not L5 cross (fail)'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: browser_verify: false → skip; browser_verify: true → force run
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-3: explicit config overrides auto-detect', () => {
  it('false always skips L5 regardless of other conditions', () => {
    const content = readFile(VERIFY_PATH);
    // Step 1 should show false → always skip
    assert.match(
      content,
      /`false`\s*→\s*always skip/i,
      'false should always skip L5'
    );
  });

  it('true always runs L5 regardless of other conditions', () => {
    const content = readFile(VERIFY_PATH);
    assert.match(
      content,
      /`true`\s*→\s*always run/i,
      'true should always run L5'
    );
  });

  it('config override is checked before auto-detect', () => {
    const content = readFile(VERIFY_PATH);
    // "Config ... overrides" should come before auto-detect logic
    const overridePos = content.indexOf('overrides');
    const autoDetectPos = content.indexOf('auto-detect using BOTH');
    assert.ok(
      overridePos < autoDetectPos,
      'Config override should be described before auto-detect logic'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: Final Test Agent fails → L0-L4 diagnostic checks, results in yaml
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-4: Final Test failure triggers diagnostic L0-L4', () => {
  it('execute.md step 8.1c invokes --diagnostic on test failure', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/);
    assert.ok(step81, 'Step 8.1 should exist');
    assert.ok(
      step81[0].includes('--diagnostic'),
      'Test failure path should invoke --diagnostic'
    );
  });

  it('verify.md diagnostic mode runs L0-L4 only', () => {
    const content = readFile(VERIFY_PATH);
    assert.match(
      content,
      /L0-L4 only.*skip L5/i,
      'Diagnostic mode should run L0-L4 only'
    );
  });

  it('results written to final-test-{spec}.yaml under diagnostics: key', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('.deepflow/results/final-test-{spec}.yaml') &&
      content.includes('`diagnostics:` key'),
      'Results should go to final-test-{spec}.yaml under diagnostics: key'
    );
  });

  it('execute.md also writes to final-test-{spec}.yaml with diagnostics key', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('final-test-{spec}.yaml') && step81.includes('diagnostics:'),
      'execute.md step 8.1c should also write diagnostics to final-test-{spec}.yaml'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5: Diagnostic verify does NOT create fix tasks, merge, or rename spec
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-5: Diagnostic verify is read-only', () => {
  it('verify.md diagnostic mode skips fix task creation', () => {
    const content = readFile(VERIFY_PATH);
    assert.match(
      content,
      /[Ss]kip.*fix task/i,
      'Diagnostic should skip fix task creation'
    );
  });

  it('verify.md diagnostic mode skips merge', () => {
    const content = readFile(VERIFY_PATH);
    assert.match(
      content,
      /[Ss]kip.*merge/i,
      'Diagnostic should skip merge'
    );
  });

  it('verify.md diagnostic mode skips spec rename', () => {
    const content = readFile(VERIFY_PATH);
    assert.match(
      content,
      /[Ss]kip.*spec rename/i,
      'Diagnostic should skip spec rename'
    );
  });

  it('execute.md step 8.1c says "informational only — no fix agents, no retries"', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('informational only') &&
      step81.includes('no fix agents') &&
      step81.includes('no retries'),
      'execute.md should explicitly state diagnostic is informational-only with no fixes or retries'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-6: All tasks [x] + Final Test passes → full L0-L5 verify + merge
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-6: Success path — full verify + merge', () => {
  it('execute.md step 8.1b: test pass proceeds to step 8.2 (full verify + merge)', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('Proceed to step 8.2') &&
      step81.includes('full L0-L5 verify + merge'),
      'Pass branch should proceed to step 8.2 for full L0-L5 verify + merge'
    );
  });

  it('execute.md step 8.2 invokes df:verify (full, not --diagnostic)', () => {
    const content = readFile(EXECUTE_PATH);
    const step82Match = content.match(/\*\*8\.2\.\s+Merge[\s\S]*?(?=\n---|\n###\s|\Z)/);
    assert.ok(step82Match, 'Step 8.2 should exist');
    const step82 = step82Match[0];
    assert.ok(
      step82.includes('df:verify') && step82.includes('doing-{name}'),
      'Step 8.2 should invoke df:verify with doing-{name}'
    );
    // Should NOT include --diagnostic in the step 8.2 invocation
    const verifyCall = step82.match(/df:verify.*doing-\{name\}/);
    assert.ok(verifyCall, 'Should have df:verify doing-{name} call');
    assert.ok(
      !verifyCall[0].includes('--diagnostic'),
      'Step 8.2 verify invocation should NOT be --diagnostic'
    );
  });

  it('verify.md Post-Verification runs when all gates pass and not --diagnostic', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('ALL gates pass AND `--diagnostic` was NOT used'),
      'Post-Verification should guard on ALL gates pass AND not --diagnostic'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7: All tasks [x] + Final Test fails → diagnostic L0-L4, no merge
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-7: Failure path — diagnostic only, no merge', () => {
  it('execute.md step 8.1c blocks merge on test failure', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('merge is blocked'),
      'Test failure should block merge'
    );
  });

  it('execute.md step 8.1c does NOT proceed to step 8.2', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('STOP. Do not proceed to merge'),
      'Failure path should STOP and not proceed to merge'
    );
  });

  it('execute.md step 8.1c leaves worktree intact', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('Leave worktree intact'),
      'Failure path should preserve worktree'
    );
  });

  it('execute.md step 8.1c sets tasks back to pending', () => {
    const content = readFile(EXECUTE_PATH);
    const step81 = content.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('status: "pending"'),
      'Failure path should set tasks back to pending'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-8: Config template has browser_verify commented out (absent), not false
// ---------------------------------------------------------------------------

describe('Auto-Verify AC-8: Config template browser_verify absent by default', () => {
  it('browser_verify is commented out in config template', () => {
    const content = readFile(CONFIG_PATH);
    assert.match(
      content,
      /^\s*#\s*browser_verify:/m,
      'browser_verify should be commented out'
    );
  });

  it('browser_verify is NOT set to false as an active key', () => {
    const content = readFile(CONFIG_PATH);
    assert.ok(
      !content.match(/^\s*browser_verify:\s*false/m),
      'browser_verify should NOT be actively set to false'
    );
  });

  it('browser_verify is NOT set to any value as an active key', () => {
    const content = readFile(CONFIG_PATH);
    const activeLines = content.split('\n').filter(
      l => !l.trim().startsWith('#') && l.includes('browser_verify:')
    );
    assert.equal(
      activeLines.length,
      0,
      'browser_verify should not appear as an active YAML key'
    );
  });

  it('config comment explains three-state semantics', () => {
    const content = readFile(CONFIG_PATH);
    assert.ok(
      content.includes('true') && content.includes('false') && content.includes('absent'),
      'Comment should explain true, false, and absent states'
    );
  });
});

// ===========================================================================
// Plan-Cleanup Spec — Integration AC Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// AC-1: verify.md Post-Verification includes step that removes spec section from PLAN.md
// ---------------------------------------------------------------------------

describe('Plan-Cleanup AC-1: Post-Verification removes spec section from PLAN.md', () => {
  it('Post-Verification has a step to remove spec section from PLAN.md', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/);
    assert.ok(postVerif, 'Post-Verification section must exist');
    assert.ok(
      postVerif[0].includes('Clean PLAN.md'),
      'Post-Verification should include a "Clean PLAN.md" step'
    );
  });

  it('removal is in step 6 (after merge, cleanup, rename, decision extraction)', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.match(
      postVerif,
      /6\.\s+\*\*Clean PLAN\.md/,
      'PLAN.md cleanup should be step 6'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2: Removal finds ### {spec-name} header, deletes through next ### or EOF
// ---------------------------------------------------------------------------

describe('Plan-Cleanup AC-2: Section removal algorithm', () => {
  it('finds section by ### {spec-name} header using name stem', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('### {spec-name}') || postVerif.includes('`### {spec-name}`'),
      'Should find section by ### {spec-name} header'
    );
    assert.ok(
      postVerif.includes('name stem'),
      'Should match on name stem'
    );
  });

  it('strips doing-/done- prefix for matching', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('doing-') && postVerif.includes('done-') && postVerif.includes('strip'),
      'Should strip doing-/done- prefix for name stem matching'
    );
  });

  it('deletes from header through line before next ### or EOF', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('Delete from header') || postVerif.includes('through the line before the next'),
      'Should describe deletion boundary'
    );
    assert.ok(
      postVerif.includes('next `### `') || postVerif.includes('next `### ` header'),
      'Should mention next ### header as boundary'
    );
    assert.ok(
      postVerif.includes('EOF'),
      'Should mention EOF as alternative boundary'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: After removal, recalculate Summary table
// ---------------------------------------------------------------------------

describe('Plan-Cleanup AC-3: Summary table recalculation', () => {
  it('step 6 describes recalculating the Summary table', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('Recalculate Summary table'),
      'Should explicitly say "Recalculate Summary table"'
    );
  });

  it('recalculation recounts ### headers for spec count', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('recount') || postVerif.includes('`### ` headers'),
      'Should recount ### headers for spec count'
    );
  });

  it('recalculation recounts task checkboxes', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('- [ ]') || postVerif.includes('`- [ ]`') ||
      postVerif.includes('task counts'),
      'Should recount task checkboxes for task counts'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4: No spec sections remain → delete PLAN.md entirely
// ---------------------------------------------------------------------------

describe('Plan-Cleanup AC-4: Empty PLAN.md deletion', () => {
  it('step 6 specifies deleting PLAN.md when no spec sections remain', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    assert.ok(
      postVerif.includes('no spec sections remain') || postVerif.includes('If no spec sections'),
      'Should describe the "no spec sections remain" condition'
    );
    assert.ok(
      postVerif.includes('delete PLAN.md entirely'),
      'Should delete PLAN.md entirely when empty'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5: plan.md step 8 text is unchanged
// ---------------------------------------------------------------------------

describe('Plan-Cleanup AC-5: plan.md step 8 unchanged', () => {
  it('plan.md step 8 is "CLEANUP PLAN.md"', () => {
    const content = readFile(PLAN_PATH);
    assert.ok(
      content.includes('### 8. CLEANUP PLAN.md'),
      'plan.md should still have step 8 titled "CLEANUP PLAN.md"'
    );
  });

  it('plan.md step 8 has original cleanup description (prune, recalculate, recreate)', () => {
    const content = readFile(PLAN_PATH);
    const step8Match = content.match(/### 8\. CLEANUP PLAN\.md\n\n([^\n]+)/);
    assert.ok(step8Match, 'step 8 should have a description line');
    const desc = step8Match[1];
    assert.ok(
      desc.includes('Prune') && desc.includes('Recalculate') && desc.includes('Summary'),
      'Step 8 description should contain original "Prune", "Recalculate", and "Summary" wording'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-6: execute.md step 8.2 no longer claims ownership of PLAN.md section removal
// ---------------------------------------------------------------------------

describe('Plan-Cleanup AC-6: execute.md step 8.2 defers cleanup to verify', () => {
  it('step 8.2 does NOT contain inline PLAN.md deletion instructions', () => {
    const content = readFile(EXECUTE_PATH);
    // Old wording would have been detailed deletion instructions in step 8.2
    assert.ok(
      !content.includes("Remove spec's ENTIRE section"),
      'step 8.2 should not have old section removal wording'
    );
  });

  it('step 8.2 does NOT directly instruct to recalculate Summary', () => {
    const content = readFile(EXECUTE_PATH);
    const lines = content.split('\n');
    const step82Start = lines.findIndex(l => l.includes('8.2'));
    assert.ok(step82Start >= 0, 'Step 8.2 must exist');
    const step82Lines = lines.slice(step82Start, step82Start + 5).join('\n');
    assert.ok(
      !step82Lines.includes('Recalculate Summary table'),
      'Step 8.2 should not directly instruct to recalculate Summary table'
    );
  });

  it('step 8.2 says cleanup is "handled by verify"', () => {
    const content = readFile(EXECUTE_PATH);
    assert.ok(
      content.includes('handled by verify'),
      'Step 8.2 should say PLAN.md cleanup is "handled by verify"'
    );
  });

  it('step 8.2 references verify step 6 for delegation', () => {
    const content = readFile(EXECUTE_PATH);
    assert.ok(
      content.includes('step 6'),
      'Step 8.2 should reference "step 6" for the delegation target'
    );
  });
});

// ===========================================================================
// Cross-file Consistency — Integration tests
// ===========================================================================

describe('Cross-file: verify and execute agree on diagnostic mode contract', () => {
  it('both files agree on L0-L4 scope for diagnostic', () => {
    const verify = readFile(VERIFY_PATH);
    const execute = readFile(EXECUTE_PATH);
    assert.ok(verify.includes('L0-L4 only'), 'verify.md should specify L0-L4 only');
    // execute.md step 8.1c should show L0-L4 levels in its yaml
    const step81 = execute.match(/\*\*8\.1\.\s+Final Test[\s\S]*?(?=\*\*8\.2\.)/)[0];
    assert.ok(
      step81.includes('L0:') && step81.includes('L1:') &&
      step81.includes('L2:') && step81.includes('L4:'),
      'execute.md diagnostics yaml should list L0, L1, L2, L4'
    );
    // Neither should include L5 in diagnostic output
    const diagYaml = step81.match(/diagnostics:[\s\S]*?(?=```)/);
    assert.ok(diagYaml, 'Should have diagnostics YAML block');
    assert.ok(
      !diagYaml[0].includes('L5:'),
      'Diagnostic YAML should not include L5 level'
    );
  });

  it('both files agree on final-test-{spec}.yaml output path', () => {
    const verify = readFile(VERIFY_PATH);
    const execute = readFile(EXECUTE_PATH);
    assert.ok(
      verify.includes('final-test-{spec}.yaml'),
      'verify.md should reference final-test-{spec}.yaml'
    );
    assert.ok(
      execute.includes('final-test-{spec}.yaml'),
      'execute.md should reference final-test-{spec}.yaml'
    );
  });
});

describe('Cross-file: verify step 6 is the sole owner of PLAN.md cleanup', () => {
  it('verify.md has detailed PLAN.md cleanup logic in step 6', () => {
    const content = readFile(VERIFY_PATH);
    const postVerif = content.match(/Post-Verification[\s\S]*$/)[0];
    // Step 6 should have all the detailed algorithm
    assert.ok(
      postVerif.includes('### {spec-name}') || postVerif.includes('`### {spec-name}`'),
      'verify step 6 should describe finding ### {spec-name} header'
    );
    assert.ok(
      postVerif.includes('Delete from header') || postVerif.includes('through the line before'),
      'verify step 6 should describe the deletion range'
    );
    assert.ok(
      postVerif.includes('Recalculate Summary'),
      'verify step 6 should describe Summary recalculation'
    );
    assert.ok(
      postVerif.includes('delete PLAN.md entirely'),
      'verify step 6 should describe full PLAN.md deletion when empty'
    );
  });

  it('execute.md has NO inline PLAN.md cleanup logic', () => {
    const content = readFile(EXECUTE_PATH);
    assert.ok(
      !content.includes('Delete from header through'),
      'execute.md should not contain inline deletion logic'
    );
    assert.ok(
      !content.includes('delete PLAN.md entirely'),
      'execute.md should not contain PLAN.md deletion instruction'
    );
  });
});

describe('Cross-file: config template and verify.md agree on three-state semantics', () => {
  it('config template documents the same three states as verify.md', () => {
    const config = readFile(CONFIG_PATH);
    const verify = readFile(VERIFY_PATH);

    // Config should mention true, false, absent
    assert.ok(
      config.includes('true') && config.includes('false') && config.includes('absent'),
      'Config template should document true/false/absent states'
    );

    // Verify should describe the same three states
    assert.ok(
      verify.includes('`false`') && verify.includes('`true`') && verify.includes('absent'),
      'verify.md should describe false/true/absent states'
    );
  });

  it('config template mentions auto-detect, matching verify.md behavior', () => {
    const config = readFile(CONFIG_PATH);
    assert.ok(
      config.includes('auto-detect'),
      'Config comment should mention auto-detect for absent state'
    );
  });
});

describe('Cross-file: diagnostic mode skips all Post-Verification steps', () => {
  it('verify.md diagnostic explicitly skips PLAN.md cleanup (step 6)', () => {
    const content = readFile(VERIFY_PATH);
    // The diagnostic skip list should mention PLAN.md cleanup
    assert.ok(
      content.includes('PLAN.md cleanup (step 6)') || content.includes('PLAN.md cleanup'),
      'Diagnostic mode should explicitly skip PLAN.md cleanup (step 6)'
    );
  });

  it('Post-Verification guard clause excludes --diagnostic runs', () => {
    const content = readFile(VERIFY_PATH);
    assert.ok(
      content.includes('`--diagnostic` was NOT used'),
      'Post-Verification should require --diagnostic was NOT used'
    );
  });
});

// ===========================================================================
// Framework table completeness — verify known frontend frameworks
// ===========================================================================

describe('Auto-Verify: Frontend framework detection table completeness', () => {
  const expectedFrameworks = ['next', 'react', 'nuxt', 'vue', 'svelte'];

  for (const fw of expectedFrameworks) {
    it(`verify.md lists ${fw} in the frontend framework detection table`, () => {
      const content = readFile(VERIFY_PATH);
      assert.ok(
        content.includes(`\`${fw}\``) || content.includes(`${fw}`),
        `verify.md should list ${fw} as a detectable frontend framework`
      );
    });
  }
});

// ===========================================================================
// L5 Outcomes completeness — all documented outcomes present
// ===========================================================================

describe('Auto-Verify: All L5 outcomes documented', () => {
  const expectedOutcomes = [
    '(no frontend)',
    '(no browser_assertions in PLAN.md)',
    '(no assertions)',
    '(install failed)',
  ];

  for (const outcome of expectedOutcomes) {
    it(`L5 outcomes include "${outcome}"`, () => {
      const content = readFile(VERIFY_PATH);
      const outcomesLine = content.split('\n').find(l => l.includes('All L5 outcomes:'));
      assert.ok(outcomesLine, 'Should have "All L5 outcomes:" line');
      assert.ok(
        outcomesLine.includes(outcome),
        `L5 outcomes line should include "${outcome}"`
      );
    });
  }
});
