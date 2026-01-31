# /df:plan — Generate Task Plan from Specs

## Purpose
Compare specs against codebase AND past experiments, identify gaps, generate prioritized task list informed by historical learnings.

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

### 2. CHECK PAST EXPERIMENTS

Before proposing approaches, learn from history:

```
1. Extract domains from spec keywords (performance, auth, caching, api, etc.)
2. Glob `.deepflow/experiments/{domain}--*`
3. Read matching files (filenames are the index, minimal token cost)
4. Note failed approaches to avoid
5. Note successful patterns to reuse
```

**If experiments found:**
- Failed: Exclude approach from plan, note why
- Success: Reference as pattern to follow

**File naming convention:**
```
.deepflow/experiments/
  {domain}--{approach}--{result}.md

Examples:
  perf--redis-caching--failed.md
  perf--connection-pooling--success.md
  auth--jwt-refresh--success.md
```

**No experiments?** Continue normally—this is expected for new projects.

### 3. DETECT PROJECT CONTEXT

For existing codebases, identify:
- Code style/conventions
- Existing patterns (error handling, API structure)
- Integration points

Include patterns in task descriptions for agents to follow.

### 4. ANALYZE CODEBASE

**Spawn Explore agents** (haiku, read-only) with dynamic count:

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

**Spawn `reasoner` agent** (Opus) for analysis:

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

### 6. VALIDATE HYPOTHESES

Before finalizing the plan, identify and test risky assumptions:

**When to validate:**
- Unfamiliar APIs or libraries
- Architectural decisions with multiple approaches
- Integration with external systems
- Performance-critical paths

**How to validate:**
1. Create minimal prototype (scratchpad, not committed)
2. Test the specific assumption
3. If fails: Write to `.deepflow/experiments/{domain}--{approach}--failed.md`
4. Adjust approach based on findings
5. Document learnings in task description

**Examples:**
- "Does SessionStart hook run once per session?" → Test with simple log
- "Can we use streaming for large files?" → Prototype with sample data
- "Will this regex handle edge cases?" → Test against real samples

**Skip validation when:**
- Using well-known patterns
- Simple CRUD operations
- Clear documentation exists

### 7. OUTPUT PLAN.md

Append tasks grouped by `### doing-{spec-name}`. Include spec gaps and validation findings.

### 8. RENAME SPECS

`mv specs/feature.md specs/doing-feature.md`

### 9. REPORT

`✓ Plan generated — {n} specs, {n} tasks. Run /df:execute`

## Rules
- **Learn from history** — Check past experiments before proposing approaches
- **Plan only** — Do NOT implement anything (except quick validation prototypes)
- **Validate before commit** — Test risky assumptions with minimal experiments
- **Confirm before assume** — Search code before marking "missing"
- **One task = one logical unit** — Atomic, committable
- Prefer existing utilities over new code
- Flag spec gaps, don't silently ignore

## Agent Scaling

| Agent | Base | Scale |
|-------|------|-------|
| Explore (search) | 10 | +1 per 20 files |
| Reasoner (analyze) | 5 | +1 per 2 specs |

## Example

```markdown
# Plan

### doing-upload

- [ ] **T1**: Create upload endpoint
  - Files: src/api/upload.ts
  - Blocked by: none

- [ ] **T2**: Add S3 service with streaming
  - Files: src/services/storage.ts
  - Blocked by: T1
  - Note: Use streaming (see experiments/perf--chunked-upload--success.md)
  - Avoid: Direct buffer upload failed for large files (experiments/perf--buffer-upload--failed.md)
```
