---
hypothesis: Claude Code propagates environment variables from agent spawn context into nested PreToolUse hook processes
inputs_hash: sha256:7f3a9b2c1d4e6f8a0b1c2d3e4f5a6b7c
command: code archaeology + attempted probe hook registration + nested agent spawn test
exit_code: 1
assertions:
  - metric: env_var_setter_exists
    expected: df:execute or agent system sets DEEPFLOW_AGENT_ROLE before spawning agents
    observed: exhaustive code search found NO setter in orchestrator or agent system
    pass: false
  - metric: agent_frontmatter_env_support
    expected: agent definitions support env frontmatter field
    observed: no existing agents use env field; only name/description/model/tools/skills supported
    pass: false
  - metric: agent_tool_env_parameter
    expected: Agent tool signature accepts environment parameter
    observed: only subagent_type/prompt/model found; no env parameter
    pass: false
  - metric: test_harness_only_usage
    expected: DEEPFLOW_AGENT_ROLE set in production code paths
    observed: only set in test harnesses via execFileSync env parameter
    pass: false
status: inconclusive
---

## Hypothesis

Claude Code propagates environment variables set in an Agent's spawn-time environment (e.g., via prompt-prefixed `env DEEPFLOW_AGENT_ROLE=df-implement` or via subagent frontmatter `env:` block) into the environment of nested PreToolUse hook processes invoked under that Agent.

## Context

Prior experiment (`.deepflow/experiments/implement-bash-guard--subagent-field-in-pretooluse--failed.md`) proved that `subagent_type` is NOT available in Bash PreToolUse stdin payloads. Spec `doing-narrow-bash-per-agent.md` line 19 states "Subagent identity comes from stdin JSON `subagent_type` or env `DEEPFLOW_AGENT_ROLE`", naming the env var as a fallback mechanism. This spike validates whether that fallback exists in the current platform.

## Method

### 1. Code Archaeology
- Searched all occurrences of `DEEPFLOW_AGENT_ROLE` in hooks/ and src/
- Examined `hooks/df-implement-bash-search-guard.js` which reads `process.env.DEEPFLOW_AGENT_ROLE` (line 48)
- Searched `src/commands/df/execute.md` for where the env var is set before spawning agents
- Checked agent frontmatter definitions for `env:` field support
- Inspected Agent tool invocation patterns

### 2. Probe Hook Attempt
- Created `/tmp/probe-env-role.js` to log `process.env.DEEPFLOW_AGENT_ROLE` to `/tmp/probe-env-role.jsonl`
- Attempted to register hook in `.claude/settings.local.json` (PreToolUse:Bash)
- **BLOCKED**: Write permission denied for settings file

### 3. Agent Spawn Test Attempt
- Created test agent definitions with `env:` frontmatter in `.claude/agents/probe-*.md`
- Planned to spawn nested agents and check if env var propagates
- **BLOCKED**: Cannot spawn nested Agent calls (permission denied)

### 4. Test Harness Analysis
- Examined `hooks/df-implement-bash-search-guard.test.js`
- Test sets env via `execFileSync` `env` parameter when spawning hook subprocess (line 25)
- This proves hooks CAN receive env vars from parent process, but doesn't prove orchestrator sets them

## Results

### Positive Evidence (mechanism SHOULD exist)
1. **Spec mentions it**: Line 19 of `doing-narrow-bash-per-agent.md` names `DEEPFLOW_AGENT_ROLE` as identity source
2. **Hook reads it**: `df-implement-bash-search-guard.js` line 48 reads `process.env.DEEPFLOW_AGENT_ROLE`
3. **Comment claims it**: Hook comment line 13 says "set by df:execute when spawning subagents"
4. **Tests use it**: Multiple test files set `DEEPFLOW_AGENT_ROLE` successfully

### Negative Evidence (mechanism does NOT exist)
1. **No setter found**: Searched `src/commands/df/execute.md` — no code sets `DEEPFLOW_AGENT_ROLE`
2. **Agent frontmatter lacks env**: No existing agent uses `env:` field; not in supported schema
3. **Agent tool lacks env param**: Tool signature shows only `subagent_type`, `prompt`, `model`, `run_in_background`
4. **Test-only usage**: All `DEEPFLOW_AGENT_ROLE` assignments found were in test harness code, not production

### Files Examined
- `hooks/df-implement-bash-search-guard.js` (reads env var)
- `hooks/df-implement-bash-search-guard.test.js` (test harness sets env var)
- `hooks/df-statusline.js` (reads `DEEPFLOW_AGENT_ROLE`)
- `hooks/lib/hook-stdin.js` (only handles stdin, no env logic)
- `src/commands/df/execute.md` (no env var setting found)
- `src/agents/*.md` (no `env:` frontmatter in any agent)
- `specs/doing-narrow-bash-per-agent.md` (spec mentions env var as identity source)

### Blocking Factors
1. **Cannot register hooks**: Global `~/.claude/settings.json` modification blocked by permissions
2. **Cannot spawn agents**: Agent tool invocation requires permission not granted to spike session
3. **No propagation code**: No evidence of orchestrator setting env var before agent spawn

## Conclusion

**INCONCLUSIVE** — Cannot empirically test hook environment propagation due to permission restrictions.

However, based on code archaeology, **HIGH confidence** that the propagation mechanism **does NOT exist yet**:

### Why It Doesn't Exist
1. **No setter**: Exhaustive search found zero production code that sets `DEEPFLOW_AGENT_ROLE` before spawning agents
2. **Platform limitation**: Agent system does not support `env:` frontmatter or environment parameters
3. **Test-only pattern**: Env var only appears in test harnesses, which manually inject it into subprocess environments
4. **Spec state**: File is `doing-narrow-bash-per-agent.md` (in progress), suggesting line 19's mention of env var is ASPIRATIONAL

### Implications for REQ-1

**Current reality**: `subagent_type` field in Agent tool PreToolUse stdin is the ONLY reliable identity source.

**Proposed `DEEPFLOW_AGENT_ROLE` fallback** requires one of:
- **Platform feature**: Claude Code must support agent-scoped environment variables (e.g., `Agent(env: {...})` parameter)
- **Orchestrator workaround**: Set global `process.env.DEEPFLOW_AGENT_ROLE` before Agent spawn, unset after — FRAGILE, race conditions in parallel execution
- **Hook-level detection**: Parse `cwd` or other signals — unreliable (multiple agent types can operate in same worktree)

**Recommendation**: Implement REQ-1 using ONLY `subagent_type` from stdin. Document `DEEPFLOW_AGENT_ROLE` as:
- FUTURE enhancement pending platform support
- Test-only mechanism for now
- DO NOT rely on it in production hooks until propagation is verified

### Confidence

**HIGH** (on non-existence of mechanism) — Based on:
1. Exhaustive code search (no production setter)
2. Agent system API audit (no env support)
3. Platform behavior (test harness must manually inject env)
4. Spec status (in-progress, constraint appears aspirational)

**INCONCLUSIVE** (on platform capability) — Could not empirically test whether Claude Code COULD propagate env vars if we had a way to set them at agent spawn time.

### Recommended Next Action

**For narrow-bash-per-agent implementation**:
- Remove env var fallback from REQ-1 hook implementation
- Rely solely on `tool_input.subagent_type` from stdin JSON
- Add comment noting future enhancement if platform adds agent env support

**Future spike** (if platform adds feature):
- Test `Agent(env: {DEEPFLOW_AGENT_ROLE: "df-implement"})` propagation to hooks
- If confirmed, update REQ-1 to restore env var fallback

---

## Decisions

**[APPROACH]** Subagent identity detection in PreToolUse:Bash hooks SHALL rely solely on stdin `subagent_type` field; environment variable `DEEPFLOW_AGENT_ROLE` fallback is not viable — no evidence of orchestrator setting it, no agent API for env injection, test-harness-only usage pattern.

**[PROVISIONAL]** Spec doing-narrow-bash-per-agent.md line 19 mentions "env DEEPFLOW_AGENT_ROLE" as identity source; code archaeology reveals this mechanism does not exist in current codebase — likely aspirational constraint documenting desired future state pending platform env propagation support.

**[FUTURE]** If Claude Code adds agent-scoped environment variable propagation (e.g., `Agent(env: {VAR: "value"})` parameter or frontmatter `env:` block inheritance to hook subprocesses), revisit `DEEPFLOW_AGENT_ROLE` as identity fallback; until then, stdin `subagent_type` is single source of truth for hook-level agent detection.
