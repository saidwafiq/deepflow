--- START ---
WORKDIR: {{WORKTREE_PATH}} — Run `cd {{WORKTREE_PATH}}` ONCE as your first Bash call; your shell session keeps the cwd, so subsequent commands do NOT need the prefix. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git operations MUST use `git -C {{WORKTREE_PATH}}` form (safety belt). NEVER run `git commit` / `git add` / `git checkout` without `-C`. Do NOT chain commands with `&&`/`;`/`|` to read files outside your slice — every chained segment is inspected by the slice guard.
{{TASK_ID}} [OPTIMIZE]: {{METRIC}} — cycle {{N}}/{{MAX}}. Files: {{FILES}}  Spec: {{SPEC}}
Current: {{CURRENT}} (baseline: {{BASELINE}}, best: {{BEST}}). Target: {{TARGET}} ({{DIRECTION}}). Metric: {{METRIC_CMD}}
CONSTRAINT: ONE atomic change.
--- MIDDLE ---
{{HISTORY_BLOCK}}LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files)
--- END ---
{{LEARNINGS}}ONE change + commit. No metric run, no multiple changes.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
