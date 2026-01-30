# /df:plan — Generate Task Plan from Specs

## Purpose
Compare specs against codebase, identify gaps, generate prioritized task list.

## Usage
```
/df:plan
```

## Skills & Agents
- Skill: `code-completeness` — Find TODOs, stubs, incomplete work
- Agent: `reasoner` (Opus) — Complex analysis and prioritization

## Behavior

### 1. LOAD CONTEXT

```
Load:
- specs/*.md (all spec files)
- PLAN.md (if exists, prior state)
- .specflow/config.yaml (if exists)

Determine source_dir from config or default to src/
```

### 2. ANALYZE CODEBASE

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

### 3. COMPARE & PRIORITIZE

**Spawn `reasoner` agent** (Opus) for complex analysis:

| Status | Meaning | Action |
|--------|---------|--------|
| DONE | Fully implemented | Mark complete |
| PARTIAL | Stub or incomplete | Task to complete |
| MISSING | Not found in code | Task to implement |
| CONFLICT | Code contradicts spec | Flag for review |

Reasoner prioritizes by dependencies, impact, and risk.

### 4. PRIORITIZE

Order tasks by:
1. **Dependencies** — Blockers first
2. **Impact** — Core features before enhancements
3. **Risk** — Unknowns early (reduce risk)

### 5. OUTPUT PLAN.md

```markdown
# Plan

Generated: {timestamp}
Specs analyzed: {count}

## Spec Gaps
[If any specs need updates, list here]
- [ ] specs/X.md: Missing error handling definition

## Tasks

### {spec-name}

- [ ] **T1**: {task description}
  - Files: {files to create/modify}
  - Blocked by: none

- [ ] **T2**: {task description}
  - Files: {files}
  - Blocked by: T1

### {another-spec}

- [ ] **T3**: {task description}
  - Files: {files}
  - Blocked by: none
```

### 6. REPORT

```
✓ Plan generated

Specs analyzed: {n}
Tasks created: {n}
Spec gaps found: {n}

Ready to execute: {n} tasks (no blockers)

Next: Run /df:execute to start implementation
```

## Rules
- **Plan only** — Do NOT implement anything
- **Confirm before assume** — Search code before marking "missing"
- **One task = one logical unit** — Atomic, committable
- Prefer existing utilities over new code
- Flag spec gaps, don't silently ignore

## Agent Spawning Rules

```yaml
search_agents:
  base: 10
  per_files: 20  # 1 agent per 20 files
  cap: 100

analyze_agents:
  base: 5
  per_specs: 2   # 1 agent per 2 specs
  cap: 20

model_selection:
  search: sonnet
  analyze: opus
```

## Example Output

```markdown
# Plan

Generated: 2025-01-28 14:30
Specs analyzed: 2

## Spec Gaps
- [ ] specs/image-upload.md: No error handling for S3 failures defined

## Tasks

### image-upload

- [ ] **T1**: Create upload API endpoint
  - Files: src/api/upload.ts (create)
  - Blocked by: none

- [ ] **T2**: Add file validation middleware
  - Files: src/middleware/validate.ts (create)
  - Blocked by: none

- [ ] **T3**: Implement S3 upload service
  - Files: src/services/storage.ts (create)
  - Blocked by: T1

- [ ] **T4**: Complete thumbnail generation
  - Files: src/services/image.ts:45 (stub found)
  - Blocked by: T3

### color-extraction

- [ ] **T5**: Integrate color-thief library
  - Files: src/services/color.ts (create)
  - Blocked by: T1
```
