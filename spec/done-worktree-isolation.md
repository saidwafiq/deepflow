# Worktree Isolation

## Objective
Isolate all `/df:execute` work in a git worktree so main directory stays untouched and failed plans can be discarded instantly.

## Requirements
- REQ-1: `/df:execute` creates a git worktree before spawning any agents
- REQ-2: Worktree branch follows pattern `df/{spec-name}` (e.g., `df/upload`)
- REQ-3: All spawned agents receive worktree path as working directory in their prompts
- REQ-4: Main directory remains unchanged during execution (no uncommitted changes, no new files)
- REQ-5: After successful `/df:verify`, worktree branch is merged to main automatically
- REQ-6: After successful merge, worktree directory and branch are removed
- REQ-7: Failed execution leaves worktree intact for debugging with cleanup instructions
- REQ-8: Checkpoint file stored in worktree, not main
- REQ-9: Result files written to worktree directory

## Constraints
- Agents prohibited from running git (except status) - worktree operations happen in orchestrator only
- Task tool uses `run_in_background: true` - cannot pass cwd, must embed path in prompt
- Checkpoint system must survive context boundaries - worktree path stored in checkpoint

## Out of Scope
- `/df:plan` isolation (runs in main, only generates PLAN.md)
- Per-spec worktrees (single worktree for entire execution batch)
- Manual merge option (always auto-merge on success)

## Acceptance Criteria
- [ ] Running `/df:execute` creates worktree at `.deepflow/worktrees/{spec}`
- [ ] `git status` in main shows clean during and after execution
- [ ] Agent prompts contain explicit worktree path
- [ ] All commits appear on worktree branch, not main
- [ ] Successful `/df:verify` merges worktree to main and cleans up
- [ ] Failed execution preserves worktree with cleanup instructions
- [ ] Dirty main branch blocks execution with clear error
- [ ] Merge conflicts preserve worktree and report resolution path
- [ ] `--continue` resumes in same worktree from checkpoint

## Technical Notes

**Integration points:**
- `execute.md`: Add worktree creation before agent spawn, modify prompts to include path
- `verify.md`: Add merge step after successful verification, add cleanup step
- `config-template.yaml`: Add `worktree:` section
- `checkpoint.json`: Add `worktree_path` field, move to worktree directory

**Edge cases:**
- Existing worktree for same spec: Prompt resume/delete/abort
- Dirty main: Fail with "commit or stash" message
- Merge conflicts: Keep worktree, report manual resolution path
- Checkpoint references deleted worktree: Fail with `--fresh` suggestion

**Config schema:**
```yaml
worktree:
  enabled: true
  base_path: .deepflow/worktrees
  branch_prefix: df/
  cleanup_on_success: true
  cleanup_on_fail: false
```

**Worktree commands:**
```bash
# Create
git worktree add -b df/upload .deepflow/worktrees/upload

# Merge (from main)
git merge df/upload

# Cleanup
git worktree remove .deepflow/worktrees/upload
git branch -d df/upload
```
