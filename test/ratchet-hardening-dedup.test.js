/**
 * Tests for ratchet-hardening spec (T49).
 *
 * T49 — Verifies execute.md §5.6 + §6 Wave Test dedup context:
 *   1. §5.6 gathers dedup context (auto-snapshot.txt, grep for test names)
 *   2. §5.6 passes SNAPSHOT_FILES and EXISTING_TEST_NAMES to wave test prompt
 *   3. §6 Wave Test prompt contains "Pre-existing test files" with {SNAPSHOT_FILES}
 *   4. §6 Wave Test prompt contains "Existing test function names" with {EXISTING_TEST_NAMES}
 *   5. §6 Wave Test prompt contains "Do not duplicate tests" instruction
 *   6. §5.6 "goto step" reference points to dedup context step (step 2)
 *
 * Uses Node.js built-in node:test to match project conventions.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const executePath = path.join(ROOT, 'src', 'commands', 'df', 'execute.md');

// ---------------------------------------------------------------------------
// Helper: read execute.md content
// ---------------------------------------------------------------------------

function getExecuteContent() {
  return fs.readFileSync(executePath, 'utf8');
}

function getSection56(content) {
  // §5.6 runs from "### 5.6. WAVE TEST AGENT" until the next ### heading
  const match = content.match(/### 5\.6\. WAVE TEST AGENT[\s\S]*?(?=###\s)/);
  return match ? match[0] : null;
}

function getWaveTestPrompt(content) {
  // Wave Test prompt is between **Wave Test** and the next ** prompt heading or ### heading
  const match = content.match(/\*\*Wave Test\*\*[\s\S]*?(?=\*\*(?:Spike|Optimize Task|Final Test)\*\*|###\s)/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// T49: §5.6 contains dedup context gathering step
// ---------------------------------------------------------------------------

describe('T49 — §5.6 dedup context gathering step', () => {
  it('execute.md exists', () => {
    assert.equal(
      fs.existsSync(executePath),
      true,
      'execute.md must exist at src/commands/df/execute.md'
    );
  });

  it('§5.6 WAVE TEST AGENT section exists', () => {
    const content = getExecuteContent();
    assert.match(
      content,
      /### 5\.6\. WAVE TEST AGENT/,
      '§5.6 should be titled "WAVE TEST AGENT"'
    );
  });

  it('§5.6 has a step that reads auto-snapshot.txt for dedup context', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    assert.ok(
      section.includes('auto-snapshot.txt') && section.includes('SNAPSHOT_FILES'),
      '§5.6 should read auto-snapshot.txt and store as SNAPSHOT_FILES'
    );
  });

  it('§5.6 extracts existing test function names via grep', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    assert.ok(
      section.includes('grep') && section.includes('EXISTING_TEST_NAMES'),
      '§5.6 should grep for test function names and store as EXISTING_TEST_NAMES'
    );
  });

  it('§5.6 grep pattern includes describe/it/test/def test_/func Test', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    assert.ok(
      section.includes('describe') && section.includes('it(') && section.includes('test(') && section.includes('def test_') && section.includes('func Test'),
      '§5.6 grep should match common test function patterns across languages'
    );
  });
});

// ---------------------------------------------------------------------------
// T49: §5.6 passes SNAPSHOT_FILES and EXISTING_TEST_NAMES to wave test prompt
// ---------------------------------------------------------------------------

describe('T49 — §5.6 passes dedup context to wave test prompt', () => {
  it('§5.6 spawn step references SNAPSHOT_FILES', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    // The spawn step should mention passing SNAPSHOT_FILES
    assert.ok(
      section.includes('passing `SNAPSHOT_FILES`') || section.includes('passing SNAPSHOT_FILES'),
      '§5.6 spawn step should pass SNAPSHOT_FILES to the wave test prompt'
    );
  });

  it('§5.6 spawn step references EXISTING_TEST_NAMES', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    assert.ok(
      section.includes('EXISTING_TEST_NAMES'),
      '§5.6 spawn step should pass EXISTING_TEST_NAMES to the wave test prompt'
    );
  });

  it('§5.6 dedup context gathering is step 2 (before spawn)', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    // Step 2 should be "Gather dedup context" and step 3 should be "Spawn"
    assert.match(
      section,
      /2\.\s+Gather dedup context/,
      '§5.6 step 2 should be "Gather dedup context"'
    );
  });

  it('§5.6 spawn agent is step 3 (after dedup context)', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    assert.match(
      section,
      /3\.\s+Spawn/,
      '§5.6 step 3 should be the spawn step'
    );
  });
});

// ---------------------------------------------------------------------------
// T49: §6 Wave Test prompt contains Pre-existing test files section
// ---------------------------------------------------------------------------

describe('T49 — §6 Wave Test prompt: Pre-existing test files section', () => {
  it('Wave Test prompt contains "Pre-existing test files" heading', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('Pre-existing test files'),
      'Wave Test prompt should contain "Pre-existing test files" section'
    );
  });

  it('Wave Test prompt includes {SNAPSHOT_FILES} placeholder', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('{SNAPSHOT_FILES}'),
      'Wave Test prompt should include {SNAPSHOT_FILES} placeholder'
    );
  });

  it('Pre-existing test files references auto-snapshot.txt', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('auto-snapshot.txt'),
      'Pre-existing test files section should reference auto-snapshot.txt as source'
    );
  });
});

// ---------------------------------------------------------------------------
// T49: §6 Wave Test prompt contains Existing test function names section
// ---------------------------------------------------------------------------

describe('T49 — §6 Wave Test prompt: Existing test function names section', () => {
  it('Wave Test prompt contains "Existing test function names" heading', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('Existing test function names'),
      'Wave Test prompt should contain "Existing test function names" section'
    );
  });

  it('Wave Test prompt includes {EXISTING_TEST_NAMES} placeholder', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('{EXISTING_TEST_NAMES}'),
      'Wave Test prompt should include {EXISTING_TEST_NAMES} placeholder'
    );
  });

  it('Existing test function names has "do NOT duplicate" instruction', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('do NOT duplicate'),
      'Existing test function names should instruct not to duplicate'
    );
  });
});

// ---------------------------------------------------------------------------
// T49: §6 Wave Test prompt contains "Do not duplicate tests" instruction
// ---------------------------------------------------------------------------

describe('T49 — §6 Wave Test prompt: dedup instruction in END section', () => {
  it('Wave Test prompt END section contains "Do not duplicate tests" instruction', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    assert.ok(
      prompt.includes('Do not duplicate tests for functionality already covered by the existing tests listed above'),
      'Wave Test prompt END section should contain full dedup instruction'
    );
  });

  it('Dedup instruction appears after the END marker', () => {
    const content = getExecuteContent();
    const prompt = getWaveTestPrompt(content);
    assert.ok(prompt, 'Should have Wave Test prompt');
    const endIdx = prompt.indexOf('--- END ---');
    const dedupIdx = prompt.indexOf('Do not duplicate tests');
    assert.ok(endIdx > -1, 'Wave Test prompt should have --- END --- marker');
    assert.ok(dedupIdx > -1, 'Wave Test prompt should have dedup instruction');
    assert.ok(
      dedupIdx > endIdx,
      'Dedup instruction should appear after --- END --- marker'
    );
  });
});

// ---------------------------------------------------------------------------
// T49: §5.6 "goto step" reference points to step 2 (dedup context)
// ---------------------------------------------------------------------------

describe('T49 — §5.6 goto reference points to dedup context step', () => {
  it('§5.6 retry flow references "goto step 2" (dedup context gathering)', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    assert.ok(
      section.includes('goto step 2'),
      '§5.6 retry flow should reference "goto step 2" (the dedup context gathering step)'
    );
  });

  it('§5.6 goto step 2 is in the re-spawn/retry context', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    // The goto step 2 should appear after mention of re-spawn/implementer
    const respawnIdx = section.indexOf('Re-spawn implementer') || section.indexOf('re-spawn implementer');
    const gotoIdx = section.indexOf('goto step 2');
    assert.ok(gotoIdx > -1, 'Should have goto step 2 reference');
    // goto step 2 should be near the retry logic (after ratchet check mention in step 4)
    assert.ok(
      section.includes('ratchet check') && gotoIdx > 0,
      'goto step 2 should be in the retry flow after ratchet check'
    );
  });

  it('§5.6 does NOT have "goto step 3" for re-spawn (would skip dedup)', () => {
    const content = getExecuteContent();
    const section = getSection56(content);
    assert.ok(section, 'Should have §5.6 section');
    // After retry, should NOT jump directly to step 3 (spawn) — must gather fresh dedup context
    const hasGotoStep3 = /goto step 3/.test(section);
    assert.equal(
      hasGotoStep3,
      false,
      '§5.6 should NOT have "goto step 3" — retry must go through step 2 to refresh dedup context'
    );
  });
});
