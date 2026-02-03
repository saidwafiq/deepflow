# /df:plan — Generate Task Plan from Specs

## Purpose
Compare specs against codebase and past experiments. Generate prioritized tasks.

## Usage
```
/df:plan                 # Plan all new specs
/df:plan feature.md      # Plan specific spec
```

## Skills & Agents
- Skill: `code-completeness` — Find TODOs, stubs, incomplete work
- Agent: `reasoner` (Opus) — Complex analysis and prioritization

## Spec File States

```
specs/
  feature.md        → New, needs planning (this command reads these)
  doing-auth.md     → In progress, has tasks in PLAN.md
  done-payments.md  → Completed, history embedded
```

**Filtering:**
- New: `specs/*.md` excluding `doing-*` and `done-*`
- In progress: `specs/doing-*.md`
- Completed: `specs/done-*.md`

## Behavior

### 1. LOAD CONTEXT

```
Load:
- specs/*.md EXCLUDING doing-* and done-* (only new specs)
- PLAN.md (if exists, for appending)
- .deepflow/config.yaml (if exists)

Determine source_dir from config or default to src/
```

If no new specs: report counts, suggest `/df:execute`.

### 2. CHECK PAST EXPERIMENTS (SPIKE-FIRST)

**CRITICAL**: Check experiments BEFORE generating any tasks.

Extract topic from spec name (fuzzy match), then:

```
Glob .deepflow/experiments/{topic}--*
```

**Experiment file naming:** `{topic}--{hypothesis}--{status}.md`
Statuses: `active`, `passed`, `failed`

| Result | Action |
|--------|--------|
| `--failed.md` exists | Extract "next hypothesis" from Conclusion section |
| `--passed.md` exists | Reference as validated pattern, can proceed to full implementation |
| `--active.md` exists | Wait for experiment completion before planning |
| No matches | New topic, needs initial spike |

**Spike-First Rule**:
- If `--failed.md` exists: Generate spike task to test the next hypothesis (from failed experiment's Conclusion)
- If no experiments exist: Generate spike task for the core hypothesis
- Full implementation tasks are BLOCKED until a spike validates the approach
- Only proceed to full task generation after `--passed.md` exists

See: `templates/experiment-template.md` for experiment format

### 3. DETECT PROJECT CONTEXT

For existing codebases, identify:
- Code style/conventions
- Existing patterns (error handling, API structure)
- Integration points

Include patterns in task descriptions for agents to follow.

### 4. ANALYZE CODEBASE

**Spawn ALL Explore agents in ONE message, then wait for ALL with TaskOutput in ONE message:**
```
// Spawn all in single message:
t1 = Task(subagent_type="Explore", model="haiku", run_in_background=true, prompt="...")
t2 = Task(subagent_type="Explore", model="haiku", run_in_background=true, prompt="...")

// Wait all in single message:
TaskOutput(task_id=t1)
TaskOutput(task_id=t2)
```

Scale agent count based on codebase size:

| File Count | Agents |
|------------|--------|
| <20 | 3-5 |
| 20-100 | 10-15 |
| 100-500 | 25-40 |
| 500+ | 50-100 (cap) |

**Explore Agent Prompt Structure:**
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

Max response: 500 tokens (configurable via .deepflow/config.yaml explore.max_tokens)
```

**Explore Agent Scope Restrictions:**
- MUST only report factual findings:
  - Files found
  - Patterns/conventions observed
  - Integration points
- MUST NOT:
  - Make recommendations
  - Propose architectures
  - Read and summarize specs (that's orchestrator's job)
  - Draw conclusions about what should be built

**Use `code-completeness` skill patterns** to search for:
- Implementations matching spec requirements
- TODO, FIXME, HACK comments
- Stub functions, placeholder returns
- Skipped tests, incomplete coverage

### 5. COMPARE & PRIORITIZE

**Use Task tool to spawn reasoner agent:**
```
Task tool parameters:
- subagent_type: "reasoner"
- model: "opus"
```

Reasoner performs analysis:

| Status | Action |
|--------|--------|
| DONE | Skip |
| PARTIAL | Task to complete |
| MISSING | Task to implement |
| CONFLICT | Flag for review |

**Spec gaps:** If spec is ambiguous or missing details, note in output (don't silently assume).

**Priority order:**
1. Dependencies — blockers first
2. Impact — core features before enhancements
3. Risk — unknowns early

### 6. GENERATE SPIKE TASKS (IF NEEDED)

**When to generate spike tasks:**
1. Failed experiment exists → Test the next hypothesis
2. No experiments exist → Test the core hypothesis
3. Passed experiment exists → Skip to full implementation

**Spike Task Format:**
```markdown
- [ ] **T1** [SPIKE]: Validate {hypothesis}
  - Type: spike
  - Hypothesis: {what we're testing}
  - Method: {minimal steps to validate}
  - Success criteria: {how to know it passed}
  - Time-box: 30 min
  - Files: .deepflow/experiments/{topic}--{hypothesis}--{status}.md
  - Blocked by: none
```

**Blocking Logic:**
- All implementation tasks MUST have `Blocked by: T{spike}` until spike passes
- After spike completes:
  - If passed: Update experiment to `--passed.md`, unblock implementation tasks
  - If failed: Update experiment to `--failed.md`, DO NOT generate implementation tasks

**Full Implementation Only After Spike:**
- Only generate full task list when spike validates the approach
- Never generate 10-task waterfall without validated hypothesis

### 7. VALIDATE HYPOTHESES

Test risky assumptions before finalizing plan.

**Validate when:** Unfamiliar APIs, multiple approaches possible, external integrations, performance-critical

**Process:**
1. Prototype in scratchpad (not committed)
2. Test assumption
3. If fails → Write `.deepflow/experiments/{topic}--{hypothesis}--failed.md`
4. Adjust approach, document in task

**Skip:** Well-known patterns, simple CRUD, clear docs exist

### 8. OUTPUT PLAN.md

Append tasks grouped by `### doing-{spec-name}`. Include spec gaps and validation findings.

### 9. RENAME SPECS

`mv specs/feature.md specs/doing-feature.md`

### 10. REPORT

`✓ Plan generated — {n} specs, {n} tasks. Run /df:execute`

## Rules
- **Spike-first** — Generate spike task before full implementation if no `--passed.md` experiment exists
- **Block on spike** — Full implementation tasks MUST be blocked by spike validation
- **Learn from failures** — Extract "next hypothesis" from failed experiments, never repeat same approach
- **Learn from history** — Check past experiments before proposing approaches
- **Plan only** — Do NOT implement anything (except quick validation prototypes)
- **Validate before commit** — Test risky assumptions with minimal experiments
- **Confirm before assume** — Search code before marking "missing"
- **One task = one logical unit** — Atomic, committable
- Prefer existing utilities over new code
- Flag spec gaps, don't silently ignore

## Agent Scaling

| Agent | Model | Base | Scale |
|-------|-------|------|-------|
| Explore (search) | haiku | 10 | +1 per 20 files |
| Reasoner (analyze) | opus | 5 | +1 per 2 specs |

**IMPORTANT**: Always use the `Task` tool with explicit `subagent_type` and `model` parameters. Do NOT use Glob/Grep/Read directly for codebase analysis - spawn agents instead.

## Example

### Spike-First (No Prior Experiments)

```markdown
# Plan

### doing-upload

- [ ] **T1** [SPIKE]: Validate streaming upload approach
  - Type: spike
  - Hypothesis: Streaming uploads will handle files >1GB without memory issues
  - Method: Create minimal endpoint, upload 2GB file, measure memory
  - Success criteria: Memory stays under 500MB during upload
  - Time-box: 30 min
  - Files: .deepflow/experiments/upload--streaming--active.md
  - Blocked by: none

- [ ] **T2**: Create upload endpoint
  - Files: src/api/upload.ts
  - Blocked by: T1 (spike must pass)

- [ ] **T3**: Add S3 service with streaming
  - Files: src/services/storage.ts
  - Blocked by: T1 (spike must pass), T2
```

### Spike-First (After Failed Experiment)

```markdown
# Plan

### doing-upload

- [ ] **T1** [SPIKE]: Validate chunked upload with backpressure
  - Type: spike
  - Hypothesis: Adding backpressure control will prevent buffer overflow
  - Method: Implement pause/resume on buffer threshold, test with 2GB file
  - Success criteria: No memory spikes above 500MB
  - Time-box: 30 min
  - Files: .deepflow/experiments/upload--chunked-backpressure--active.md
  - Blocked by: none
  - Note: Previous approach failed (see upload--buffer-upload--failed.md)

- [ ] **T2**: Implement chunked upload endpoint
  - Files: src/api/upload.ts
  - Blocked by: T1 (spike must pass)
```

### After Spike Validates (Full Implementation)

```markdown
# Plan

### doing-upload

- [ ] **T1**: Create upload endpoint
  - Files: src/api/upload.ts
  - Blocked by: none
  - Note: Use streaming (validated in upload--streaming--passed.md)

- [ ] **T2**: Add S3 service with streaming
  - Files: src/services/storage.ts
  - Blocked by: T1
  - Avoid: Direct buffer upload failed (see upload--buffer-upload--failed.md)
```
