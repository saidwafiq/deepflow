--- START ---
{{TASK_ID}} [OPTIMIZE PROBE]: {{METRIC}} — probe {{PROBE_ID}} ({{ROLE}})
Current: {{CURRENT}}. Target: {{TARGET}}. Role instruction:
{{ROLE_INSTRUCTION}}
--- MIDDLE ---
{{HISTORY_BLOCK}}LSP documentSymbol on Impact files → Read with offset/limit on relevant ranges only (never read full files)
--- END ---
ONE atomic change. Commit. STOP.
Last line of your response MUST be: TASK_STATUS:pass (if successful) or TASK_STATUS:fail (if failed) or TASK_STATUS:revert (if reverted)
