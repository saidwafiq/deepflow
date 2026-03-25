'use strict';

/**
 * Mutator prompt builder for the skill-eval Karpathy loop.
 *
 * Layout follows the attention U-curve pattern:
 *   START zone: ## Skill + ## Hypothesis  (highest attention — task + context)
 *   MIDDLE zone: ## History               (lower attention — truncated experiment log)
 *   END zone:   ## Instructions           (highest attention — action directive)
 *
 * Full file replacement: the mutator is instructed to output the COMPLETE new
 * skill file, not a diff or partial edit.
 */

const CHARS_PER_TOKEN = 4; // rough estimate: 1 token ≈ 4 characters

/**
 * Truncate experiment history to fit within maxHistoryTokens, keeping the most
 * recent experiments first (they are assumed to be ordered newest → oldest in
 * the `history` array).
 *
 * @param {string[]} history  Array of experiment strings, most recent first.
 * @param {number}   maxTokens  Token budget for the history section.
 * @returns {string}  Concatenated history that fits within budget.
 */
function truncateHistory(history, maxTokens) {
  if (!history || history.length === 0) return '(no experiments yet)';

  const budget = maxTokens * CHARS_PER_TOKEN;
  const kept = [];
  let used = 0;

  for (const entry of history) {
    const entryChars = entry.length + 2; // +2 for the separating newlines
    if (used + entryChars > budget) break;
    kept.push(entry);
    used += entryChars;
  }

  if (kept.length === 0) {
    // Even the single most-recent entry exceeds budget — truncate it hard.
    const single = history[0].slice(0, budget - 3) + '...';
    return single;
  }

  const dropped = history.length - kept.length;
  const suffix = dropped > 0 ? `\n\n_(${dropped} older experiment(s) omitted to fit token budget)_` : '';
  return kept.join('\n\n') + suffix;
}

/**
 * Build the mutator prompt.
 *
 * @param {object} options
 * @param {string}   options.skillContent       Full text of the current skill file.
 * @param {string}   options.hypothesis         The current mutation hypothesis.
 * @param {string[]} [options.history=[]]       Experiment history strings, most recent first.
 * @param {number}   [options.maxHistoryTokens=4000]  Token budget for history section.
 * @returns {string}  The complete prompt string to send to the mutator LLM.
 */
function buildMutatorPrompt({
  skillContent,
  hypothesis,
  history = [],
  maxHistoryTokens = 4000,
}) {
  if (typeof skillContent !== 'string' || skillContent.length === 0) {
    throw new Error('skillContent must be a non-empty string');
  }
  if (typeof hypothesis !== 'string' || hypothesis.length === 0) {
    throw new Error('hypothesis must be a non-empty string');
  }

  const historyText = truncateHistory(history, maxHistoryTokens);

  return [
    '## Skill',
    '',
    skillContent.trimEnd(),
    '',
    '## Hypothesis',
    '',
    hypothesis.trimEnd(),
    '',
    '## History',
    '',
    historyText,
    '',
    '## Instructions',
    '',
    'You are mutating the skill file above to test the hypothesis.',
    '',
    'Rules:',
    '- Output the COMPLETE replacement skill file — no diffs, no partial edits.',
    '- Do not change the YAML frontmatter `name` or `description` fields.',
    '- Apply exactly ONE focused change that directly tests the hypothesis.',
    '- If the history shows this hypothesis already failed, try a different angle.',
    '- If the history shows a best-known state, you may backtrack to it and try a',
    '  smaller variation.',
    '',
    'Respond with only the new skill file content, starting with the YAML front matter.',
    'No prose, no explanation, no code fences.',
  ].join('\n');
}

module.exports = { buildMutatorPrompt };
