---
name: df:plan
description: Compare specs against codebase and past experiments, generate prioritized tasks
---

# /df:plan — Generate Task Plan from Specs

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

Shell injection:
- `` !`ls specs/*.md 2>/dev/null || echo 'NOT_FOUND'` ``
- `` !`cat PLAN.md 2>/dev/null || echo 'NOT_FOUND'` ``

Run `validateSpec` on each spec. Hard failures → skip + error. Advisory → include.
Record each spec's computed layer (gates task generation per §1.5).
No new specs → report counts, suggest `/df:execute`.

### 1.5. LAYER-GATED TASK GENERATION

| Layer | Sections present | Allowed task types |
|-------|------------------|--------------------|
| L0 | Objective | Spikes only |
| L1 | + Requirements | Spikes only (better targeted) |
| L2 | + Acceptance Criteria | Spikes + Implementation |
| L3 | + Constraints, Out of Scope, Technical Notes | Spikes + Implementation + Impact analysis + Optimize |

**Rules:**
- L0–L1: ONLY spike tasks. Implementation blocked until spec deepens to L2+.
- L2: spikes + implementation, skip impact analysis.
- L3: full planning — spikes, implementation, impact analysis, optimize.
- Spike results deepen specs: findings incorporated back via user or `/df:spec`, raising layer.
- Report layer: `"Spec {name}: L{N} ({label}) — {task_types_generated}"`

### 2. CHECK PAST EXPERIMENTS (SPIKE-FIRST)

**CRITICAL**: Check experiments BEFORE generating tasks.

Glob `.deepflow/experiments/{topic}--*`. File naming: `{topic}--{hypothesis}--{status}.md`

| Result | Action |
|--------|--------|
| `--failed.md` | Extract "next hypothesis" from Conclusion, generate spike |
| `--passed.md` | Proceed to full implementation |
| `--active.md` | Wait for completion |
| No matches | New topic, generate initial spike |

Implementation tasks BLOCKED until spike validates.

### 3. DETECT PROJECT CONTEXT

Identify code style, patterns (error handling, API structure), integration points. Include in task descriptions.

### 4. IMPACT ANALYSIS (L3 specs only)

Skip for L0–L2 specs. For each file in a task's `Files:` list, find blast radius.

**Search (prefer LSP, fallback grep):**
1. **Callers:** LSP `findReferences`/`incomingCalls` on exports being changed. Annotate WHY impacted. Fallback: grep.
2. **Duplicates:** Similar logic files. Classify: `[active]` → consolidate, `[dead]` → DELETE.
3. **Data flow:** LSP `outgoingCalls` to trace consumers.

Embed as `Impact:` block in each task. Files outside original `Files:` → add with `(impact — verify/update)`. Skip for spikes.

### 4.5. TARGETED EXPLORATION

Follow `templates/explore-agent.md` for spawn rules. 3-5 agents cover post-LSP gaps: conventions, dead code, implicit patterns.

Use `code-completeness` skill: implementations matching spec, TODOs/FIXMEs/HACKs, stubs, skipped tests.

### 4.6. CROSS-TASK FILE CONFLICT DETECTION

After all tasks have `Files:` lists, detect overlaps requiring sequential execution.

1. Build map: `file → [task IDs]`
2. For files with >1 task: add `Blocked by` from later → earlier task
3. Skip if dependency already exists (direct or transitive)

**Rules:** Chain only (T5→T3, not T5→T1+T3). Append `(file conflict: {filename})`. Logical deps override conflict edges. Cross-spec conflicts get same treatment.

### 5. COMPARE & PRIORITIZE

Spawn `Task(subagent_type="reasoner", model="opus")`. Map each requirement to DONE/PARTIAL/MISSING/CONFLICT. Check REQ-AC alignment. Flag spec gaps.

Priority: Dependencies → Impact → Risk

#### Metric AC Detection

Scan ACs for pattern `{metric} {operator} {number}[unit]` (e.g., `coverage > 85%`, `latency < 200ms`). Operators: `>`, `<`, `>=`, `<=`, `==`.

- **Match:** flag as metric AC → generate `Optimize:` task (§6.5)
- **Non-match:** standard implementation task
- **Ambiguous** ("fast", "small"): flag as spec gap, request numeric threshold

### 5.5. CLASSIFY MODEL + EFFORT PER TASK

#### Routing matrix

| Task type | Model | Effort |
|-----------|-------|--------|
| Bootstrap (scaffold, config, rename) | `haiku` | `low` |
| browse-fetch (doc retrieval) | `haiku` | `low` |
| Single-file simple addition | `haiku` | `high` |
| Multi-file with clear specs | `sonnet` | `medium` |
| Bug fix (clear repro) | `sonnet` | `medium` |
| Bug fix (unclear cause) | `sonnet` | `high` |
| Spike / validation | `sonnet` | `high` |
| Optimize (metric AC) | `opus` | `high` |
| Feature work (well-specced) | `sonnet` | `medium` |
| Feature work (ambiguous ACs) | `opus` | `medium` |
| Refactor (>5 files, many callers) | `opus` | `medium` |
| Architecture change | `opus` | `high` |
| Unfamiliar API integration | `opus` | `high` |
| Retried after revert | _(raise one level)_ | `high` |

Add `Model:` and `Effort:` to each task. Defaults: `sonnet` / `medium`.

### 6. GENERATE SPIKE TASKS (IF NEEDED)

**Format:**
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

All implementation tasks MUST `Blocked by: T{spike}`. Spike fails → `--failed.md`, no implementation.

#### Probe Diversity

| Requirement | Rule |
|-------------|------|
| Contradictory | ≥2 probes with opposing approaches |
| Naive | ≥1 probe without prior technical justification |
| Parallel | All run simultaneously |
| Scoped | Minimal — just enough to validate |

Before output, verify: ≥2 opposing probes, ≥1 naive, all independent.

### 6.5. GENERATE OPTIMIZE TASKS (FROM METRIC ACs)

**Format:**
```markdown
- [ ] **T{n}** [OPTIMIZE]: Improve {metric_name} to {target}
  - Type: optimize
  - Files: {primary files affecting metric}
  - Optimize:
      metric: "{shell command outputting single number}"
      target: {number}
      direction: higher|lower
      max_cycles: {number, default 20}
      secondary_metrics:
        - metric: "{shell command}"
          name: "{label}"
          regression_threshold: 5%
  - Model: opus
  - Effort: high
  - Blocked by: {spike if applicable, else none}
```

**Field rules:** `metric` must be deterministic, side-effect free, return single scalar. `direction`: higher for `>`/`>=`, lower for `<`/`<=`, higher for `==`. `max_cycles`: from spec or default 20. Always `opus`/`high`. Block on spike if one exists.

### 7. VALIDATE HYPOTHESES

Unfamiliar APIs or performance-critical → prototype in scratchpad. Fails → `--failed.md`. Skip for known patterns.

### 8. CLEANUP PLAN.md

Prune stale `done-*` sections and orphaned headers. Recalculate Summary. Empty → recreate fresh.

### 9. OUTPUT & RENAME

Append tasks grouped by `### doing-{spec-name}`. Rename `specs/feature.md` → `specs/doing-feature.md`.

Report:
```
✓ Plan generated — {n} specs, {n} tasks. Run /df:execute

Spec layers:
  {name}: L{N} ({label}) — {n} spikes{, {n} impl tasks if L2+}
```

If any L0–L1 spec: `ℹ L0–L1 specs generate spikes only. Deepen with /df:spec {name} to unlock implementation.`

## Rules
- **Layer-gated** — L0–L1 → spikes only; L2+ → implementation; L3 → full planning
- **Spike-first** — No `--passed.md` → spike before implementation
- **Block on spike** — Implementation blocked until spike validates
- **Learn from failures** — Extract next hypothesis, never repeat approach
- **Plan only** — Do NOT implement (except quick validation prototypes)
- **One task = one logical unit** — Atomic, committable
- Prefer existing utilities over new code; flag spec gaps
- Always use `Task` tool with explicit `subagent_type` and `model`
