# Plan

Generated: 2026-03-18
Updated: 2026-03-20

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 2 |
| Tasks created | 15 |
| Tasks completed | 15 |
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

### ratchet-hardening

#### Spec Layer

Spec ratchet-hardening: L3 (full) — 1 spike, 6 impl tasks

#### Spec Gaps Flagged

1. **GAP-1**: AC-1 specifies JSON output but does not mention exit code convention (0/1/2) from Technical Notes. Both are needed by the orchestrator.
2. **GAP-2**: AC-3 covers the snapshot guard hook behavior but not its registration in `bin/install.js`. Constraints mention registration but no AC verifies it. Task T47 covers registration.
3. **GAP-3**: AC-2 says "using xargs from auto-snapshot.txt" but doesn't specify that the correct test runner must be auto-detected per project type indicator files. Covered by spike T45.

#### REQ Status

| REQ | Status | Notes |
|-----|--------|-------|
| REQ-1 | MISSING | `bin/ratchet.js` does not exist |
| REQ-2 | MISSING | No xargs-based test invocation exists |
| REQ-3 | MISSING | No snapshot guard hook exists in `hooks/` |
| REQ-4 | MISSING | `execute.md` §5.5 still has inline health-check logic |
| REQ-5 | MISSING | Wave test prompt has no dedup context |
| REQ-6 | PARTIAL | Revert policy exists at execute.md:136 but separate-task requirement for snapshot test updates is not stated |

#### Tasks

- [x] **T45** [SPIKE]: Validate xargs-based test invocation across project types + worktree snapshot path resolution (9904ab9)
  - Type: spike
  - Hypothesis: `xargs {test_runner} < .deepflow/auto-snapshot.txt` works for Node (npm test), Python (pytest), Go (go test), Rust (cargo test) with file paths from `git ls-files`
  - Method:
    1. Create minimal test projects (Node + Python) with 2 test files each
    2. Generate `auto-snapshot.txt` via `git ls-files | grep` pattern
    3. Run `xargs {runner} < auto-snapshot.txt` and verify only listed tests execute
    4. Test from within a git worktree to verify `.deepflow/` path resolution (relative vs absolute)
  - Success criteria: At least Node and Python runners accept file lists via xargs; worktree path is unambiguous
  - Time-box: 30 min
  - Files: .deepflow/experiments/ratchet-hardening--xargs-test-runner--{status}.md
  - Model: sonnet
  - Effort: high
  - Blocked by: none

- [x] **T46**: Create `bin/ratchet.js` — mechanical ratchet script with JSON output + auto-revert (a3278aa)
  - Files: bin/ratchet.js (CREATE)
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-1, REQ-2
  - Changes:
    1. Pure Node.js script (no dependencies), consistent with `bin/install.js`
    2. Detect project type from indicator files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) with `.deepflow/config.yaml` overrides
    3. Run health checks in order: build → test → typecheck → lint (stop on first failure)
    4. Test command constructed via xargs from `.deepflow/auto-snapshot.txt` — no test discovery, no globs (adapted per spike T45 results)
    5. Output exactly one JSON line: `{"result":"PASS"}`, `{"result":"FAIL","stage":"test"}`, or `{"result":"SALVAGEABLE","stage":"lint","log":"..."}`
    6. Exit codes: 0=PASS, 1=FAIL, 2=SALVAGEABLE
    7. On FAIL: execute `git revert HEAD --no-edit` before returning
    8. Must work from within worktrees (paths relative to cwd)
  - Impact:
    - Callers: `src/commands/df/execute.md` §5.5 (will call `node bin/ratchet.js`)
    - Data flow: replaces inline health-check logic; orchestrator receives only structured JSON
  - Blocked by: T45

- [x] **T47**: Create `hooks/df-snapshot-guard.js` + register in `bin/install.js` (bdd3356)
  - Files: hooks/df-snapshot-guard.js (CREATE), bin/install.js
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-3
  - Changes:
    1. PostToolUse hook following `df-worktree-guard.js` stdin JSON contract (`{tool_name, tool_input, cwd}`)
    2. Block `Write` and `Edit` calls targeting any file listed in `.deepflow/auto-snapshot.txt`
    3. Read `auto-snapshot.txt` on each invocation, match `tool_input.file_path` against listed files
    4. Exit 1 with explanatory message on violation; exit 0 on parse error or non-match
    5. In `bin/install.js`: add `df-snapshot-guard` to hook variable declarations (~line 244), PostToolUse filter (~line 350), PostToolUse push (~line 386), uninstall toRemove array, and uninstall settings cleanup
  - Impact:
    - Callers: Claude Code PostToolUse hook system (automatic on every Write/Edit)
    - Data flow: physical barrier independent of prompt instructions; prevents agents from modifying pre-existing test files
  - Blocked by: none

- [x] **T48**: Harden `execute.md` §5.5 — replace inline ratchet with `node bin/ratchet.js` call (aa688f6)
  - Files: src/commands/df/execute.md
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-4, REQ-6
  - Changes:
    1. Replace §5.5 (lines 102-137) inline health-check steps with single `node bin/ratchet.js` call
    2. Remove all raw test/build output from orchestrator context — orchestrator sees only JSON result
    3. Add explicit prohibitions: "You MUST NOT inspect, classify, or reinterpret test failures. FAIL means revert. No exceptions."
    4. Prohibit `git stash`, `git checkout` for investigation purposes during ratchet
    5. Prohibit inline edits to pre-existing test files
    6. Add policy: "Updating pre-existing tests requires a separate dedicated task in PLAN.md with explicit justification — never inline during execution"
    7. Preserve metric gate logic for [OPTIMIZE] tasks (runs separately from ratchet script)
    8. Preserve edit scope validation and impact completeness checks
    9. Preserve token tracking result block
    10. Preserve salvage logic: SALVAGEABLE → spawn haiku fix agent; FAIL → already reverted by script
  - Impact:
    - Callers: auto-cycle skill (delegates to `/df:execute`), user direct invocation
    - Data flow: orchestrator loses access to raw test output; gains structured PASS/FAIL/SALVAGEABLE signal
  - Blocked by: T46

- [x] **T49**: Add dedup context to wave test agent prompt in `execute.md` §5.6/§6 (f345e22)
  - Files: src/commands/df/execute.md
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-5
  - Changes:
    1. In §5.6 wave test flow (lines 138-177), pass full `auto-snapshot.txt` file list to test agent prompt
    2. Extract existing test function names from snapshot files (grep for `describe|it|test|def test_|func Test`) and include in prompt
    3. Add instruction: "Do not duplicate tests for functionality already covered by these existing tests"
    4. Include file list and function names as context block in §6 Wave Test prompt template
  - Impact:
    - Callers: wave test agent spawned by execute orchestrator after ratchet pass
    - Data flow: test agent receives awareness of existing coverage, reducing test inflation
  - Blocked by: T48 (file conflict: execute.md)

- [x] **T50**: Update `templates/config-template.yaml` with ratchet config section (f957542)
  - Files: templates/config-template.yaml
  - Model: haiku
  - Effort: low
  - REQs: (supports REQ-1 config override mechanism)
  - Changes:
    1. Add `ratchet:` section after quality section (~line 97) with override fields for build/test/typecheck/lint commands
    2. Document that `.deepflow/config.yaml` overrides take precedence over indicator-file detection in `bin/ratchet.js`
  - Impact:
    - Callers: `bin/ratchet.js` reads config; `npx deepflow` scaffolds from template
    - Data flow: config template → `.deepflow/config.yaml` → `bin/ratchet.js`
  - Blocked by: none

- [x] **T51**: Final verification — ratchet script test + hook test + execute.md grep (0abbc78)
  - Files: (verification only, no changes)
  - Model: sonnet
  - Effort: medium
  - REQs: AC-1 through AC-6
  - Changes:
    1. Run `node bin/ratchet.js` in a test project — verify JSON output and exit codes
    2. Verify snapshot guard hook blocks Write to a snapshot-listed file (manual stdin pipe test)
    3. Grep `execute.md` for raw test output parsing — must return 0 matches
    4. Grep `execute.md` for `node bin/ratchet.js` — must return match
    5. Grep `execute.md` for prohibition text (reinterpret, git stash, inline test edits)
    6. Verify `bin/install.js` registers `df-snapshot-guard` in PostToolUse
    7. Verify wave test prompt includes dedup instruction
  - Impact:
    - None (read-only verification)
  - Blocked by: T46, T47, T48, T49, T50

## Dependency Graph (ratchet-hardening)

```
T45 (spike: xargs + worktree paths)
 └→ T46 (bin/ratchet.js)
     └→ T48 (harden execute.md §5.5)
         └→ T49 (wave test dedup) ← file conflict: execute.md

T47 (snapshot guard hook + install.js) ← independent

T50 (config template) ← independent

T51 (verification) ← blocked by T46-T50
```

## Parallelism Opportunities (ratchet-hardening)

- **Wave 1**: T45 (spike) + T47 (snapshot guard hook) + T50 (config template) — all independent
- **Wave 2**: T46 (ratchet script) — blocked by T45
- **Wave 3**: T48 (execute.md hardening) — blocked by T46
- **Wave 4**: T49 (wave test dedup) — blocked by T48 (file conflict)
- **Wave 5**: T51 (verification) — blocked by all

## File Conflict Matrix (ratchet-hardening)

| File | Tasks |
|------|-------|
| `src/commands/df/execute.md` | T48, T49 → T49 blocked by T48 (file conflict) |
| `bin/install.js` | T47 only |

No cross-spec file conflicts with done-command-cleanup (all tasks completed).
