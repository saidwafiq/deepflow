--- START ---
WORKDIR: {{WORKTREE_PATH}} — Run `cd {{WORKTREE_PATH}}` ONCE as your first Bash call; your shell session keeps the cwd, so subsequent commands do NOT need the prefix. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git operations MUST use `git -C {{WORKTREE_PATH}}` form (safety belt). NEVER run `git commit` / `git add` / `git checkout` without `-C`. Do NOT chain commands with `&&`/`;`/`|` to read files outside your slice — every chained segment is inspected by the slice guard.
{{TASK_ID}} [OPTIMIZE PROBE]: {{METRIC}} — probe {{PROBE_ID}} ({{ROLE}})
Current: {{CURRENT}}. Target: {{TARGET}}. Role instruction:
{{ROLE_INSTRUCTION}}
--- MIDDLE ---
{{HISTORY_BLOCK}}LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files)
--- END ---
ONE atomic change. Commit. STOP.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
