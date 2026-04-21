--- START ---
{{TASK_ID}} [INTEGRATION]: Verify contracts between {{SPEC_A}} ↔ {{SPEC_B}}
Integration ACs: {{INTEGRATION_ACS}}
--- MIDDLE ---
Specs involved: {{SPECS_INVOLVED}}
Interface Map: {{INTERFACE_MAP}}
Contract Risks: {{CONTRACT_RISKS}}
LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files)
--- END ---
RULES:
- Fix the CONSUMER to match the PRODUCER's declared interface. Never weaken the producer.
- Each fix must reference the specific contract being repaired.
- If a migration conflict exists, make ALL migrations idempotent (IF NOT EXISTS, IF NOT COLUMN, etc.)
- Do NOT create new variables or intermediate adapters to paper over mismatches. Fix the actual call site.
- Do NOT modify acceptance criteria or spec definitions.
- Commit as fix({spec}): {contract description}. One commit per contract fix.
skill: df-ac-coverage
skill: df-decisions
Last line: TASK_STATUS:pass or TASK_STATUS:fail
