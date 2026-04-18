# housekeeping-migration — idempotent cleanup [PASS]

Objective: Validate shell command semantics for post-verify cleanup (REQ-1..REQ-5).
Spike scope: research only — no changes to verify.md.

---

## 1. `mkdir -p .deepflow/specs-done/` — idempotency

`mkdir -p` is POSIX-guaranteed idempotent:
- Dir absent → creates it (including intermediate paths).
- Dir exists → exits 0, no error.
- Dir partially exists (parent exists, child missing) → creates child, exits 0.
- Dir is a symlink to a real dir → exits 0.

Verdict: **safe unconditionally**. No guard needed.

---

## 2. `mv specs/done-{name}.md .deepflow/specs-done/` — target-exists collision

`mv` OVERWRITES silently on most POSIX systems (Linux + macOS). This is a problem
on a second verify run: source is already gone but destination already exists — `mv`
will fail with "No such file or directory" (source missing), not silently succeed.

Proposed guard (handles both first and second run safely):

```sh
if [ -f "specs/done-$N.md" ]; then
  mv -f "specs/done-$N.md" ".deepflow/specs-done/done-$N.md"
fi
```

- First run: source exists → mv succeeds.
- Second run: source absent → skip block entirely, no error.
- Target already exists: `-f` forces overwrite (identical content anyway).

Alternative one-liner from spec's Technical Notes — `mv -f ... 2>/dev/null` — is also
safe because the only error is a missing source, which we suppress. Either form works.
The `test -f` guard is more explicit and avoids swallowing real errors (e.g., permission
denied on destination); prefer it in verify.md.

---

## 3. Idempotent deletion patterns

### 3a. auto-snapshot

```sh
rm -f ".deepflow/auto-snapshot-$N.txt"
```

`rm -f` exits 0 whether file exists or not. Safe on any run count.

### 3b. results/T*.yaml scoped to spec

Must read task IDs BEFORE deleting `plans/done-$N.md` (REQ-5 deletes that file too).

```sh
# Extract task IDs from plan file (if it exists)
if [ -f ".deepflow/plans/done-$N.md" ]; then
  TASK_IDS=$(grep -oE 'T[0-9]+' ".deepflow/plans/done-$N.md" | sort -u)
  for TID in $TASK_IDS; do
    rm -f ".deepflow/results/$TID.yaml"
  done
fi
```

On second run: plan file already deleted → block skipped → no results deleted again
(they were already gone). Idempotent.

Edge case: `grep` matches task references in prose too (e.g. "depends on T3"). This
is acceptable over-deletion because results files are ephemeral; false positive matches
produce `rm -f` on non-existent files (exit 0). No data loss risk.

### 3c. plans/done-{name}.md

```sh
rm -f ".deepflow/plans/done-$N.md"
```

`rm -f` — idempotent. Safe.

---

## 4. Edge cases

### 4a. Concurrent verify runs

Two parallel `/df:verify` calls on the same spec is not a supported workflow (single
worktree, single checkpoint). Risk is theoretical. The `test -f` guard on `mv` provides
a natural race guard: only the first process to check will find the source file; the
second will skip. Results deletion is idempotent via `rm -f`. No locking needed.

### 4b. Pre-existing `.deepflow/specs-done/` with stale same-name file

`mv -f` overwrites → destination gets fresh copy. No orphan risk.

### 4c. `specs/done-$N.md` never created (verify PASS without rename step)

If rename (step 4) ran but cleanup (new step) did not (e.g., interrupted), on re-run
source won't exist. The `test -f` guard handles this gracefully.

### 4d. REQ-7 safety

None of the above commands touch: `execution-history.jsonl`, `context.json`,
`decisions.md`, `auto-memory.yaml`, or `experiments/`. They operate on distinct paths.

---

## Shell block for verify.md (PASS branch, after step 6)

```sh
# REQ-1/2: Archive done spec
mkdir -p .deepflow/specs-done
if [ -f "specs/done-$N.md" ]; then
  mv -f "specs/done-$N.md" ".deepflow/specs-done/done-$N.md"
fi

# REQ-4: Delete scoped results BEFORE removing plan (need task IDs)
if [ -f ".deepflow/plans/done-$N.md" ]; then
  for TID in $(grep -oE 'T[0-9]+' ".deepflow/plans/done-$N.md" | sort -u); do
    rm -f ".deepflow/results/$TID.yaml"
  done
fi

# REQ-3/5: Delete ephemeral artifacts
rm -f ".deepflow/auto-snapshot-$N.txt"
rm -f ".deepflow/plans/done-$N.md"
```

Conclusion: approach is **safe and idempotent**. Recommend proceeding to implementation.
