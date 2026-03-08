# /df:auto — Autonomous Mode

Run the full autonomous cycle via agent teams. Auto-promotes unprefixed specs to `doing-*`, then processes all `doing-*` specs through every phase: discover, pre-check, hypothesize, spike, implement, select, verify, PR, report.

## Usage
```
/df:auto              # process all specs
```

## Behavior

Load and execute the lead agent at `.claude/agents/deepflow-auto.md`.

Run the full autonomous cycle now. Auto-promote unprefixed specs to `doing-*`, then process all `doing-*` specs through every phase. Do not ask questions — act autonomously.

Output progress as each phase completes. Generate `.deepflow/auto-report.md` at the end.
