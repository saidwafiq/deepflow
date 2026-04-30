---
hypothesis: "PreToolUse:Bash payload contains at least one field that deterministically distinguishes orchestrator from subagent calls without mtime heuristics"
inputs_hash: "2c9a81b3f27ab63404cac9e9226ad80c4ecb44d7a977fae30288e45a77529abb"
command: "Read hooks/lib/agent-role.js, hooks/df-bash-scope.js, .deepflow/codebase/INTEGRATIONS.md; analyzed telemetry"
exit_code: 0
assertions:
  - metric: caller_field_identified
    expected: "at least one field uniquely identifies subagent vs orchestrator"
    observed: "transcript_path and session_id documented but not empirically verified"
    pass: false
  - metric: deterministic_no_mtime
    expected: "identification works without mtime/recency heuristics"
    observed: "Cannot verify without raw payload data"
    pass: false
status: inconclusive
files:
  - /Users/saidsalles/apps/agentSkills/deepflow/hooks/lib/agent-role.js
  - /Users/saidsalles/apps/agentSkills/deepflow/hooks/df-bash-scope.js
  - /Users/saidsalles/apps/agentSkills/deepflow/.deepflow/codebase/INTEGRATIONS.md
  - /tmp/probe-payload-fields.js
---

## Hypothesis

The PreToolUse:Bash JSON stdin payload contains at least one of `agent_id`, `parent_uuid`, `caller_kind`, `transcript_path`, or `session_id` that lets a hook deterministically distinguish an orchestrator-issued Bash call from a subagent-issued one without mtime heuristics.

## Method

1. Read `.deepflow/bash-telemetry.jsonl` (4048 lines): telemetry contains DERIVED data (role computed by inferAgentRole), not raw payload fields
2. Read hooks/df-bash-telemetry.js: accesses `tool_name`, `tool_input.command`, `cwd`, `tool_result` but does NOT persist full payload
3. Read hooks/lib/agent-role.js line 212–229: accesses `payload.cwd` (line 218) and `payload.transcript_path` (line 222)
4. Read .deepflow/codebase/INTEGRATIONS.md line 43: documents payload schema as `tool_name, tool_input, cwd, session_id, transcript_path`
5. Read prior spike .deepflow/experiments/implement-bash-guard--subagent-field-in-pretooluse--failed.md line 104: "No `transcript_path` field found" (contradicts current code)
6. Attempted empirical verification: no raw payload dumps exist

## Results

### Contradiction Identified

- **Prior spike** (implement-bash-guard line 104): transcript_path is ABSENT
- **Current code** (agent-role.js line 222): transcript_path is USED
- **Documentation** (INTEGRATIONS.md line 43): transcript_path is DOCUMENTED

Resolution: Either Claude Code schema changed AFTER prior spike, OR prior spike had insufficient evidence, OR current code uses undefined field that gracefully returns null.

### Field Presence Matrix

| Field             | Documented | Used by code | Verified in raw payload |
|-------------------|------------|--------------|-------------------------|
| `cwd`             | Yes        | Yes          | No data                 |
| `session_id`      | Yes        | No           | No data                 |
| `transcript_path` | Yes        | Yes          | No data (contradicts prior spike) |
| `agent_id`        | No         | No           | No data                 |
| `parent_uuid`     | No         | No           | No data                 |
| `caller_kind`     | No         | No           | No data                 |

### Root Cause Analysis

Tier-2 inference (agent-role.js line 152–197) scans `<parent-sid>/subagents/*.meta.json` files and returns the agentType of the most-recently-modified .jsonl file within `staleMs` (default 5000ms). If an orchestrator-issued Bash call happens within the stale window after a subagent completes, Tier-2 misclassifies it as the subagent.

## Criteria Check

**Can we identify a deterministic caller field?**
- UNKNOWN — candidate fields (transcript_path, session_id) are documented/used but not empirically verified

**Does evidence confirm or refute hypothesis?**
- INCONCLUSIVE — cannot confirm or refute without raw payload data

## Conclusion

**INCONCLUSIVE** — Cannot validate hypothesis without empirical payload data.

### Why Inconclusive

1. Contradictory evidence between prior spike and current code
2. No raw payload dumps in telemetry (writes DERIVED data post-inference)
3. Candidate fields exist but are unverified

### Confidence

**LOW** — analysis grounded in code/docs but requires empirical data that doesn't exist

### Recommendation for T9

**Option A: Empirical payload capture (one-shot probe)**

Deploy `/tmp/probe-payload-fields.js` to capture raw payloads from orchestrator and subagent contexts.

Installation:
```bash
cp /tmp/probe-payload-fields.js ~/.claude/hooks/probe-payload-capture.js
# Add to settings.local.json: "hooks": {"PreToolUse": {"Bash": ["probe-payload-capture.js"]}}
```

Usage:
1. Run `ls` from orchestrator → `/tmp/probe-T7-orchestrator-*.json`
2. Spawn Task subagent with `ls` → `/tmp/probe-T7-subagent-*.json`
3. Compare: `diff <(jq .payload_keys /tmp/probe-T7-*.json)`
4. If fields/values differ → gate Tier-2 on that field
5. Remove probe hook

**Option B: Drop Tier-2**

If no usable field found:
1. Remove `inferAgentRoleViaTranscript` from agent-role.js
2. Gate on `payload.cwd` ONLY (Tier-1)
3. Require scoped subagents to run from task worktrees

**Option C: Explicit injection**

If Claude Code doesn't propagate parent context:
1. Write `.deepflow/runtime/active-subagent.json` on Task spawn
2. Hook reads this file if Tier-1 returns null

**Recommendation**: Try A first; if transcript_path/session_id work, gate on that. Otherwise fall back to B.

## Next Hypothesis

"PreToolUse:Bash payload is tool-centric (no parent-agent context), so agent identification MUST use observable side effects (cwd, git branch, sidecar files) not direct payload fields."
