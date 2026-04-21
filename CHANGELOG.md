## v0.1.126 — 2026-04-21

Bash output compression now applies to every project, not just deepflow ones.

### What's new

- **Universal bash compression** — The hook that silently compresses verbose-but-confirmatory commands (`npm install`, `npm run build`, `pnpm install`, `yarn build`, `git stash`, `git worktree add`) now runs in any Claude Code project, reducing context rot for everyone.
- **Opt-out escape hatch** — Set `DF_BASH_REWRITE=0` in your environment to see full command output when you need it (e.g. debugging a dependency resolution issue).

### Fixes & internals

- Synced `package-lock.json`.
