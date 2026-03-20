# Experiment: Loop Skill Invocation

**Hypothesis:** `/loop 1m /auto-cycle` (skill invocation) works the same as `/loop 1m /df:auto-cycle` (command invocation)

**Status:** FAIL

**Date:** 2026-03-20

---

## Method

Investigated by:
1. Reading `src/commands/df/auto-cycle.md` and `src/commands/df/auto.md` to understand how `/loop` is referenced
2. Searching for any `loop` skill in `src/skills/` — none exists; `/loop` is a native Claude Code built-in
3. Reading `~/.claude/cache/changelog.md` for `/loop` documentation (added v2.1.71)
4. Reading the Claude Code plugin/skill documentation to understand slash command vs skill resolution
5. Examining the `example-command` SKILL.md for the unified command/skill loading claim

---

## Findings

### How `/loop` dispatches

`/loop` is a **native Claude Code built-in** command added in v2.1.71. The changelog documents it as:

> "Added `/loop` command to run a prompt or slash command on a recurring interval (e.g. `/loop 5m check the deploy`)"

`/loop` dispatches its argument as a **slash command string** — it resolves `/df:auto-cycle` through Claude Code's unified command/skill registry. This is path **(b)** from the hypothesis: it directly invokes the slash command by name, not via the `Skill` tool.

### The unified registry

Claude Code's slash command resolution **does** unify commands and skills. Evidence:
- Changelog v2.1.75: "Fixed slash commands showing 'Unknown skill'" — commands and skills share the same resolution namespace
- `example-command` SKILL.md states: skills in `skills/<name>/SKILL.md` are "functionally identical to the legacy `commands/example-command.md` format — both are loaded the same way; only the file layout differs"
- Skills in `.claude/skills/<name>/SKILL.md` are invokable as `/<name>` directly

### Why the hypothesis FAILS

A skill named `auto-cycle` (placed at `.claude/skills/auto-cycle/SKILL.md`) would be invokable as `/auto-cycle`. So `/loop 1m /auto-cycle` would work **for the skill itself**.

However, the hypothesis fails for this refactor for two reasons:

1. **Namespace loss**: The current command is `df:auto-cycle` (namespaced under `df:`). A skill does not support colons in its name to replicate the `df:` namespace. `/loop 1m /auto-cycle` would lose the `df:` prefix, creating a naming conflict risk with any other `auto-cycle` command in the system.

2. **Thin shim still needed for namespacing**: If the goal is to move logic to a skill while keeping `df:auto-cycle` callable by `/loop`, a thin shim command at `commands/df/auto-cycle.md` must remain to preserve the `df:` namespace. The skill itself (`/auto-cycle`) could not be used directly by `/loop` while maintaining the `df:` prefix convention.

3. **Skill invocation path confirms (b)**: `/loop` does NOT use the `Skill` tool internally. It resolves the argument as a slash command string through the registry. A skill named `auto-cycle` would resolve correctly as `/auto-cycle`, but this is still path (b) — the registry just happens to include both commands and skills.

---

## Answer to Key Question

**`/loop` uses path (b)**: It passes the slash command string directly to the slash command resolution system. The resolution system handles both commands AND skills, so `/auto-cycle` (a skill) would be recognized.

**BUT**: `/auto-cycle` ≠ `/df:auto-cycle`. The `df:` prefix is a namespace from the `commands/df/` directory structure. Skills cannot replicate this namespace. Therefore, switching to a skill alone would require either:
- Renaming the entrypoint from `/df:auto-cycle` to `/auto-cycle` (breaking change), OR
- Keeping a thin shim command `commands/df/auto-cycle.md` that delegates to the skill via `Skill tool` internally

---

## Conclusion

The hypothesis is **FAIL**: `/loop 1m /auto-cycle` does NOT work the same as `/loop 1m /df:auto-cycle` because the `df:` namespace cannot be replicated in a skill name. A thin shim command is required if the `df:` prefix must be preserved.

If the `df:` prefix can be dropped (i.e., rename to `/auto-cycle`), then a pure skill approach works — no shim needed — because `/loop` resolves skills and commands identically through the unified registry.
