# /df:plan — Generate Task Plan from Specs

## Purpose
Compare specs against codebase and past experiments. Generate prioritized tasks.

**NEVER:** use EnterPlanMode, use ExitPlanMode — this command IS the planning phase; native plan mode conflicts with it

## Usage
```
/df:plan                 # Plan all new specs
/df:plan feature.md      # Plan specific spec
```

## Skills & Agents
- Skill: `code-completeness` — Find TODOs, stubs, incomplete work
- Agent: `reasoner` (Opus) — Complex analysis and prioritization

## Spec File States

| Prefix | State | Action |
|--------|-------|--------|
| (none) | New | Plan this |
| `doing-` | In progress | Skip |
| `done-` | Completed | Skip |

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

Follow `templates/explore-agent.md` for spawn rules, prompt structure, and scope restrictions.

Scale agent count based on codebase size:

| File Count | Agents |
|------------|--------|
| <20 | 3-5 |
| 20-100 | 10-15 |
| 100-500 | 25-40 |
| 500+ | 50-100 (cap) |

**Use `code-completeness` skill patterns** to search for:
- Implementations matching spec requirements
- TODO, FIXME, HACK comments
- Stub functions, placeholder returns
- Skipped tests, incomplete coverage

### 5. COMPARE & PRIORITIZE

Spawn `Task(subagent_type="reasoner", model="opus")`. Reasoner maps each requirement to DONE / PARTIAL / MISSING / CONFLICT. Flag spec gaps; don't silently assume.

**Priority order:** Dependencies → Impact → Risk

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

**Blocking Logic:** All implementation tasks MUST have `Blocked by: T{spike}` until spike passes. If spike fails: update to `--failed.md`, DO NOT generate implementation tasks.

### 7. VALIDATE HYPOTHESES

For unfamiliar APIs, ambiguous approaches, or performance-critical work: prototype in scratchpad (not committed). If assumption fails, write `.deepflow/experiments/{topic}--{hypothesis}--failed.md`. Skip for well-known patterns/simple CRUD.

### 8. CLEANUP PLAN.md

Before writing new tasks, prune stale sections:

```
For each ### section in PLAN.md:
  Extract spec name from header (e.g. "doing-upload" or "done-upload")
  If specs/done-{name}.md exists:
    → Remove the ENTIRE section: header, tasks, execution summary, fix tasks, separators
  If header references a spec with no matching specs/doing-*.md or specs/done-*.md:
    → Remove it (orphaned section)
```

Also recalculate the Summary table (specs analyzed, tasks created/completed/pending) to reflect only remaining sections.

If PLAN.md becomes empty after cleanup, delete the file and recreate fresh.

### 9. OUTPUT PLAN.md

Append tasks grouped by `### doing-{spec-name}`. Include spec gaps and validation findings.

### 10. RENAME SPECS

`mv specs/feature.md specs/doing-feature.md`

### 11. REPORT

`✓ Plan generated — {n} specs, {n} tasks. Run /df:execute`

### 12. CAPTURE DECISIONS

Follow the **default** variant from `templates/decision-capture.md`. Command name: `plan`.

## Rules
- **Spike-first** — Generate spike task before full implementation if no `--passed.md` experiment exists
- **Block on spike** — Full implementation tasks MUST be blocked by spike validation
- **Learn from failures** — Extract "next hypothesis" from failed experiments, never repeat same approach
- **Plan only** — Do NOT implement (except quick validation prototypes)
- **Confirm before assume** — Search code before marking "missing"
- **One task = one logical unit** — Atomic, committable
- Prefer existing utilities over new code; flag spec gaps

## Agent Scaling

| Agent | Model | Base | Scale |
|-------|-------|------|-------|
| Explore (search) | haiku | 10 | +1 per 20 files |
| Reasoner (analyze) | opus | 5 | +1 per 2 specs |

Always use the `Task` tool with explicit `subagent_type` and `model`. Do NOT use Glob/Grep/Read directly.

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
