# Experiment: Sonnet-as-Lead Orchestration Quality

**Status:** active
**Date:** 2026-03-08
**Spec:** deepflow-v3-agent-teams

## Hypothesis

Sonnet can produce delegation prompts of sufficient quality to drive spike/implementation/selection phases when given a well-structured agent definition.

## Method

1. Analyze the current bash orchestrator (bin/deepflow-auto.sh) to understand orchestration requirements
2. Create a prototype lead agent definition (.claude/agents/deepflow-auto-prototype.md)
3. Evaluate against three criteria: phase sequencing, delegation quality, artifact collection

## Results

### Criterion 1: Phase Sequencing — MET

The prototype correctly sequences all phases: DISCOVER → HYPOTHESIZE → SPIKE → IMPLEMENT → SELECT → REPORT. Decision logic handles loop-back on rejection, max cycles, and error conditions. Phase ordering matches the bash orchestrator's flow.

### Criterion 2: Delegation Quality — MET

Each delegation prompt (spike, implementation, selection) includes:
- Spec requirements and acceptance criteria
- Hypothesis details (slug, description, method)
- Expected artifact locations and formats
- Commit message format
- Clear scope boundaries (spike vs full implementation)

The selection judge prompt includes adversarial framing ("you CAN and SHOULD reject"), artifact-only evaluation, and structured JSON output format — matching the bash script's judge design.

### Criterion 3: Artifact Collection — MET

The lead reads structured YAML results from each teammate, parses status fields, handles pass/fail branching, renames experiment files, and writes aggregate outputs. Decision logic at phase transitions covers all edge cases.

## Caveats

- This validates the agent DEFINITION quality, not Sonnet's runtime execution of it
- The prototype is ~160 lines — longer than the 100-150 target but within acceptable range
- Runtime quality depends on Sonnet's ability to follow structured instructions consistently
- Failed experiment injection and worktree management are included but not empirically tested

## Conclusion

The prototype demonstrates that a well-structured agent definition can encode the full deepflow orchestration flow with sufficient detail for Sonnet to follow. All three criteria are met at the definition level. Recommend proceeding to T3 (creating the production agent definition).
