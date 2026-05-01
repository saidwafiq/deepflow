---
name: df:spec
description: Transform conversation context into a structured specification file with requirements, acceptance criteria, and curated task plan
allowed-tools: [Task, AskUserQuestion, Read, Write, Bash]
---

# /df:spec — Generate Spec from Conversation

## Flags

- `--curate` — run only the curation phase against an existing spec. Skip §1–§3; read REQs/ACs from the existing spec, jump to §4, append/replace `## Tasks (curated)` and `## Execution graph`, write back.
- `--upgrade {path}` — re-curate an existing spec.md in place. Read the spec at `{path}`, run §4 against the current REQs/ACs and current code state, replace any pre-existing `## Tasks (curated)` and `## Execution graph` sections (or append if absent), write back to the same path. Use to migrate pre-curator specs.

## Orchestrator Role

Coordinate agents, ask questions, read files for curation, write spec. Never search code with Grep/Glob.

**NEVER:** Use Glob/Grep directly, run git, use TaskOutput, EnterPlanMode, ExitPlanMode

**ONLY:** Spawn agents (non-background), ask user questions, Read target files during curation, run Bash for LSP/decisions, write spec file

## Agents

| Agent | subagent_type | model | Count | Purpose |
|-------|---------------|-------|-------|---------|
| Explore | `Explore` | `haiku` | 2-3 (<20 files), 5-8 (20-100), 10-15 (100+) | Find related code, patterns |
| Reasoner | `reasoner` | `opus` | 1 | Synthesize into requirements |

Skill: `gap-discovery` — Proactive requirement gap identification

**IMPORTANT**: Always use `Task` tool with explicit `subagent_type` and `model` parameters.

## Behavior

### 1. GATHER CODEBASE CONTEXT

Check for `specs/.debate-{name}.md` first — if exists, read it and pass Synthesis section to reasoner in step 3.

**Upstream artifact loader** (shell injection — load before spawning explore agents; proceed normally when absent):
- `` !`cat .deepflow/maps/{name}/sketch.md 2>/dev/null || echo 'NOT_FOUND'` `` (discover prior: modules, entry_points, related_specs; `{name}` is the `<name>` argument)
- `` !`cat .deepflow/codebase/STACK.md 2>/dev/null || echo 'NOT_FOUND'` `` (runtime, deps, scripts)
- `` !`cat .deepflow/codebase/ARCHITECTURE.md 2>/dev/null || echo 'NOT_FOUND'` `` (component map, data flow, design patterns)
- `` !`cat .deepflow/codebase/INTEGRATIONS.md 2>/dev/null || echo 'NOT_FOUND'` `` (external services, env vars)

If any `.deepflow/codebase/*.md` loaders return `NOT_FOUND`, proceed but add hint in §6 confirmation: `ℹ .deepflow/codebase/ artifacts not generated — run /df:map for warm-up context on next /df:spec`.

Pass loaded artifacts to reasoner in §3 under `## Codebase warm-up`. Follow `templates/explore-agent.md`. Find: related implementations, patterns, integration points, TODOs.

### 2. GAP CHECK (layer-aware)

Use `gap-discovery` skill. Gaps determine spec layer — they do NOT block spec creation.

- Core objective clear → L0
- Requirements enumerated → L1
- Testable ACs stated → L2
- Scope boundaries + constraints + technical context → L3

**L0-L1 gaps:** AskUserQuestion (max 4 per call). **L2-L3 gaps:** Do NOT block — write spec at current layer.

### 3. SYNTHESIZE FINDINGS

Spawn reasoner agent (`subagent_type: "reasoner"`, `model: "opus"`). Pass Explore agent outputs **verbatim**. The reasoner receives:

```
## Analysis request: Synthesize codebase findings into a specification

## Codebase warm-up (verbatim from .deepflow/codebase/, when generated)

{verbatim contents of STACK.md, ARCHITECTURE.md, INTEGRATIONS.md — concatenated with file-name headers; or "(not generated — run /df:map)" when all three returned NOT_FOUND}

## Explore agent outputs (verbatim — do NOT read any files; work from these outputs only)

{verbatim outputs from all Explore agents, concatenated in order}

## Debate context (if specs/.debate-{name}.md exists)

{verbatim Synthesis section from the debate file — or "(none)" if no debate file}

## Synthesis task

1. Identify constraints from existing architecture
2. Suggest requirements based on patterns found
3. Flag conflicts with existing code
4. Verify every REQ-N has a corresponding AC; flag uncovered requirements
5. Flag vague/untestable requirements
6. If Explore agents found relevant type definitions, include ## Domain Model with Key Types (signatures only) and Ubiquitous Language. Omit if no relevant types found.

Return ONLY the structured findings. No preamble.
```

The orchestrator stores the reasoner output verbatim for §4 and §5.

### 4. CURATE TASKS

Using the reasoner's synthesis output and the spec layer, build the curated task plan. This replaces the former /df:plan phase.

**L0 specs → spike-only mode:** emit one spike task (no implementation tasks). Skip touch-set computation.

**L2+ specs → full curation:**

#### 4a. Impact analysis (run before slicing)

```bash
# LSP refs per touched module (skip silently if bin absent)
node "${HOME}/.claude/bin/lsp-query.js" --refs <symbol> --json 2>/dev/null || true

# Decisions index over candidate file paths (skip silently if bin absent)
node "${HOME}/.claude/bin/decisions-index.js" <file_paths> 2>/dev/null || true
```

Use output to surface prior decisions/experiments relevant to slices.

#### 4b. Slice the work

Each task touches one logical unit (one file, one function, one cohesive set of related edits). Use Read to load actual file content for each slice. Extract excerpts ≤30 lines per region, rendering as fenced code blocks:

````
```
# file: path/to/file.ext (excerpt — description, lines N-M)
<code excerpt>
```
````

#### 4c. Compute file-touch sets and parallelism

For each task T, compute `touch(T)` = union of files in: Slice field + Context bundle `# file:` headers + Subagent prompt edit targets.

- `touch(Ta) ∩ touch(Tb) = ∅` → both are `[P]`
- `touch(Ta) ∩ touch(Tb) ≠ ∅` → lower-numbered task is the blocker; higher task gets `Blocked by: T<n>`

Conflict detection is deterministic at curation time, never runtime inference.

#### 4d. Render curated section

Append to spec after Acceptance Criteria:

```markdown
## Tasks (curated)

### T1: [TYPE] {Short title}
**Slice:** {file or function being changed}
**Parallel:** [P]  ← or: Blocked by: T<n>[, T<m>]
**Context bundle:**
​```
# file: path/to/file.ext (excerpt — description, lines N-M)
{code excerpt ≤30 lines}
​```
**Subagent prompt:**
> {Full instruction text}
> CRITICAL: do not use Read/Grep/Glob. The bundle above is exhaustive. If context is missing, output CONTEXT_INSUFFICIENT: <file_path> and stop.
```

**Title type marker** drives subagent selection in `/df:execute`. Required when applicable, omit otherwise:

| Marker | Used when | subagent_type |
|--------|-----------|---------------|
| `[INTEGRATION]` | Task wires together producer/consumer interfaces from prior tasks | `df-integration` |
| `[SPIKE]` | Hypothesis-validating exploration (L0 specs always emit these) | `df-spike` |
| `[TEST]` | Dedicated test-writing task | `df-test` |
| `[OPTIMIZE]` | Has an `Optimize:` block with metric/target | `df-optimize` |
| (none) | Standard implementation task | `df-implement` |

#### 4e. Execution graph (>2 tasks only)

```markdown
## Execution graph

​```
Wave 1: T1 [P] | T2 [P]   (reason)
Wave 2: T3                (depends on T1, T2)
​```
```

### 5. GENERATE SPEC

Run `validateSpec` on generated content **before** writing.
- **Hard failure:** Do NOT write. Show errors with fix suggestions, re-synthesize.
- **Advisory warnings:** Write file, display warnings after confirmation.
- **Layer < 2:** Expected when info incomplete. Write the spec.

Create `specs/{name}.md` with the curated section already appended:

```markdown
# {Name}

## Objective
[One sentence: what this achieves for the user]

## Requirements
- REQ-1: [Requirement]

## Constraints
- [Constraint]

## Out of Scope
- [Explicitly excluded item]

## Acceptance Criteria
- [ ] **AC-1** — (REQ-1) WHEN [condition] THEN [outcome] SHALL [assertion]

## Technical Notes
[Implementation hints from codebase analysis]

## Tasks (curated)

### T1: ...
...

## Execution graph   ← only when >2 tasks

...
```

### 6. CONFIRM

```
✓ Created specs/{name}.md — Layer {N} ({label})

Requirements: {count}
Acceptance criteria: {count}
Tasks (curated): {count}

Next: Run /df:execute to spawn curated tasks
```

When curation was skipped (e.g., L0 with no spike emitted): `Next: Refine the spec; run /df:execute when ready`

**Layer labels:** L0="problem defined", L1="requirements known", L2="verifiable", L3="fully constrained"

If layer < 2: `ℹ Spec is at L{N} — /df:execute will generate spikes to discover what's missing. To deepen: add {missing sections for next layer}.`

## Rules

- Orchestrator never searches with Grep/Glob — spawn agents for codebase exploration
- Do NOT generate spec if L0 gaps remain (no clear objective)
- L2+ gaps do NOT block spec creation
- Max 4 questions per AskUserQuestion call
- Requirements must be testable; ACs must be verifiable (when present)
- Every AC line MUST use format `- [ ] **AC-N** — (REQ-M) ...`; never reuse `REQ-N:` as AC identifier
- Every AC description MUST follow WHEN/THEN/SHALL phrasing in that order
- `[P]` only when file-touch sets are pairwise empty; otherwise `Blocked by: T<n>`
- Excerpts ≤30 lines per region
- Subagent prompts MUST end with: `CRITICAL: do not use Read/Grep/Glob. The bundle above is exhaustive. If context is missing, output CONTEXT_INSUFFICIENT: <file_path> and stop.`
- Include agent-discovered context in Technical Notes
- Keep specs concise (<100 lines for spec body, excluding Tasks section)
