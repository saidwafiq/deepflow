# /df:plan — Generate Task Plan from Specs

## Purpose
Compare specs against codebase and past experiments. Generate prioritized tasks.

**NEVER:** use EnterPlanMode, use ExitPlanMode — this command IS the planning phase

## Usage
```
/df:plan                 # Plan all new specs
/df:plan feature.md      # Plan specific spec
```

## Skills & Agents
- Skill: `code-completeness` — Find TODOs, stubs, incomplete work
- Agent: `reasoner` (Opus) — Complex analysis and prioritization

## Spec File States

| Prefix | Action |
|--------|--------|
| (none) | Plan this |
| `doing-` | Skip |
| `done-` | Skip |

## Behavior

### 1. LOAD CONTEXT

```
Load: specs/*.md (exclude doing-*/done-*), PLAN.md (if exists), .deepflow/config.yaml
Determine source_dir from config or default to src/
```

Run `validateSpec` on each spec. Hard failures → skip + error. Advisory → include in output.
No new specs → report counts, suggest `/df:execute`.

### 2. CHECK PAST EXPERIMENTS (SPIKE-FIRST)

**CRITICAL**: Check experiments BEFORE generating any tasks.

```
Glob .deepflow/experiments/{topic}--*
```

File naming: `{topic}--{hypothesis}--{status}.md` (active/passed/failed)

| Result | Action |
|--------|--------|
| `--failed.md` | Extract "next hypothesis" from Conclusion, generate spike |
| `--passed.md` | Proceed to full implementation |
| `--active.md` | Wait for completion |
| No matches | New topic, generate initial spike |

Full implementation tasks BLOCKED until spike validates. See `templates/experiment-template.md`.

### 3. DETECT PROJECT CONTEXT

Identify code style, patterns (error handling, API structure), integration points. Include in task descriptions.

### 4. ANALYZE CODEBASE

Follow `templates/explore-agent.md` for spawn rules and scope.

| File Count | Agents |
|------------|--------|
| <20 | 3-5 |
| 20-100 | 10-15 |
| 100-500 | 25-40 |
| 500+ | 50-100 (cap) |

Use `code-completeness` skill to search for: implementations matching spec requirements, TODOs/FIXMEs/HACKs, stubs, skipped tests.

### 4.5. IMPACT ANALYSIS (per planned file)

For each file in a task's "Files:" list, find the full blast radius.

**Search for:**

1. **Callers:** `grep -r "{exported_function}" --include="*.{ext}" -l` — files that import/call what's being changed
2. **Duplicates:** Files with similar logic (same function name, same transformation). Classify:
   - `[active]` — used in production → must consolidate
   - `[dead]` — bypassed/unreachable → must delete
3. **Data flow:** If file produces/transforms data, find ALL consumers of that shape across languages

**Embed as `Impact:` block in each task:**
```markdown
- [ ] **T2**: Add new features to YAML export
  - Files: src/utils/buildConfigData.ts
  - Impact:
    - Callers: src/routes/index.ts:12, src/api/handler.ts:45
    - Duplicates:
      - src/components/YamlViewer.tsx:19 (own generateYAML) [active — consolidate]
      - backend/yaml_gen.go (generateYAMLFromConfig) [dead — DELETE]
    - Data flow: buildConfigData → YamlViewer, SimControls, RoleplayPage
  - Blocked by: T1
```

Files outside original "Files:" → add with `(impact — verify/update)`.
Skip for spike tasks.

### 5. COMPARE & PRIORITIZE

Spawn `Task(subagent_type="reasoner", model="opus")`. Map each requirement to DONE / PARTIAL / MISSING / CONFLICT. Check REQ-AC alignment. Flag spec gaps.

Priority: Dependencies → Impact → Risk

### 6. GENERATE SPIKE TASKS (IF NEEDED)

**Spike Task Format:**
```markdown
- [ ] **T1** [SPIKE]: Validate {hypothesis}
  - Type: spike
  - Hypothesis: {what we're testing}
  - Method: {minimal steps}
  - Success criteria: {measurable}
  - Time-box: 30 min
  - Files: .deepflow/experiments/{topic}--{hypothesis}--{status}.md
  - Blocked by: none
```

All implementation tasks MUST `Blocked by: T{spike}`. Spike fails → `--failed.md`, no implementation tasks.

#### Probe Diversity

When generating multiple spikes for the same problem:

| Requirement | Rule |
|-------------|------|
| Contradictory | ≥2 probes with opposing approaches |
| Naive | ≥1 probe without prior technical justification |
| Parallel | All run simultaneously |
| Scoped | Minimal — just enough to validate |

Before output, verify: ≥2 opposing probes, ≥1 naive, all independent.

**Example — caching problem, 3 diverse probes:**
```markdown
- [ ] **T1** [SPIKE]: Validate in-memory LRU cache
  - Role: Contradictory-A (in-process)
  - Hypothesis: In-memory LRU reduces DB queries by ≥80%
  - Method: LRU with 1000-item cap, load test
  - Success criteria: DB queries drop ≥80% under 100 concurrent users

- [ ] **T2** [SPIKE]: Validate Redis distributed cache
  - Role: Contradictory-B (external, opposing T1)
  - Hypothesis: Redis scales across multiple instances
  - Method: Redis client, cache top 10 queries, same load test
  - Success criteria: DB queries drop ≥80%, works across 2 instances

- [ ] **T3** [SPIKE]: Validate query optimization without cache
  - Role: Naive (no prior justification — tests if caching is even necessary)
  - Hypothesis: Indexes + query batching alone may suffice
  - Method: Add indexes, batch N+1 queries, same load test — no cache
  - Success criteria: DB queries drop ≥80% with zero cache infrastructure
```

### 7. VALIDATE HYPOTHESES

Unfamiliar APIs or performance-critical → prototype in scratchpad. Fails → write `--failed.md`. Skip for known patterns.

### 8. CLEANUP PLAN.md

Prune stale sections: remove `done-*` sections and orphaned headers. Recalculate Summary table. Empty → recreate fresh.

### 9. OUTPUT & RENAME

Append tasks grouped by `### doing-{spec-name}`. Rename `specs/feature.md` → `specs/doing-feature.md`.

Report: `✓ Plan generated — {n} specs, {n} tasks. Run /df:execute`

## Rules
- **Spike-first** — No `--passed.md` → spike before implementation
- **Block on spike** — Implementation tasks blocked until spike validates
- **Learn from failures** — Extract next hypothesis, never repeat approach
- **Plan only** — Do NOT implement (except quick validation prototypes)
- **One task = one logical unit** — Atomic, committable
- Prefer existing utilities over new code; flag spec gaps

## Agent Scaling

| Agent | Model | Base | Scale |
|-------|-------|------|-------|
| Explore | haiku | 10 | +1 per 20 files |
| Reasoner | opus | 5 | +1 per 2 specs |

Always use `Task` tool with explicit `subagent_type` and `model`.

## Example

```markdown
### doing-upload

- [ ] **T1** [SPIKE]: Validate streaming upload approach
  - Type: spike
  - Hypothesis: Streaming uploads handle >1GB without memory issues
  - Success criteria: Memory <500MB during 2GB upload
  - Files: .deepflow/experiments/upload--streaming--active.md
  - Blocked by: none

- [ ] **T2**: Create upload endpoint
  - Files: src/api/upload.ts
  - Impact:
    - Callers: src/routes/index.ts:5
    - Duplicates: backend/legacy-upload.go [dead — DELETE]
  - Blocked by: T1

- [ ] **T3**: Add S3 service with streaming
  - Files: src/services/storage.ts
  - Blocked by: T1, T2
```
