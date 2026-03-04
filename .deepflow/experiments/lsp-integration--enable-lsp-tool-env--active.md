# Experiment: ENABLE_LSP_TOOL Env Var in Claude Code

**Domain:** lsp-integration
**Approach:** enable-lsp-tool-env
**Status:** active (pending verifier)
**Date:** 2026-03-04
**Claude Version:** 2.1.68

---

## Hypothesis

Setting `ENABLE_LSP_TOOL=1` in `~/.claude/settings.json` under the `env` key makes `goToDefinition`, `findReferences`, and `workspaceSymbol` available as tools in Claude Code sessions, including spawned agents.

---

## Method

Since a new Claude Code session cannot be started from within this session, validation was performed by:

1. Reading `~/.claude/settings.json` to check current state
2. Checking current `process.env` for `ENABLE_LSP_TOOL`
3. Extracting and analyzing the compiled Claude Code binary (`2.1.68`) to confirm exact behavior
4. Checking installed plugins and LSP servers
5. Researching community documentation

---

## Findings

### 1. Current State

- **`ENABLE_LSP_TOOL` in current process.env:** NOT SET
- **`env` key in `~/.claude/settings.json`:** NOT PRESENT (no `env` block exists)
- **LSP plugins installed:** None (`~/.claude/plugins/installed_plugins.json` = `{"version":2,"plugins":{}}`)
- **LSP language servers installed:** None (`typescript-language-server`, `pyright`, `gopls`, `rust-analyzer` all absent)
- **Project `.claude/settings.local.json`:** Not present in worktree

### 2. Binary Analysis — ENABLE_LSP_TOOL Gate

Extracted from `/Users/saidsalles/.local/share/claude/versions/2.1.68` (compiled binary):

```javascript
function PRT() {
  return [
    dET, GbR, A0, qu, sk, qQ, c$, _Q, BQ, el, HQ, $I, JbR, qbR, NZT, HRT, $iT,
    ...KG() ? [TgB, OgB, LgB, VgB] : [],
    ...GcB ? [GcB] : [],
    ...JcB ? [JcB] : [],
    ...process.env.ENABLE_LSP_TOOL ? [UuA] : [],  // <-- LSP tool gated here
    ...YZT() ? [wuB] : [],
    // ...
  ]
}
```

**Conclusion:** The LSP tool (`UuA`, named `"LSP"`) is only added to the available tools list when `process.env.ENABLE_LSP_TOOL` is truthy. Without it, the tool is absent from `PRT()` and never exposed.

### 3. LSP Tool Details (from binary)

**Tool name:** `"LSP"`
**Operations supported:**
- `goToDefinition` — Find where a symbol is defined
- `findReferences` — Find all references to a symbol
- `hover` — Get hover information (documentation, type info)
- `documentSymbol` — Get all symbols in a document
- `workspaceSymbol` — Search for symbols across entire workspace
- `goToImplementation` — Find interface/abstract method implementations
- `prepareCallHierarchy` — Get call hierarchy at a position
- `incomingCalls` — Find callers of a function
- `outgoingCalls` — Find callees of a function

**`isEnabled()` check (from binary):**
```javascript
isEnabled() {
  if (fHT().status === "failed") return false;  // LSP manager must not have failed
  let R = sl();
  if (!R) return false;  // LSP manager must be running
  let A = R.getAllServers();
  if (A.size === 0) return false;  // At least one server must be registered
  return Array.from(A.values()).some(B => B.state === ...)  // Server must be active
}
```

Both conditions must hold:
1. `ENABLE_LSP_TOOL` must be set (tool added to list)
2. An LSP plugin must be installed and its server running (tool `isEnabled()` returns true)

### 4. Settings.json env Key Mechanism (from binary)

```javascript
function gAT() {
  let T = V9() || {};                        // T = local settings (.claude/settings.local.json)
  Object.assign(process.env, NR().env);      // Apply global ~/.claude/settings.json env
  Object.assign(process.env, T.env);         // Apply project .claude/settings.local.json env (overrides)
  $1R();                                     // Signal settings applied
}
```

**Path mapping (from `Dq()` function):**
- `userSettings` → `~/.claude/settings.json`
- `localSettings` → `.claude/settings.local.json` (in project dir)
- `projectSettings` → `.claude/settings.json` (in project dir)

**Trigger:** `gAT()` is called when `settings.env` changes, merging both global and local `env` blocks into `process.env`. **Local settings override global settings.**

### 5. Agent/Subagent Inheritance

Claude Code agents (invoked via Task tool) run **in-process** — they share the same Node.js/Bun process and thus the same `process.env`. Since `ENABLE_LSP_TOOL` is set via `Object.assign(process.env, ...)` at session startup, all agents spawned within the session inherit it automatically.

Evidence from binary: `SuA()` (which calls `PRT()`) is the function that generates the tool list for all agents. Since `PRT()` checks `process.env.ENABLE_LSP_TOOL` directly, agents see the same value.

### 6. settings.local.json Behavior

The `gAT()` function applies `V9().env` (local settings) **after** `NR().env` (global settings), meaning:
- `.claude/settings.local.json` `env` values **override** `~/.claude/settings.json` `env` values
- Both contribute to `process.env`
- Project-level `ENABLE_LSP_TOOL=1` in `.claude/settings.local.json` would work for project-scoped enabling

**Not tested live** (would require session restart; no TypeScript LSP server installed).

### 7. Why Tools Are NOT Available in This Session

- `ENABLE_LSP_TOOL` is not in `process.env` (not set in settings.json, not in shell profile)
- No LSP plugins installed
- No LSP servers installed
- Cannot start a new session to test live activation

---

## Criteria Assessment

| Criterion | Target | Actual | Met |
|-----------|--------|--------|-----|
| goToDefinition/findReferences/workspaceSymbol available as tools | Tools appear in session with env var set | Binary confirms tools exist, gated by `ENABLE_LSP_TOOL`; NOT currently active (var not set, no plugins) | Partial — mechanism confirmed, live validation blocked |
| Spawned agents also see LSP tools | Agents inherit env | In-process agents share `process.env`; confirmed via binary | Yes (architecture confirmed) |
| Project-level settings.local.json env behavior documented | Works or does not work — documented | Documented: works, overrides global settings | Yes |

---

## Configuration Recipe (Validated via Binary)

### Global (all projects):
```json
// ~/.claude/settings.json
{
  "env": {
    "ENABLE_LSP_TOOL": "1"
  }
}
```

### Project-level (one project):
```json
// <project>/.claude/settings.local.json
{
  "env": {
    "ENABLE_LSP_TOOL": "1"
  }
}
```

### Required additional steps:
1. Install an LSP plugin: `claude plugin install typescript-lsp` (after adding marketplace)
2. Install the language server: `npm install -g typescript-language-server typescript`
3. Restart Claude Code session (env is read at startup)

---

## Summary

The `ENABLE_LSP_TOOL=1` mechanism is confirmed to work via binary analysis of Claude Code 2.1.68. The `env` key in both `~/.claude/settings.json` (global) and `.claude/settings.local.json` (project-level) is merged into `process.env` at session start. Agents inherit this because they run in-process. Live tool availability was not demonstrated because: (a) the env var is not currently set, (b) no LSP plugins are installed, and (c) a session restart would be required — none of which can be done from within this agent session.
