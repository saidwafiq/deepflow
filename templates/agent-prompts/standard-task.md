--- START ---
WORKDIR: {{WORKTREE_PATH}} — All Bash MUST start with `cd {{WORKTREE_PATH}} &&`. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git MUST use `git -C {{WORKTREE_PATH}}`. NEVER run git commit/add/checkout from inherited cwd.
{{TASK_ID}}: {{DESCRIPTION}}  Files: {{FILES}}  Spec: {{SPEC}}
{{REVERTED_BLOCK}}{{SPIKE_BLOCK}}Success criteria: {{ACS}}
{{DOMAIN_MODEL_BLOCK}}{{EXISTING_TYPES_BLOCK}}--- MIDDLE (omit for low effort; omit deps for medium) ---
{{TASK_BODY}}
--- END ---
Duplicates: [active]→consolidate [dead]→DELETE. ONLY job: code+commit. No merge/rename/checkout.
New packages: declare `"types": "./dist/index.d.ts"` in package.json; add `"node"` to tsconfig `compilerOptions.types` when using `__dirname`/`__filename`.
skill: df-ac-coverage
skill: df-decisions
Files: List every file you modified or created, one per line, in the format `Files: path/to/file.ts, path/to/other.ts`. This is required so the orchestrator can detect file conflicts across concurrent tasks.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
