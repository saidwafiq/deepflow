# Plan

Generated: 2026-03-18
Updated: 2026-03-20

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 2 |
| Tasks created | 10 |
| Tasks completed | 10 |
| Tasks pending | 0 |

### doing-command-cleanup

#### Spec Layer

Spec command-cleanup: L3 (full) — 1 spike, 7 impl tasks

#### Spec Gaps Flagged

1. **GAP-1**: `src/commands/df/execute.md:188` references "schema in auto-cycle.md" — no REQ/AC covers updating this cross-reference. Task T43 covers it.
2. **GAP-2**: AC-18 grep scope omits `hooks/` directory. Low risk since AC-5 covers hook deletion directly.
3. **GAP-3**: No AC verifies `src/commands/df/auto-cycle.md` deletion after refactor to skill. AC-6 only checks new skill exists.

#### REQ Status

| REQ | Status | Notes |
|-----|--------|-------|
| REQ-1 through REQ-5 | READY | Files exist, self-referencing only |
| REQ-6 | READY — spike resolved (FAIL → shim) | `/loop` resolves slash commands; skill loses `df:` namespace. Thin shim command required. |
| REQ-7 | READY | Shim preserves `/df:auto-cycle` invocation; `/loop` unchanged |
| REQ-8, 9, 10 | READY | `bin/install.js` lines 186, 239, 298, 310-315, 578, 607 |
| REQ-11, 12 | READY | `README.md` lines 147-152, 168-169 |
| REQ-13 | DONE | CLAUDE.md has no references — already satisfied |
| REQ-14 | READY | `docs/concepts.md:165` references `/df:note` |
| REQ-15, 16 | CONSTRAINT | Guard only — no action needed |

#### Tasks

- [x] **T37** [SPIKE]: Validate whether `/loop` can invoke a skill directly (auto-cycle refactor) — FAIL → shim approach
  - Type: spike
  - Hypothesis: `/loop 1m /auto-cycle` (skill invocation) works the same as `/loop 1m /df:auto-cycle` (command invocation)
  - Result: FAIL — `/loop` resolves slash commands via unified registry. Skills named `auto-cycle` resolve as `/auto-cycle`, not `/df:auto-cycle`. The `df:` prefix is a namespace from `commands/df/` directory. Thin shim command at `commands/df/auto-cycle.md` must remain to preserve namespace.
  - Files: .deepflow/experiments/command-cleanup--loop-skill-invocation--fail.md
  - Model: sonnet
  - Effort: high
  - Blocked by: none

- [x] **T38**: Delete 4 unused commands + consolidation hook (ff3c789)
  - Files: src/commands/df/report.md (DELETE), src/commands/df/note.md (DELETE), src/commands/df/resume.md (DELETE), src/commands/df/consolidate.md (DELETE), hooks/df-consolidation-check.js (DELETE)
  - Model: haiku
  - Effort: low
  - REQs: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5
  - Changes:
    1. Delete `src/commands/df/report.md`
    2. Delete `src/commands/df/note.md`
    3. Delete `src/commands/df/resume.md`
    4. Delete `src/commands/df/consolidate.md`
    5. Delete `hooks/df-consolidation-check.js`
  - Impact:
    - Callers: none — all self-referencing only, no other src/ files import these
    - Data flow: removes dead code
  - Blocked by: none

- [x] **T39**: Refactor auto-cycle from command to skill (shim approach) (277af1e)
  - Files: src/skills/auto-cycle/SKILL.md (CREATE), src/commands/df/auto-cycle.md (CONVERT to shim)
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-6
  - Changes:
    1. Create `src/skills/auto-cycle/SKILL.md` with skill-format frontmatter (`name: auto-cycle`, no `df:` prefix)
    2. Move all logic from `src/commands/df/auto-cycle.md` into the new skill file
    3. Convert `src/commands/df/auto-cycle.md` to thin shim that delegates to auto-cycle skill via Skill tool (spike T37 confirmed `/loop` can't replicate `df:` namespace)
  - Impact:
    - Callers: `src/commands/df/auto.md` (line 33: `/loop 1m /df:auto-cycle`), `src/commands/df/execute.md` (line 188: reference to auto-cycle.md schema)
    - Data flow: skill logic unchanged, shim preserves invocation path
  - Blocked by: T37

- [x] **T40**: Update auto.md + execute.md for skill invocation (5e2a688)
  - Files: src/commands/df/auto.md, src/commands/df/execute.md
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-7
  - Changes:
    1. `auto.md` line 8: update description to reference auto-cycle as skill (or shim command per spike result)
    2. `auto.md` line 33: update `/loop 1m /df:auto-cycle` if invocation syntax changed
    3. `auto.md` line 45: update table reference
    4. `execute.md` line 188: update "schema in auto-cycle.md" cross-reference to new skill path (GAP-1 fix)
  - Impact:
    - Callers: `/df:auto` is user-invoked; `/df:execute` is invoked by auto-cycle
    - Data flow: no behavioral change, only reference updates
  - Blocked by: T39

- [x] **T41**: Clean up bin/install.js — remove consolidation + update output + add skill (319bead)
  - Files: bin/install.js
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-8, REQ-9, REQ-10
  - Changes:
    1. Line 186: remove report, note, resume, consolidate from command listing; add auto-cycle to skills listing
    2. Line 239: remove `consolidationCheckCmd` variable
    3. Lines 296-298: remove filter for `df-consolidation-check` from SessionStart cleanup
    4. Lines 309-315: remove consolidation-check hook push to SessionStart
    5. Line 578: remove `hooks/df-consolidation-check.js` from uninstall `toRemove` array
    6. Lines 605-607: remove `df-consolidation-check` from SessionStart filter in uninstall settings cleanup
  - Impact:
    - Callers: `npx deepflow` (installer), `npx deepflow --uninstall` (uninstaller)
    - Data flow: installer/uninstaller idempotency preserved
  - Blocked by: T39 (need to know final auto-cycle skill name for output listing)

- [x] **T42**: Update README.md — remove commands + file structure refs (d7a292b)
  - Files: README.md
  - Model: haiku
  - Effort: low
  - REQs: REQ-11, REQ-12
  - Changes:
    1. Lines 147-152: remove rows for `/df:note`, `/df:consolidate`, `/df:resume`, `/df:report` from command table
    2. Update command count in "Minimal Ceremony" section (line 181: "6 commands" needs recount)
    3. Lines 168-169: remove `report.json` and `report.md` from file structure section
  - Impact:
    - Callers: none (documentation)
  - Blocked by: T38 (commands must be deleted first to count accurately)

- [x] **T43**: Update docs/concepts.md — remove /df:note reference + update auto-cycle (06b4b19)
  - Files: docs/concepts.md
  - Model: haiku
  - Effort: low
  - REQs: REQ-14
  - Changes:
    1. Line 165: replace `/df:note` reference with alternative phrasing (decisions are auto-extracted by `/df:verify`)
    2. If auto-cycle is now a skill, update line 155 `/df:auto-cycle` reference accordingly
  - Impact:
    - Callers: none (documentation)
  - Blocked by: T39 (need to know auto-cycle's final form for line 155)

- [x] **T44**: Final verification — grep check + npx deepflow (4922a00)
  - Files: (verification only, no changes)
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-17, REQ-18
  - Changes:
    1. Run: `grep -r "df:report\|df:note\|df:resume\|df:consolidate" src/ docs/ bin/ hooks/ CLAUDE.md README.md` — must return 0 matches
    2. Run: `npx deepflow` — must install without errors
    3. Verify all 18 ACs pass
  - Impact:
    - None (read-only verification)
  - Blocked by: T38, T39, T40, T41, T42, T43

## Dependency Graph (command-cleanup)

```
T37 (spike: /loop + skill) [DONE]
 └→ T39 (refactor auto-cycle)
     ├→ T40 (update auto.md + execute.md)
     ├→ T41 (clean install.js) ← needs skill name for output
     └→ T43 (update concepts.md) ← needs auto-cycle final form

T38 (delete commands + hook)
 └→ T42 (update README)

T44 (verification) ← blocked by T38-T43
```

## Parallelism Opportunities (command-cleanup)

- **Wave 1**: T38 (delete files) + T39 (auto-cycle refactor) — parallel, no shared files (T37 spike done)
- **Wave 2**: T40 (auto.md/execute.md) + T41 (install.js) + T42 (README) + T43 (concepts.md) — T40/T41/T43 blocked by T39, T42 blocked by T38
- **Wave 3**: T44 (verification) — blocked by all

## File Conflict Matrix (command-cleanup)

No file conflicts — each task touches distinct files. `bin/install.js` only modified by T41.

---

### doing-plan-cleanup

#### Spec Layer

Spec plan-cleanup: L3 (full) — 0 spikes, 2 impl tasks

#### REQ Status

| REQ | Status | Notes |
|-----|--------|-------|
| REQ-1 | MISSING | `verify.md` post-verification (lines 159-169) has no PLAN.md cleanup step |
| REQ-2 | MISSING | No summary recalculation or empty-delete logic in verify.md |
| REQ-3 | DONE | `plan.md:200-202` step 8 already prunes stale done-* sections |
| REQ-4 | MISSING | `execute.md:380` still says "Remove spec's ENTIRE section from PLAN.md" |

#### Tasks

- [x] **T49**: Add PLAN.md cleanup step to verify.md post-verification (f2ecfaf)
  - Files: src/commands/df/verify.md
  - Model: haiku
  - Effort: low
  - REQs: REQ-1, REQ-2
  - Changes:
    1. Add step 6 to Post-Verification section (after step 5 "Extract decisions", line 167): "**Clean PLAN.md:** Find the `### {spec-name}` section (match on name stem, strip `doing-`/`done-` prefix). Delete from header through the line before the next `### ` header (or EOF). Recalculate Summary table (recount `### ` headers for spec count, `- [ ]`/`- [x]` for task counts). If no spec sections remain, delete PLAN.md entirely. Skip silently if PLAN.md missing or section already gone."
    2. Update output line 169: add `✓ Cleaned PLAN.md` to success message
  - Impact:
    - Callers: `/df:execute` step 8.2 invokes verify — cleanup now happens inside verify
    - Data flow: verify.md post-verification now removes done spec section from PLAN.md
  - Blocked by: none

- [x] **T50**: Reword execute.md step 8.2 — defer PLAN.md cleanup to verify (cdece5a)
  - Files: src/commands/df/execute.md
  - Model: haiku
  - Effort: low
  - REQs: REQ-4
  - Changes:
    1. Line 380: replace "Remove spec's ENTIRE section from PLAN.md. Recalculate Summary table." with "PLAN.md section cleanup handled by verify (step 6)."
  - Impact:
    - Callers: no behavioral change — verify already runs in step 8.2 line 379
    - Data flow: removes duplicate ownership of PLAN.md cleanup
  - Blocked by: T40 (file conflict: execute.md)

## Dependency Graph (plan-cleanup)

```
T49 (verify.md step 6) ← no blockers
T50 (execute.md reword) ← blocked by T40 (command-cleanup, execute.md conflict)
```

## Parallelism Opportunities (plan-cleanup)

- **Wave 1**: T49 — parallel with T38, T39, T45, T48 (no shared files or different sections)
- **Wave 2**: T50 — blocked by T40 (cross-spec)

## File Conflict Matrix (plan-cleanup)

| File | Tasks | Resolution |
|------|-------|------------|
| verify.md | T49 (plan-cleanup), T45 (auto-verify), T46 (auto-verify) | T49 ∥ T45 (different sections) → T46 |
| execute.md | T50 (plan-cleanup), T40 (command-cleanup), T47 (auto-verify) | T40 → T50 → T47 |

---

## Global Cross-Spec Dependency Summary

```
execute.md chain: T40 (command-cleanup) → T50 (plan-cleanup) → T47 (auto-verify)
verify.md chain:  T45 ∥ T49 (parallel, different sections) → T46 → (T47 needs T46)
```

## Global Wave Plan

- **Wave 1**: T38 + T39 + T45 + T48 + T49 — all parallel (no file conflicts)
- **Wave 2**: T40 + T41 + T42 + T43 + T46 — T40/T41/T43 blocked by T39, T42 by T38, T46 by T45
- **Wave 3**: T44 + T50 — T44 blocked by T38-T43, T50 blocked by T40
- **Wave 4**: T47 — blocked by T46 + T50
