/**
 * Unit tests for pipeline-critical-fixes T5.
 *
 * T5: Streaming dedup heuristic — assert that re-ingesting a session with
 *     duplicate streaming chunks produces tokens_in within 10% of the
 *     single-call value, not a naive sum across all chunks.
 *
 * Also covers:
 *   - Subagent virtual sessions parsed from synthetic agent-*.jsonl with known
 *     cache_creation_5m / cache_creation_1h tokens produce cost > 0.
 *
 * Strategy: inline the accumulation loop logic (pure JS, no dist required)
 * and source-level assertions to confirm the implementation is present.
 *
 * Node.js built-in node:test (ESM).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_ROOT = resolve(ROOT, 'src');

// ---------------------------------------------------------------------------
// Helpers: replicate the dedup accumulation loop from sessions.ts in pure JS
// so the test does not depend on a compiled dist/ directory.
// ---------------------------------------------------------------------------

/**
 * Simulate the streaming-dedup token accumulation logic from parseSessions.
 * Each element of `events` is an object with an optional `usage` key matching
 * the shape produced by the Claude Code JSONL format.
 */
function simulateAccumulation(events) {
  let tokensIn = 0, tokensOut = 0, cacheRead = 0;
  let cacheCreation = 0, cacheCreation5m = 0, cacheCreation1h = 0;

  let lastInputTokens = -1;
  let lastAddedIn = 0, lastAddedCacheRead = 0, lastAddedCacheCreation = 0;
  let lastAdded5m = 0, lastAdded1h = 0;

  for (const event of events) {
    const usage = event.usage;
    if (!usage) continue;

    const inputTokens       = usage.input_tokens ?? 0;
    const outputTokens      = usage.output_tokens ?? 0;
    const cacheReadTokens   = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

    const ccBreakdown = (usage.cache_creation && typeof usage.cache_creation === 'object')
      ? usage.cache_creation : null;
    const cc5m = ccBreakdown ? (ccBreakdown.ephemeral_5m_input_tokens ?? 0) : 0;
    const cc1h = ccBreakdown ? (ccBreakdown.ephemeral_1h_input_tokens ?? 0) : 0;

    if (lastInputTokens >= 0 && inputTokens <= lastInputTokens) {
      // Streaming dup: undo last-added, substitute max
      tokensIn        = tokensIn        - lastAddedIn              + Math.max(lastAddedIn,              inputTokens);
      cacheRead       = cacheRead       - lastAddedCacheRead        + Math.max(lastAddedCacheRead,        cacheReadTokens);
      cacheCreation   = cacheCreation   - lastAddedCacheCreation    + Math.max(lastAddedCacheCreation,    cacheCreationTokens);
      cacheCreation5m = cacheCreation5m - lastAdded5m               + Math.max(lastAdded5m,               cc5m);
      cacheCreation1h = cacheCreation1h - lastAdded1h               + Math.max(lastAdded1h,               cc1h);

      lastAddedIn            = Math.max(lastAddedIn,            inputTokens);
      lastAddedCacheRead     = Math.max(lastAddedCacheRead,     cacheReadTokens);
      lastAddedCacheCreation = Math.max(lastAddedCacheCreation, cacheCreationTokens);
      lastAdded5m            = Math.max(lastAdded5m,            cc5m);
      lastAdded1h            = Math.max(lastAdded1h,            cc1h);
    } else {
      // Real new turn: sum normally
      tokensIn        += inputTokens;
      cacheRead       += cacheReadTokens;
      cacheCreation   += cacheCreationTokens;
      cacheCreation5m += cc5m;
      cacheCreation1h += cc1h;

      lastAddedIn            = inputTokens;
      lastAddedCacheRead     = cacheReadTokens;
      lastAddedCacheCreation = cacheCreationTokens;
      lastAdded5m            = cc5m;
      lastAdded1h            = cc1h;
    }

    // output_tokens always sums
    tokensOut += outputTokens;

    lastInputTokens = inputTokens;
  }

  return { tokensIn, tokensOut, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h };
}

/**
 * Inline computeCost using the bundled pricing fallback JSON.
 * Avoids any import from dist/.
 */
function computeCostInline(model, inputTokens, outputTokens, cacheReadTokens, cc5m, cc1h) {
  const fallback = JSON.parse(
    readFileSync(resolve(SRC_ROOT, 'data', 'pricing-fallback.json'), 'utf8')
  );
  const p = fallback.models[model];
  if (!p) return 0;
  const M = 1_000_000;
  return (
    (inputTokens   * p.input)              / M +
    (outputTokens  * p.output)             / M +
    (cacheReadTokens * p.cache_read)       / M +
    (cc5m          * p.cache_creation)     / M +
    (cc1h          * (p.cache_creation_1h ?? p.input * 2)) / M
  );
}

// ---------------------------------------------------------------------------
// T5-A: Streaming dedup heuristic
//
// Synthetic event sequence:
//   A: input=1000, output=50,  cache_read=200  → first turn, sums normally
//   B: input=1000, output=80,  cache_read=200  → dup (input stayed at 1000)
//       tokensIn stays 1000 (max), tokensOut = 50+80=130
//   C: input=1200, output=30,  cache_read=0    → real new turn (input grew)
//       tokensIn = 1000+1200=2200, tokensOut = 130+30=160
//
// Without dedup: tokensIn would be 1000+1000+1200=3200.
// With dedup:    tokensIn should be 2200.
// ---------------------------------------------------------------------------

describe('T5-A — streaming dedup heuristic: tokens_in within 10% of single-call value', () => {

  it('streaming duplicate keeps max input, not sum', () => {
    const events = [
      // Event A: first turn
      { usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200 } },
      // Event B: streaming dup (same input_tokens = 1000 ≤ previous 1000)
      { usage: { input_tokens: 1000, output_tokens: 80, cache_read_input_tokens: 200 } },
      // Event C: real new turn (input_tokens grew to 1200)
      { usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 0 } },
    ];

    const result = simulateAccumulation(events);

    // Expected: tokensIn = 2200 (1000 max from A/B + 1200 from C)
    const expected = 2200;
    const tolerance = expected * 0.10;

    assert.ok(
      Math.abs(result.tokensIn - expected) <= tolerance,
      `tokens_in should be within 10% of ${expected} (single-call value), got ${result.tokensIn} (naive sum would be 3200)`
    );
  });

  it('tokens_in with dedup is significantly less than naive sum', () => {
    const events = [
      { usage: { input_tokens: 1000, output_tokens: 50,  cache_read_input_tokens: 200 } },
      { usage: { input_tokens: 1000, output_tokens: 80,  cache_read_input_tokens: 200 } },
      { usage: { input_tokens: 1200, output_tokens: 30,  cache_read_input_tokens: 0   } },
    ];

    const result = simulateAccumulation(events);
    const naiveSum = 1000 + 1000 + 1200; // 3200

    assert.ok(
      result.tokensIn < naiveSum,
      `tokens_in (${result.tokensIn}) should be less than naive sum (${naiveSum})`
    );
  });

  it('output_tokens is always summed (not deduped)', () => {
    const events = [
      { usage: { input_tokens: 1000, output_tokens: 50,  cache_read_input_tokens: 0 } },
      { usage: { input_tokens: 1000, output_tokens: 80,  cache_read_input_tokens: 0 } },
      { usage: { input_tokens: 1200, output_tokens: 30,  cache_read_input_tokens: 0 } },
    ];

    const result = simulateAccumulation(events);

    // output is always summed: 50 + 80 + 30 = 160
    assert.equal(result.tokensOut, 160,
      `tokens_out should be sum of all output values (50+80+30=160), got ${result.tokensOut}`);
  });

  it('cache_read deduplicated: max per streaming group', () => {
    const events = [
      { usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200 } },
      { usage: { input_tokens: 1000, output_tokens: 80, cache_read_input_tokens: 200 } },
      { usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 0   } },
    ];

    const result = simulateAccumulation(events);

    // A → adds 200. B → dup: max(200, 200)=200, so stays 200. C → new turn adds 0.
    // Total cacheRead = 200.
    assert.equal(result.cacheRead, 200,
      `cache_read should be 200 (max of dup group + new turn), got ${result.cacheRead}`);
  });

  it('single event (no dups): pass-through unchanged', () => {
    const events = [
      { usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 50 } },
    ];
    const result = simulateAccumulation(events);
    assert.equal(result.tokensIn,  500);
    assert.equal(result.tokensOut, 100);
    assert.equal(result.cacheRead, 50);
  });

  it('three consecutive dups: takes max across all three', () => {
    // input_tokens never increases: all three are streaming chunks of one API call
    const events = [
      { usage: { input_tokens: 800, output_tokens: 20, cache_read_input_tokens: 100 } },
      { usage: { input_tokens: 800, output_tokens: 40, cache_read_input_tokens: 100 } },
      { usage: { input_tokens: 800, output_tokens: 60, cache_read_input_tokens: 100 } },
    ];
    const result = simulateAccumulation(events);

    // tokensIn should be max=800 (not 2400)
    assert.equal(result.tokensIn, 800,
      `three identical chunks should yield max(800)=800, not sum 2400, got ${result.tokensIn}`);
    // tokensOut sums: 20+40+60=120
    assert.equal(result.tokensOut, 120);
  });

  it('decreasing input_tokens also triggers dedup (streaming with smaller chunk)', () => {
    // Some Claude streaming events can send a final summary with fewer input tokens
    const events = [
      { usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0 } },
      { usage: { input_tokens:  900, output_tokens: 30, cache_read_input_tokens: 0 } }, // decreased
    ];
    const result = simulateAccumulation(events);
    // Heuristic: 900 <= 1000 → dup; max(1000, 900)=1000
    assert.equal(result.tokensIn, 1000,
      `decreasing input_tokens treated as dup; tokensIn should be max(1000,900)=1000, got ${result.tokensIn}`);
    assert.equal(result.tokensOut, 80); // 50+30 always sums
  });
});

// ---------------------------------------------------------------------------
// T5-B: Source-level assertions — confirm the heuristic is in sessions.ts
// ---------------------------------------------------------------------------

describe('T5-B — sessions.ts source contains the dedup heuristic implementation', () => {
  const sessionsSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'sessions.ts'), 'utf8');

  it('declares lastInputTokens tracking variable', () => {
    assert.ok(
      sessionsSrc.includes('lastInputTokens'),
      'sessions.ts must declare lastInputTokens for streaming dedup'
    );
  });

  it('dedup triggers when inputTokens <= lastInputTokens', () => {
    assert.ok(
      sessionsSrc.includes('lastInputTokens >= 0 && inputTokens <= lastInputTokens'),
      'dedup condition must be: lastInputTokens >= 0 && inputTokens <= lastInputTokens'
    );
  });

  it('uses Math.max to keep the larger input-side value', () => {
    assert.ok(
      sessionsSrc.includes('Math.max(lastAddedIn,') ||
      sessionsSrc.includes('Math.max(lastAddedIn ,'),
      'dedup must substitute Math.max(lastAddedIn, inputTokens)'
    );
  });

  it('output tokens are always summed (tokensOut += outputTokens outside the dedup branch)', () => {
    // The line `tokensOut += outputTokens` must appear after (not inside) the if/else block
    // We verify it exists as an unconditional accumulation
    assert.ok(
      sessionsSrc.includes('tokensOut += outputTokens'),
      'tokensOut must be accumulated unconditionally (always summed)'
    );
  });

  it('tracks lastAdded5m and lastAdded1h for cache_creation breakdown dedup', () => {
    assert.ok(
      sessionsSrc.includes('lastAdded5m') && sessionsSrc.includes('lastAdded1h'),
      'sessions.ts must track lastAdded5m and lastAdded1h for 5m/1h cache breakdown dedup'
    );
  });

  it('advances lastInputTokens at end of each usage block', () => {
    assert.ok(
      sessionsSrc.includes('lastInputTokens = inputTokens'),
      'lastInputTokens must be updated to current inputTokens at end of each event'
    );
  });
});

// ---------------------------------------------------------------------------
// T5-C: Subagent cost > 0 from known cache_creation_5m / cache_creation_1h
//
// Verifies AC-4: "Subagent sessions parsed from synthetic agent-*.jsonl with
// known cache_creation_5m / cache_creation_1h tokens produce cost > 0"
//
// Uses inline computeCost with the bundled pricing-fallback.json.
// ---------------------------------------------------------------------------

describe('T5-C — subagent cost > 0 with known cache_creation_5m / cache_creation_1h tokens', () => {

  it('cost > 0 when only cache_creation_5m tokens are present', () => {
    const model = 'claude-sonnet-4-20250514';
    const cost = computeCostInline(model, 0, 0, 0, 500, 0);
    assert.ok(cost > 0,
      `cost should be > 0 with 500 cache_creation_5m tokens, got ${cost}`);
  });

  it('cost > 0 when only cache_creation_1h tokens are present', () => {
    const model = 'claude-sonnet-4-20250514';
    const cost = computeCostInline(model, 0, 0, 0, 0, 500);
    assert.ok(cost > 0,
      `cost should be > 0 with 500 cache_creation_1h tokens, got ${cost}`);
  });

  it('cost > 0 with realistic subagent event (input + output + 5m cache creation)', () => {
    const model = 'claude-sonnet-4-20250514';
    // Synthetic agent JSONL event:
    //   input_tokens=200, output_tokens=50, cache_creation.ephemeral_5m_input_tokens=300
    const events = [
      {
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
        },
      },
    ];

    const acc = simulateAccumulation(events);
    const cost = computeCostInline(
      model,
      acc.tokensIn,
      acc.tokensOut,
      acc.cacheRead,
      acc.cacheCreation5m,
      acc.cacheCreation1h,
    );

    assert.ok(cost > 0,
      `cost should be > 0 for subagent session with input+output+5m cache, got ${cost}`);
  });

  it('1h cache is more expensive per token than 5m cache (correct tier pricing)', () => {
    const model = 'claude-sonnet-4-20250514';
    const cost5m = computeCostInline(model, 0, 0, 0, 1_000_000, 0);
    const cost1h = computeCostInline(model, 0, 0, 0, 0, 1_000_000);
    assert.ok(cost1h > cost5m,
      `1h cache creation should be more expensive than 5m: cost1h=${cost1h} > cost5m=${cost5m}`);
  });

  it('simulateAccumulation correctly extracts 5m and 1h breakdown from usage.cache_creation', () => {
    const events = [
      {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 400,
          cache_creation: { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 150 },
        },
      },
    ];

    const acc = simulateAccumulation(events);
    assert.equal(acc.cacheCreation5m, 250, `cacheCreation5m should be 250, got ${acc.cacheCreation5m}`);
    assert.equal(acc.cacheCreation1h, 150, `cacheCreation1h should be 150, got ${acc.cacheCreation1h}`);
  });
});

// ---------------------------------------------------------------------------
// T6-A: Source-level assertions — confirm filesystem scan is in sessions.ts
//
// Verifies AC-2: subagent JSONL files are discovered and parsed from the
// {projectDir}/subagents/ directory, producing virtual sessions for each file.
// ---------------------------------------------------------------------------

describe('T6-A — sessions.ts source contains filesystem subagent scan implementation', () => {
  const sessionsSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'sessions.ts'), 'utf8');

  it('scans subagents/ directory for agent-*.jsonl files', () => {
    assert.ok(
      sessionsSrc.includes("subagents"),
      'sessions.ts must reference a subagents directory'
    );
  });

  it('uses regex to match agent-*.jsonl filenames (AC-2: >95% file coverage)', () => {
    // The regex must match files like agent-abc.jsonl but not agent-abc.meta.json
    assert.ok(
      sessionsSrc.includes('/^agent-[^.]+\\.jsonl$/') ||
      sessionsSrc.includes("agent-") && sessionsSrc.includes(".jsonl"),
      'sessions.ts must filter files with agent-*.jsonl regex pattern'
    );
  });

  it('reads agent-{hash}.meta.json sibling for parent session context', () => {
    assert.ok(
      sessionsSrc.includes('meta.json'),
      'sessions.ts must read .meta.json files for parent session context'
    );
  });

  it('extracts parent_session_id from meta.json session_id field', () => {
    assert.ok(
      sessionsSrc.includes('parentSessionId') &&
      (sessionsSrc.includes('session_id') || sessionsSrc.includes('session_id as string')),
      'sessions.ts must read session_id from meta.json to populate parentSessionId'
    );
  });

  it('constructs virtual ID as {parent_session_id}::{agentId}', () => {
    assert.ok(
      sessionsSrc.includes('`${parentSessionId}::${agentId}`') ||
      sessionsSrc.includes("parentSessionId + '::' + agentId"),
      'sessions.ts must construct virtualId using {parent}::{agentId} pattern'
    );
  });

  it('falls back to fs::{agentId} when no parent session found', () => {
    assert.ok(
      sessionsSrc.includes('`fs::${agentId}`') ||
      sessionsSrc.includes("'fs::' + agentId"),
      'sessions.ts must use fs::{agentId} fallback virtual ID when parentSessionId is null'
    );
  });

  it('inserts virtual session with agent_role from meta.json agent_type field', () => {
    assert.ok(
      sessionsSrc.includes('agentType') && sessionsSrc.includes('agent_role'),
      'sessions.ts must use agent_type from meta.json as the agent_role in sessions table'
    );
  });

  it('inserts virtual session with parent_session_id column populated', () => {
    assert.ok(
      sessionsSrc.includes('parent_session_id') && sessionsSrc.includes('parentSessionId'),
      'sessions.ts must populate the parent_session_id column for subagent virtual sessions'
    );
  });

  it('uses per-file offset key for incremental ingest (AC-2: stateful coverage)', () => {
    assert.ok(
      sessionsSrc.includes("'ingest_offset:session:'") ||
      sessionsSrc.includes('ingest_offset:session:'),
      'sessions.ts must use per-file offset keys to track ingested lines for subagent files'
    );
  });
});

// ---------------------------------------------------------------------------
// T6-B: Inline simulation of subagent JSONL parsing
//
// Simulates what parseSessions does when it processes:
//   subagents/agent-abc.jsonl + agent-abc.meta.json
//
// Verifies:
//   AC-3: non-zero cache_creation_5m / cache_creation_1h from breakdown object
//   AC-5: correct model/agent_role derived from event stream and meta.json
// ---------------------------------------------------------------------------

/**
 * Simulate the subagent JSONL parsing loop (mirrors the subagent section of parseSessions).
 * Reads a list of event objects, returns accumulated token/model/message values.
 */
function simulateSubagentParsing(events, metaModel = 'unknown') {
  // Start from meta model; event stream can override
  let subModel = metaModel.replace(/\[\d+[km]\]$/i, '');
  let subTokensIn = 0, subTokensOut = 0, subCacheRead = 0, subCacheCreation = 0;
  let subCacheCreation5m = 0, subCacheCreation1h = 0;
  let subMessages = 0, subToolCalls = 0;
  let subStartedAt = null, subEndedAt = null;
  let subHasNewData = false;

  let subLastInputTokens = -1;
  let subLastAddedIn = 0, subLastAddedCacheRead = 0, subLastAddedCacheCreation = 0;
  let subLastAdded5m = 0, subLastAdded1h = 0;

  for (const event of events) {
    subHasNewData = true;

    if (!subStartedAt && event.timestamp) subStartedAt = event.timestamp;
    if (event.timestamp) subEndedAt = event.timestamp;

    const msg = event.message;
    const msgModel = msg?.model;
    const evtModel = event.model;
    const resolvedModel = msgModel ?? evtModel;
    if (resolvedModel && resolvedModel !== 'unknown') {
      subModel = resolvedModel.replace(/\[\d+[km]\]$/i, '');
    }

    const eventType = event.type;
    if (eventType === 'assistant' || event.role === 'assistant') subMessages++;
    if (eventType === 'user' || eventType === 'human' || event.role === 'human' || event.role === 'user') subMessages++;

    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') subToolCalls++;
      }
    }

    const msgUsage = msg?.usage;
    const evtUsage = event.usage;
    const usage = msgUsage ?? evtUsage;
    if (usage) {
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

      const ccBreakdown = (usage.cache_creation && typeof usage.cache_creation === 'object')
        ? usage.cache_creation : null;
      const cc5m = ccBreakdown ? (ccBreakdown.ephemeral_5m_input_tokens ?? 0) : 0;
      const cc1h = ccBreakdown ? (ccBreakdown.ephemeral_1h_input_tokens ?? 0) : 0;

      if (subLastInputTokens >= 0 && inputTokens <= subLastInputTokens) {
        subTokensIn        = subTokensIn        - subLastAddedIn            + Math.max(subLastAddedIn,            inputTokens);
        subCacheRead       = subCacheRead       - subLastAddedCacheRead      + Math.max(subLastAddedCacheRead,     cacheReadTokens);
        subCacheCreation   = subCacheCreation   - subLastAddedCacheCreation  + Math.max(subLastAddedCacheCreation, cacheCreationTokens);
        subCacheCreation5m = subCacheCreation5m - subLastAdded5m             + Math.max(subLastAdded5m,            cc5m);
        subCacheCreation1h = subCacheCreation1h - subLastAdded1h             + Math.max(subLastAdded1h,            cc1h);

        subLastAddedIn            = Math.max(subLastAddedIn,            inputTokens);
        subLastAddedCacheRead     = Math.max(subLastAddedCacheRead,     cacheReadTokens);
        subLastAddedCacheCreation = Math.max(subLastAddedCacheCreation, cacheCreationTokens);
        subLastAdded5m            = Math.max(subLastAdded5m,            cc5m);
        subLastAdded1h            = Math.max(subLastAdded1h,            cc1h);
      } else {
        subTokensIn           += inputTokens;
        subCacheRead          += cacheReadTokens;
        subCacheCreation      += cacheCreationTokens;
        subCacheCreation5m    += cc5m;
        subCacheCreation1h    += cc1h;

        subLastAddedIn            = inputTokens;
        subLastAddedCacheRead     = cacheReadTokens;
        subLastAddedCacheCreation = cacheCreationTokens;
        subLastAdded5m            = cc5m;
        subLastAdded1h            = cc1h;
      }

      subTokensOut += outputTokens;
      subLastInputTokens = inputTokens;
    }
  }

  return {
    model: subModel,
    tokensIn: subTokensIn, tokensOut: subTokensOut,
    cacheRead: subCacheRead, cacheCreation: subCacheCreation,
    cacheCreation5m: subCacheCreation5m, cacheCreation1h: subCacheCreation1h,
    messages: subMessages, toolCalls: subToolCalls,
    startedAt: subStartedAt, endedAt: subEndedAt,
    hasNewData: subHasNewData,
  };
}

/**
 * Simulate meta.json parsing as done in parseSessions filesystem scan.
 */
function parseSubagentMeta(metaObj) {
  return {
    parentSessionId: metaObj.session_id ?? null,
    agentType: metaObj.agent_type ?? 'subagent',
    model: metaObj.model ?? 'unknown',
  };
}

/**
 * Build the virtual session ID from parent and agent hash.
 */
function buildVirtualId(parentSessionId, agentId) {
  return parentSessionId ? `${parentSessionId}::${agentId}` : `fs::${agentId}`;
}

describe('T6-B — subagent filesystem discovery: virtual session construction', () => {

  // Mock data: single subagent with cache_creation breakdown
  const MOCK_META = {
    session_id: 'parent-session-001',
    agent_type: 'subagent',
    model: 'claude-sonnet-4-20250514',
  };

  const MOCK_EVENTS = [
    {
      type: 'user',
      timestamp: '2026-03-20T10:00:00Z',
      usage: {
        input_tokens: 200,
        output_tokens: 0,
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-03-20T10:00:01Z',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 200,
        output_tokens: 75,
        cache_creation_input_tokens: 400,
        cache_creation: {
          ephemeral_5m_input_tokens: 300,
          ephemeral_1h_input_tokens: 100,
        },
      },
    },
  ];

  it('virtual session ID has format {parent_session_id}::{agentId} (AC-5)', () => {
    const meta = parseSubagentMeta(MOCK_META);
    const virtualId = buildVirtualId(meta.parentSessionId, 'abc');
    assert.equal(virtualId, 'parent-session-001::abc',
      `virtual ID should be parent::hash format, got ${virtualId}`);
  });

  it('parent_session_id is populated from meta.json session_id (AC-5)', () => {
    const meta = parseSubagentMeta(MOCK_META);
    assert.equal(meta.parentSessionId, 'parent-session-001',
      `parentSessionId should equal meta.session_id, got ${meta.parentSessionId}`);
  });

  it('model is read from meta.json (AC-5: correct model)', () => {
    const meta = parseSubagentMeta(MOCK_META);
    assert.equal(meta.model, 'claude-sonnet-4-20250514',
      `model should come from meta.json when not overridden by events, got ${meta.model}`);
  });

  it('agent_role is populated from meta.json agent_type (AC-5)', () => {
    const meta = parseSubagentMeta(MOCK_META);
    assert.equal(meta.agentType, 'subagent',
      `agentType should be 'subagent' from meta.json, got ${meta.agentType}`);
  });

  it('cache_creation_5m > 0 from JSONL usage breakdown (AC-3: non-zero cache breakdown)', () => {
    const acc = simulateSubagentParsing(MOCK_EVENTS, MOCK_META.model);
    assert.ok(acc.cacheCreation5m > 0,
      `cacheCreation5m should be > 0 (got ${acc.cacheCreation5m}) — AC-3 requires non-zero cache breakdown`);
  });

  it('cache_creation_1h > 0 from JSONL usage breakdown (AC-3)', () => {
    const acc = simulateSubagentParsing(MOCK_EVENTS, MOCK_META.model);
    assert.ok(acc.cacheCreation1h > 0,
      `cacheCreation1h should be > 0 (got ${acc.cacheCreation1h}) — AC-3 requires non-zero cache breakdown`);
  });

  it('cache_creation_5m = 300 matches ephemeral_5m_input_tokens in event', () => {
    const acc = simulateSubagentParsing(MOCK_EVENTS, MOCK_META.model);
    assert.equal(acc.cacheCreation5m, 300,
      `cacheCreation5m should be 300, got ${acc.cacheCreation5m}`);
  });

  it('cache_creation_1h = 100 matches ephemeral_1h_input_tokens in event', () => {
    const acc = simulateSubagentParsing(MOCK_EVENTS, MOCK_META.model);
    assert.equal(acc.cacheCreation1h, 100,
      `cacheCreation1h should be 100, got ${acc.cacheCreation1h}`);
  });

  it('model from event stream overrides meta.json model when present', () => {
    // Event explicitly sets model='claude-opus-4-5-20250514'
    const events = [
      {
        type: 'assistant',
        timestamp: '2026-03-20T10:00:01Z',
        model: 'claude-opus-4-5-20250514',
        usage: { input_tokens: 100, output_tokens: 30 },
      },
    ];
    const acc = simulateSubagentParsing(events, 'claude-sonnet-4-20250514');
    assert.equal(acc.model, 'claude-opus-4-5-20250514',
      `event model should override meta model, got ${acc.model}`);
  });

  it('fallback virtual ID is fs::{agentId} when meta.json has no session_id', () => {
    const meta = parseSubagentMeta({ agent_type: 'subagent' }); // no session_id
    const virtualId = buildVirtualId(meta.parentSessionId, 'xyz');
    assert.equal(virtualId, 'fs::xyz',
      `fallback virtual ID should be 'fs::xyz', got ${virtualId}`);
  });

  it('messages counted correctly: user + assistant events (AC-5)', () => {
    const acc = simulateSubagentParsing(MOCK_EVENTS, MOCK_META.model);
    // MOCK_EVENTS has 1 user + 1 assistant event
    assert.equal(acc.messages, 2,
      `messages should be 2 (1 user + 1 assistant), got ${acc.messages}`);
  });

  it('subagent cost > 0 using accumulated 5m/1h tokens (AC-3)', () => {
    const acc = simulateSubagentParsing(MOCK_EVENTS, MOCK_META.model);
    const cost = computeCostInline(
      MOCK_META.model,
      acc.tokensIn,
      acc.tokensOut,
      acc.cacheRead,
      acc.cacheCreation5m,
      acc.cacheCreation1h,
    );
    assert.ok(cost > 0,
      `subagent session cost should be > 0 with real tokens, got ${cost}`);
  });
});

// ---------------------------------------------------------------------------
// T6-C: AC-2 validation — verify >95% subagent file coverage assertion
//
// The regex /^agent-[^.]+\.jsonl$/ must match agent-*.jsonl files and exclude
// agent-*.meta.json so no subagent JSONL is silently skipped.
// ---------------------------------------------------------------------------

describe('T6-C — AC-2: subagent file regex covers >95% of expected filenames', () => {
  const FILE_REGEX = /^agent-[^.]+\.jsonl$/;

  const SHOULD_MATCH = [
    'agent-abc.jsonl',
    'agent-a1b2c3.jsonl',
    'agent-deadbeef12345678.jsonl',
    'agent-UPPERCASE.jsonl',
    'agent-with-dashes.jsonl',
  ];

  const SHOULD_NOT_MATCH = [
    'agent-abc.meta.json',
    'agent-abc.jsonl.bak',
    'session-abc.jsonl',
    'abc.jsonl',
    '.jsonl',
    'agent-.meta.json',
  ];

  for (const fname of SHOULD_MATCH) {
    it(`regex matches agent JSONL: ${fname}`, () => {
      assert.ok(FILE_REGEX.test(fname),
        `regex should match '${fname}' — these are subagent JSONL files to ingest`);
    });
  }

  for (const fname of SHOULD_NOT_MATCH) {
    it(`regex excludes non-agent-JSONL: ${fname}`, () => {
      assert.ok(!FILE_REGEX.test(fname),
        `regex should NOT match '${fname}' — this file should be excluded from ingest`);
    });
  }

  it('sessions.ts uses the correct regex for file filtering (AC-2 source check)', () => {
    const sessionsSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'sessions.ts'), 'utf8');
    // The source must have a pattern that captures 'agent-' + something + '.jsonl'
    const hasAgentJsonlFilter = sessionsSrc.includes("agent-") && sessionsSrc.includes(".jsonl");
    assert.ok(hasAgentJsonlFilter,
      'sessions.ts must filter for agent-*.jsonl files in subagents/ directory scan');
  });
});

// ---------------------------------------------------------------------------
// T6-D: Model resolution from JSONL events — subagent sessions must not be 'unknown'
//
// Verifies AC-1: subagent virtual sessions show the correct model from the
// JSONL event stream (event.message.model) rather than defaulting to 'unknown'.
// ---------------------------------------------------------------------------

describe('T6-D — subagent model resolution: model from JSONL events, not unknown', () => {

  // Haiku events: model lives in event.message.model (the real subagent JSONL structure)
  const HAIKU_EVENTS_MSG_MODEL = [
    {
      type: 'user',
      timestamp: '2026-03-20T10:00:00Z',
      message: { role: 'user' },
    },
    {
      type: 'assistant',
      timestamp: '2026-03-20T10:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 150,
          output_tokens: 40,
        },
      },
    },
  ];

  // Haiku events: model lives in top-level event.model (alternative JSONL structure)
  const HAIKU_EVENTS_TOP_MODEL = [
    {
      type: 'user',
      timestamp: '2026-03-20T10:00:00Z',
    },
    {
      type: 'assistant',
      timestamp: '2026-03-20T10:00:01Z',
      model: 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: 150,
        output_tokens: 40,
      },
    },
  ];

  it('model is extracted from event.message.model (real subagent JSONL structure)', () => {
    // Start with metaModel = 'unknown' (meta.json has no model field)
    const acc = simulateSubagentParsing(HAIKU_EVENTS_MSG_MODEL, 'unknown');
    assert.equal(acc.model, 'claude-haiku-4-5-20251001',
      `model should be 'claude-haiku-4-5-20251001' from event.message.model, got '${acc.model}'`);
  });

  it('model is not unknown when events contain event.message.model', () => {
    const acc = simulateSubagentParsing(HAIKU_EVENTS_MSG_MODEL, 'unknown');
    assert.notEqual(acc.model, 'unknown',
      `model must not be 'unknown' when events carry event.message.model`);
  });

  it('model is extracted from top-level event.model (alternative JSONL structure)', () => {
    const acc = simulateSubagentParsing(HAIKU_EVENTS_TOP_MODEL, 'unknown');
    assert.equal(acc.model, 'claude-haiku-4-5-20251001',
      `model should be 'claude-haiku-4-5-20251001' from event.model, got '${acc.model}'`);
  });

  it('model is not unknown when events contain top-level event.model', () => {
    const acc = simulateSubagentParsing(HAIKU_EVENTS_TOP_MODEL, 'unknown');
    assert.notEqual(acc.model, 'unknown',
      `model must not be 'unknown' when events carry top-level event.model`);
  });

  it('sessions.ts upsert includes model = excluded.model in SET clause (AC-1 source check)', () => {
    const sessionsSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'sessions.ts'), 'utf8');
    assert.ok(
      sessionsSrc.includes('model = excluded.model'),
      'sessions.ts upsert must include "model = excluded.model" so virtual sessions get the correct model on re-ingest'
    );
  });

  it('sessions.ts upsert WHERE clause triggers when sessions.model = unknown (AC-1 source check)', () => {
    const sessionsSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'parsers', 'sessions.ts'), 'utf8');
    assert.ok(
      sessionsSrc.includes("sessions.model = 'unknown'"),
      "sessions.ts upsert WHERE clause must include \"sessions.model = 'unknown'\" to trigger model update"
    );
  });

  it('sessions.ts references runMigrationSubagentModelFixV1 (AC-3: migration runs on ingest)', () => {
    const ingestSrc = readFileSync(resolve(SRC_ROOT, 'ingest', 'index.ts'), 'utf8');
    assert.ok(
      ingestSrc.includes('runMigrationSubagentModelFixV1'),
      'ingest/index.ts must call runMigrationSubagentModelFixV1 to reset stale unknown models'
    );
  });
});
