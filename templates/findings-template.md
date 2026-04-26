# Findings: {spec-name}

---

## T{n}: {task-description}

files_read:
  - {file-path}: {why it was read}

hypotheses_discarded:
  - {hypothesis}: disproved by {command/test/diff anchor}

confirmed:
  - {what was found/decided/changed}

---

<!--
Findings Guidelines:
- Written by df-implement agents, one block per completed task
- Append-only: never modify earlier blocks
- Each block is ~10 lines; keep it skim-friendly
- files_read: only files that materially shaped the decision
- hypotheses_discarded: include the anchor (command run, test result, or diff line) that disproved each hypothesis
- confirmed: one-line facts; what the next agent should know before starting
- Consumed by subsequent task agents via shell-injection: cat ... 2>/dev/null || echo 'NOT_FOUND'
- Missing file is the no-op default; presence is always additive
-->
