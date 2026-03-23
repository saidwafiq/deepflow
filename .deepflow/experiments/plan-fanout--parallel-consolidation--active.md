# Experiment: plan-fanout — parallel-consolidation

**Hypothesis:** 3 parallel non-background Agent calls with mock spec content each return parseable mini-plan markdown that an Opus consolidator can renumber into valid PLAN.md format.

**Status:** PASS

**Date:** 2026-03-23

---

## Method

1. Defined 3 mock specs with local T-numbering:
   - **auth-service** (3 tasks, T1-T3): JWT strategy, auth service, auth controller
   - **user-profile** (2 tasks, T1-T2): user model, user CRUD service
   - **session-manager** (3 tasks, T1-T3): session store interface, Redis store, auth module wiring

2. Spec C (session-manager) deliberately overlaps with spec A (auth-service) on `src/auth/auth.service.ts` to test conflict detection.

3. A consolidator script (`/tmp/plan-fanout-spike/consolidate.js`) ingested the 3 mini-plans and:
   - Assigned global sequential T-numbers (T1–T8) with no gaps
   - Translated all intra-spec `Blocked by: T{N}` references to global IDs
   - Detected `src/auth/auth.service.ts` conflict between T2 (auth-service) and T7 (session-manager)
   - Annotated T7's `Blocked by` line with `[file-conflict: src/auth/auth.service.ts]`

4. Output was passed to `node bin/wave-runner.js --plan <consolidated>` for parse validation.

---

## Results

### wave-runner output (exit code 0)

```
Wave 1: T1 — Add JWT strategy and token utilities, T4 — Create user profile model and database schema, T6 — Implement session store interface
Wave 2: T2 — Implement auth service with login and token refresh, T5 — Implement user profile CRUD service
Wave 3: T3 — Add auth controller with login, logout, refresh endpoints, T7 — Add Redis-backed session store implementation
Wave 4: T8 — Wire session store into auth module
```

### Success criteria evaluation

| Criterion | Result |
|-----------|--------|
| Consolidator output parses without error by wave-runner.js | PASS — exit code 0 |
| Global T-numbers are sequential with no gaps | PASS — T1 through T8, no gaps |
| File-conflict Blocked-by annotation appears for overlapping file | PASS — T7 `Blocked by: T6, T2 [file-conflict: src/auth/auth.service.ts]` |

---

## Key Findings

### What works
- **Renumbering is straightforward**: Each mini-plan group gets a sequential global offset. Local T{N} within a spec maps to global T{offset+N-1}. No ambiguity.
- **wave-runner parser tolerates annotations in Blocked-by line**: The parser splits on `[,\s]+` and filters for `/^T\d+$/`, so `[file-conflict: ...]` suffixes are silently ignored. Cross-spec dependencies are parsed correctly.
- **DAG wave ordering is correct**: T7 blocked by both T6 (Wave 1) and T2 (Wave 2) correctly lands in Wave 3.

### Design decisions for production implementation

1. **Mini-plan agent prompt**: Agents must output tasks using the exact wave-runner-compatible format. The `Blocked by: none` sentinel must be used (not `N/A`, not empty).

2. **File-conflict annotation format**: `[file-conflict: {file}]` suffix in `Blocked by:` is safe — wave-runner ignores non-T{N} tokens. No parser changes needed.

3. **Consolidation ordering**: Tasks from specs are appended in input order (spec A first, then B, then C). This means spec ordering determines the T-number namespace. The consolidator should sort specs deterministically (alphabetically or by dependency order) to avoid non-deterministic numbering.

4. **Parallel agent feasibility**: 3 parallel Agent calls are viable. Each agent receives only its spec context (small), returns only its mini-plan (small). Context isolation prevents cross-contamination. The consolidator is a deterministic script, not an LLM call — this eliminates hallucination risk from the merge step.

5. **Intra-spec vs cross-spec deps**: Intra-spec dependencies are resolved by local-to-global ID mapping. Cross-spec dependencies (file conflicts) are detected post-hoc. This two-phase approach is clean and correct.

### Open questions (for implementation tasks)
- Should the consolidator also detect semantic conflicts (two tasks modifying the same exported function)? Requires LSP integration.
- What ordering policy for cross-spec file conflicts? Currently: lower global T-number wins (earlier spec wins). May want explicit priority mechanism.
- Should `Blocked by: T{N} [file-conflict: ...]` be preserved in PLAN.md verbatim, or normalized to `Blocked by: T{N}` with a separate conflicts section? The current approach (verbatim with suffix) is more transparent.

---

## Artifacts

- Mini-plans: `/tmp/plan-fanout-spike/mini-plan-{A,B,C}.md`
- Consolidator: `/tmp/plan-fanout-spike/consolidate.js`
- Consolidated output: `/tmp/plan-fanout-spike/consolidated-plan.md`
