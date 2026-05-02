---
name: df:update
description: Update or uninstall deepflow, check installed version
---

# /df:update — Update deepflow

**ACTION REQUIRED:** Immediately run the update command below. Do NOT ask for confirmation — the user already confirmed by running `/df:update`.

```bash
npm install -g deepflow@latest && deepflow
```

Updates the global npm package, then runs the installer to refresh `~/.claude/`.

**Why not `npx deepflow@latest`?** Inside the Claude Code Bash sandbox, `npx`'s package-fetch step silently exits with code 194 and produces no output, leaving you unable to tell whether the install succeeded. `npm install -g` works reliably and the globally installed `deepflow` binary then runs the installer cleanly.

## Uninstall

To uninstall instead, run:

```bash
deepflow --uninstall
```

## Check Version

```bash
# Installed version (source of truth):
cat ~/.claude/cache/df-update-check.json | grep currentVersion

# Latest on npm:
npm view deepflow version
```

**NOTE:** Do NOT use `npm list -g deepflow` — it shows a stale version unrelated to the actual installation.
