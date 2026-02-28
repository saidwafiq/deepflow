# /df:verify — Verify Specs Satisfied

## Purpose
Check that implemented code satisfies spec requirements and acceptance criteria.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Usage
```
/df:verify                  # Verify doing-* specs with all tasks completed
/df:verify doing-upload     # Verify specific spec
/df:verify --re-verify      # Re-verify done-* specs (already merged)
```

## Skills & Agents
- Skill: `code-completeness` — Find incomplete implementations

**Use Task tool to spawn agents:**
| Agent | subagent_type | model | Purpose |
|-------|---------------|-------|---------|
| Scanner | `Explore` | `haiku` | Fast codebase scanning |

Follow `templates/explore-agent.md` for all Explore agent spawning. Scale: 1-2 agents per spec, cap 10.

## Spec File States

```
specs/
  feature.md        → Unplanned (skip)
  doing-auth.md     → Executed, ready for verification (default target)
  done-upload.md    → Already verified and merged (--re-verify only)
```

## Behavior

### 1. LOAD CONTEXT

Load: `specs/doing-*.md`, `PLAN.md`, source code. Load `specs/done-*.md` only if `--re-verify`.

**Readiness check:** For each `doing-*` spec, check PLAN.md:
- All tasks `[x]` → ready (proceed)
- Some tasks `[ ]` → warn: "⚠ {spec} has {n} incomplete tasks. Run /df:execute first."

If no `doing-*` specs found: report counts, suggest `/df:execute`.

### 1.5. DETECT PROJECT COMMANDS

**Config override always wins.** If `.deepflow/config.yaml` has `quality.test_command` or `quality.build_command`, use those.

**Auto-detection (first match wins):**

| File | Build | Test |
|------|-------|------|
| `package.json` with `scripts.build` | `npm run build` | `npm test` (if scripts.test is not default placeholder) |
| `pyproject.toml` or `setup.py` | — | `pytest` |
| `Cargo.toml` | `cargo build` | `cargo test` |
| `go.mod` | `go build ./...` | `go test ./...` |
| `Makefile` with `test` target | `make build` (if target exists) | `make test` |

- Commands found: `Build: npm run build | Test: npm test`
- Nothing found: `⚠ No build/test commands detected. L0/L4 skipped. Set quality.test_command in .deepflow/config.yaml`

### 2. VERIFY EACH SPEC

**L0: Build check** (if build command detected)

Run the build command in the worktree:
- Exit code 0 → L0 pass, continue to L1-L3
- Exit code non-zero → L0 FAIL: report "✗ L0: Build failed" with last 30 lines, add fix task to PLAN.md, stop (skip L1-L4)

**L1-L3: Static analysis** (via Explore agents)

Check requirements, acceptance criteria, and quality (stubs/TODOs).
Mark each: ✓ satisfied | ✗ missing | ⚠ partial

**L4: Test execution** (if test command detected)

Run AFTER L0 passes and L1-L3 complete. Run even if L1-L3 found issues.

- Exit code 0 → L4 pass
- Exit code non-zero → L4 FAIL: capture last 50 lines, report "✗ L4: Tests failed (N of M)", add fix task

**Flaky test handling** (if `quality.test_retry_on_fail: true` in config):
- Re-run ONCE on failure. Second pass → "⚠ L4: Passed on retry (possible flaky test)". Second fail → genuine failure.

### 3. GENERATE REPORT

**Format on success:**
```
done-upload.md: L0 ✓ | 4/4 reqs ✓, 5/5 acceptance ✓ | L4 ✓ (12 tests) | 0 quality issues
```

**Format on failure:**
```
done-upload.md: L0 ✓ | 4/4 reqs ✓, 3/5 acceptance ✗ | L4 ✗ (3 failed) | 1 quality issue

Issues:
  ✗ AC-3: YAML parsing missing for consolation
  ✗ L4: 3 test failures
    FAIL src/upload.test.ts > should validate file type
    FAIL src/upload.test.ts > should reject oversized files
  ⚠ Quality: TODO in parse_config()

Fix tasks added to PLAN.md:
  T10: Add YAML parsing for consolation section
  T11: Fix 3 failing tests in upload module
  T12: Remove TODO in parse_config()

Run /df:execute --continue to fix in the same worktree.
```

**Gate conditions (ALL must pass to merge):**
- L0: Build passes (or no build command detected)
- L1-L3: All requirements satisfied, no stubs, properly wired
- L4: Tests pass (or no test command detected)

**If all gates pass:** Proceed to Post-Verification merge.

**If issues found:** Add fix tasks to PLAN.md in the worktree and register as native tasks:
1. Discover worktree (same logic as Post-Verification step 1)
2. Write fix tasks to `{worktree_path}/PLAN.md` under existing spec section (IDs continue from last)
3. Register each fix task: `TaskCreate(subject: "T10: Fix {description}", ...)` + `TaskUpdate(addBlockedBy: [...])` if dependencies exist
4. Output report + "Run /df:execute --continue to fix in the same worktree."

**Do NOT** create new specs, new worktrees, or merge with issues pending.

### 4. CAPTURE LEARNINGS

On success, write to `.deepflow/experiments/{domain}--{approach}--success.md` when: non-trivial approach used, alternatives rejected, performance optimization made, or integration pattern discovered. Skip simple CRUD/standard patterns.

```markdown
# {Approach} [SUCCESS]
Objective: ...
Approach: ...
Why it worked: ...
Files: ...
```

## Verification Levels

| Level | Check | Method | Runner |
|-------|-------|--------|--------|
| L0: Builds | Code compiles/builds | Run build command | Orchestrator (Bash) |
| L1: Exists | File/function exists | Glob/Grep | Explore agents |
| L2: Substantive | Real code, not stub | Read + analyze | Explore agents |
| L3: Wired | Integrated into system | Trace imports/calls | Explore agents |
| L4: Tested | Tests pass | Run test command | Orchestrator (Bash) |

**Default: L0 through L4.** L0 and L4 skipped ONLY if no build/test command detected (see step 1.5). L0 and L4 run via Bash — Explore agents cannot execute commands.

## Rules
- Verify against spec, not assumptions
- Flag partial implementations
- Report TODO/FIXME as quality issues
- Don't auto-fix — add fix tasks to PLAN.md, then `/df:execute --continue`
- Capture learnings — Write experiments for significant approaches

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL gates pass.** If any gate fails, fix tasks were added to PLAN.md instead (see step 3).

### 1. DISCOVER WORKTREE

Find worktree info (checkpoint → fallback to git):

```bash
# Strategy 1: checkpoint.json
if [ -f .deepflow/checkpoint.json ]; then
  WORKTREE_BRANCH=$(cat .deepflow/checkpoint.json | jq -r '.worktree_branch')
  WORKTREE_PATH=$(cat .deepflow/checkpoint.json | jq -r '.worktree_path')
fi

# Strategy 2: Infer from doing-* spec + git worktree list
if [ -z "${WORKTREE_BRANCH}" ]; then
  SPEC_NAME=$(basename specs/doing-*.md .md | sed 's/doing-//')
  WORKTREE_PATH=".deepflow/worktrees/${SPEC_NAME}"
  WORKTREE_BRANCH=$(git worktree list --porcelain | grep -A2 "${WORKTREE_PATH}" | grep 'branch' | sed 's|branch refs/heads/||')
fi

# No worktree found
if [ -z "${WORKTREE_BRANCH}" ]; then
  echo "No worktree found — nothing to merge. Workflow may already be on main."
  exit 0
fi
```

### 2. MERGE TO MAIN

```bash
git checkout main
git merge "${WORKTREE_BRANCH}" --no-ff -m "feat({spec}): merge verified changes"
```

**On merge conflict:** Keep worktree intact, output "Merge conflict detected. Resolve manually, then run /df:verify --merge-only", exit without cleanup.

### 3. CLEANUP WORKTREE

```bash
git worktree remove --force "${WORKTREE_PATH}"
git branch -d "${WORKTREE_BRANCH}"
rm -f .deepflow/checkpoint.json
```

Output:
```
✓ Merged df/upload to main
✓ Cleaned up worktree and branch
✓ Spec complete: doing-upload → done-upload

Workflow complete! Ready for next feature: /df:spec <name>
```

### 4. CAPTURE DECISIONS (success path only)

Follow the **success-path-only** variant from `templates/decision-capture.md`. Command name: `verify`.
