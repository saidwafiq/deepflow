# T45 Spike: xargs test invocation + worktree path resolution

## Result: PASS

## Node.js (`node --test`) — CONFIRMED WORKING

This project has **no `npm test` script**. The correct runner is `node --test`.

`node --test` accepts multiple file paths as positional arguments:
```bash
node --test test/auto-verify.test.js test/plan-cleanup.test.js  # works
node --test bin/install.test.js test/*.test.js                  # works — 262 tests pass
```

xargs equivalent:
```bash
xargs node --test < /path/to/auto-snapshot.txt  # works — positional args = file paths
```

## Python (`pytest`) — CONFIRMED by design

pytest accepts file paths as positional args:
```bash
xargs pytest < snapshot.txt  # works — pytest's CLI is positional-file-path based
```

## Worktree path resolution — SOLVED

`auto-snapshot.txt` is in the **main repo's** `.deepflow/`, not the worktree's.

Worktree's `.deepflow/` contains: `context.json`, `experiments/`, `results/`, `token-history.jsonl` — no snapshot.

**Canonical resolution from any worktree:**
```bash
MAIN_REPO=$(dirname $(git rev-parse --git-common-dir))
SNAPSHOT="$MAIN_REPO/.deepflow/auto-snapshot.txt"
```

`git rev-parse --git-common-dir` returns `/main-repo/.git` from any worktree.

**auto-snapshot.txt stores relative paths** — must be absolutized when running from a worktree:
```bash
MAIN_REPO=$(dirname $(git rev-parse --git-common-dir))
SNAPSHOT="$MAIN_REPO/.deepflow/auto-snapshot.txt"
# Absolutize and run:
node --test $(sed "s|^|$MAIN_REPO/|" "$SNAPSHOT" | tr '\n' ' ')
```

## Summary table

| Runner        | Accepts file list | xargs OK | Notes |
|---------------|------------------|----------|-------|
| `node --test` | YES              | YES      | Use directly; no npm test script |
| `pytest`      | YES              | YES      | Positional args = file paths |
| `go test`     | NO               | NO       | Uses package paths, not file paths |

## Key decisions for ratchet implementation

1. Use `node --test` (not `npm test`) for this project
2. Snapshot path = `$(dirname $(git rev-parse --git-common-dir))/.deepflow/auto-snapshot.txt`
3. Prepend main repo root to relative snapshot paths before invoking runner
4. Go requires different approach (package paths, not file paths)
