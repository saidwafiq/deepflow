---
name: df:execute
description: Execute curated tasks from spec serially in the main thread (v2)
allowed-tools: [Bash, Read, Edit, Write, Glob, Grep, TaskCreate, TaskUpdate, TaskList]
---

# /df:execute — Implement tasks from a curated spec, serially

## Role

You are the implementer. There is no orchestrator role, no sub-agents, no shared worktree. You work in-place on the current git branch, one task at a time, in dependency order.

## Behavior

### 1. Select spec

Inventory `specs/`:

```bash
DOING=$(ls specs/doing-*.md 2>/dev/null)
PLANNED=$(ls specs/*.md 2>/dev/null | grep -vE '/(doing-|done-|_|\.)' || true)
```

Selection rules (in order):

1. **Explicit start** — `/df:execute {spec-name}` matches `specs/{spec-name}.md` (planned). Rename to `specs/doing-{spec-name}.md` and proceed. If `{spec-name}` is already `doing-*`, resume. If neither exists, exit 1.
2. **At least one `doing-*.md` exists** — proceed.
3. **No `doing-*.md`, one planned spec** — TTY: prompt `Start specs/{name}.md? [Y/n]`. Default Y → rename → proceed. Non-TTY → exit 1 with hint.
4. **No `doing-*.md`, multiple planned** — TTY: prompt to pick one. Non-TTY → exit 1.
5. **None of the above** — exit 1: `no specs to execute. Author one with /df:spec.`

Rename uses `git mv` when tracked, plain `mv` otherwise.

### 2. Validate curated section

Each `specs/doing-*.md` MUST contain a `## Tasks (curated)` section. Missing → hard error:

```
✗ ERROR: specs/doing-{name}.md has no '## Tasks (curated)' section.
  Run /df:spec --upgrade specs/doing-{name}.md, then re-run /df:execute.
```

Exit 1.

### 3. Parse curated tasks

Read every `specs/doing-*.md`. From the `## Tasks (curated)` section, extract each `### T<n>: <title>` block. Fields per task:

- `**Slice:**` — files this task may touch
- `**Parallel:**` — `[P]` (no dependencies) or `Blocked by: T<a>, T<b>`
- `**Task description:**` — what to implement (or any free-form description block)
- Optional title markers: `[SPIKE]`, `[INTEGRATION]`, `[TEST]`, `[OPTIMIZE]` — advisory hints about task nature; do not change execution mechanics

Build dependency ordering. Topologically sort tasks: any `Blocked by: T<x>` must come after `T<x>`. Within an unblocked group, order by task number.

**No parallelism.** Even tasks marked `[P]` run sequentially in v2.

Create tracking tasks via `TaskCreate` (one per spec task) so the user sees progress.

### 4. Execute tasks one at a time

For each task `T<n>` in dependency order:

1. `TaskUpdate(status: "in_progress")` for this task.
2. **Record baseline:**
   ```bash
   git rev-parse HEAD > /tmp/df-exec-baseline-T<n>
   ```
3. **Refresh ratchet snapshot** (pre-existing test files, so this task's own tests don't count as "passing what was already passing"):
   ```bash
   git ls-files | grep -E '\.(test|spec)\.[^/]+$|^test_|_test\.[^/]+$|^tests/|__tests__/' \
     > .deepflow/auto-snapshot.txt
   ```
4. **Implement the task** directly using your available tools (Read, Edit, Write, Bash, Glob, Grep). The `**Slice:**` field tells you which files are in scope. Stay within slice unless you discover a genuine blocker (see §5).
5. **Run ratchet check** — pre-existing tests must still pass:
   ```bash
   node ~/.claude/bin/ratchet.js --snapshot .deepflow/auto-snapshot.txt --task T<n>
   ```
   - Exit 0: pass → step 6.
   - Exit 1: regression → revert (see §6).
   - Exit 2: salvageable → attempt one fix in-line, then re-run ratchet. Still failing → revert.
6. **Atomic commit** (via `atomic-commits` skill conventions):
   ```
   {type}({scope}): {description}

   T<n> from specs/doing-{spec}.md

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```
   `type` ∈ {feat, fix, refactor, test, docs}, picked by content of the change.
7. **AC coverage check** (only relevant if the task added/modified tests):
   ```bash
   node ~/.claude/hooks/ac-coverage.js --spec specs/doing-{name}.md --snapshot .deepflow/auto-snapshot.txt --status pass
   ```
   Exit 2 → log untagged ACs to user, do NOT revert (advisory).
8. **Extract decisions** — if your reasoning during this task included an architectural decision worth recording, append to `.deepflow/decisions.md` per `df-decisions` skill conventions: `[TAG] description — rationale` where TAG ∈ {APPROACH, PROVISIONAL, ASSUMPTION, FUTURE, UPDATE}.
9. `TaskUpdate(status: "completed")`.
10. Report one line: `✓ T<n>: {short summary} ({short_sha})`

Continue to next task. **End-turn between tasks is optional** — the whole spec runs in one conversation.

### 5. Escape hatch: missing context

If you discover you genuinely cannot complete a task because the spec lacks information about a file/system you need to touch (and the file is outside `**Slice:**`):

1. Read the file you need.
2. Append a brief note to the spec's task entry under a new `**Discovered context:**` field via `Edit`.
3. Continue implementing.

This is not a failure — it's the curator gap being filled by your direct knowledge. Spec format evolves with use.

If you discover a task is genuinely impossible (missing infrastructure, conflicting requirement, broken dependency), halt the task chain:
- `TaskUpdate(status: "pending")` for the current task
- Report: `✗ T<n>: blocked — {explanation}`
- Do NOT proceed to dependent tasks
- Exit normally (user picks up the diagnostic)

### 6. Revert on regression

`ratchet.js` exit 1 (FAIL) auto-reverts via `git revert HEAD --no-edit` before exiting — your atomic commit T<n> stays in history, followed by a "Revert T<n>" commit, and the working tree is back to baseline. No additional revert needed.

After ratchet auto-revert:
- `TaskUpdate(status: "pending")` for T<n>.
- Continue with non-dependent tasks. Tasks `Blocked by: T<n>` are skipped (left pending).
- Add T<n> to `tasks_reverted` array for the spec's outcome.json.

If you ever need to undo something ratchet didn't catch (e.g. you partially edited then aborted before commit), use the saved baseline:

```bash
git reset --hard $(cat /tmp/df-exec-baseline-T<n>)
```

### 7. Spec completion

When all tasks are processed (completed, reverted-pending, or skipped due to blocked-by):

1. **Locate or create the outcome directory.** The directory name uses the date of the **first** `/df:execute` attempt for this spec, not today's date:
   ```bash
   OUTCOME_DIR=$(ls -d .deepflow/spec-outcomes/*-{spec} 2>/dev/null | head -1)
   if [ -z "$OUTCOME_DIR" ]; then
     OUTCOME_DIR=".deepflow/spec-outcomes/$(date +%Y-%m-%d)-{spec}"
   fi
   mkdir -p "$OUTCOME_DIR/attempts"
   ```

2. **Determine the next attempt number:**
   ```bash
   N=$(ls "$OUTCOME_DIR/attempts/" 2>/dev/null | wc -l | tr -d ' ')
   NEXT=$(printf '%02d' $((N + 1)))
   ```

3. **Write this attempt** to `$OUTCOME_DIR/attempts/{NEXT}.json`:
   ```json
   {
     "attempt_n": 1,
     "spec_id": "{spec-name}",
     "started_at": "{ISO-8601 — when /df:execute began this run}",
     "completed_at": "{ISO-8601 — now}",
     "tasks_total": N,
     "tasks_completed": M,
     "tasks_reverted": [...],
     "tasks_blocked": [...],
     "merged": false,
     "branch": "{current-branch-name}",
     "trigger": "fresh|continue|manual-rerun"
   }
   ```
   `trigger` distinguishes how this attempt started: `fresh` = first attempt or invoked with `--fresh`; `continue` = `--continue` resumed a previous attempt; `manual-rerun` = invoked again on an existing `doing-*.md` without `--fresh`.

4. **Update `aggregate.json` roll-up** at `$OUTCOME_DIR/aggregate.json` after every attempt:
   ```json
   {
     "spec_id": "{spec-name}",
     "first_attempt_at": "{from attempts/01.json.started_at}",
     "last_attempt_at": "{this attempt's completed_at}",
     "total_attempts": N,
     "final_status": "in-progress",
     "merged_at": null,
     "tasks_total": N,
     "tasks_completed_best": "max across all attempts",
     "tasks_reverted_total": "sum of reverts across attempts",
     "branches_used": ["unique branch names across attempts"]
   }
   ```
   `final_status` stays `in-progress` until `/df:verify` confirms the spec landed (then `merged`) or the user abandons the spec (then `abandoned`).

5. **Auto-verify** (only if at least one task completed in this attempt):
   ```
   /df:verify doing-{name} --from-execute
   ```
   If verify passes and renames `doing-` → `done-`, update `aggregate.json`:
   - `final_status: "merged"`
   - `merged_at: <ISO-8601>`

6. **Final report**:
   ```
   Attempt {NEXT}: {M}/{T} tasks completed. {len(reverted)} reverted, {len(blocked)} blocked.
   Outcome:   $OUTCOME_DIR/attempts/{NEXT}.json
   Aggregate: $OUTCOME_DIR/aggregate.json (total_attempts: N, final_status: ...)
   ```

**Why per-attempt instead of single outcome.json:** PR-style iteration carries signal — if a spec needed 3 attempts to land cleanly, that is diagnostic data Mode B's proposer should see. Single overwrite loses it. Each `attempts/NN.json` is immutable after write; `aggregate.json` is the only roll-up that re-derives on each run.

## Usage

```
/df:execute                    # Auto: pick or resume a doing- spec
/df:execute {spec-name}        # Start specs/{spec-name}.md (renames to doing-)
/df:execute T1 T2              # Only specific tasks within active doing-*
/df:execute --dry-run          # Print plan, do nothing
```

## Skills

`atomic-commits` (commit format), `df-decisions` (decision log conventions), `df-ac-coverage` (AC tagging in tests).

## Rules

| Rule | Detail |
|------|--------|
| Serial only | One task at a time, in dependency order |
| In-place | Current branch, no worktree, no sub-agents |
| 1 task = 1 commit | Atomic, revertable |
| Ratchet judges | Pre-existing tests must still pass |
| No LLM judge | Build/test exit codes only |
| Outcome logged | `.deepflow/spec-outcomes/` on every run (feeds future Mode B) |
| Auto-verify | After all tasks, invoke `/df:verify` once |
| Halt on hard block | Genuine blocker stops the chain; dependents stay pending |
