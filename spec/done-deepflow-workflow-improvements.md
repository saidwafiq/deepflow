# Deepflow Workflow Improvements

## Objective
Fix deepflow's planning workflow to prioritize fast experiments over full implementations, enforce concise agent output, and prevent haiku agents from adding bias.

## Requirements

### REQ-1: Experiment-First Planning
- `/df:plan` MUST check `.deepflow/experiments/` for past experiments on the same topic BEFORE generating tasks
- If a failed experiment exists: propose a **hypothesis spike** (1-2 tasks) to validate the next approach, NOT full implementation
- If no experiments exist: first task should be a minimal validation spike
- Full implementation tasks only after spike validates the hypothesis

### REQ-2: Concise Agent Output
- Explore agents MUST return structured findings, not verbose dumps
- Maximum 500 tokens per agent response (configurable)
- Output format: bullet points with file paths and one-line summaries
- No tables, no lengthy explanations, no code excerpts unless critical

### REQ-3: Haiku Scope Limits
- Explore agents (haiku) MUST only report **factual findings**:
  - Files found
  - Patterns/conventions observed
  - Integration points
- Explore agents MUST NOT:
  - Make recommendations
  - Propose architectures
  - Read and summarize specs (that's orchestrator's job)
  - Draw conclusions about what should be built

### REQ-4: Hypothesis Validation Loop
- New workflow: `Experiment → Validate → Plan → Implement`
- Each experiment records: hypothesis, method, result, conclusion
- Failed experiments inform next hypothesis (not repeat same approach)
- `/df:execute` checks experiment status before starting full implementation

## Constraints
- Changes must be backward compatible with existing specs
- No changes to spec file format
- Experiments directory structure: `.deepflow/experiments/{topic}--{hypothesis}--{status}.md`

## Out of Scope
- Changes to `/df:verify`
- Changes to skill invocation mechanism
- Multi-project experiment sharing

## Acceptance Criteria
- [ ] `/df:plan` reads `.deepflow/experiments/` before generating tasks
- [ ] When failed experiment exists, plan starts with spike task (not full impl)
- [ ] Explore agent prompts include explicit scope restrictions
- [ ] Explore agent output is <500 tokens per response
- [ ] No recommendations appear in Explore agent output
- [ ] Hypothesis spike template exists in deepflow

## Technical Notes

### Current Problem (from `/df:plan` execution)
- Explore agent returned ~37K tokens of verbose output
- Haiku read specs and made architectural recommendations (out of scope)
- Plan ignored failed experiment, proposed 10-task waterfall
- No validation spike before committing to full implementation

### Proposed Explore Agent Prompt Structure
```
Find: [specific question]
Return ONLY:
- File paths matching criteria
- One-line description per file
- Integration points (if asked)

DO NOT:
- Read or summarize spec files
- Make recommendations
- Propose solutions
- Generate tables or lengthy explanations

Max response: 500 tokens
```

### Experiment-Aware Planning Flow
```
1. Load .deepflow/experiments/*.md
2. Filter by topic (fuzzy match on spec name)
3. If failed experiment exists:
   - Extract "next hypothesis" from conclusion
   - Generate spike task to test hypothesis
   - Block full implementation on spike success
4. If no experiments:
   - Generate spike task for core hypothesis
   - Block full implementation on spike
5. Only after spike validates: generate full task list
```
