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

## Spec File States

```
specs/
  feature.md        → Unplanned (skip)
  doing-auth.md     → Executed, ready for verification (default target)
  done-upload.md    → Already verified and merged (--re-verify only)
```

## Behavior

### 1. LOAD CONTEXT

```
Load:
- specs/doing-*.md (primary verify targets)
- PLAN.md (check task completion status)
- specs/done-*.md (only if --re-verify flag)
- Source code (actual implementation)
```

**Readiness check:** For each `doing-*` spec, check PLAN.md:
- All tasks `[x]` → ready for verification (proceed)
- Some tasks `[ ]` → not ready, warn: "⚠ {spec} has {n} incomplete tasks. Run /df:execute first."

If no `doing-*` specs found: report counts, suggest `/df:execute`.

### 1.5. DETECT PROJECT COMMANDS

Detect build and test commands by inspecting project files in the worktree.

**Config override always wins.** If `.deepflow/config.yaml` has `quality.test_command` or `quality.build_command`, use those.

**Auto-detection (first match wins):**

| File | Build | Test |
|------|-------|------|
| `package.json` with `scripts.build` | `npm run build` | `npm test` (if scripts.test is not default placeholder) |
| `pyproject.toml` or `setup.py` | — | `pytest` |
| `Cargo.toml` | `cargo build` | `cargo test` |
| `go.mod` | `go build ./...` | `go test ./...` |
| `Makefile` with `test` target | `make build` (if target exists) | `make test` |

**Output:**
- Commands found: `Build: npm run build | Test: npm test`
- Nothing found: `⚠ No build/test commands detected. L0/L4 skipped. Set quality.test_command in .deepflow/config.yaml`

### 2. VERIFY EACH SPEC

**L0: Build check** (if build command detected)

Run the build command in the worktree:
- Exit code 0 → L0 pass, continue to L1-L3
- Exit code non-zero → L0 FAIL
  - Report: "✗ L0: Build failed" with last 30 lines of output
  - Add fix task: "Fix build errors" to PLAN.md
  - Do NOT proceed to L1-L4 (no point checking if code doesn't build)

**L1-L3: Static analysis** (via Explore agents)

Check requirements, acceptance criteria, and quality (stubs/TODOs).
Mark each: ✓ satisfied | ✗ missing | ⚠ partial

**L4: Test execution** (if test command detected)

Run AFTER L0 passes and L1-L3 complete. Run even if L1-L3 found issues — test failures reveal additional problems.

- Run test command in the worktree (timeout from config, default 5 min)
- Exit code 0 → L4 pass
- Exit code non-zero → L4 FAIL
  - Capture last 50 lines of output
  - Report: "✗ L4: Tests failed (N of M)" with relevant output
  - Add fix task: "Fix failing tests" with test output in description

**Flaky test handling** (if `quality.test_retry_on_fail: true` in config):
- If tests fail, re-run ONCE
- Second run passes → L4 pass with note: "⚠ L4: Passed on retry (possible flaky test)"
- Second run fails → genuine failure

### 3. GENERATE REPORT

Report per spec with L0/L4 status, requirements count, acceptance count, quality issues.

**Format on success:**
```
done-upload.md: L0 ✓ | 4/4 reqs ✓, 5/5 acceptance ✓ | L4 ✓ (12 tests) | 0 quality issues
```

**Format on failure:**
```
done-upload.md: L0 ✓ | 4/4 reqs ✓, 5/5 acceptance ✓ | L4 ✗ (3 failed) | 0 quality issues

Issues:
  ✗ L4: 3 test failures
    FAIL src/upload.test.ts > should validate file type
    FAIL src/upload.test.ts > should reject oversized files

Fix tasks added to PLAN.md:
  T10: Fix 3 failing tests in upload module
```

**Gate conditions (ALL must pass to merge):**
- L0: Build passes (or no build command detected)
- L1-L3: All requirements satisfied, no stubs, properly wired
- L4: Tests pass (or no test command detected)

**If all gates pass:** Proceed to Post-Verification merge.

**If issues found:** Add fix tasks to PLAN.md in the worktree and register as native tasks, then loop back to execute:

1. Discover worktree (same logic as Post-Verification step 1)
2. Write new fix tasks to `{worktree_path}/PLAN.md` under the existing spec section
   - Task IDs continue from last (e.g. if T9 was last, fixes start at T10)
   - Format: `- [ ] **T10**: Fix {description}` with `Files:` and details
3. Register fix tasks as native tasks for immediate tracking:
   ```
   For each fix task added:
     TaskCreate(subject: "T10: Fix {description}", description: "...", activeForm: "Fixing {description}")
     TaskUpdate(addBlockedBy: [...]) if dependencies exist
   ```
   This allows `/df:execute --continue` to find fix tasks via TaskList immediately.
4. Output report + next step:

```
done-upload.md: L0 ✓ | 4/4 reqs ✓, 3/5 acceptance ✗ | L4 ✗ (2 failed) | 1 quality issue

Issues:
  ✗ AC-3: YAML parsing missing for consolation
  ✗ L4: 2 test failures
    FAIL src/upload.test.ts > should validate file type
    FAIL src/upload.test.ts > should reject oversized files
  ⚠ Quality: TODO in parse_config()

Fix tasks added to PLAN.md:
  T10: Add YAML parsing for consolation section
  T11: Fix 2 failing tests in upload module
  T12: Remove TODO in parse_config()

Run /df:execute --continue to fix in the same worktree.
```

**Do NOT** create new specs, new worktrees, or merge with issues pending.

### 4. CAPTURE LEARNINGS

On success, write significant learnings to `.deepflow/experiments/{domain}--{approach}--success.md`

**Write when:**
- Non-trivial approach used
- Alternatives rejected during planning
- Performance optimization made
- Integration pattern discovered

**Format:**
```markdown
# {Approach} [SUCCESS]
Objective: ...
Approach: ...
Why it worked: ...
Files: ...
```

**Skip:** Simple CRUD, standard patterns, user declines

## Verification Levels

| Level | Check | Method | Runner |
|-------|-------|--------|--------|
| L0: Builds | Code compiles/builds | Run build command | Orchestrator (Bash) |
| L1: Exists | File/function exists | Glob/Grep | Explore agents |
| L2: Substantive | Real code, not stub | Read + analyze | Explore agents |
| L3: Wired | Integrated into system | Trace imports/calls | Explore agents |
| L4: Tested | Tests pass | Run test command | Orchestrator (Bash) |

**Default: L0 through L4.** L0 and L4 are skipped ONLY if no build/test command is detected (see step 1.5).
L0 and L4 run directly via Bash — Explore agents cannot execute commands.

## Rules
- **Never use TaskOutput** — Returns full transcripts that explode context
- **Never use run_in_background for Explore agents** — Causes late notifications that pollute output
- Verify against spec, not assumptions
- Flag partial implementations
- Report TODO/FIXME as quality issues
- Don't auto-fix — add fix tasks to PLAN.md, then `/df:execute --continue`
- Capture learnings — Write experiments for significant approaches

## Agent Usage

**NEVER use `run_in_background` for Explore agents** — causes late "Agent completed" notifications that pollute output after work is done.

**NEVER use TaskOutput** — returns full agent transcripts (100KB+) that explode context.

**Spawn ALL Explore agents in ONE message (non-background, parallel):**

```python
# All in single message — runs in parallel, blocks until all complete:
Task(subagent_type="Explore", model="haiku", prompt="Find: ...")
Task(subagent_type="Explore", model="haiku", prompt="Find: ...")
# Each returns agent's final message only (not full transcript)
# No late notifications — agents complete before orchestrator proceeds
```

Scale: 1-2 agents per spec, cap 10.

## Examples

### All pass → merge
```
/df:verify

Checking doing-* specs...
  doing-upload.md: all tasks [x] ✓ (ready)
  doing-auth.md: all tasks [x] ✓ (ready)

Build: npm run build | Test: npm test

doing-upload.md: L0 ✓ | 4/4 reqs ✓, 5/5 acceptance ✓ | L4 ✓ (12 tests) | 0 quality issues
doing-auth.md: L0 ✓ | 2/2 reqs ✓, 3/3 acceptance ✓ | L4 ✓ (8 tests) | 0 quality issues

✓ All gates passed

✓ Merged df/upload to main
✓ Cleaned up worktree and branch
✓ doing-upload → done-upload
✓ doing-auth → done-auth

Learnings captured:
  → experiments/perf--streaming-upload--success.md
```

### Issues found → fix tasks added
```
/df:verify

Checking doing-* specs...
  doing-upload.md: all tasks [x] ✓ (ready)

Build: npm run build | Test: npm test

doing-upload.md: L0 ✓ | 4/4 reqs ✓, 3/5 acceptance ✗ | L4 ✗ (3 failed) | 1 quality issue

Issues:
  ✗ AC-3: YAML parsing missing for consolation
  ✗ L4: 3 test failures
    FAIL src/upload.test.ts > should validate file type
    FAIL src/upload.test.ts > should reject oversized files
    FAIL src/upload.test.ts > should handle empty input
  ⚠ Quality: TODO in parse_config()

Fix tasks added to PLAN.md:
  T10: Add YAML parsing for consolation section
  T11: Fix 3 failing tests in upload module
  T12: Remove TODO in parse_config()

Run /df:execute --continue to fix in the same worktree.
```

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL gates pass** (L0 build, L1-L3 static analysis, L4 tests). If any gate fails, fix tasks were added to PLAN.md instead (see step 3).

### 1. DISCOVER WORKTREE

Find worktree info using two strategies (checkpoint → fallback to git):

```bash
# Strategy 1: checkpoint.json (from interrupted executions)
if [ -f .deepflow/checkpoint.json ]; then
  WORKTREE_BRANCH=$(cat .deepflow/checkpoint.json | jq -r '.worktree_branch')
  WORKTREE_PATH=$(cat .deepflow/checkpoint.json | jq -r '.worktree_path')
fi

# Strategy 2: Infer from doing-* spec + git worktree list (no checkpoint needed)
if [ -z "${WORKTREE_BRANCH}" ]; then
  SPEC_NAME=$(basename specs/doing-*.md .md | sed 's/doing-//')
  WORKTREE_PATH=".deepflow/worktrees/${SPEC_NAME}"
  # Get branch from git worktree list
  WORKTREE_BRANCH=$(git worktree list --porcelain | grep -A2 "${WORKTREE_PATH}" | grep 'branch' | sed 's|branch refs/heads/||')
fi

# No worktree found — nothing to merge
if [ -z "${WORKTREE_BRANCH}" ]; then
  echo "No worktree found — nothing to merge. Workflow may already be on main."
  exit 0
fi
```

### 2. MERGE TO MAIN

```bash
# Switch to main and merge
git checkout main
git merge "${WORKTREE_BRANCH}" --no-ff -m "feat({spec}): merge verified changes"
```

**On merge conflict:**
- Keep worktree intact for manual resolution
- Output: "Merge conflict detected. Resolve manually, then run /df:verify --merge-only"
- Exit without cleanup

### 3. CLEANUP WORKTREE

After successful merge:

```bash
# Remove worktree and branch
git worktree remove --force "${WORKTREE_PATH}"
git branch -d "${WORKTREE_BRANCH}"

# Remove checkpoint if it exists
rm -f .deepflow/checkpoint.json
```

**Output on success:**
```
✓ Merged df/upload to main
✓ Cleaned up worktree and branch
✓ Spec complete: doing-upload → done-upload

Workflow complete! Ready for next feature: /df:spec <name>
```

### 4. CAPTURE DECISIONS (success path only)

Extract up to 4 candidate decisions (quality findings, patterns validated, lessons learned). Present via AskUserQuestion with `multiSelect: true`; tags: `[APPROACH]`, `[PROVISIONAL]`, `[ASSUMPTION]`.

```
AskUserQuestion(question: "Which decisions to record?", multiSelect: true,
  options: [{ label: "[APPROACH] <decision>", description: "<rationale>" }, ...])
```

For each confirmed decision, append to `.deepflow/decisions.md` (create if missing):
`### {YYYY-MM-DD} — verify` / `- [TAG] {decision text} — {rationale}`

Skip if user confirms none or declines.
