# Sketch: {spec-name}

Generated: {timestamp}

modules:
  - {module-path}: {one-line purpose}

entry_points:
  - {file}:{line} — {symbol or export name}

related_specs:
  - {spec-slug}: {relationship}

## Notes

{Optional: anything unusual found during discovery that doesn't fit the fields above}

---

<!--
Sketch Guidelines:
- Written by /df:discover at end of exploration, before handoff to /df:spec
- Consumed by /df:plan and /df:spec via shell-injection (cat ... 2>/dev/null || echo 'NOT_FOUND')
- Keep between 15 and 25 lines (excluding this comment block)
- All three top-level keys (modules:, entry_points:, related_specs:) are required
- Use NOT_FOUND placeholder values when a field has no entries
-->
