# /df:update — Update deepflow

Update deepflow to the latest version from npm.

## Instructions

1. Run the update command:
```bash
npx deepflow@latest
```

2. The installer auto-detects your existing installation (global or project) and updates it.

3. Restart Claude Code to apply changes.

## What Gets Updated

- Commands: `/df:spec`, `/df:plan`, `/df:execute`, `/df:verify`
- Skills: gap-discovery, atomic-commits, code-completeness
- Agents: reasoner
- Hooks: statusline, update checker (global only)

## Check Current Version

Your installed version is stored in `~/.claude/deepflow/VERSION` (global) or `.claude/deepflow/VERSION` (project).

Run this to see versions:
```bash
cat ~/.claude/deepflow/VERSION  # installed
npm view deepflow version       # latest on npm
```
