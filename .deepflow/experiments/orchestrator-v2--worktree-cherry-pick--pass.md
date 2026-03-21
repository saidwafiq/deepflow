# Spike: Worktree Cherry-Pick Merge-Back

**Hypothesis:** `isolation: "worktree"` agents can cherry-pick their commits back to the shared worktree reliably when tasks modify different files within the same package.

**Status:** PASS

## Method

Created a throwaway git repo with a package containing 3 files. Simulated intra-wave parallel tasks using `git worktree`, then cherry-picked commits back to the main branch sequentially. Three phases tested:

1. **Non-overlapping files** — 3 tasks each modify a different file in the same package
2. **Overlapping same line** — 2 tasks modify the same line in the same file
3. **Same file, non-overlapping regions** — 2 tasks modify different regions of the same file

## Results

| Phase | Scenario | Result |
|-------|----------|--------|
| 1 | Different files, same package | PASS — all 3 cherry-picks succeeded cleanly |
| 2 | Same file, same line | PASS — conflict detected, `git cherry-pick` exits non-zero |
| 3 | Same file, different regions | PASS — git auto-merged cleanly |

## Key Findings

1. **Cherry-pick is reliable for non-overlapping changes.** Sequential cherry-pick of commits touching different files always succeeds. This is the expected case for well-planned intra-wave tasks.

2. **Conflict detection works out of the box.** When two tasks touch the same line, `git cherry-pick` exits with a non-zero status and reports `CONFLICT`. The orchestrator can catch this with a simple exit-code check — no special tooling needed.

3. **Git's 3-way merge handles same-file, different-region edits.** Even when two tasks modify the same file, if the changes are in different regions (separated by >=3 unchanged context lines), cherry-pick auto-merges successfully. This is a bonus — the orchestrator doesn't need to restrict parallelism to file-level granularity.

4. **Cherry-pick order doesn't matter for non-overlapping changes.** Since each commit is independent (branched from the same base), the order of cherry-picking is irrelevant when files don't overlap.

## Implications for Orchestrator V2

- **Wave-level parallelism is safe** when tasks modify different files (the common case for well-scoped tasks).
- **Conflict recovery strategy:** On cherry-pick failure, the orchestrator should: (a) abort the cherry-pick, (b) mark the conflicting task as failed, (c) continue with remaining tasks, (d) retry the failed task after the wave completes (it will see the merged state).
- **No need for file-locking** — git's merge machinery handles detection automatically.
- **Task scoping in /df:plan matters:** The planner should ensure intra-wave tasks target different files. The `scope.files` field in PLAN.md tasks already supports this constraint.
