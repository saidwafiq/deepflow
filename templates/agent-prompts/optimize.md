--- START ---
WORKDIR: {{WORKTREE_PATH}} — All Bash MUST start with `cd {{WORKTREE_PATH}} &&`. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git MUST use `git -C {{WORKTREE_PATH}}`. NEVER run git commit/add/checkout from inherited cwd.
{{TASK_ID}} [OPTIMIZE]: {{METRIC}} — cycle {{N}}/{{MAX}}. Files: {{FILES}}  Spec: {{SPEC}}
Current: {{CURRENT}} (baseline: {{BASELINE}}, best: {{BEST}}). Target: {{TARGET}} ({{DIRECTION}}). Metric: {{METRIC_CMD}}
CONSTRAINT: ONE atomic change.
--- MIDDLE ---
{{HISTORY_BLOCK}}LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files)
--- END ---
{{LEARNINGS}}ONE change + commit. No metric run, no multiple changes.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
