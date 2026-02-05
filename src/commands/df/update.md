# /df:update — Update deepflow

## Update

```bash
npx deepflow@latest
```

Auto-detects existing installation and updates it.

## Uninstall

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
