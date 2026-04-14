#!/usr/bin/env node
// @hook-event: PreToolUse
// @hook-owner: dashboard
/**
 * deepflow explore metrics logger
 * PreToolUse hook: captures explore phase-1 hit rate to explore-metrics.jsonl.
 *
 * Extracted from df-explore-protocol.js so that metrics ownership lives in the
 * dashboard package, not in the core deepflow hook.
 *
 * Fails open (exit 0) on all errors — never blocks tool execution.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinIfMain } = require('./lib/hook-stdin');

readStdinIfMain(module, (payload) => {
  try {
    const { tool_name, tool_input, cwd } = payload;

    if (tool_name !== 'Agent') {
      return;
    }
    const subagentType = (tool_input.subagent_type || '').toLowerCase();
    if (subagentType !== 'explore') {
      return;
    }

    const effectiveCwd = cwd || process.cwd();
    const originalPrompt = tool_input.prompt || '';

    // Determine phase1_hit by checking whether the injected LSP block is present.
    // This hook fires after df-explore-protocol has already modified the prompt, so
    // the presence of the LSP Phase marker signals a phase-1 hit on a prior cycle.
    // For the current cycle we cannot know the hit result from this hook alone, so
    // we record what is observable: whether the prompt already carries phase-1 data.
    const phase1Hit = originalPrompt.includes('[LSP Phase -- locations found]');

    try {
      const metricsDir = path.join(effectiveCwd, '.deepflow');
      const metricsPath = path.join(metricsDir, 'explore-metrics.jsonl');
      if (!fs.existsSync(metricsDir)) {
        fs.mkdirSync(metricsDir, { recursive: true });
      }
      const metricsEntry = {
        timestamp: new Date().toISOString(),
        query: originalPrompt,
        phase1_hit: phase1Hit,
        // tool_calls intentionally omitted: PreToolUse fires before execution,
        // so actual tool call counts are not observable here.
      };
      fs.appendFileSync(metricsPath, JSON.stringify(metricsEntry) + '\n', 'utf8');
    } catch (_) {
      // Metrics failure is silent — never blocks execution.
    }
  } catch (_) {
    // Fail open on all errors.
  }
});
