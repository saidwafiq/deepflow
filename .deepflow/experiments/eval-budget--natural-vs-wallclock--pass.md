# eval-budget: natural-completion vs fixed wall-clock budget strategies

**hypothesis**: Natural completion produces more stable, comparable metrics than fixed wall-clock for the eval loop
**status**: pass
**date**: 2026-03-25

---

## Empirical Data

Data source: `.deepflow/token-history.jsonl` (88 sessions, 4,734 entries spanning real deepflow agent runs)

### Session Duration Variance

| Metric | Value |
|--------|-------|
| Sessions analyzed (30–250 entries, 500k+ tokens) | 47 |
| Duration mean | 229.8 min |
| Duration stdev | 324.8 min |
| Duration CV (stdev/mean) | **1.41** |
| Duration median | 80.1 min |

Duration histogram:
```
  0– 10 min:  3  sessions  ███
 10– 30 min:  5  sessions  █████
 30– 60 min: 13  sessions  █████████████
 60–120 min:  5  sessions  █████
120–300 min:  9  sessions  █████████
300–600 min:  8  sessions  ████████
600+   min:  4  sessions  ████
```

Wall-clock duration has a **coefficient of variation of 1.41** — an extreme spread with a 3,000x range (0.5 min to 1,537 min) across real sessions. This is driven by API latency (cold starts, queue depth, network) rather than semantic task complexity.

### cache_ratio Stability

| Metric | Value |
|--------|-------|
| cache_ratio mean | 0.920 |
| cache_ratio stdev | 0.065 |
| cache_ratio CV (stdev/mean) | **0.070** |

cache_ratio has a **CV of 0.070** — 20× more stable than wall-clock duration (CV 1.41 vs 0.070).

### Intra-Session cache_ratio Convergence

Within a session (sample: session a5ecc9ba, 146 entries), cache_ratio converges quickly:
- Entry 1: 0.964 (already near final)
- Entry 5: 0.966
- Entry 10: 0.978
- Entry 30: 0.970
- Final (146 entries): 0.978

The ratio stabilizes within the first ~10 tool calls and stays within ±0.01 thereafter. This is because Claude's prompt caching is determined by the static prefix (CLAUDE.md, memory files, system context) — the same bytes hash to the same cache blocks on every turn in the session.

### Why cache_ratio is Structurally Stable

The atomic-commits skill SKILL.md is ~80 lines. When the eval fixture runs it:
1. Static context (CLAUDE.md, system prompt, memory files) is cached on turn 1 and reused every turn thereafter → cache_read dominates
2. The only uncached tokens are the incremental new tool results and the current task state
3. Total session cache_ratio = cache_read / (cache_read + cache_create + input) ≈ constant once context is primed

Across sessions: mean=0.920, stdev=0.065. **Outliers are early-session measurements** where the cache hasn't been primed yet — precisely what natural completion avoids by running to completion.

---

## Strategy Analysis

### (A) Natural Completion

Each eval iteration runs the fixture to completion, collecting total tokens and cache_ratio at end.

**Stability**: cache_ratio CV = 0.070 across 47 real sessions → highly comparable between iterations
**Completeness**: Measures the full semantic cost of a skill variant — how many tokens it takes to finish the job
**Guard integrity**: The ratchet + fixture tests gate on actual outputs, preventing Goodhart's law gaming
**Termination**: Deterministic — session ends when the agent produces a final answer (natural Claude session boundary)
**Duration variance**: High (CV 1.41) but irrelevant — we aren't comparing wall time, we're comparing token metrics

Trade-off: Iterations with stuck or looping agents can take very long. Mitigation: `--loop N` provides a hard iteration cap; each iteration is a separate agent run with a fresh context.

### (B) Fixed Wall-Clock Budget

Each iteration gets X minutes of execution; agent is interrupted at deadline.

**Comparability**: Iterations are time-comparable — but this is a false advantage
**Core problem**: Interrupted sessions produce partial work. If iteration A completes in 4 min and iteration B hits the 5-min wall, their token counts are not comparable — B may have done 2x more work before truncation
**cache_ratio distortion**: An interrupted early-session run has low cache_ratio (cache not yet primed). A completed run has high cache_ratio. Fixed wall-clock conflates "fast because it got cut off" with "fast because the skill is efficient"
**API latency confound**: The 1.41 CV on real duration data shows API latency dwarfs actual execution time differences. A 2-minute API queue adds noise that swamps a real 20% token reduction signal
**Partial results**: Guard checks on truncated outputs may produce false positives or false negatives, corrupting the `guard_fail` signal

The fundamental problem: **fixed wall-clock measures API latency + execution, not execution alone**. There is no way to separate these without benchmarking infrastructure deepflow deliberately avoids.

---

## Recommendation

**Use natural completion (Strategy A).**

Rationale:
1. **cache_ratio is 20× more stable than wall-clock** (CV 0.070 vs 1.41). The metric we care about varies minimally across real sessions; wall time varies wildly.
2. **Partial completions are incomparable**. A fixed budget that truncates iteration B halfway through its work cannot be compared to iteration A that completed. Natural completion ensures both iterations produced complete outputs.
3. **The guard already prevents gaming**. The ratchet + fixture tests make it impossible for a skill mutation to game cache_ratio by, e.g., writing fewer tool calls but breaking behavior. Token efficiency gains must come with correct outputs.
4. **API latency is not a token metric**. Fixed wall-clock conflates API queue depth (infrastructure noise) with actual token efficiency (the signal). Natural completion eliminates this confound entirely.
5. **Karpathy's wall-clock intuition applies to GPU training, not LLM agents**. In GPU training, wall time ≈ compute cost (FLOPs). In LLM agents, wall time ≈ compute + latency + queue depth. The analogy breaks.

**Implementation note**: Natural completion is the default behavior of the eval loop as specified (REQ-3). No special budget mechanism is needed. The `--loop N` flag provides iteration-count control, which is the correct knob for managing eval duration.

**Secondary finding**: cache_ratio as a metric has a structural floor ~0.70 and ceiling ~0.98 in practice. A skill mutation that changes the static prefix size (e.g., adds examples to SKILL.md) will shift cache_ratio by changing cache block boundaries. This is intentional — it measures real caching behavior of the modified skill.
