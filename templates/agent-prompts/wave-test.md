--- START ---
WORKDIR: {{WORKTREE_PATH}} — Run `cd {{WORKTREE_PATH}}` ONCE as your first Bash call; your shell session keeps the cwd, so subsequent commands do NOT need the prefix. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git operations MUST use `git -C {{WORKTREE_PATH}}` form (safety belt). NEVER run `git commit` / `git add` / `git checkout` without `-C`. Do NOT chain commands with `&&`/`;`/`|` to read files outside your slice — every chained segment is inspected by the slice guard.
{{TASK_ID}} [TEST]: Write tests for {{SPEC_NAME}}. Files+Spec.
Module under test: {{EDIT_SCOPE}}
Success criteria: {{ACS}}
Pre-existing test files:
{{SNAPSHOT_FILES}}
Existing test function names (do NOT duplicate these):
{{EXISTING_TEST_NAMES}}
--- MIDDLE ---
Spec: {{SPEC_PATH}}
Test files (Files): {{FILES}}
--- END ---
RULES:
- Use the `Read` tool (or `git diff HEAD~1`) to inspect what the implementation changed before writing tests.
- Do not duplicate tests that already exist in the pre-existing test files listed above.
- Do not modify pre-existing test files — write new test files only.
- Each new test MUST annotate covered AC via `specs/{spec-slug}.md#AC-N` in a comment (e.g. `// covers specs/foo.md#AC-3`) or inside the test name itself.
- Commit as test({{SPEC}}): {description}.
skill: df-ac-coverage
skill: df-decisions
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
