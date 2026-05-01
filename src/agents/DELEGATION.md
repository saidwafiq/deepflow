# Delegation Contract

This file is the single source of truth for per-agent input/output contracts in deepflow.
It is enforced at runtime by `hooks/df-delegation-contract.js` (PreToolUse, `Task` spawns).

Machine-parseable format: each agent entry is a fenced YAML block tagged with `agent:<name>`.
The hook extracts these blocks via regex — no external YAML parser required.

---

## Router vs Interpreter

Orchestrators (slash commands) are **routers**, not interpreters.

### The Rule

> Orchestrators MUST pass verbatim artifacts or delegate summarization to `reasoner`.  
> Orchestrators MUST NOT paraphrase, summarize, or editorialize agent-bound inputs inline.

### Rationale

When an orchestrator re-words context before passing it to a specialist agent, two problems arise:

1. **Information loss** — the orchestrator's summary omits details the specialist needs.
2. **Interpretation laundering** — the orchestrator's framing biases the specialist's output before the specialist sees the raw evidence.

The fix is mechanical: either pass the raw artifact verbatim, or spawn `reasoner` to compress it, store the output verbatim, and pass that to downstream agents.

### Precedent Violations (historical, now corrected)

The following were identified as orchestrator-interpretation anti-patterns during the authoring of this contract:

| File | Location | Violation | Fix Applied |
|------|----------|-----------|-------------|
| `src/commands/df/debate.md` | §1 SUMMARIZE | Orchestrator wrote the neutral summary itself | Delegated to `reasoner` with verbatim conversation paste |
| `src/commands/df/discover.md` | On-Demand Context Fetching | Orchestrator paraphrased agent output | Added "relay verbatim" rule before resuming questioning |
| `templates/explore-protocol.md` | Editorial tail | Orchestrator injected editorial guidance after verbatim output | Removed editorial tail; output is now relayed as-is |

### Compliant Pattern

```
# COMPLIANT — orchestrator passes verbatim transcript
reasoner_prompt = """
Produce a ~200 word neutral summary.

## Raw Conversation Context
{verbatim_transcript}

Return ONLY the summary text. No preamble.
"""
summary = spawn(reasoner, reasoner_prompt)
# Pass summary verbatim — do NOT edit it before forwarding
specialist_prompt = build_prompt(summary)
spawn(specialist, specialist_prompt)
```

```
# NON-COMPLIANT — orchestrator writes the summary itself
summary = "The user wants to add caching to the API layer to reduce latency."
spawn(specialist, build_prompt(summary))
```

---

## Tool Inventory

Authoritative listing of which tools each agent's frontmatter grants. Mirror this table when editing any agent's `tools:` field — drift between this section and `src/agents/*.md` is a Wave 3 regression.

| Agent | Tools | Role |
|---|---|---|
| df-implement | Edit, Write, Bash, mcp__ide__getDiagnostics, mcp__ide__executeCode | Curator-fed implementer — no Read/Grep/Glob; CONTEXT_INSUFFICIENT escape on missing context |
| df-test | Edit, Write, Bash, mcp__ide__getDiagnostics, mcp__ide__executeCode | Curator-fed test author — no Read/Grep/Glob |
| df-integration | Edit, Write, Bash, mcp__ide__getDiagnostics, mcp__ide__executeCode | Curator-fed integration implementer — bundle is read post-commit by the orchestrator (single shared worktree) |
| df-optimize | Edit, Write, Bash, mcp__ide__getDiagnostics, mcp__ide__executeCode | Curator-fed optimizer — no Read/Grep/Glob |
| df-haiku-ops | Bash | Mechanical git/shell agent (widest Bash scope — see Risk concentration below) |
| df-spike | Read, Bash, WebFetch, Write | Exploratory spike — keeps Read because hypotheses are unknowns the curator cannot pre-bundle |
| df-spike-platform | Bash, Read, Write (via `allowed-tools:`) | Elevated-scope platform spike for hook/system probes |
| reasoner | Read, Grep, Glob, Edit | Analysis/comparison agent for human discussion — full read tools intentional |

**Why execution agents lost Read/Grep/Glob (Wave 3, spec `subagent-toolset-restriction`):** the curator orchestrator pre-bundles required file content inline. Re-discovery via Read/Grep negates the curator pattern's cost win (bench `orchestration-vs-solo` arm B vs arm C: 4× cost, 3.3× wall time, 3 vs 0 regressions). Tool absence makes the restriction correct-by-construction — a misbundled task surfaces as `CONTEXT_INSUFFICIENT: <path>` (curator gap, observable signal) rather than silent re-discovery.

**Escape hatch:** any execution agent that finds its bundle insufficient SHALL output `CONTEXT_INSUFFICIENT: <path>` on its own line and stop. The orchestrator reads the missing file and re-spawns with augmented context (max 2 retries; see `execute-v2-curator` AC-6).

---

## Agent Contracts

Each block below is machine-parseable by the hook via the pattern
(fenced block opening `yaml agent:<name>`, body, closing fence).

---

### df-haiku-ops

```yaml agent:df-haiku-ops
allowed-inputs:
  - exact-shell-commands: "Literal shell commands or git operation specs — no ambiguity"
  - operation-spec: "Structured description of git/filesystem operation with target paths"
  - exit-code-check: "Request to capture and return exit code + stdout/stderr of a command"

forbidden-inputs:
  - source-file-content: "Do not pass source code for reading or understanding — that is the coordinator's job"
  - architectural-context: "Do not include design rationale, trade-off analysis, or spec context"
  - edit-instructions: "Do not ask df-haiku-ops to modify file contents — only shell/git operations"
  - open-ended-questions: "Do not ask 'what should I commit?' — provide the exact commit message"

required-output-schema:
  exit: "Integer exit code (0 = success, non-zero = failure)"
  stdout: "Captured standard output of the command"
  stderr: "Captured standard error (may be empty)"
  task-status: "Final line must be TASK_STATUS:pass or TASK_STATUS:fail"
```

#### Risk concentration

As of T110 (narrow-bash-per-agent), df-haiku-ops holds the **widest Bash scope** in the system.
Git mutations (commit, push, branch, merge) and filesystem mutations that were previously on the global allowlist are now exclusively permitted for df-haiku-ops; all other agents operate under a narrower pattern set.

Enforcement is per-agent at hook load time via `hooks/df-bash-scope.js` (PreToolUse, Bash invocations) backed by scope definitions in `hooks/lib/bash-scopes.js`.
Every Bash invocation is appended to `.deepflow/bash-telemetry.jsonl` (one JSON line per call: role, command, decision, timestamp) for post-hoc audit.

Implication: a misconfigured or over-permissive df-haiku-ops contract grants access to the broadest mutation surface in the pipeline.
Review `allowedInputs` and `forbiddenInputs` for this agent with extra scrutiny before making any changes.

---

### df-implement

```yaml agent:df-implement
allowed-inputs:
  - task-id: "T{N}: label identifying the task (e.g. T3:)"
  - description: "Single-sentence task description"
  - files: "Files: list of file paths to read/edit (comma or newline separated)"
  - spec: "Spec: name of the owning spec"
  - success-criteria: "Success criteria: list of AC-{n} identifiers"
  - task-body: "MIDDLE block with full task context (requirements, dependencies, impact)"
  - spike-block: "Optional SPIKE_BLOCK with prior spike findings"
  - reverted-block: "Optional REVERTED_BLOCK with prior failure context"
  - lsp-impact: "Optional CONTEXT: Impact block injected by df-implement-protocol.js"
  - existing-types: "Optional CONTEXT: Existing Types block injected by df-implement-protocol.js"

forbidden-inputs:
  - orchestrator-summary: "Do not pass a paraphrased summary of the spec — pass the raw task body"
  - full-codebase-dump: "Do not include full file contents of files not listed in Files:"
  - other-task-context: "Do not include AC lists or task bodies from sibling tasks"
  - merge-instructions: "Do not include git merge, push, or branch-switch instructions"

required-output-schema:
  decisions: "Optional DECISIONS: block with [TAG] entries for non-obvious choices"
  ac-coverage: "AC_COVERAGE: block listing AC-{n}:done:covered by {evidence}"
  task-status: "Final line must be TASK_STATUS:pass, TASK_STATUS:fail, or TASK_STATUS:revert"
```

---

### df-integration

```yaml agent:df-integration
allowed-inputs:
  - task-id: "T{N} [INTEGRATION]: label"
  - spec-pair: "Integration ACs: listing the two specs being integrated (Spec A ↔ Spec B)"
  - integration-acs: "Explicit integration acceptance criteria"
  - specs-involved: "MIDDLE: Specs involved section listing all affected spec names"
  - interface-map: "MIDDLE: Interface Map section mapping producer and consumer surfaces"
  - contract-risks: "MIDDLE: Contract Risks section listing known breakage points"

forbidden-inputs:
  - single-spec-task: "Do not use df-integration for tasks touching only one spec — use df-implement"
  - orchestrator-summary: "Do not pass a paraphrased codebase summary — pass raw interface excerpts or delegate to reasoner"
  - acceptance-criteria-edits: "Do not ask df-integration to modify spec acceptance criteria"
  - producer-weakening: "Do not ask df-integration to change the producer interface to match a broken consumer"

required-output-schema:
  ac-coverage: "AC_COVERAGE: block for each integration AC"
  task-status: "Final line must be TASK_STATUS:pass or TASK_STATUS:fail"
```

---

### df-optimize

```yaml agent:df-optimize
allowed-inputs:
  - optimization-target: "Named file or module to optimize (e.g. 'hooks/df-implement-protocol.js token budget')"
  - baseline-metric: "Current measured cost: time in seconds, token count, line count, or bundle size in bytes"
  - improvement-goal: "Target improvement expressed as absolute or percentage (e.g. '≥20% token reduction')"
  - files: "Files: list of paths in scope for optimization"
  - constraints: "Behavioral constraints — what must not change externally"

forbidden-inputs:
  - feature-requests: "Do not ask df-optimize to add new functionality — file a spec instead"
  - unmeasured-targets: "Do not pass 'optimize X' without a baseline measurement — 'feels slow' is not valid"
  - spec-changes: "Do not ask df-optimize to modify acceptance criteria or spec definitions"
  - orchestrator-summary: "Do not pass a paraphrased description of the codebase — pass the target file paths directly"

required-output-schema:
  before-after: "Metric reported as: before {value} → after {value} ({pct}% improvement)"
  task-status: "Final line must be TASK_STATUS:pass or TASK_STATUS:fail"
```

---

### df-spike

```yaml agent:df-spike
allowed-inputs:
  - hypothesis: "Single-sentence falsifiable yes/no hypothesis"
  - experiment-design: "Optional: minimum viable experiment description"
  - files: "Optional Files: list of paths relevant to the hypothesis"
  - spike-id: "Optional T{N} [SPIKE]: label"

forbidden-inputs:
  - implementation-tasks: "Do not ask df-spike to edit existing source files — only Write to new experiment/probe files"
  - multi-hypothesis: "Do not pass more than one hypothesis per spike — split into separate T[SPIKE] tasks"
  - orchestrator-summary: "Do not pass a paraphrased problem statement — provide the raw hypothesis directly"
  - production-changes: "Do not ask df-spike to commit code changes to src/ or hooks/"

required-output-schema:
  result-file: "Write result to .deepflow/experiments/{topic}--{hypothesis}--{status}.md"
  conclusion: "PASSED/FAILED/INCONCLUSIVE with confidence level (HIGH/MEDIUM/LOW)"
  task-status: "Final line must be TASK_STATUS:pass or TASK_STATUS:fail"
```

---

### df-spike-platform

```yaml agent:df-spike-platform
allowed-inputs:
  - hypothesis: "Single-sentence falsifiable yes/no hypothesis about hook config or platform instrumentation"
  - hook-config: "Verbatim hook configuration excerpts or hook file paths relevant to the experiment"
  - platform-instrumentation: "Live runtime payload samples, telemetry output, or bash-telemetry.jsonl excerpts"
  - live-runtime-payload: "Raw PreToolUse/PostToolUse event payloads captured from a live Claude session"
  - experiment-design: "Optional: minimum viable experiment description scoped to hook/platform behavior"
  - spike-id: "Optional T{N} [SPIKE]: label"

forbidden-inputs:
  - production-source-edits: "Do not ask df-spike-platform to edit src/ or hooks/ production files — only Write to new experiment/probe files"
  - spec-edits: "Do not ask df-spike-platform to modify specs/*.md or PLAN.md"
  - plan-edits: "Do not ask df-spike-platform to add, remove, or reorder tasks in PLAN.md"
  - multi-hypothesis: "Do not pass more than one hypothesis per spike — split into separate T[SPIKE] tasks"
  - orchestrator-summary: "Do not pass a paraphrased problem statement — provide the raw hypothesis and raw payloads directly"

required-output-schema:
  result-file: "Write result to .deepflow/experiments/{topic}--{hypothesis}--{status}.md"
  conclusion: "PASSED/FAILED/INCONCLUSIVE with confidence level (HIGH/MEDIUM/LOW)"
  task-status: "Final line must be TASK_STATUS:pass or TASK_STATUS:fail"
```

#### Risk concentration

df-spike-platform operates at the boundary between Claude's hook system and live runtime events.
Its inputs are raw platform payloads (PreToolUse/PostToolUse events) rather than stable source files,
making payload-shape assumptions a primary failure mode.

Exemplar incidents:
- **T103** (parent spike INCONCLUSIVE): The spike could not determine the exact shape of the `bash_command`
  field in the PreToolUse Bash payload, leaving hook logic unverifiable without a live session.
- **T114-retry** (orchestrator escalation): The T114 spike was escalated to orchestrator after T103's
  INCONCLUSIVE result because the platform payload shape could not be inferred statically — a live
  instrumented session was required to observe actual field names and nesting.

Implication: any df-spike-platform task that concludes INCONCLUSIVE on payload shape MUST document
the specific unknown fields and escalate to the orchestrator for live-session capture before
downstream implementation tasks proceed.

---

### df-test

```yaml agent:df-test
allowed-inputs:
  - task-id: "T{N}: label identifying the test task"
  - module-under-test: "Explicit file path(s) of the source being tested"
  - files: "Files: list of test file paths to author or update"
  - success-criteria: "AC-{n} identifiers stating what behaviors must be covered"
  - test-constraints: "Optional: determinism requirements, network isolation, fixture data paths"

forbidden-inputs:
  - production-source-edits: "Do not ask df-test to modify non-test source files unless explicitly permitted by the task"
  - open-ended-coverage: "Do not ask df-test to 'add tests for everything' — specify ACs"
  - orchestrator-summary: "Do not pass a paraphrased description of what to test — pass the module path and ACs directly"
  - merge-instructions: "Do not include git merge or push instructions"

required-output-schema:
  decisions: "Optional DECISIONS: block for non-obvious test design choices"
  ac-coverage: "AC_COVERAGE: block listing AC-{n}:done:covered by {test name or assertion}"
  task-status: "Final line must be TASK_STATUS:pass, TASK_STATUS:fail, or TASK_STATUS:revert"
```

---

### reasoner

```yaml agent:reasoner
allowed-inputs:
  - analysis-request: "Named analytical task: prioritization, debugging, spec comparison, architecture decision"
  - raw-artifacts: "Verbatim artifacts to analyze: transcripts, diffs, spec text, log output"
  - question: "Single focused question requiring deep reasoning"
  - context-files: "Optional file paths for reasoner to Read during analysis"

forbidden-inputs:
  - implementation-tasks: "Do not ask reasoner to write or edit source code — use df-implement"
  - test-authoring: "Do not ask reasoner to write test files — use df-test"
  - shell-operations: "Do not ask reasoner to run git or shell commands as primary output — use df-haiku-ops"
  - multi-question-overload: "Do not pass more than one analytical question per spawn — split if needed"

required-output-schema:
  analysis: "## Analysis section: what was analyzed"
  findings: "## Findings section: key discoveries with evidence (file:line citations)"
  recommendation: "## Recommendation section: suggested action with rationale"
  max-length: "500 words maximum"
```

---

## Enforcement

The hook `hooks/df-delegation-contract.js` fires on every `Task` tool invocation.

For each spawn it:
1. Identifies the target agent from `subagent_type` (or `agent:` field in the prompt)
2. Looks up the agent's contract block from this file (cached at hook load time)
3. Checks the prompt against `forbidden-inputs` patterns
4. Checks the prompt for presence of `required` fields listed in `allowed-inputs`
5. If a violation is found, blocks the spawn and emits a structured error:

```
DELEGATION CONTRACT VIOLATION
Agent: {agent-name}
Rule: {forbidden-input key or required-input key}
Ref: DELEGATION.md#{agent-name}
Fix: {one-line remediation hint}
```

To suppress enforcement for a spawn (escape hatch, use sparingly):
Add `<!-- df-delegation-contract:skip -->` anywhere in the prompt.
