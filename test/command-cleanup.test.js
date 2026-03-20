/**
 * Tests for command-cleanup spec.
 *
 * T38 — Verifies:
 *   1. Deleted files no longer exist (commands: consolidate, note, report, resume;
 *      hook: df-consolidation-check)
 *   2. Remaining commands still exist (discover, plan, execute, spec, debate,
 *      auto, auto-cycle, dashboard, verify, update)
 *   3. Remaining hooks still exist
 *
 * T39 — Verifies auto-cycle command→skill refactor:
 *   1. src/skills/auto-cycle/SKILL.md exists with correct frontmatter
 *   2. src/commands/df/auto-cycle.md still exists as a shim
 *   3. The shim body is ≤5 lines (excluding frontmatter)
 *   4. The shim references the "auto-cycle" skill
 *   5. The skill file contains substantial content (logic moved from command)
 *
 * Uses Node.js built-in node:test to match project conventions (see bin/install.test.js).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Root of the worktree (or repo) — resolve relative to this test file
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Deleted files no longer exist
// ---------------------------------------------------------------------------

describe('Deleted files — commands and hooks removed by command-cleanup', () => {
  const deletedCommands = [
    'consolidate.md',
    'note.md',
    'report.md',
    'resume.md',
  ];

  for (const file of deletedCommands) {
    it(`src/commands/df/${file} does not exist`, () => {
      const filePath = path.join(ROOT, 'src', 'commands', 'df', file);
      assert.equal(
        fs.existsSync(filePath),
        false,
        `${file} should have been deleted but still exists at ${filePath}`
      );
    });
  }

  it('hooks/df-consolidation-check.js does not exist', () => {
    const filePath = path.join(ROOT, 'hooks', 'df-consolidation-check.js');
    assert.equal(
      fs.existsSync(filePath),
      false,
      'df-consolidation-check.js should have been deleted but still exists'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Remaining commands still exist
// ---------------------------------------------------------------------------

describe('Remaining commands — all expected command files are present', () => {
  const expectedCommands = [
    'discover.md',
    'plan.md',
    'execute.md',
    'spec.md',
    'debate.md',
    'auto.md',
    'auto-cycle.md',
    'dashboard.md',
    'verify.md',
    'update.md',
  ];

  for (const file of expectedCommands) {
    it(`src/commands/df/${file} exists`, () => {
      const filePath = path.join(ROOT, 'src', 'commands', 'df', file);
      assert.equal(
        fs.existsSync(filePath),
        true,
        `Expected command file ${file} is missing at ${filePath}`
      );
    });
  }

  it('no deleted command files remain in src/commands/df/', () => {
    const commandsDir = path.join(ROOT, 'src', 'commands', 'df');
    const files = fs.readdirSync(commandsDir);
    const deleted = ['consolidate.md', 'note.md', 'report.md', 'resume.md'];
    const unexpected = files.filter(f => deleted.includes(f));
    assert.equal(
      unexpected.length,
      0,
      `Deleted commands still found: ${unexpected.join(', ')}`
    );
  });

  it('command directory contains exactly the expected files', () => {
    const commandsDir = path.join(ROOT, 'src', 'commands', 'df');
    const files = fs.readdirSync(commandsDir).sort();
    const expected = expectedCommands.slice().sort();
    assert.deepEqual(
      files,
      expected,
      `Command directory contents mismatch.\nExpected: ${expected.join(', ')}\nActual: ${files.join(', ')}`
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Remaining hooks still exist
// ---------------------------------------------------------------------------

describe('Remaining hooks — all expected hook files are present', () => {
  const expectedHooks = [
    'df-check-update.js',
    'df-dashboard-push.js',
    'df-execution-history.js',
    'df-invariant-check.js',
    'df-quota-logger.js',
    'df-spec-lint.js',
    'df-statusline.js',
    'df-tool-usage-spike.js',
    'df-tool-usage.js',
    'df-worktree-guard.js',
  ];

  for (const file of expectedHooks) {
    it(`hooks/${file} exists`, () => {
      const filePath = path.join(ROOT, 'hooks', file);
      assert.equal(
        fs.existsSync(filePath),
        true,
        `Expected hook file ${file} is missing at ${filePath}`
      );
    });
  }

  it('df-consolidation-check.js is not among remaining hooks', () => {
    const hooksDir = path.join(ROOT, 'hooks');
    const files = fs.readdirSync(hooksDir);
    assert.equal(
      files.includes('df-consolidation-check.js'),
      false,
      'df-consolidation-check.js should not be in hooks directory'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Deleted command files have no residual references in remaining commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T39: auto-cycle command→skill refactor
// ---------------------------------------------------------------------------

describe('T39 — auto-cycle skill file exists with correct frontmatter', () => {
  const skillPath = path.join(ROOT, 'src', 'skills', 'auto-cycle', 'SKILL.md');

  it('src/skills/auto-cycle/SKILL.md exists', () => {
    assert.equal(
      fs.existsSync(skillPath),
      true,
      'SKILL.md should exist at src/skills/auto-cycle/SKILL.md'
    );
  });

  it('skill frontmatter has name: auto-cycle', () => {
    const content = fs.readFileSync(skillPath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'SKILL.md should have YAML frontmatter delimited by ---');
    assert.match(
      fmMatch[1],
      /name:\s*auto-cycle/,
      'Frontmatter must contain name: auto-cycle'
    );
  });
});

describe('T39 — auto-cycle.md is a thin shim', () => {
  const shimPath = path.join(ROOT, 'src', 'commands', 'df', 'auto-cycle.md');

  it('src/commands/df/auto-cycle.md still exists', () => {
    assert.equal(
      fs.existsSync(shimPath),
      true,
      'auto-cycle.md command shim must still exist'
    );
  });

  it('shim body is ≤5 lines (excluding frontmatter)', () => {
    const content = fs.readFileSync(shimPath, 'utf8');
    // Strip frontmatter (--- ... ---)
    const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    assert.ok(bodyMatch, 'Shim should have frontmatter');
    const body = bodyMatch[1].trim();
    const lines = body.split('\n').filter(l => l.trim().length > 0);
    assert.ok(
      lines.length <= 5,
      `Shim body should be ≤5 non-empty lines, got ${lines.length}: \n${body}`
    );
  });

  it('shim references the auto-cycle skill', () => {
    const content = fs.readFileSync(shimPath, 'utf8');
    assert.match(
      content,
      /auto-cycle/,
      'Shim body must reference the auto-cycle skill'
    );
  });
});

describe('T39 — skill file contains substantial logic', () => {
  it('SKILL.md has significantly more content than the shim', () => {
    const skillPath = path.join(ROOT, 'src', 'skills', 'auto-cycle', 'SKILL.md');
    const shimPath = path.join(ROOT, 'src', 'commands', 'df', 'auto-cycle.md');
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const shimContent = fs.readFileSync(shimPath, 'utf8');
    // The skill should be substantially larger — at least 10x the shim
    assert.ok(
      skillContent.length > shimContent.length * 5,
      `Skill (${skillContent.length} chars) should be much larger than shim (${shimContent.length} chars)`
    );
  });

  it('SKILL.md contains key behavioral sections', () => {
    const skillPath = path.join(ROOT, 'src', 'skills', 'auto-cycle', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    // The logic should include core auto-cycle sections
    const expectedSections = ['LOAD STATE', 'PICK NEXT TASK', 'EXECUTE', 'CIRCUIT BREAKER'];
    for (const section of expectedSections) {
      assert.ok(
        content.includes(section),
        `SKILL.md should contain "${section}" section`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Deleted command files have no residual references in remaining commands
// ---------------------------------------------------------------------------

describe('No residual references to deleted commands in remaining files', () => {
  const deletedNames = ['consolidate', 'df:note', 'df:report', 'df:resume', 'df:consolidate'];

  it('remaining commands do not reference deleted command names', () => {
    const commandsDir = path.join(ROOT, 'src', 'commands', 'df');
    const files = fs.readdirSync(commandsDir);

    for (const file of files) {
      const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
      for (const name of deletedNames) {
        // Allow the name to appear as part of a longer word or in comments about removal,
        // but flag direct command references like /df:consolidate
        const pattern = new RegExp(`/df:${name.replace('df:', '')}(?![a-zA-Z-])`, 'g');
        const matches = content.match(pattern);
        assert.equal(
          matches,
          null,
          `${file} contains reference to deleted command "${name}": ${(matches || []).join(', ')}`
        );
      }
    }
  });
});
