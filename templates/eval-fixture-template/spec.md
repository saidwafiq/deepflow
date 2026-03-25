# {benchmark-name}

## Objective

[One sentence: what skill behavior this benchmark evaluates]

## Target Metric

- **Primary (target)**: `cache_ratio` — cache_read_input_tokens / input_tokens (higher = better)
- **Secondary**: `total_tokens`, `wall_time`, `context_burn`
- **Guard**: fixture tests pass (binary — failure auto-reverts before any metric check)

## Skill Under Evaluation

- **Skill path**: `skills/{skill-name}/SKILL.md`
- **First hypothesis**: [Your opening hypothesis about what to change and why]

## Fixture Design

The `fixture/` directory contains a 12-file deepflow-like skeleton codebase. It is intentionally small but realistic — enough to exercise real skill behavior (file reads, edits, spec lookups, git operations) without taking more than a few minutes per iteration.

The `tests/` directory holds guard tests. These MUST cover the behavior you care about so the optimizer cannot game the target metric by breaking real functionality.

## Constraints

- One change per iteration (atomic causality)
- Loop runs until Ctrl+C or `--loop N` cap
- No LLM judges — only mechanical metrics decide keep/revert

## Acceptance Criteria

- [ ] Guard tests in `tests/` pass on the unmodified fixture
- [ ] Fixture exercises the skill's primary code path
- [ ] Hypotheses file (`hypotheses.md`) has at least 3 entries to seed the loop
