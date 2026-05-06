--- START ---
WORKDIR: {{WORKTREE_PATH}} — Run `cd {{WORKTREE_PATH}}` ONCE as your first Bash call; your shell session keeps the cwd, so subsequent commands do NOT need the prefix. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git operations MUST use `git -C {{WORKTREE_PATH}}` form (safety belt). NEVER run `git commit` / `git add` / `git checkout` without `-C`. Do NOT chain commands with `&&`/`;`/`|` to read files outside your slice — every chained segment is inspected by the slice guard.
{{TASK_ID}}: {{DESCRIPTION}}  Files: {{FILES}}  Spec: {{SPEC}}
{{REVERTED_BLOCK}}{{SPIKE_BLOCK}}Success criteria: {{ACS}}
{{DOMAIN_MODEL_BLOCK}}{{EXISTING_TYPES_BLOCK}}--- MIDDLE (omit for low effort; omit deps for medium) ---
{{TASK_BODY}}
--- END ---
Duplicates: [active]→consolidate [dead]→DELETE. ONLY job: code+commit. No merge/rename/checkout.
New packages: declare `"types": "./dist/index.d.ts"` in package.json; add `"node"` to tsconfig `compilerOptions.types` when using `__dirname`/`__filename`.
skill: df-decisions
Files: List every file you modified or created, one per line, in the format `Files: path/to/file.ts, path/to/other.ts`. This is required so the curator can detect file conflicts across concurrent tasks.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
