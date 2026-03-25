---
name: df:eval
description: Evaluate a skill or command against a benchmark suite, or scaffold a new benchmark directory
allowed-tools: [Read, Bash, Write, Glob, Grep]
---

# /df:eval — Skill Evaluation

Run a benchmark suite against a skill/command, or scaffold a new benchmark directory.

## Usage

```
/df:eval --scaffold benchmarks/<name>/                        # Create benchmark directory structure
/df:eval benchmarks/<name>/                                   # Run benchmark suite (reads hypotheses.md)
/df:eval benchmarks/<name>/ --hypothesis "reduce token use"   # Override hypothesis explicitly
```

## Subcommands

### `--scaffold <target-dir>`

Creates a benchmark directory from the fixture template at `templates/eval-fixture-template/`.

**What gets created:**

```
<target-dir>/
  fixture/          # Minimal repo fixture (hooks, specs, src, package.json)
  tests/            # Behavior and guard test files
  spec.md           # Benchmark objective and acceptance criteria
  config.yaml       # Benchmark configuration (skill under test, thresholds)
  hypotheses.md     # Hypotheses to validate
```

**Steps:**

1. Validate `<target-dir>` argument is provided; abort with usage hint if missing.
2. Check `<target-dir>` does not already exist; abort with error if it does.
3. Copy `templates/eval-fixture-template/` recursively to `<target-dir>`.
4. Confirm with summary:

```
Created benchmark scaffold at <target-dir>/
  fixture/    - minimal repo fixture
  tests/      - behavior.test.js, guard.test.js
  spec.md     - edit to define benchmark objective
  config.yaml - edit to set skill under test and thresholds
  hypotheses.md - edit to define hypotheses

Next: edit spec.md and config.yaml, then run /df:eval <target-dir>/
```

**Implementation:**

```bash
# Parse --scaffold flag and target dir from $ARGUMENTS
# e.g. /df:eval --scaffold benchmarks/my-bench/
ARGS="$ARGUMENTS"
TARGET=$(echo "$ARGS" | sed 's/--scaffold[[:space:]]*//')
TEMPLATE="templates/eval-fixture-template"

if [ -z "$TARGET" ]; then
  echo "Error: target directory required. Usage: /df:eval --scaffold benchmarks/<name>/"
  exit 1
fi

if [ -d "$TARGET" ]; then
  echo "Error: $TARGET already exists."
  exit 1
fi

cp -r "$TEMPLATE/" "$TARGET"
echo "Created benchmark scaffold at $TARGET"
```

### `--hypothesis <text>`

Overrides the mutation hypothesis for the eval session. Without this flag the
loop reads `{benchDir}/hypotheses.md` and uses the first list item it finds.

**Hypothesis resolution order:**

1. `--hypothesis "<text>"` flag value — used as-is.
2. `{benchDir}/hypotheses.md` first list item (ordered or unordered markdown list).
3. Error if neither source is available.

**Module:** `src/eval/hypothesis.js` — `loadHypothesis({ flag, benchDir })`

---

## Main Eval Loop (T9 — implemented)

Running `/df:eval benchmarks/<name>/` without `--scaffold` runs the Karpathy loop:

1. Load `benchmarks/<name>/config.yaml` — skill under test, thresholds, iteration count
2. Resolve hypothesis via `--hypothesis` flag or `benchmarks/<name>/hypotheses.md` (first list item)
3. Create a worktree-isolated branch for the session (`eval/<skill>/<timestamp>`)
4. **Loop** (until Ctrl+C or `--loop N`):
   a. Mutate skill file via agent prompt built from current content + history
   b. Commit experiment (`status:pending`)
   c. Run guard check (build + test commands from config)
      - Guard fail → `git revert`, log `status:guard_fail`, next iteration
   d. Collect metrics from `.deepflow/` JSONL files
   e. Compare target metric against baseline
      - Improved → log `status:kept`, update baseline
      - Regression → `git revert`, log `status:reverted`
   f. Record secondary metrics in commit message (never influence keep/revert)

**Implementation:** `src/eval/loop.js` (`runEvalLoop`), `src/eval/hypothesis.js` (`loadHypothesis`)

## Rules

- `--scaffold` never overwrites an existing directory
- Template is always copied from `templates/eval-fixture-template/`
- Main eval loop is non-deterministic by design — it samples skill behavior across N runs
- No LLM judges another LLM — only objective metrics (file diffs, test results, token counts) are used
