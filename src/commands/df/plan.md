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

### 4.7. FAN-OUT ORCHESTRATION (MULTI-SPEC)

**When:** >1 plannable spec found in §1.

**Skip condition:** If exactly 1 plannable spec → skip this section entirely, continue to §5 monolithic path with zero overhead. No fan-out code runs.

#### 4.7.1. Count & Cap

Count plannable specs (no `doing-`/`done-` prefix, passed `validateSpec`).

- **1 spec** → skip to §5 (monolithic path)
- **2–5 specs** → fan-out all
- **>5 specs** → select first 5 by filesystem `ls` order. Report to user:
  ```
  ⚠ {total} specs found. Planning first 5 now. Queued for next run:
    - {spec6.md}
    - {spec7.md}
    ...
  Re-run /df:plan to process remaining specs.
  ```

#### 4.7.2. Spawn Sub-Agents (Thin Dispatcher)

For each plannable spec (up to 5), spawn a **parallel non-background** `Task(subagent_type="default", model="sonnet")` call. All calls are independent — spawn them simultaneously.

**The master orchestrator is a thin dispatcher.** Each sub-agent receives ONLY the spec file path — no pre-computed context, no spec content, no impact analysis, no experiment results.

Each sub-agent prompt:

```
You are a spec planner. Your job is to independently analyze a spec and produce a mini-plan.

## Spec file
{spec_file_path}

## Instructions

1. **Read the spec** — use Read tool on the spec file path above
2. **Compute spec layer** — determine L0–L3 based on sections present (see layer rules below)
3. **Check experiments** — glob `.deepflow/experiments/{topic}--*` for past spikes
4. **Explore the codebase** — detect code style, patterns, integration points relevant to this spec
5. **Impact analysis** (L3 only) — LSP-first blast radius for files in scope
6. **Targeted exploration** — follow `templates/explore-agent.md` spawn rules for post-LSP gaps
7. **Generate tasks** — produce a mini-plan following the output format below

## Layer-gating rules
| Layer | Sections present | Allowed task types |
|-------|------------------|--------------------|
| L0 | Objective | Spikes only |
| L1 | + Requirements | Spikes only (better targeted) |
| L2 | + Acceptance Criteria | Spikes + Implementation |
| L3 | + Constraints, Out of Scope, Technical Notes | Spikes + Implementation + Impact analysis + Optimize |

## OUTPUT FORMAT — MANDATORY (no deviations)
Return ONLY a markdown task list. Use local T-numbering starting at T1.
Each task MUST follow this exact format:

### {spec-name}

- [ ] **T{N}**: {Task description}
  - Files: {comma-separated file paths}
  - Blocked by: none | T{N}[, T{M}...]

Optional fields (add when applicable):
  - Model: haiku | sonnet | opus
  - Effort: low | medium | high
  - Impact: {blast radius details, L3 only}
  - Optimize: {metric block, for metric ACs only}

Rules:
- "Blocked by: none" is required (not "N/A", not empty)
- T-numbers are local to this spec (T1, T2, T3...)
- One task = one atomic commit
- Spike tasks use: **T{N}** [SPIKE]: {description}
- L0-L1 specs: ONLY spike tasks allowed
- L2+ specs: spikes + implementation tasks allowed
- L3 specs: include Impact: blocks from impact analysis
```

#### 4.7.3. Collect & Persist Mini-Plans

Each sub-agent returns a mini-plan string (markdown). Collect all return values.

**Graceful degradation (AC-10):** For each sub-agent result, check for failure conditions:
- Sub-agent threw an error or returned a non-string value → log warning, skip spec
- Output is empty (whitespace only) → log warning, skip spec
- Output contains no task items (no `- [ ] **T` pattern) → log warning (unparseable), skip spec

Warning format:
```
⚠ Warning: sub-agent for {specName} failed — {reason}. Continuing with remaining specs.
```

Continue processing remaining specs regardless of individual failures. Only successfully parsed mini-plans are stored.

**Persist to disk (REQ-3):** For each successful mini-plan, write to `.deepflow/plans/doing-{specName}.md`. Create `.deepflow/plans/` directory if it doesn't exist.

- If ALL sub-agents fail: report error, abort plan generation.
- If at least 1 succeeds: continue to §5 with successful mini-plans on disk.

**Flow after fan-out:** The consolidator (§5B) reads mini-plans from `.deepflow/plans/` for consolidation (global renumbering, cross-spec conflict detection, prioritization). §5 handles both the single-spec monolithic path and the multi-spec consolidation path.

### 5. COMPARE & PRIORITIZE

**Two paths** — determined by spec count from §1/§4.7:

#### 5A. SINGLE-SPEC (MONOLITHIC PATH)

**When:** Exactly 1 plannable spec (§4.7 was skipped).

Spawn `Task(subagent_type="reasoner", model="opus")`. Map each requirement to DONE/PARTIAL/MISSING/CONFLICT. Check REQ-AC alignment. Flag spec gaps.

Priority: Dependencies → Impact → Risk

##### Metric AC Detection

Scan ACs for pattern `{metric} {operator} {number}[unit]` (e.g., `coverage > 85%`, `latency < 200ms`). Operators: `>`, `<`, `>=`, `<=`, `==`.

- **Match:** flag as metric AC → generate `Optimize:` task (§6.5)
- **Non-match:** standard implementation task
- **Ambiguous** ("fast", "small"): flag as spec gap, request numeric threshold

Then apply §5.5 routing matrix. Continue to §6.

#### 5B. MULTI-SPEC CONSOLIDATOR (FAN-OUT PATH)

**When:** >1 plannable spec (§4.7 produced mini-plans in `.deepflow/plans/`).

**This is the ONLY Opus invocation in the fan-out path** (REQ-12). Sub-agents in §4.7 use Sonnet.

**Input:** Mini-plan files in `.deepflow/plans/doing-*.md`. The consolidator must NOT modify these files (REQ-5).

**Architecture:** Mechanical work (T-id renumbering, file-conflict detection) is delegated to `bin/plan-consolidator.js`. Opus handles ONLY cross-spec prioritization and summary narrative.

##### Step 1: Run plan-consolidator (mechanical — no LLM)

Shell-inject the consolidator output:

`` !`node bin/plan-consolidator.js --plans-dir .deepflow/plans/ 2>/dev/null || true` ``

This produces the `## Tasks` section with:
- Globally sequential T-ids (no gaps, no duplicates) — AC-4
- Remapped `Blocked by` references (local → global)
- `[file-conflict: {filename}]` annotations on cross-spec file overlaps
- Mini-plan files left byte-identical (read-only) — AC-5

If the consolidator output is empty or contains `(no mini-plan files found` → abort, report error.

##### Step 2: Opus prioritization & summary (single invocation)

Spawn a single `Task(subagent_type="reasoner", model="opus")` with the consolidated tasks from Step 1:

```
You are the plan prioritizer. The mechanical consolidation (global T-numbering, file-conflict detection) is already done. Do NOT renumber tasks or modify T-ids.

## Consolidated tasks (from plan-consolidator)

{paste consolidator stdout here}

## Spec files

{for each plannable spec: spec filename and its Requirements + Acceptance Criteria sections}

## Your job — THREE things only

### 1. Cross-Spec Prioritization
Review the task ordering across specs. If a different spec ordering would reduce blocked tasks or improve parallelism, suggest reordering. Otherwise confirm the current ordering is optimal.

If reordering is needed, output the recommended spec order. The orchestrator will reorder the mini-plan files in `.deepflow/plans/` (alphabetical prefix rename) and re-run the consolidator.

### 2. Requirement Mapping & Spec Gaps
For each spec, map requirements to DONE/PARTIAL/MISSING/CONFLICT. Flag spec gaps.
Scan ACs for metric patterns `{metric} {operator} {number}[unit]` — flag matches for §6.5 Optimize tasks, flag ambiguous thresholds ("fast", "small") as spec gaps.

### 3. Model + Effort Classification
Apply routing matrix to each task:

| Task type | Model | Effort |
|-----------|-------|--------|
| Bootstrap (scaffold, config, rename) | haiku | low |
| browse-fetch (doc retrieval) | haiku | low |
| Single-file simple addition | haiku | high |
| Multi-file with clear specs | sonnet | medium |
| Bug fix (clear repro) | sonnet | medium |
| Bug fix (unclear cause) | sonnet | high |
| Spike / validation | sonnet | high |
| Optimize (metric AC) | opus | high |
| Feature work (well-specced) | sonnet | medium |
| Feature work (ambiguous ACs) | opus | medium |
| Refactor (>5 files, many callers) | opus | medium |
| Architecture change | opus | high |
| Unfamiliar API integration | opus | high |
| Retried after revert | (raise one level) | high |

Defaults: sonnet / medium.

## OUTPUT FORMAT — MANDATORY

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | {N} |
| Tasks created | {N} |
| Ready (no blockers) | {N} |
| Blocked | {N} |

## Spec Gaps

- [ ] `specs/{name}.md`: {gap description}

## Tasks

{Insert the consolidated tasks from plan-consolidator verbatim, adding ONLY `Model:` and `Effort:` lines to each task. Do NOT alter T-ids, descriptions, Files, Blocked by, or conflict annotations.}

Rules:
- Do NOT renumber T-ids — they are already globally sequential from plan-consolidator
- Do NOT modify Blocked by lines or conflict annotations — they are mechanical outputs
- ONLY add Model: and Effort: lines per the routing matrix
- Preserve all existing fields (Impact:, Optimize:, tags, etc.)
- Spike tasks keep their [SPIKE] or [OPTIMIZE] markers
```

**Post-consolidation:**
- The orchestrator receives the Opus output as structured PLAN.md content
- Mini-plans persist in `.deepflow/plans/doing-{name}.md` for reuse by `/df:execute` (REQ-3, REQ-7)
- §8 cleanup and §9 output/rename run after this step in the orchestrator

### 5.5. CLASSIFY MODEL + EFFORT PER TASK

**Note:** In the fan-out path (§5B), model/effort classification is performed inside the consolidator prompt. This section applies only to the monolithic path (§5A).

#### Routing matrix

| Task type | Model | Effort |
|-----------|-------|--------|
| Bootstrap (scaffold, config, rename) | `sonnet` | `low` |
| browse-fetch (doc retrieval) | `haiku` | `low` |
| Single-file simple addition | `sonnet` | `medium` |
| Multi-file with clear specs | `sonnet` | `medium` |
| Bug fix (clear repro) | `opus` | `medium` |
| Bug fix (unclear cause) | `opus` | `high` |
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

**Fan-out path:** Run ONLY after §5B consolidation is complete. Operate on the consolidated output only — do NOT run inside sub-agents or during mini-plan collection.

Prune stale `done-*` sections and orphaned headers. Recalculate Summary. Empty → recreate fresh.

### 9. OUTPUT & RENAME

**Fan-out path:** Run ONLY after §5B consolidation is complete (AC-13). Operate on successfully planned specs only — specs whose sub-agents failed (§4.7.3) are NOT renamed and NOT appended to PLAN.md.

Append tasks grouped by `### doing-{spec-name}`. Rename `specs/feature.md` → `specs/doing-feature.md` for each successfully planned spec only.

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
