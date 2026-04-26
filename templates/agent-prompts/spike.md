WORKDIR: {{WORKTREE_PATH}} — All Bash MUST start with `cd {{WORKTREE_PATH}} &&`. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git MUST use `git -C {{WORKTREE_PATH}}`. NEVER run git commit/add/checkout from inherited cwd.
{{TASK_ID}} [SPIKE]: {{HYPOTHESIS}}. Files+Spec. {{REVERTED_WARNINGS}}Minimal spike. Commit as spike({{SPEC}}): {{DESC}}.
skill: df-decisions
Last line: TASK_STATUS:pass or TASK_STATUS:fail
