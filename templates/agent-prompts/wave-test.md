--- START ---
{{TASK_ID}} [TEST]: Write tests for {{SPEC_NAME}}. Files+Spec.
Pre-existing test files:
{{SNAPSHOT_FILES}}
Existing test function names (do NOT duplicate these):
{{EXISTING_TEST_NAMES}}
--- MIDDLE ---
Spec: {{SPEC_PATH}}
Edit scope: {{EDIT_SCOPE}}
--- END ---
RULES:
- Use the `Read` tool (or `git diff HEAD~1`) to inspect what the implementation changed before writing tests.
- Do not duplicate tests that already exist in the pre-existing test files listed above.
- Do not modify pre-existing test files — write new test files only.
- Each new test MUST annotate covered AC via `specs/{spec-slug}.md#AC-N` in a comment (e.g. `// covers specs/foo.md#AC-3`) or inside the test name itself.
- Commit as test({{SPEC}}): {description}.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed)
