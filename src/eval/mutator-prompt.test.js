'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMutatorPrompt } = require('./mutator-prompt.js');

const DEFAULTS = { skillContent: '---\nname: test\n---\nSome skill', hypothesis: 'Try X' };

describe('buildMutatorPrompt', () => {
  // --- AC-8: Section order ---

  it('emits sections in order: ## Skill, ## Hypothesis, ## History, ## Instructions', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    const headings = [...result.matchAll(/^## \w+/gm)].map(m => m[0]);
    assert.deepStrictEqual(headings, ['## Skill', '## Hypothesis', '## History', '## Instructions']);
  });

  it('## Skill appears before ## Hypothesis which appears before ## History which appears before ## Instructions', () => {
    const result = buildMutatorPrompt({ ...DEFAULTS, history: ['exp1'] });
    const skillIdx = result.indexOf('## Skill');
    const hypIdx = result.indexOf('## Hypothesis');
    const histIdx = result.indexOf('## History');
    const instrIdx = result.indexOf('## Instructions');
    assert.ok(skillIdx < hypIdx, 'Skill before Hypothesis');
    assert.ok(hypIdx < histIdx, 'Hypothesis before History');
    assert.ok(histIdx < instrIdx, 'History before Instructions');
  });

  // --- Skill content placement ---

  it('places skillContent after ## Skill heading', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    const afterSkill = result.split('## Skill\n\n')[1];
    assert.ok(afterSkill.startsWith(DEFAULTS.skillContent));
  });

  it('places hypothesis after ## Hypothesis heading', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    const afterHyp = result.split('## Hypothesis\n\n')[1];
    assert.ok(afterHyp.startsWith(DEFAULTS.hypothesis));
  });

  // --- Empty history ---

  it('shows "(no experiments yet)" when history is empty', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    assert.ok(result.includes('(no experiments yet)'));
  });

  it('shows "(no experiments yet)" when history is not provided', () => {
    const result = buildMutatorPrompt({ skillContent: 'skill', hypothesis: 'hyp' });
    assert.ok(result.includes('(no experiments yet)'));
  });

  // --- AC-9: History truncation ---

  it('includes all history entries when within token budget', () => {
    const history = ['entry-one', 'entry-two'];
    const result = buildMutatorPrompt({ ...DEFAULTS, history, maxHistoryTokens: 4000 });
    assert.ok(result.includes('entry-one'));
    assert.ok(result.includes('entry-two'));
    assert.ok(!result.includes('omitted'));
  });

  it('truncates older entries when history exceeds maxHistoryTokens budget', () => {
    // budget = 5 tokens * 4 chars/token = 20 chars
    // Each entry gets length + 2 for separating newlines
    const history = ['aaaa', 'bbbb', 'cccccccccccccccc'];
    // entry 'aaaa' = 4+2=6 chars, 'bbbb' = 4+2=6 chars => 12 chars fits in 20
    // 'cccc...' = 16+2=18 chars => 12+18=30 > 20 => dropped
    const result = buildMutatorPrompt({ ...DEFAULTS, history, maxHistoryTokens: 5 });
    assert.ok(result.includes('aaaa'), 'newest entry kept');
    assert.ok(result.includes('bbbb'), 'second entry kept');
    assert.ok(!result.includes('cccccccccccccccc'), 'oldest entry dropped');
    assert.ok(result.includes('1 older experiment(s) omitted'));
  });

  it('keeps entries newest-first and drops from the end', () => {
    // budget = 3 tokens * 4 = 12 chars total
    const history = ['AAAA', 'BBBB', 'CCCC'];
    // 'AAAA' = 4+2=6, 'BBBB' = 4+2=6 => 12, fits exactly. 'CCCC' dropped.
    const result = buildMutatorPrompt({ ...DEFAULTS, history, maxHistoryTokens: 3 });
    assert.ok(result.includes('AAAA'));
    assert.ok(result.includes('BBBB'));
    assert.ok(!result.includes('CCCC'));
    assert.ok(result.includes('1 older experiment(s) omitted'));
  });

  it('reports correct count of dropped entries', () => {
    // budget = 2 tokens * 4 = 8 chars
    // 'AA' = 2+2=4, fits. 'BB'=4+2=8 => 4+4=8 fits. 'CC' and 'DD' dropped.
    // Wait: 'AA' len=2+2=4, 'BB' len=2+2=4, total=8 which equals budget so 'BB' fits.
    const history = ['AA', 'BB', 'CC', 'DD'];
    const result = buildMutatorPrompt({ ...DEFAULTS, history, maxHistoryTokens: 2 });
    assert.ok(result.includes('2 older experiment(s) omitted'));
  });

  // --- Single entry exceeding budget: hard truncation ---

  it('hard-truncates a single entry that exceeds the entire budget', () => {
    const longEntry = 'X'.repeat(200);
    // budget = 2 tokens * 4 = 8 chars. Entry is 200 chars, exceeds budget.
    const result = buildMutatorPrompt({ ...DEFAULTS, history: [longEntry], maxHistoryTokens: 2 });
    // Hard truncated to budget-3 chars + '...'
    assert.ok(result.includes('...'), 'should end with ellipsis');
    assert.ok(!result.includes('X'.repeat(200)), 'full entry should not appear');
    // The truncated text should be budget - 3 = 5 chars of X + '...'
    assert.ok(result.includes('XXXXX...'));
  });

  it('hard-truncated single entry length equals budget chars', () => {
    const longEntry = 'Y'.repeat(500);
    const maxTokens = 10; // budget = 40 chars
    const result = buildMutatorPrompt({ ...DEFAULTS, history: [longEntry], maxHistoryTokens: maxTokens });
    // Truncated to (40 - 3) = 37 Y's + '...' = 40 chars total
    const historySection = result.split('## History\n\n')[1].split('\n\n## Instructions')[0];
    assert.equal(historySection.length, 40);
    assert.ok(historySection.endsWith('...'));
  });

  // --- Full file replacement instructions ---

  it('contains full file replacement instruction', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    assert.ok(result.includes('COMPLETE replacement skill file'));
  });

  it('instructs no diffs or partial edits', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    assert.ok(result.includes('no diffs, no partial edits'));
  });

  it('instructs to respond with only skill file content', () => {
    const result = buildMutatorPrompt(DEFAULTS);
    assert.ok(result.includes('Respond with only the new skill file content'));
  });

  // --- Default maxHistoryTokens is 4000 ---

  it('defaults maxHistoryTokens to 4000 (fits ~16000 chars of history)', () => {
    // With default 4000 tokens = 16000 chars budget
    // Create history that fits in 16000 but would not fit in, say, 1000
    const entry = 'Z'.repeat(5000); // 5000 + 2 = 5002 chars each
    const history = [entry, entry, entry]; // 3 * 5002 = 15006 chars, fits in 16000
    const result = buildMutatorPrompt({ ...DEFAULTS, history });
    // All three should be present with the default budget
    const count = (result.match(/Z{5000}/g) || []).length;
    assert.equal(count, 3, 'all three entries should be included with default 4000 token budget');
    assert.ok(!result.includes('omitted'));
  });

  // --- Input validation ---

  it('throws when skillContent is missing', () => {
    assert.throws(() => buildMutatorPrompt({ hypothesis: 'hyp' }), /skillContent must be a non-empty string/);
  });

  it('throws when skillContent is empty string', () => {
    assert.throws(() => buildMutatorPrompt({ skillContent: '', hypothesis: 'hyp' }), /skillContent must be a non-empty string/);
  });

  it('throws when hypothesis is missing', () => {
    assert.throws(() => buildMutatorPrompt({ skillContent: 'skill' }), /hypothesis must be a non-empty string/);
  });

  it('throws when hypothesis is empty string', () => {
    assert.throws(() => buildMutatorPrompt({ skillContent: 'skill', hypothesis: '' }), /hypothesis must be a non-empty string/);
  });

  // --- Edge cases ---

  it('trims trailing whitespace from skillContent and hypothesis', () => {
    const result = buildMutatorPrompt({ skillContent: 'skill  \n\n', hypothesis: 'hyp  \n' });
    // After ## Skill, should have trimmed content
    const skillSection = result.split('## Skill\n\n')[1].split('\n\n## Hypothesis')[0];
    assert.equal(skillSection, 'skill');
    const hypSection = result.split('## Hypothesis\n\n')[1].split('\n\n## History')[0];
    assert.equal(hypSection, 'hyp');
  });
});
