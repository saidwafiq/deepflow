'use strict';

/**
 * failures-only — strips passing test lines; surfaces only failures and summaries.
 *
 * Archetype: failures-only
 * Matches: test runner invocations (npm test, node --test, jest, vitest, mocha, etc.).
 *
 * apply() keeps:
 *   - Lines containing failure signals (FAIL, ✗, ✕, Error, not ok, failing, ×)
 *   - Stack-trace lines (indented `at ` lines following a failure)
 *   - Final summary line(s) (pass/fail totals)
 */

const MATCH_RE = /^(npm\s+(test|run\s+test)|node\s+--test\b|jest\b|vitest\b|mocha\b|tap\b|ava\b)/;

const FAIL_RE = /\b(FAIL|FAILED|FAILING|failing|Error:|not ok|✗|✕|×)\b/;
const PASS_RE = /\b(PASS|passing|ok\s+\d|✓|✔|passed)\b/;
const SUMMARY_RE = /\b(\d+\s+(passing|failing|skipped|tests?|assertions?))\b/i;
const STACK_RE = /^\s{2,}at\s+/;

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  return MATCH_RE.test(cmd.trimStart());
}

/**
 * @param {string} raw
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const lines = raw.split('\n');
  const kept = [];
  let inFailureBlock = false;
  let total = 0;
  let failures = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    total++;

    const isFail = FAIL_RE.test(line);
    const isSummary = SUMMARY_RE.test(line);
    const isStack = STACK_RE.test(line);

    if (isFail) {
      inFailureBlock = true;
      failures++;
      kept.push(line);
    } else if (isStack && inFailureBlock) {
      kept.push(line);
    } else if (isSummary) {
      inFailureBlock = false;
      kept.push(line);
    } else {
      inFailureBlock = false;
      // suppress passing lines
    }
  }

  const dropped = total - kept.length;
  const header = `# failures-only (${failures} failure(s), ${total} total lines → ${kept.length} kept)`;
  const body = kept.join('\n');

  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'failures-only', archetype: 'failures-only', match, apply };
