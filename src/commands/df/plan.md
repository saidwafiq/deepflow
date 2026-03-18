---
name: df:plan
description: Compare specs against codebase and past experiments, generate prioritized tasks
---

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

Shell injection (use output directly — no manual file reads needed):
- `` !`ls specs/*.md 2>/dev/null || echo 'NOT_FOUND'` ``
- `` !`cat PLAN.md 2>/dev/null || echo 'NOT_FOUND'` ``

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

**Search for (prefer LSP, fallback to grep):**

1. **Callers:** Use LSP `findReferences` / `incomingCalls` on each exported function/type being changed. Annotate each caller with WHY it's impacted (e.g. "imports validateToken which this task changes"). Fallback: `grep -r "{exported_function}" --include="*.{ext}" -l`
2. **Duplicates:** Files with similar logic (same function name, same transformation). Classify:
   - `[active]` — used in production → must consolidate
   - `[dead]` — bypassed/unreachable → must delete
3. **Data flow:** If file produces/transforms data, use LSP `outgoingCalls` to trace consumers. Fallback: grep across languages

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

### 4.6. CROSS-TASK FILE CONFLICT DETECTION

After all tasks have their `Files:` lists, detect overlaps that require sequential execution.

**Algorithm:**
1. Build a map: `file → [task IDs that list it]`
2. For each file with >1 task: add `Blocked by` edge from later task → earlier task (by task number)
3. If a dependency already exists (direct or transitive), skip (no redundant edges)

**Example:**
```
T1: Files: config.go, feature.go  — Blocked by: none
T3: Files: config.go              — Blocked by: none
T5: Files: config.go              — Blocked by: none
```
After conflict detection:
```
T1: Blocked by: none
T3: Blocked by: T1 (file conflict: config.go)
T5: Blocked by: T3 (file conflict: config.go)
```

**Rules:**
- Only add the minimum edges needed (chain, not full mesh — T5 blocks on T3, not T1+T3)
- Append `(file conflict: {filename})` to the Blocked by reason for traceability
- If a logical dependency already covers the ordering, don't add a redundant conflict edge
- Cross-spec conflicts: tasks from different specs sharing files get the same treatment

### 5. COMPARE & PRIORITIZE

Spawn `Task(subagent_type="reasoner", model="opus")`. Map each requirement to DONE / PARTIAL / MISSING / CONFLICT. Check REQ-AC alignment. Flag spec gaps.

Priority: Dependencies → Impact → Risk

#### Metric AC Detection

While comparing requirements, scan each spec AC for the pattern `{metric} {operator} {number}[unit]`:

- **Pattern examples**: `coverage > 85%`, `latency < 200ms`, `p99_latency <= 150ms`, `bundle_size < 500kb`
- **Operators**: `>`, `<`, `>=`, `<=`, `==`
- **Number**: float or integer, optional unit suffix (%, ms, kb, mb, s, etc.)
- **On match**: flag the AC as a **metric AC** and generate an `Optimize:` task (see section 6.5)
- **Non-match**: treat as standard functional AC → standard implementation task
- **Ambiguous ACs** (qualitative terms like "fast", "small", "improved"): flag as spec gap, request numeric threshold before planning

### 5.5. CLASSIFY MODEL + EFFORT PER TASK

For each task, assign `Model:` and `Effort:` based on the routing matrix:

#### Routing matrix

| Task type | Model | Effort | Rationale |
|-----------|-------|--------|-----------|
| Bootstrap (scaffold, config, rename) | `haiku` | `low` | Mechanical, pattern-following, zero ambiguity |
| browse-fetch (doc retrieval) | `haiku` | `low` | Just fetching and extracting, no reasoning |
| Single-file simple addition | `haiku` | `high` | Small scope but needs to get it right |
| Multi-file with clear specs | `sonnet` | `medium` | Standard work, specs remove need for deep thinking |
| Bug fix (clear repro) | `sonnet` | `medium` | Diagnosis done, just apply fix |
| Bug fix (unclear cause) | `sonnet` | `high` | Needs reasoning to find root cause |
| Spike / validation | `sonnet` | `high` | Scoped but needs reasoning to validate hypothesis |
| Optimize (metric AC) | `opus` | `high` | Multi-cycle, ambiguous — best strategy changes per iteration |
| Feature work (well-specced) | `sonnet` | `medium` | Clear ACs reduce thinking overhead |
| Feature work (ambiguous ACs) | `opus` | `medium` | Needs intelligence but effort can be moderate with good specs |
| Refactor (>5 files, many callers) | `opus` | `medium` | Blast radius needs intelligence, patterns are repetitive |
| Architecture change | `opus` | `high` | High complexity + high ambiguity |
| Unfamiliar API integration | `opus` | `high` | Needs deep reasoning about unknown patterns |
| Retried after revert | _(raise one level)_ | `high` | Prior failure means harder than expected |

#### Decision inputs

1. **File count** — 1 file → haiku/sonnet, 2-5 → sonnet, >5 → sonnet/opus
2. **Impact blast radius** — many callers/duplicates → raise model
3. **Spec clarity** — clear ACs → lower effort, ambiguous → raise effort
4. **Type** — spikes → `sonnet high`, bootstrap → `haiku low`
5. **Has prior failures** — raise model one level AND set effort to `high`
6. **Repetitiveness** — repetitive pattern across files → lower effort even at higher model

#### Effort economics

Effort controls ALL token spend (text, tool calls, thinking). Lower effort = fewer tool calls, less preamble, shorter reasoning.

- `low` → ~60-70% token reduction vs high. Use when task is mechanical.
- `medium` → ~30-40% token reduction. Use when specs are clear.
- `high` → full spend (default). Use when ambiguity or risk is high.

Add `Model: haiku|sonnet|opus` and `Effort: low|medium|high` to each task block. Defaults: `Model: sonnet`, `Effort: medium`.

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

### 6.5. GENERATE OPTIMIZE TASKS (FROM METRIC ACs)

For each metric AC detected in section 5, generate an `Optimize:` task using this format:

**Optimize Task Format:**
```markdown
- [ ] **T{n}** [OPTIMIZE]: Improve {metric_name} to {target}
  - Type: optimize
  - Files: {primary files likely to affect the metric}
  - Optimize:
      metric: "{shell command that outputs a single number}"
      target: {number}
      direction: higher|lower
      max_cycles: {number, default 20}
      secondary_metrics:
        - metric: "{shell command}"
          name: "{label}"
          regression_threshold: 5%
  - Model: opus
  - Effort: high
  - Blocked by: {spike T{n} if applicable, else none}
```

**Field rules:**
- `metric`: a shell command returning a single scalar float/integer (e.g., `npx jest --coverage --json | jq '.coverageMap | .. | .pct? | numbers' | awk '{sum+=$1;n++} END{print sum/n}'`). Must be deterministic and side-effect free.
- `target`: the numeric threshold extracted from the AC (strip unit suffix for the value; note unit in task description)
- `direction`: `higher` if operator is `>` or `>=`; `lower` if `<` or `<=`; `higher` by convention for `==`
- `max_cycles`: from spec if stated; default 20
- `secondary_metrics`: other metrics from the same spec that could regress (e.g., build time, bundle size, test count). Omit if none.

**Model/Effort**: always `opus` / `high` (see routing matrix).

**Blocking**: if a spike exists for the same area, block the optimize task on the spike passing.

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
  - Model: sonnet
  - Impact:
    - Callers: src/routes/index.ts:5
    - Duplicates: backend/legacy-upload.go [dead — DELETE]
  - Blocked by: T1

- [ ] **T3**: Add S3 service with streaming
  - Files: src/services/storage.ts
  - Model: opus
  - Blocked by: T1, T2
```

**Optimize task example** (from spec AC: `coverage > 85%`):

```markdown
### doing-quality

- [ ] **T1** [OPTIMIZE]: Improve test coverage to >85%
  - Type: optimize
  - Files: src/
  - Optimize:
      metric: "npx jest --coverage --json 2>/dev/null | jq '[.. | .pct? | numbers] | add / length'"
      target: 85
      direction: higher
      max_cycles: 20
      secondary_metrics:
        - metric: "npx jest --json 2>/dev/null | jq '.testResults | length'"
          name: test_count
          regression_threshold: 5%
  - Model: opus
  - Effort: high
  - Blocked by: none
```
