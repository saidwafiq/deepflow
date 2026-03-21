# Plan

Generated: 2026-03-18
Updated: 2026-03-21

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 4 |
| Tasks created | 59 |
| Tasks completed | 51 |
| Tasks pending | 8 |

### doing-orchestrator-v2

#### Spec Layer

Spec orchestrator-v2: L3 (full) — 1 spike, 6 impl tasks, 1 verification

#### Spec Gaps Flagged

1. **GAP-1**: REQ-6 (`isolation: "worktree"` for intra-wave parallelism) directly contradicts `execute.md:96` which **explicitly bans** worktree isolation: "NEVER use `isolation: "worktree"`. Deepflow manages a shared worktree so wave 2 sees wave 1 commits." Spike T52 must resolve this architectural conflict before implementation.
2. **GAP-2**: `execute.md:106` references `--worktree` and `--snapshot` flags on `ratchet.js`, but ratchet.js uses `process.cwd()` and `mainRepoRoot()` — no CLI flag parser exists. REQ-4 (`--task` flag) requires building arg parsing first.
3. **GAP-3**: Technical Notes mention adding wave-runner.js to `bin/install.js`, but bin/ files are NOT distributed by the installer — they're invoked in-place via `node bin/ratchet.js` from within the deepflow repo. No install.js change needed.
4. **GAP-4**: wave-runner.js output format unspecified beyond "plain text." Execute.md integration (T56) must define the exact text format.

#### REQ Status

| REQ | Status | Notes |
|-----|--------|-------|
| REQ-1 | MISSING | `bin/wave-runner.js` does not exist |
| REQ-2 | MISSING | Same — `--recalc --failed` requires wave-runner.js |
| REQ-3 | MISSING | execute.md:158 constructs IMPL_DIFF; line 288 passes inline to wave test prompt |
| REQ-4 | MISSING | ratchet.js has no `--task` flag, no PLAN.md awareness, no commit hash logic |
| REQ-5 | MISSING | No haiku subagent for git ops in execute.md |
| REQ-6 | CONFLICT | execute.md:96 explicitly bans `isolation: "worktree"` for standard tasks |
| REQ-7 | DONE | execute.md:98 — file conflict detection already implemented (1 file = 1 writer rule) |

#### Tasks

- [ ] **T52** [SPIKE]: Validate worktree isolation + cherry-pick merge-back for standard (non-spike) intra-wave tasks
  - Type: spike
  - Hypothesis: `isolation: "worktree"` agents can cherry-pick their commits back to the shared worktree reliably when tasks modify different files within the same package
  - Method:
    1. Create a test PLAN.md with 3 tasks in the same wave, each modifying a different file in the same package
    2. Simulate worktree isolation by creating git worktrees manually, making commits in each
    3. Cherry-pick all 3 commits back to the main worktree in sequence
    4. Verify build passes after cherry-pick sequence
    5. Test failure case: 2 tasks modifying the same file — verify conflict is detected
  - Success criteria: Cherry-pick succeeds for non-overlapping file changes; build passes; overlapping files produce detectable conflict
  - Time-box: 30 min
  - Files: .deepflow/experiments/orchestrator-v2--worktree-cherry-pick--{status}.md
  - Model: opus
  - Effort: high
  - Blocked by: none

- [ ] **T53**: Create `bin/wave-runner.js` — PLAN.md parser + DAG resolver + wave text output
  - Files: bin/wave-runner.js (CREATE)
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-1, REQ-2
  - Changes:
    1. `#!/usr/bin/env node`, pure Node.js (no deps), consistent with ratchet.js
    2. Parse PLAN.md: extract `- [ ] **T{N}**` lines (pending tasks only) and `Blocked by: T{N}` annotations
    3. Build dependency DAG, topological sort into waves (tasks with no unmet deps → wave 1, etc.)
    4. Output plain text: `Wave 1: T1, T4, T7\nWave 2: T2, T5\n...` with task descriptions
    5. Accept `--plan` path arg (default `PLAN.md`)
    6. Accept `--recalc --failed T{N}` — mark specified task as stuck, exclude transitive dependents from ready status
    7. Exit 0 on success, exit 1 on parse error
  - Impact:
    - Callers: `src/commands/df/execute.md` will invoke via `node bin/wave-runner.js`
    - Data flow: PLAN.md → wave-runner.js → text briefing → orchestrator prompt
  - Blocked by: none

- [ ] **T54**: Add `--task T{N}` flag to `bin/ratchet.js` — update PLAN.md on PASS
  - Files: bin/ratchet.js
  - Model: sonnet
  - Effort: low
  - REQs: REQ-4
  - Changes:
    1. Add minimal CLI arg parser (process.argv slicing, consistent with existing codebase style)
    2. Accept `--task T{N}` flag (optional — backward compat when omitted)
    3. On PASS (exit 0), if `--task` provided: read PLAN.md, find matching `- [ ] **T{N}**` line, replace `[ ]` with `[x]`, append commit hash via `git rev-parse --short HEAD`
    4. Preserve existing JSON output and exit code contract (0/1/2)
    5. PLAN.md update happens AFTER JSON output, BEFORE exit
  - Impact:
    - Callers: execute.md §5.5 (existing ratchet invocation gains `--task` flag)
    - Backward compat: no `--task` → no PLAN.md update, identical behavior
  - Blocked by: none

- [ ] **T55**: Replace IMPL_DIFF push model with pull-via-Read in `execute.md` wave test prompt
  - Files: src/commands/df/execute.md
  - Model: haiku
  - Effort: low
  - REQs: REQ-3
  - Changes:
    1. Remove IMPL_DIFF capture at §5.6 (line 158): delete `git -C ${WORKTREE_PATH} diff HEAD~1 → IMPL_DIFF`
    2. In §6 Wave Test prompt (line 288): replace `{IMPL_DIFF}` with instruction: "Use `Read` tool or run `git diff HEAD~1` to inspect the implementation diff yourself"
    3. Reduces orchestrator context consumption by eliminating inline diff storage
  - Impact:
    - Callers: wave test agent prompt (executed by Opus QA agent)
    - Data flow: push (orchestrator collects diff → passes inline) → pull (test agent reads own diff)
  - Blocked by: none

- [ ] **T56**: Integrate `wave-runner.js` into `execute.md` wave dispatch logic
  - Files: src/commands/df/execute.md
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-1
  - Changes:
    1. Replace manual wave computation in execute.md with `node bin/wave-runner.js --plan PLAN.md` shell injection
    2. Parse text output to determine which tasks are in current wave
    3. On task failure + revert: call `node bin/wave-runner.js --recalc --failed T{N}` to recompute remaining waves
    4. Update ratchet invocation to include `--task T{N}` flag
    5. Define wave-runner.js text format contract in execute.md comments
  - Impact:
    - Callers: auto-cycle skill (delegates to `/df:execute`), user direct invocation
    - Data flow: execute.md delegates DAG resolution to wave-runner.js, reducing prompt complexity
  - Blocked by: T53, T55 (file conflict: execute.md)

- [ ] **T57**: Add haiku git-ops context-fork pattern to `execute.md`
  - Files: src/commands/df/execute.md
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-5
  - Changes:
    1. Add context-fork pattern (following browse-fetch skill model): spawn haiku subagent for git diff, git stash, cherry-pick operations
    2. Haiku agent receives worktree path, executes git command, returns one-line summary
    3. Orchestrator receives summary instead of raw diff output
    4. Apply to: post-implementation diff capture, revert confirmation, cherry-pick merge (if T52 passes)
  - Impact:
    - Callers: execute.md orchestrator spawns haiku on each git-heavy operation
    - Data flow: raw git output stays in haiku context; orchestrator sees only summary
  - Blocked by: T52, T56 (file conflict: execute.md)

- [ ] **T58**: Add worktree isolation + cherry-pick merge to `execute.md` (CONDITIONAL on T52 PASS)
  - Files: src/commands/df/execute.md
  - Model: sonnet
  - Effort: high
  - REQs: REQ-6
  - Changes:
    1. Remove line 96 ban on `isolation: "worktree"`
    2. Add `isolation: "worktree"` to Agent() calls for intra-wave parallel tasks
    3. Add cherry-pick merge step between waves: collect worktree commits, cherry-pick to shared worktree in task-number order
    4. Add conflict detection: if cherry-pick fails, log error and revert
    5. Preserve wave sequencing: wave N+1 starts only after all wave N cherry-picks complete
  - Impact:
    - Callers: all intra-wave parallel agents
    - Data flow: agents work in isolated worktrees → cherry-pick → shared worktree
  - Blocked by: T52 (spike must PASS), T57 (file conflict: execute.md)

- [ ] **T59**: Verification — wave-runner + ratchet --task + execute.md changes
  - Files: (verification only, no changes)
  - Model: sonnet
  - Effort: medium
  - REQs: AC-1 through AC-10
  - Changes:
    1. Run `node bin/wave-runner.js` with test PLAN.md — verify text output contains waves and task assignments (AC-1, AC-2)
    2. Run `node bin/wave-runner.js --recalc --failed T3` — verify dependents excluded (AC-3)
    3. Grep execute.md for `Read tool` diff instruction — must match (AC-4); grep for `IMPL_DIFF` — must not match
    4. Test ratchet.js `--task` on PASS — verify PLAN.md `[x]` + commit hash (AC-5, AC-6)
    5. Grep execute.md for haiku git-ops context-fork pattern (AC-7)
    6. Grep execute.md for `isolation: "worktree"` (AC-8) and cherry-pick merge logic (AC-9) — conditional on T52
    7. Grep execute.md for file conflict deferral pattern (AC-10) — already DONE
  - Impact:
    - None (read-only verification)
  - Blocked by: T53, T54, T55, T56, T57, T58

## Dependency Graph (doing-orchestrator-v2)

```
T52 (spike: worktree cherry-pick) ────────────────────┐
                                                       ↓
T53 (wave-runner.js) ─┐                         T57 (haiku git-ops)
                       ↓                               ↓
T55 (IMPL_DIFF pull) → T56 (integrate wave-runner) → T58 (worktree isolation, CONDITIONAL)
                                                       ↓
T54 (ratchet --task) ─────────────────────────────→ T59 (verification)
```

## Parallelism Opportunities (doing-orchestrator-v2)

- **Wave 1**: T52 (spike) + T53 (wave-runner.js) + T54 (ratchet --task) + T55 (IMPL_DIFF pull) — all independent
- **Wave 2**: T56 (integrate wave-runner) — blocked by T53, T55
- **Wave 3**: T57 (haiku git-ops) — blocked by T52, T56
- **Wave 4**: T58 (worktree isolation) — blocked by T52 PASS, T57
- **Wave 5**: T59 (verification) — blocked by all

## File Conflict Matrix (doing-orchestrator-v2)

| File | Tasks |
|------|-------|
| `src/commands/df/execute.md` | T55, T56, T57, T58 → chained: T55 → T56 → T57 → T58 |
| `bin/ratchet.js` | T54 only |
| `bin/wave-runner.js` | T53 only (CREATE) |

No cross-spec file conflicts (all prior spec tasks completed).

---

### done-command-cleanup

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

### done-dashboard-instrumentation-audit

#### Spec Layer

Spec dashboard-instrumentation-audit: L3 (full) — 0 spikes, 20 impl tasks

#### Spec Gaps Flagged

1. **GAP-1**: REQ-4 (stats-cache INSERT OR IGNORE drops data) has no acceptance criteria. Proposed: "Re-ingesting stats-cache.json with updated token counts for an existing session updates (not ignores) the session row."
2. **GAP-2**: REQ-10 (destructive migration) has no AC. Proposed: "cost_reparse migration preserves user, project, model, messages, tool_calls, duration_ms, started_at, ended_at fields."
3. **GAP-3**: REQ-13 (cache breakdown in cost views) has no AC. Proposed: "CostOverview and ModelDonut tables display cache_read and cache_creation columns."
4. **GAP-4**: REQ-7, REQ-14, REQ-15, REQ-17, REQ-18 lack ACs — lower priority, tasks still generated.
5. **GAP-5**: AC-1 ambiguity — "matching session with known model" should clarify: model != 'unknown' in token_events for same session_id.
6. **GAP-6**: AC-10 ambiguity — "correct rates" for haiku-4-5 needs reference to specific pricing values.

#### REQ Status

| REQ | Status | Notes |
|-----|--------|-------|
| REQ-1 | PARTIAL | Aggregation step resolves model via COALESCE subquery; cache-history still inserts 'unknown' fallback |
| REQ-2 | MISSING | No CHECK constraints in schema, no validation in parsers or API |
| REQ-3 | MISSING | No idempotency guard; duplicate POSTs create duplicate token_events |
| REQ-4 | MISSING | stats-cache.ts uses INSERT OR IGNORE, drops richer data |
| REQ-5 | DONE | Window type names already match Claude Code format |
| REQ-6 | PARTIAL | captured_at SELECTed in SQL but not mapped to API response or displayed |
| REQ-7 | MISSING | Only latest snapshot returned; no time-series endpoint |
| REQ-8 | MISSING | Orphaned task_end events silently skipped |
| REQ-9 | MISSING | token-history explicitly skips worktree dirs (line 22) |
| REQ-10 | MISSING | cost_reparse migration does DELETE FROM sessions, losing metadata |
| REQ-11 | PARTIAL | FK exists but intentionally relaxed; needs documentation comment |
| REQ-12 | MISSING | Session interface has fields but table doesn't render user/cache columns |
| REQ-13 | PARTIAL | Data fetched from /api/costs but cache breakdown not displayed |
| REQ-14 | MISSING | PeakHours fetches full session objects, only needs started_at |
| REQ-15 | MISSING | "/" route shows PlaceholderView stub |
| REQ-16 | MISSING | No bearer token auth on POST /api/ingest |
| REQ-17 | MISSING | No rate limiting |
| REQ-18 | MISSING | Backfill has no offset/checkpoint tracking |
| REQ-19 | PARTIAL | Alias maps claude-haiku-4-5 → claude-haiku-3-5-20241022; functional but confusing |
| REQ-20 | MISSING | Pricing cached forever; no TTL |
| REQ-21 | DONE | aggregateAndComputeCosts already recomputes cost=0 sessions |

#### Tasks

- [x] **T52**: Add CHECK constraints + validation for negative token/cost values (2a5e94f)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/db/schema.sql, packages/deepflow-dashboard/src/api/ingest.ts, packages/deepflow-dashboard/src/ingest/parsers/cache-history.ts, packages/deepflow-dashboard/src/ingest/parsers/stats-cache.ts, packages/deepflow-dashboard/src/ingest/parsers/token-history.ts, packages/deepflow-dashboard/src/ingest/parsers/sessions.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-2
  - ACs: AC-2
  - Changes:
    1. Add CHECK constraints to schema.sql: `CHECK (tokens_in >= 0)`, `CHECK (tokens_out >= 0)`, `CHECK (cache_read >= 0)`, `CHECK (cache_creation >= 0)`, `CHECK (cost >= 0)` on sessions and token_events tables
    2. Add `Math.max(0, value)` clamping in each parser before INSERT/UPDATE for token and cost fields
    3. Expand `validatePayload()` in api/ingest.ts to reject payloads with negative token/cost values
    4. Log warning when clamping occurs
  - Impact:
    - Callers: all ingest parsers in ingest/index.ts (lines 175-184), POST /api/ingest
    - Data flow: validation at insert boundary; CHECK constraints as safety net
  - Blocked by: none

- [x] **T53**: Fix destructive cost_reparse migration — preserve non-token session fields (de715bf)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/ingest/index.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-10
  - Changes:
    1. Replace `DELETE FROM sessions` (line ~146) with `UPDATE sessions SET cost = 0, tokens_in = 0, tokens_out = 0, cache_read = 0, cache_creation = 0`
    2. Keep `DELETE FROM token_events` to force re-ingestion of token data
    3. Keep `DELETE FROM task_attempts` as-is
    4. Preserve user, project, model, messages, tool_calls, duration_ms, started_at, ended_at fields
  - Impact:
    - Callers: migration runs once at startup (line 171), never called directly
    - Data flow: subsequent aggregateAndComputeCosts() recomputes from clean token slate while preserving metadata
  - Blocked by: none

- [x] **T54**: Resolve model='unknown' in token_events via enhanced aggregation (c1cf7ab)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/ingest/parsers/cache-history.ts, packages/deepflow-dashboard/src/ingest/index.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-1
  - ACs: AC-1
  - Changes:
    1. In cache-history.ts: when inserting token_events, attempt to resolve model from existing session row first (SELECT model FROM sessions WHERE id = ?)
    2. In aggregateAndComputeCosts(): add UPDATE query to resolve remaining 'unknown' model in token_events by joining on sessions table
    3. Ensure synthetic sessions (cache-synthetic-*) get model resolved from their first non-'unknown' token_event
  - Impact:
    - Callers: parseCacheHistory() from ingest/index.ts (line 180), aggregateAndComputeCosts() from ingest/index.ts (line 197)
    - Data flow: model resolution happens at two stages — parse-time (best effort) and aggregation-time (cleanup)
  - Blocked by: T53 (file conflict: ingest/index.ts)

- [x] **T55**: Add idempotency guard to POST /api/ingest (ae4a7a8)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/api/ingest.ts, packages/deepflow-dashboard/src/db/schema.sql
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-3
  - ACs: AC-3
  - Changes:
    1. Add UNIQUE constraint on token_events (session_id, model, source) or use INSERT OR IGNORE for token_events to prevent duplicate rows
    2. Change session UPDATE logic in insertPayload() to use absolute values (not deltas) — idempotent SET instead of accumulating
    3. Wrap insertPayload() in a transaction for atomicity
    4. Return 200 with same response shape on duplicate POST
  - Impact:
    - Callers: POST /api/ingest handler (line 119), backfill.ts sendInBatches()
    - Data flow: duplicate POSTs become no-ops; totals stay stable
  - Blocked by: T52 (file conflict: schema.sql, api/ingest.ts)

- [x] **T56**: Replace stats-cache INSERT OR IGNORE with upsert logic (30e8234)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/ingest/parsers/stats-cache.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-4
  - Changes:
    1. Replace `INSERT OR IGNORE INTO sessions` (line 73) with existence check + conditional UPDATE/INSERT
    2. Follow pattern from sessions.ts (lines 175-206): check if session exists, UPDATE if yes (merge richer data), INSERT if new
    3. When updating, use COALESCE to prefer non-'unknown' values: `model = COALESCE(NULLIF(?, 'unknown'), model)`
    4. Preserve existing non-zero token counts if new data has zeros
  - Impact:
    - Callers: parseStatsCache() from ingest/index.ts (line 183)
    - Data flow: re-ingestion enriches sessions instead of being silently dropped
  - Blocked by: T52 (file conflict: stats-cache.ts)

- [x] **T57**: Add bearer token auth to POST /api/ingest (6ef57a5)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/api/ingest.ts, packages/deepflow-dashboard/src/server.ts, packages/deepflow-dashboard/src/backfill.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-16
  - ACs: AC-9
  - Changes:
    1. Read shared secret from env `DEEPFLOW_INGEST_SECRET` or `.deepflow/config.yaml` `ingest_secret` field
    2. Add auth middleware to POST /api/ingest: if secret configured, require `Authorization: Bearer {secret}` header
    3. Return 401 Unauthorized when secret configured but request lacks valid bearer token
    4. Skip auth check when no secret configured (backward compatible)
    5. Update backfill.ts to read same secret and include Authorization header in POST requests
  - Impact:
    - Callers: POST /api/ingest handler, backfill.ts sendInBatches()
    - Data flow: auth is opt-in; existing local-mode usage unaffected
  - Blocked by: T55 (file conflict: api/ingest.ts)

- [x] **T58**: Log warning for orphaned task_end events (d3ea36e)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/ingest/parsers/execution-history.ts
  - Model: haiku
  - Effort: low
  - REQs: REQ-8
  - ACs: AC-6
  - Changes:
    1. Replace silent `continue` at line 120 with `console.warn('[ingest:execution-history] Orphaned task_end: task_id=${end.task_id}, session_id=${end.session_id}')` before continuing
  - Impact:
    - Callers: parseExecutionHistory() from ingest/index.ts (line 182)
    - Data flow: warning logged to console; no behavioral change
  - Blocked by: none

- [x] **T59**: Parse worktree token-history dirs (50d14b6)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/ingest/parsers/token-history.ts
  - Model: haiku
  - Effort: high
  - REQs: REQ-9
  - ACs: AC-7
  - Changes:
    1. Remove worktree skip condition at line 22: `if (dirName.includes('--')) continue`
    2. Ensure offset tracking works per-worktree-dir (separate _meta key per dir)
    3. Verify token_events from worktree dirs are correctly associated with sessions
  - Impact:
    - Callers: parseTokenHistory() from ingest/index.ts (line 178)
    - Data flow: worktree token data flows into token_events → aggregation → sessions
  - Blocked by: none

- [x] **T60**: Display "Updated X min ago" in QuotaStatus view (d174ef4)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/client/views/QuotaStatus.tsx, packages/deepflow-dashboard/src/client/components/QuotaGauge.tsx, packages/deepflow-dashboard/src/api/quota.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-6
  - ACs: AC-5
  - Changes:
    1. In quota.ts: ensure captured_at is included in the API response mapping (verify it's not dropped between SQL and JSON)
    2. In QuotaStatus.tsx: add `captured_at: string` to QuotaEntry interface
    3. In QuotaGauge.tsx: add `capturedAt` prop, render human-friendly relative time ("Updated 5 min ago")
    4. Pass captured_at from QuotaStatus to QuotaGauge
  - Impact:
    - Callers: QuotaStatus routed at /quota in App.tsx
    - Data flow: captured_at flows from DB → API → QuotaStatus → QuotaGauge → rendered text
  - Blocked by: none

- [x] **T61**: Add user, cache_read, cache_creation columns to SessionList (7b953c5)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/client/views/SessionList.tsx
  - Model: haiku
  - Effort: high
  - REQs: REQ-12
  - ACs: AC-8
  - Changes:
    1. Add column headers: User, Cache Read, Cache Creation to table header row
    2. Add corresponding `<td>` cells rendering `session.user`, `session.cache_read`, `session.cache_creation` with formatting
    3. Add User to sortable columns list
  - Impact:
    - Callers: SessionList routed at /sessions in App.tsx
    - Data flow: data already fetched from /api/sessions; only UI rendering changes
  - Blocked by: none

- [x] **T62**: Display cache token breakdown in CostOverview and ModelDonut (b6fa0e2)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/client/views/CostOverview.tsx, packages/deepflow-dashboard/src/client/views/ModelDonut.tsx
  - Model: haiku
  - Effort: high
  - REQs: REQ-13
  - Changes:
    1. CostOverview: add MetricCards or table columns for cache_read_tokens and cache_creation_tokens
    2. ModelDonut: add Cache Creation column to the per-model table (line ~142); data already available in response
  - Impact:
    - Callers: CostOverview at /costs, ModelDonut at /models in App.tsx
    - Data flow: data already fetched from /api/costs; only UI rendering changes
  - Blocked by: none

- [x] **T63**: Replace Overview placeholder with CostOverview (ed8ad9e)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/client/App.tsx
  - Model: haiku
  - Effort: low
  - REQs: REQ-15
  - Changes:
    1. Remove PlaceholderView function (lines 19-23) if no other users
    2. Replace `const OverviewView = () => <PlaceholderView name="Overview" />` (line 29) with `const OverviewView = CostOverview` or import CostOverview directly for the "/" route
  - Impact:
    - Callers: "/" route in browser
    - Data flow: existing CostOverview component reused; no new data fetching
  - Blocked by: none

- [x] **T64**: Fix haiku pricing alias and add validation (e384314)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/pricing.ts
  - Model: haiku
  - Effort: high
  - REQs: REQ-19
  - ACs: AC-10
  - Changes:
    1. Verify alias at line 73: `'claude-haiku-4-5': 'claude-haiku-3-5-20241022'` — confirm this maps to correct pricing entry in pricing-fallback.json
    2. Add `'claude-haiku-4-5-20251001'` alias if missing (actual model ID from Anthropic)
    3. Add warning log when resolveModelPricing() returns null for a model
    4. Add comment documenting the alias mapping rationale
  - Impact:
    - Callers: resolveModelPricing() → computeCost() → aggregateAndComputeCosts()
    - Data flow: alias resolution → pricing lookup → cost computation
  - Blocked by: none

- [x] **T65**: Add TTL to pricing cache (b285ad0)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/pricing.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-20
  - ACs: AC-11
  - Changes:
    1. Add `cachedAt: number` alongside `cached` variable (line ~20)
    2. Add TTL constant: `const PRICING_TTL_MS = 3600_000` (1 hour)
    3. In fetchPricing(): check `Date.now() - cachedAt > PRICING_TTL_MS` before returning cached
    4. On TTL expiry: attempt refetch, fall back to stale cached on failure
    5. Export TTL constant for testability
  - Impact:
    - Callers: fetchPricing() from server.ts (startup) and ingest/index.ts (aggregation)
    - Data flow: pricing auto-refreshes hourly; graceful fallback to stale data
  - Blocked by: T64 (file conflict: pricing.ts)

- [x] **T66**: Add rate limiting to /api/ingest (ff744f1)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/api/ingest.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-17
  - Changes:
    1. Implement in-memory rate limiter: Map<string, { count: number, resetAt: number }> keyed by IP
    2. Add middleware before POST handler: extract IP from request, check count against threshold (100 req/min)
    3. Return 429 Too Many Requests with Retry-After header when limit exceeded
    4. Clean up expired entries periodically (on each request check)
  - Impact:
    - Callers: POST /api/ingest
    - Data flow: rate limiter sits between auth and handler; does not affect authenticated local-mode usage
  - Blocked by: T57 (file conflict: api/ingest.ts)

- [x] **T67**: Optimize PeakHours to fetch only started_at (39826d8)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/api/sessions.ts, packages/deepflow-dashboard/src/client/views/PeakHours.tsx
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-14
  - Changes:
    1. Add `?fields=started_at` query param support to /api/sessions endpoint — when present, SELECT only the requested columns
    2. Update PeakHours.tsx fetch (line ~61) to use `?fields=started_at&limit=500`
    3. Keep backward compatibility: omitting `fields` returns full session objects
  - Impact:
    - Callers: PeakHours view; /api/sessions endpoint used by SessionList (unaffected, no fields param)
    - Data flow: reduced payload size for PeakHours (~95% reduction)
  - Blocked by: none

- [x] **T68**: Add quota time-series endpoint (d6ba2ca)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/api/quota.ts, packages/deepflow-dashboard/src/client/views/QuotaStatus.tsx
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-7
  - Changes:
    1. Add GET /api/quota/history endpoint with optional `?window_type=` and `?days=7` query params
    2. Query: SELECT captured_at, window_type, used, limit_val FROM quota_snapshots WHERE captured_at > ? ORDER BY captured_at
    3. Add trend chart section to QuotaStatus.tsx using existing StackedAreaChart or line chart
    4. Fetch from /api/quota/history on mount
  - Impact:
    - Callers: QuotaStatus view (new section)
    - Data flow: historical snapshots already in DB; new endpoint exposes them as time-series
  - Blocked by: T60 (file conflict: quota.ts, QuotaStatus.tsx)

- [x] **T69**: Add backfill offset tracking (32a4234)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/backfill.ts
  - Model: sonnet
  - Effort: medium
  - REQs: REQ-18
  - Changes:
    1. Store last-sent offset per source in `.deepflow/backfill-state.json`: `{ "sessions_offset": 150, "token_history_offset": 3200 }`
    2. Load state at start of backfill run; skip already-sent records
    3. Update offset after each successful batch POST
    4. On failure: stop and preserve last-good offset (no partial updates)
  - Impact:
    - Callers: backfill CLI (standalone invocation)
    - Data flow: idempotent re-runs skip already-synced data
  - Blocked by: none

- [x] **T70**: Document relaxed FK on command_history.session_id (bd98b62)
  - Type: implementation
  - Files: packages/deepflow-dashboard/src/db/schema.sql
  - Model: haiku
  - Effort: low
  - REQs: REQ-11
  - Changes:
    1. Add comment above session_id column: `-- Nullable: CLI commands may run outside sessions (global /init, cross-project tools)`
  - Impact:
    - None (documentation only)
  - Blocked by: none

- [x] **T71**: Final verification — build + typecheck + AC validation (824ba57)
  - Type: verification
  - Files: (verification only, no changes)
  - Model: sonnet
  - Effort: medium
  - REQs: AC-1 through AC-11
  - Changes:
    1. Run `npm run build` — must pass
    2. Run `npm run typecheck` — must pass
    3. AC-1: `SELECT COUNT(*) FROM token_events WHERE model='unknown'` = 0 for events with known-model sessions
    4. AC-2: Attempt INSERT with negative tokens_in — verify rejection or clamp
    5. AC-3: POST same payload twice to /api/ingest — verify identical totals
    6. AC-4: Verify window_type values in quota_snapshots after real quota-history parse
    7. AC-5: QuotaStatus renders "Updated X min ago"
    8. AC-6: Grep execution-history.ts for `console.warn.*Orphaned` — must match
    9. AC-7: Verify token-history parser processes worktree dirs
    10. AC-8: SessionList has user, cache_read, cache_creation columns
    11. AC-9: POST /api/ingest returns 401 without valid bearer when auth configured
    12. AC-10: Verify getPricing('claude-haiku-4-5') returns non-null
    13. AC-11: Verify pricing cache refreshes after TTL
  - Impact:
    - None (read-only verification)
  - Blocked by: T52, T53, T54, T55, T56, T57, T58, T59, T60, T61, T62, T63, T64, T65, T66, T67, T68, T69, T70

## Dependency Graph (dashboard-instrumentation-audit)

```
T52 (negative validation) ──┬──→ T55 (idempotency) ──→ T57 (auth) ──→ T66 (rate limit)
                            └──→ T56 (stats-cache upsert)

T53 (safe migration) ──→ T54 (model resolution)

T58 (orphan log)           ← independent
T59 (worktree token)       ← independent
T60 (quota updated-at) ──→ T68 (quota time-series)
T61 (session columns)      ← independent
T62 (cache breakdown)      ← independent
T63 (overview placeholder) ← independent
T64 (haiku alias) ──→ T65 (pricing TTL)
T67 (peakhours opt)        ← independent
T69 (backfill offset)      ← independent
T70 (FK docs)              ← independent

T71 (verification) ← blocked by all
```

## Parallelism Opportunities (dashboard-instrumentation-audit)

- **Wave 1**: T52 (validation) + T53 (migration) + T58 (orphan log) + T59 (worktree) + T60 (quota updated) + T61 (session cols) + T62 (cache breakdown) + T63 (overview) + T64 (haiku alias) + T67 (peakhours) + T69 (backfill) + T70 (FK docs)
- **Wave 2**: T54 (model resolution, blocked T53) + T55 (idempotency, blocked T52) + T56 (stats-cache, blocked T52) + T65 (pricing TTL, blocked T64) + T68 (quota time-series, blocked T60)
- **Wave 3**: T57 (auth, blocked T55)
- **Wave 4**: T66 (rate limit, blocked T57)
- **Wave 5**: T71 (verification, blocked all)

## File Conflict Matrix (dashboard-instrumentation-audit)

| File | Tasks | Resolution |
|------|-------|------------|
| `src/db/schema.sql` | T52, T55, T70 | T52 → T55 (CHECK before UNIQUE); T70 independent (comment only) |
| `src/api/ingest.ts` | T52, T55, T57, T66 | T52 → T55 → T57 → T66 (validation → dedup → auth → rate limit) |
| `src/ingest/index.ts` | T53, T54 | T53 → T54 (fix migration before aggregation) |
| `src/ingest/parsers/stats-cache.ts` | T52, T56 | T52 → T56 (validation before upsert) |
| `src/pricing.ts` | T64, T65 | T64 → T65 (alias before TTL) |
| `src/api/quota.ts` | T60, T68 | T60 → T68 (updated-at before time-series) |
| `src/client/views/QuotaStatus.tsx` | T60, T68 | T60 → T68 |

No cross-spec file conflicts (prior specs fully completed).
