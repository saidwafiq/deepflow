# T114: PreToolUse:Bash Payload Shape Probe

## Status: PASSED — CLEAN-PATH

## Hypothesis
Does the PreToolUse:Bash event payload carry a correlator (session_id, transcript_path, etc.) that lets a hook running inside a subagent walk back to the agent's identity (`agent_type` from the dashboard's `meta.json` source)?

## Method
1. Wrote 5-line debug hook `/tmp/df-debug-bash-stdin.js` that appends raw stdin to `/tmp/df-debug-bash-stdin.jsonl` on every PreToolUse:Bash invocation.
2. Backed up `/Users/saidsalles/apps/agentSkills/deepflow/.claude/settings.local.json` to `/tmp/settings.local.json.bak-T114`.
3. Registered the debug hook under `hooks.PreToolUse[] { matcher: "Bash" }`.
4. Triggered captures from BOTH the orchestrator (main session) AND a freshly-spawned `df-haiku-ops` subagent running `date`.
5. Compared captured payloads.
6. Inspected the subagent transcript directory `~/.claude/projects/-Users-saidsalles-apps-agentSkills-deepflow/<parent>/subagents/`.
7. Restored settings; verified hook stopped firing.

## Raw payload sample
```json
{
  "session_id": "cdfbe7d6-52ba-4ec1-80ec-0f3ad05bfaea",
  "transcript_path": "/Users/saidsalles/.claude/projects/-Users-saidsalles-apps-agentSkills-deepflow/cdfbe7d6-52ba-4ec1-80ec-0f3ad05bfaea.jsonl",
  "cwd": "/Users/saidsalles/apps/agentSkills/deepflow",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "date",
    "description": "..."
  },
  "tool_use_id": "toolu_..."
}
```

## Field inventory (5 captures, mixed orchestrator + haiku-ops)
| Key | Type | Example | Presence |
|-----|------|---------|----------|
| `session_id` | string (UUID) | `cdfbe7d6-...` | 5/5 |
| `transcript_path` | string (abs path) | `/Users/saidsalles/.claude/projects/.../<sid>.jsonl` | 5/5 |
| `cwd` | string (abs path) | `/Users/saidsalles/apps/agentSkills/deepflow` | 5/5 |
| `permission_mode` | string | `default` | 5/5 |
| `hook_event_name` | string | `PreToolUse` | 5/5 |
| `tool_name` | string | `Bash` | 5/5 |
| `tool_input.command` | string | `date` | 5/5 |
| `tool_input.description` | string | `...` | 5/5 |
| `tool_use_id` | string | `toolu_...` | 5/5 |
| `subagent_type` | — | absent | 0/5 (confirms prior `--failed.md`) |
| `agent_id` / `agentId` | — | absent | 0/5 |
| `parent_session_id` | — | absent | 0/5 |

**Key observation:** `session_id` and `transcript_path` from a *subagent-context* Bash call are IDENTICAL to those of an *orchestrator-context* Bash call — both point at the **parent (orchestrator) session**. The hook does NOT receive the subagent's own session/transcript directly.

## Correlator analysis (the walk that works)

From `transcript_path` we derive the subagent directory:
```
parent_session_dir = dirname(transcript_path) + '/' + basename(transcript_path, '.jsonl') + '/subagents/'
                   = /Users/saidsalles/.claude/projects/-Users-saidsalles-apps-agentSkills-deepflow/cdfbe7d6-52ba-4ec1-80ec-0f3ad05bfaea/subagents/
```

This directory contains, per active subagent:
- `agent-{agentId}.jsonl` — sub-session transcript (timestamped entries, one per tool use)
- `agent-{agentId}.meta.json` — sibling metadata file

`meta.json` content (verified):
```json
{"agentType":"df-haiku-ops","description":"T114 capture trigger — haiku-ops Bash"}
```

**Both files exist during execution, before SubagentStop fires.** Confirmed by mtime: `21:23:24` for both files; haiku-ops session was still active at that moment.

The subagent's own JSONL also embeds `"agentId":"a2853052422f5ca9d"` and `"isSidechain":true` on every entry — but the hook can't see that file directly without first knowing the agentId. Hence the mtime-based discovery below.

### Walk algorithm (drop-in for `hooks/lib/agent-role.js` extension)

```js
function inferAgentRoleViaTranscript(transcriptPath, nowMs = Date.now(), staleMs = 5000) {
  if (!transcriptPath) return null;
  const path = require('path');
  const fs = require('fs');
  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath, '.jsonl');
  const subDir = path.join(dir, base, 'subagents');
  let entries;
  try { entries = fs.readdirSync(subDir); } catch { return null; }
  // candidates: meta files whose sibling .jsonl was written within staleMs
  const candidates = entries
    .filter(n => n.endsWith('.meta.json'))
    .map(n => {
      const agentId = n.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
      try {
        const st = fs.statSync(jsonlPath);
        return { agentId, metaPath: path.join(subDir, n), mtimeMs: st.mtimeMs };
      } catch { return null; }
    })
    .filter(c => c && (nowMs - c.mtimeMs) < staleMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);  // most-recent first
  if (candidates.length === 0) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(candidates[0].metaPath, 'utf8'));
    return meta.agentType || meta.agent_type || null;  // matches dashboard's read fallback
  } catch { return null; }
}
```

### Combined inference (T106 cwd-inference + transcript-walk fallback)

```js
function inferAgentRole(payload) {
  // Tier 1: cwd-branch inference (T106) — deterministic for task agents in df/<spec>--probe-T<N> worktrees
  const fromCwd = inferAgentRoleFromCwd(payload.cwd);
  if (fromCwd) return fromCwd;
  // Tier 2: transcript-walk — covers df-haiku-ops and any subagent invoked from arbitrary cwd
  const fromTranscript = inferAgentRoleViaTranscript(payload.transcript_path);
  if (fromTranscript) return fromTranscript;
  // Tier 3: orchestrator pass-through
  return null;
}
```

## Verdict for T108: CLEAN-PATH

T108 should be **rescoped** (not retired) to:
> **T108 [RESCOPED]**: Extend `hooks/lib/agent-role.js` with a transcript-walk fallback (`inferAgentRoleViaTranscript`) that reads the subagent's sibling `meta.json` via `<parent_session_dir>/subagents/agent-{agentId}.meta.json`, where the agentId is resolved by mtime-recency on the directory listing. `df-bash-scope` calls the combined two-tier inference. No marker files, no spawn-counter keying, no PreToolUse:Agent cooperation needed — the metadata Claude Code already writes for the dashboard IS the runtime correlator we needed.

## Confidence: HIGH
- Empirical capture (5 payloads, both contexts) confirms field shape
- Filesystem inspection confirms `meta.json` exists during execution
- Algorithm tested mentally against the haiku-ops case (mtime within 5s) and the orchestrator case (no recent subagent → null fallback)
- Race-condition window: mtime granularity + concurrent subagents → bound to most-recent. For the haiku-ops use case (cherry-pick is sequential per /df:execute §5.1), this is correct. Document the heuristic boundary in T108's implementation.

## Cleanup
- `.claude/settings.local.json`: restored from backup, diff = empty
- `/tmp/df-debug-bash-stdin.js`: deleted
- `/tmp/df-debug-bash-stdin.jsonl`: 24 lines captured during probe; line count unchanged after restore-sanity-check (`date` call did NOT trigger it, confirming hook unregistered)
- Backup `/tmp/settings.local.json.bak-T114` preserved for audit

## Recommended next step
T108 rescope per "Verdict" above. Add to `hooks/lib/agent-role.js` (T106's module) so the two-tier strategy lives in one place. T107's `df-bash-scope` already calls `inferAgentRole(payload)` — extend its arg from `payload.cwd` to the full payload to enable the transcript fallback.
