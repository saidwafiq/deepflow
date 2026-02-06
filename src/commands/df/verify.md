# /df:verify — Verify Specs Satisfied

## Purpose
Check that implemented code satisfies spec requirements and acceptance criteria.

## Usage
```
/df:verify                  # Verify all done-* specs
/df:verify --doing          # Also verify in-progress specs
/df:verify done-upload      # Verify specific spec
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
  doing-auth.md     → In progress (verify with --doing)
  done-upload.md    → Completed (default verify target)
```

## Behavior

### 1. LOAD CONTEXT

```
Load:
- specs/done-*.md (completed specs to verify)
- specs/doing-*.md (if --doing flag)
- Source code (actual implementation)
```

If no done-* specs: report counts, suggest `--doing`.

### 2. VERIFY EACH SPEC

Check requirements, acceptance criteria, and quality (stubs/TODOs).
Mark each: ✓ satisfied | ✗ missing | ⚠ partial

### 3. GENERATE REPORT

Report per spec: requirements count, acceptance count, quality issues.

**If all pass:** Proceed to Post-Verification merge.

**If issues found:** Add fix tasks to PLAN.md in the worktree and loop back to execute:

1. Discover worktree (same logic as Post-Verification step 1)
2. Write new fix tasks to `{worktree_path}/PLAN.md` under the existing spec section
   - Task IDs continue from last (e.g. if T9 was last, fixes start at T10)
   - Format: `- [ ] **T10**: Fix {description}` with `Files:` and details
3. Output report + next step:

```
done-upload.md: 4/4 reqs ✓, 3/5 acceptance ✗, 1 quality issue

Issues:
  ✗ AC-3: YAML parsing missing for consolation
  ⚠ Quality: TODO in parse_config()

Fix tasks added to PLAN.md:
  T10: Add YAML parsing for consolation section
  T11: Remove TODO in parse_config()

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

| Level | Check | Method |
|-------|-------|--------|
| L1: Exists | File/function exists | Glob/Grep |
| L2: Substantive | Real code, not stub | Read + analyze |
| L3: Wired | Integrated into system | Trace imports/calls |
| L4: Tested | Has passing tests | Run tests |

Default: L1-L3 (L4 optional, can be slow)

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

done-upload.md: 4/4 reqs ✓, 5/5 acceptance ✓, clean
done-auth.md: 2/2 reqs ✓, 3/3 acceptance ✓, clean

✓ All specs verified

✓ Merged df/upload to main
✓ Cleaned up worktree and branch

Learnings captured:
  → experiments/perf--streaming-upload--success.md
```

### Issues found → fix tasks added
```
/df:verify --doing

doing-upload.md: 4/4 reqs ✓, 3/5 acceptance ✗, 1 quality issue

Issues:
  ✗ AC-3: YAML parsing missing for consolation
  ⚠ Quality: TODO in parse_config()

Fix tasks added to PLAN.md:
  T10: Add YAML parsing for consolation section
  T11: Remove TODO in parse_config()

Run /df:execute --continue to fix in the same worktree.
```

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL specs pass verification.** If issues were found, fix tasks were added to PLAN.md instead (see step 3).

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
