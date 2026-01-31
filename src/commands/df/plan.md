# /df:plan — Generate Task Plan from Specs

## Purpose
Compare specs against codebase, identify gaps, generate prioritized task list.

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

### 2. DETECT PROJECT CONTEXT

For existing codebases, identify:
- Code style/conventions
- Existing patterns (error handling, API structure)
- Integration points

Include patterns in task descriptions for agents to follow.

### 3. ANALYZE CODEBASE

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

### 4. COMPARE & PRIORITIZE

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

### 5. OUTPUT PLAN.md

Append tasks grouped by `### doing-{spec-name}`. Include spec gaps if any.

### 6. RENAME SPECS

`mv specs/feature.md specs/doing-feature.md`

### 7. REPORT

`✓ Plan generated — {n} specs, {n} tasks. Run /df:execute`

## Rules
- **Plan only** — Do NOT implement anything
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

- [ ] **T2**: Add S3 service
  - Files: src/services/storage.ts
  - Blocked by: T1
```
