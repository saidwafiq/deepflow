---
name: df:update
description: Update or uninstall deepflow, check installed version
---

# /df:update — Update deepflow

**ACTION REQUIRED:** Immediately run the update command below. Do NOT ask for confirmation — the user already confirmed by running `/df:update`.

```bash
npx deepflow@latest
```

Auto-detects existing installation and updates it.

## Uninstall

To uninstall instead, run:

```bash
npx deepflow --uninstall
```

## Check Version

```bash
# Installed version (source of truth):
cat ~/.claude/cache/df-update-check.json | grep currentVersion

# Latest on npm:
npm view deepflow version
```

**NOTE:** Do NOT use `npm list -g deepflow` — it shows a stale version unrelated to the actual installation.
