WORKDIR: {{WORKTREE_PATH}} — Run `cd {{WORKTREE_PATH}}` ONCE as your first Bash call; your shell session keeps the cwd, so subsequent commands do NOT need the prefix. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git operations MUST use `git -C {{WORKTREE_PATH}}` form (safety belt). NEVER run `git commit` / `git add` / `git checkout` without `-C`. Do NOT chain commands with `&&`/`;`/`|` to read files outside your slice — every chained segment is inspected by the slice guard.
{{TASK_ID}} [SPIKE]: {{HYPOTHESIS}}. Files+Spec. {{REVERTED_WARNINGS}}Minimal spike. Commit as spike({{SPEC}}): {{DESC}}.
skill: df-decisions
Last line: TASK_STATUS:pass or TASK_STATUS:fail
