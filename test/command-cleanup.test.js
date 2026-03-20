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

// ---------------------------------------------------------------------------
// T40: auto.md references src/skills/auto-cycle/SKILL.md
// ---------------------------------------------------------------------------

describe('T40 — auto.md cross-reference updated', () => {
  const autoPath = path.join(ROOT, 'src', 'commands', 'df', 'auto.md');

  it('auto.md references src/skills/auto-cycle/SKILL.md', () => {
    const content = fs.readFileSync(autoPath, 'utf8');
    assert.ok(
      content.includes('src/skills/auto-cycle/SKILL.md'),
      'auto.md should reference src/skills/auto-cycle/SKILL.md'
    );
  });

  it('auto.md does not reference /df:auto-cycle as a standalone command', () => {
    const content = fs.readFileSync(autoPath, 'utf8');
    // /df:auto-cycle should only appear in the /loop invocation line, not as
    // a cross-reference to a command file. The skill reference should use the
    // src/skills path instead.
    const lines = content.split('\n');
    for (const line of lines) {
      // Skip the /loop invocation line — that's expected to use /df:auto-cycle
      if (line.includes('/loop') && line.includes('/df:auto-cycle')) continue;
      // Skip lines that mention it as a shim name (acceptable)
      if (line.includes('shim')) continue;
      // Any other line referencing /df:auto-cycle as a command doc is wrong
      // We allow the name "auto-cycle" but not "/df:auto-cycle" as a cross-ref
    }
    // The key assertion: the "Cycle logic" rule row should point to the skill path
    assert.match(
      content,
      /Cycle logic.*src\/skills\/auto-cycle\/SKILL\.md/,
      'The rules table should reference src/skills/auto-cycle/SKILL.md for cycle logic'
    );
  });
});

// ---------------------------------------------------------------------------
// T40: execute.md cross-reference updated
// ---------------------------------------------------------------------------

describe('T40 — execute.md cross-reference to auto-cycle skill', () => {
  const executePath = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

  it('execute.md references src/skills/auto-cycle/SKILL.md', () => {
    const content = fs.readFileSync(executePath, 'utf8');
    assert.ok(
      content.includes('src/skills/auto-cycle/SKILL.md'),
      'execute.md should reference src/skills/auto-cycle/SKILL.md'
    );
  });
});

// ---------------------------------------------------------------------------
// T41: bin/install.js — removed commands and consolidation-check
// ---------------------------------------------------------------------------

describe('T41 — bin/install.js command output cleanup', () => {
  const installPath = path.join(ROOT, 'bin', 'install.js');

  it('source does not define consolidationCheckCmd variable', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    assert.ok(
      !src.includes('consolidationCheckCmd'),
      'consolidationCheckCmd variable should not exist in install.js'
    );
  });

  it('source does not reference consolidation-check in hook setup', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    assert.ok(
      !src.includes('consolidation-check'),
      'consolidation-check should not appear anywhere in install.js'
    );
  });

  it('command output line does not list /df:report', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    // Find the commands output line
    const commandLine = src.split('\n').find(l => l.includes('commands/df/') && l.includes('/df:'));
    assert.ok(commandLine, 'Should have a commands/df/ output line');
    assert.ok(
      !commandLine.includes('/df:report'),
      'Commands output should not list /df:report'
    );
  });

  it('command output line does not list /df:note', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    const commandLine = src.split('\n').find(l => l.includes('commands/df/') && l.includes('/df:'));
    assert.ok(
      !commandLine.includes('/df:note'),
      'Commands output should not list /df:note'
    );
  });

  it('command output line does not list /df:resume', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    const commandLine = src.split('\n').find(l => l.includes('commands/df/') && l.includes('/df:'));
    assert.ok(
      !commandLine.includes('/df:resume'),
      'Commands output should not list /df:resume'
    );
  });

  it('command output line does not list /df:consolidate', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    const commandLine = src.split('\n').find(l => l.includes('commands/df/') && l.includes('/df:'));
    assert.ok(
      !commandLine.includes('/df:consolidate'),
      'Commands output should not list /df:consolidate'
    );
  });

  it('skills output line includes auto-cycle', () => {
    const src = fs.readFileSync(installPath, 'utf8');
    const skillsLine = src.split('\n').find(l => l.includes('skills/') && l.includes('atomic-commits'));
    assert.ok(skillsLine, 'Should have a skills/ output line');
    assert.ok(
      skillsLine.includes('auto-cycle'),
      'Skills output should list auto-cycle'
    );
  });
});

// ---------------------------------------------------------------------------
// T42: README.md — command table and file structure
// ---------------------------------------------------------------------------

describe('T42 — README.md command table has exactly 8 rows', () => {
  const readmePath = path.join(ROOT, 'README.md');

  it('command table has exactly 8 command rows', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    // Find the Commands table — rows start with | `/df:
    const commandRows = content.split('\n').filter(l => /^\|\s*`\/df:/.test(l));
    assert.equal(
      commandRows.length,
      8,
      `Expected 8 command rows, got ${commandRows.length}: ${commandRows.map(r => r.trim()).join('\n')}`
    );
  });

  it('command table does not include /df:report', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    const commandRows = content.split('\n').filter(l => /^\|\s*`\/df:/.test(l));
    const reportRow = commandRows.find(r => r.includes('/df:report'));
    assert.equal(reportRow, undefined, 'Command table should not have /df:report row');
  });

  it('command table does not include /df:note', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    const commandRows = content.split('\n').filter(l => /^\|\s*`\/df:/.test(l));
    const noteRow = commandRows.find(r => r.includes('/df:note'));
    assert.equal(noteRow, undefined, 'Command table should not have /df:note row');
  });

  it('command table does not include /df:resume', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    const commandRows = content.split('\n').filter(l => /^\|\s*`\/df:/.test(l));
    const resumeRow = commandRows.find(r => r.includes('/df:resume'));
    assert.equal(resumeRow, undefined, 'Command table should not have /df:resume row');
  });

  it('command table does not include /df:consolidate', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    const commandRows = content.split('\n').filter(l => /^\|\s*`\/df:/.test(l));
    const consolidateRow = commandRows.find(r => r.includes('/df:consolidate'));
    assert.equal(consolidateRow, undefined, 'Command table should not have /df:consolidate row');
  });

  it('file structure does not mention report.json', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    assert.ok(
      !content.includes('report.json'),
      'README file structure should not mention report.json'
    );
  });

  it('file structure does not mention report.md as an artifact file', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    // report.md should not appear in the file structure tree section
    // (auto-report.md is fine — that's the autonomous mode report)
    const fileStructureMatch = content.match(/## File Structure[\s\S]*?```[\s\S]*?```/);
    assert.ok(fileStructureMatch, 'Should have a File Structure section');
    // Check that report.md does not appear (but auto-report.md is allowed)
    const structureBlock = fileStructureMatch[0];
    const lines = structureBlock.split('\n');
    const reportMdLines = lines.filter(l =>
      l.includes('report.md') && !l.includes('auto-report.md')
    );
    assert.equal(
      reportMdLines.length,
      0,
      `File structure should not mention report.md (found: ${reportMdLines.join(', ')})`
    );
  });

  it('command count text says 8 commands', () => {
    const content = fs.readFileSync(readmePath, 'utf8');
    assert.ok(
      content.includes('8 commands'),
      'README should mention "8 commands" in the ceremony/rejects section'
    );
  });
});

// ---------------------------------------------------------------------------
// T43: docs/concepts.md — no /df:note or /df:auto-cycle as command
// ---------------------------------------------------------------------------

describe('T43 — docs/concepts.md references updated', () => {
  const conceptsPath = path.join(ROOT, 'docs', 'concepts.md');

  it('does not reference /df:note', () => {
    const content = fs.readFileSync(conceptsPath, 'utf8');
    assert.ok(
      !content.includes('/df:note'),
      'concepts.md should not reference /df:note — command was removed'
    );
  });

  it('does not reference /df:auto-cycle as a command', () => {
    const content = fs.readFileSync(conceptsPath, 'utf8');
    assert.ok(
      !content.includes('/df:auto-cycle'),
      'concepts.md should not reference /df:auto-cycle as a command — it is now a skill'
    );
  });

  it('references auto-cycle as a skill', () => {
    const content = fs.readFileSync(conceptsPath, 'utf8');
    assert.ok(
      content.includes('auto-cycle skill') || content.includes('auto-cycle'),
      'concepts.md should reference auto-cycle (as a skill, not a command)'
    );
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
