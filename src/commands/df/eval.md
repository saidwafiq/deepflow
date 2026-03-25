---
name: df:eval
description: Evaluate a skill or command against a benchmark suite, or scaffold a new benchmark directory
allowed-tools: [Read, Bash, Write, Glob, Grep]
---

# /df:eval — Skill Evaluation

Run a benchmark suite against a skill/command, or scaffold a new benchmark directory.

## Usage

```
/df:eval --scaffold benchmarks/<name>/   # Create benchmark directory structure
/df:eval benchmarks/<name>/              # Run benchmark suite (wired in T9)
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

---

## Main Eval Loop (T9 — not yet implemented)

Running `/df:eval benchmarks/<name>/` without `--scaffold` will:

1. Load `benchmarks/<name>/config.yaml` — skill under test, thresholds, iteration count
2. Load `benchmarks/<name>/spec.md` — acceptance criteria to measure against
3. Run the skill N times against `benchmarks/<name>/fixture/`
4. Score each run against the ACs
5. Aggregate pass rate, latency, token cost
6. Report results with pass/fail verdict against configured thresholds

**Placeholder — implementation pending T9.**

## Rules

- `--scaffold` never overwrites an existing directory
- Template is always copied from `templates/eval-fixture-template/`
- Main eval loop is non-deterministic by design — it samples skill behavior across N runs
- No LLM judges another LLM — only objective metrics (file diffs, test results, token counts) are used
