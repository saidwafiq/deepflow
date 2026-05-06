--- START ---
WORKDIR: {{WORKTREE_PATH}} — Run `cd {{WORKTREE_PATH}}` ONCE as your first Bash call; your shell session keeps the cwd, so subsequent commands do NOT need the prefix. All Read/Edit/Write paths MUST be absolute under {{WORKTREE_PATH}}. All git operations MUST use `git -C {{WORKTREE_PATH}}` form (safety belt). NEVER run `git commit` / `git add` / `git checkout` without `-C`. Do NOT chain commands with `&&`/`;`/`|` to read files outside your slice — every chained segment is inspected by the slice guard.
{{TASK_ID}} [INTEGRATION]: Verify contracts between {{SPEC_A}} ↔ {{SPEC_B}}
Integration ACs: {{INTEGRATION_ACS}}
--- MIDDLE ---
Specs involved: {{SPECS_INVOLVED}}
Interface Map: {{INTERFACE_MAP}}
Contract Risks: {{CONTRACT_RISKS}}
LSP documentSymbol on Impact files (sketch.md, impact.md, findings.md) → Read with offset/limit on relevant ranges only (never read full files)
--- END ---
RULES:
- Fix the CONSUMER to match the PRODUCER's declared interface. Never weaken the producer.
- Each fix must reference the specific contract being repaired.
- If a migration conflict exists, make ALL migrations idempotent (IF NOT EXISTS, IF NOT COLUMN, etc.)
- Do NOT create new variables or intermediate adapters to paper over mismatches. Fix the actual call site.
- Do NOT modify acceptance criteria or spec definitions.
- Commit as fix({spec}): {contract description}. One commit per contract fix.
skill: df-decisions
Last line: TASK_STATUS:pass or TASK_STATUS:fail
