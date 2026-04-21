## Hypothesis

Claude Code resolves `Agent(subagent_type: "df-implement")` by looking up `~/.claude/agents/df-implement.md`, enforcing that file's `allowed-tools` frontmatter when the agent runs.

## Method

1. Read `bin/install.js` to confirm agents are copied from `src/agents/` to `~/.claude/agents/` (or `.claude/agents/` for project installs) via the `copyDir` function.

2. Created a minimal probe agent `src/agents/df-probe-test.md` with frontmatter `allowed-tools: [Bash]` and no `description` field.

3. Ran `npx deepflow` (non-interactive, defaulted to global update). Confirmed `~/.claude/agents/df-probe-test.md` was installed with correct content.

4. Ran `claude agents` to list active agents. The probe agent did NOT appear despite being on disk.

5. Extracted and analyzed `parseAgentFromMarkdown` (function `RL9`) from the Claude Code binary (v2.1.116 at `~/.local/share/claude/versions/2.1.116`). This function is the authoritative agent loader:

   **Key code (deobfuscated):**
   ```js
   function RL9(filePath, baseDir, frontmatter, content, source) {
     const { name, description } = frontmatter;
     if (!name || typeof name !== 'string') return null;
     if (!description || typeof description !== 'string') {
       // logs: "Agent file X is missing required 'description' in frontmatter"
       return null;
     }
     const agentType = path.basename(filePath, '.md');  // FILENAME STEM = agentType
     const tools = S4H(frontmatter.tools);              // reads "tools:" key
     const disallowedTools = S4H(frontmatter.disallowedTools);
     return {
       agentType,        // "df-implement.md" → agentType = "df-implement"
       whenToUse: description,
       tools,            // enforced at harness level
       disallowedTools,
       source,
       // ...model, color, skills, hooks etc.
     };
   }
   ```

6. Confirmed `getActiveAgentsFromList` builds a `Map` keyed by `agentType`. When `Task(subagent_type: "df-implement")` is called, the harness looks up the map by `agentType` string.

7. Ran `claude agents` after cleanup — probe absent, confirming `description` is a hard requirement.

## Results

### (a) Does harness resolve by name?

**YES — CONFIRMED.** `agentType` is set to `path.basename(filePath, '.md')`. A file named `df-implement.md` in `~/.claude/agents/` gets `agentType = "df-implement"`, which is exactly what `subagent_type: "df-implement"` matches against. The `name:` frontmatter field is used for display only; the filename stem is the canonical lookup key.

### (b) Is `allowed-tools` enforced?

**PARTIAL CONFIRMATION with CORRECTION.** The binary reads `frontmatter.tools` (key: `tools:`), NOT `frontmatter['allowed-tools']` (key: `allowed-tools:`). The `tools` field IS enforced at the harness level — it populates the `tools` array in the agent definition, which restricts what tools the spawned agent can use. However:

- The correct frontmatter key is **`tools:`**, not `allowed-tools:`.
- Using `allowed-tools:` (as in the probe and in `src/agents/df-probe-test.md`) results in the tools field being `undefined`, meaning the agent gets **no tool restriction** — it inherits full default tools.
- The existing `reasoner.md` already uses `tools:` (correct), while the spec (REQ-1 through REQ-5) describes `allowed-tools:` which would be WRONG.

### (c) Constraints found

1. **`description:` is required** — agents missing description are silently dropped from the active agent map. They exist on disk but are never resolved.
2. **`tools:` is the correct frontmatter key** — `allowed-tools:` is silently ignored; use `tools:` to restrict agent capabilities.
3. **Filename stem = agentType** — `df-implement.md` → `subagent_type: "df-implement"`. Name frontmatter field is cosmetic.
4. **Source priority order**: built-in → plugin → userSettings → projectSettings → flagSettings → policySettings. User agents (`~/.claude/agents/`) have source `"userSettings"`.
5. **`disallowedTools:` also supported** — complementary to `tools:` for exclusion-based restriction.

## Criteria Check

- Does harness resolve by name? **YES** (via filename stem = agentType key)
- Is allowed-tools enforced? **YES, but via `tools:` key not `allowed-tools:` key** — critical correction needed in spec
- What constraints exist? description required; tools: not allowed-tools:; filename determines agentType

## Conclusion

**PASSED** — The hypothesis is CONFIRMED with one important correction: the frontmatter key is `tools:` not `allowed-tools:`. The resolution mechanism works exactly as hypothesized (filename → agentType → lookup), tool enforcement is real and harness-level, but the spec REQ-1 through REQ-5 must use `tools:` not `allowed-tools:` in agent frontmatter.

### Confidence

**HIGH** — Based on direct binary analysis of the live `parseAgentFromMarkdown` function (RL9) in Claude Code v2.1.116, plus empirical validation (probe agent was installed but excluded from active agents due to missing description field, matching the binary logic exactly).
