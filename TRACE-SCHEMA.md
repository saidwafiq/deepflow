# Trace Schema (v2 → Mode B contract)

Documents the on-disk format of evaluation artifacts produced by `tools/eval-runner.js`. This is the **frozen contract** that Meta-Harness (Mode B) will consume — the proposer reads these files via `grep`/`cat` to learn from prior candidates.

> Inspired by Lee et al. 2026, *Meta-Harness*: the proposer's access to raw execution traces (not summaries) is the primary lever. Section 4.1, Table 3: full-trace condition outperforms scores-only by +15 pp accuracy.

## Directory layout per evaluation run

```
~/meta-harness/runs/{run-id}/
├── scoreboard.json                        # aggregate across all evaluated specs
└── evals/
    └── {spec-slug}/
        ├── workdir/                       # the actual git tree where /df:execute ran
        │   ├── .claude/                   # installed harness (commands, skills)
        │   ├── .deepflow/                 # state during execution
        │   │   ├── auto-snapshot.txt      # baseline ratchet
        │   │   ├── bash-telemetry.jsonl   # every bash command, normalized
        │   │   ├── events.jsonl           # spec/tool events
        │   │   ├── token-history.jsonl    # per-call token usage
        │   │   └── spec-outcomes/         # outcome.json from /df:execute
        │   └── specs/doing-{slug}.md      # the task spec
        ├── trace.txt                      # captured stdout/stderr of `claude -p`
        ├── diff.patch                     # `git diff baseline..HEAD` after Claude exits
        └── result.json                    # structured reward + metadata
```

## `result.json` schema

One per (run-id, spec) pair.

```json
{
  "slug": "ci-lint-fix",
  "run_id": "2026-05-11T18-46-00",
  "started_at": "2026-05-11T18:47:03.142Z",
  "completed_at": "2026-05-11T18:51:28.901Z",
  "wall_seconds": 265,

  "exit_code": 0,
  "signal": null,
  "error": null,

  "stdout_bytes": 14829,
  "stderr_bytes": 312,

  "files_changed": 13,
  "diff_stat": "13 files changed, 139 insertions(+), 43 deletions(-)",

  "reward": {
    "build_passed": true,
    "lint_passed": true,
    "tests_passed": true,
    "tests_failed_count": 0,
    "ac_coverage_pct": null,
    "notes": []
  },

  "harness_path": "/Users/saidsalles/apps/agentSkills/deepflow",
  "timeout_seconds": 1800
}
```

### Field semantics

| Field | Type | Notes |
|---|---|---|
| `slug` | string | Matches `corpus/{slug}/` |
| `wall_seconds` | int | Real-time from claude spawn to exit |
| `exit_code` | int | `0` = clean exit, `-1` = process error, other = Claude's own exit |
| `signal` | string \| null | e.g. `"SIGKILL"` when timed out |
| `files_changed` | int | Distinct files in diff vs. baseline |
| `reward.build_passed` | bool \| null | `null` when reward_spec has no build command |
| `reward.tests_passed` | bool \| null | Pass-all-or-fail, not partial |
| `reward.ac_coverage_pct` | float \| null | Reserved; computed by future ac-coverage scan |
| `reward.notes` | string[] | Human-readable diagnostics; not parsed |

## `scoreboard.json` schema

One per run. Aggregates per-spec results.

```json
{
  "run_id": "2026-05-11T18-46-00",
  "harness": "/Users/saidsalles/apps/agentSkills/deepflow",
  "completed_at": "2026-05-11T22:31:14.001Z",
  "n_specs": 12,
  "results": [
    { /* result.json entries, inlined */ }
  ]
}
```

## `trace.txt`

Raw stdout/stderr from `claude -p`. Mode B's proposer reads this verbatim — it contains the implementer's natural-language reasoning, tool calls, and any error chatter. **Do not transform.**

Approximate size: tens to hundreds of KB per task. The Meta-Harness paper notes the proposer reads ~82 files/iteration including traces.

## `diff.patch`

Output of `git diff {initial-baseline-commit}..HEAD` after Claude finishes. Includes every change the harness produced across all tasks in the spec. **Single source of truth for what the harness did.**

## In-workdir observability (`workdir/.deepflow/*.jsonl`)

These are written by the surviving v2 hooks during execution. They survive even if Claude is killed (timeout), giving partial visibility into long-running evals.

| File | Writer | Use |
|---|---|---|
| `bash-telemetry.jsonl` | `df-bash-telemetry.js` | Every bash command pattern, exit code, follow-up timing |
| `events.jsonl` | `spec-transition.js`, `df-statusline.js` | Spec lifecycle + tool usage events |
| `token-history.jsonl` | `df-statusline.js` | Per-call input/cache/output tokens, context window % |
| `spec-outcomes/{date}-{spec}/attempts/NN.json` | `/df:execute` v2 | Per-attempt record (see below) |
| `spec-outcomes/{date}-{spec}/aggregate.json` | `/df:execute` v2 | Roll-up across attempts, updated on every run |

### `attempts/NN.json` schema

One file per `/df:execute` invocation against the spec. Immutable after write. `NN` is zero-padded sequence (`01.json`, `02.json`, …).

```json
{
  "attempt_n": 2,
  "spec_id": "crash-bonus-simulator",
  "started_at": "2026-05-12T00:11:04.123Z",
  "completed_at": "2026-05-12T01:15:42.901Z",
  "tasks_total": 9,
  "tasks_completed": 9,
  "tasks_reverted": [],
  "tasks_blocked": [],
  "merged": false,
  "branch": "main",
  "trigger": "fresh"
}
```

`trigger` ∈ `{fresh, continue, manual-rerun}`.

### `aggregate.json` schema

Single file per spec, re-derived after every attempt. Mutable.

```json
{
  "spec_id": "crash-bonus-simulator",
  "first_attempt_at": "2026-05-12T00:11:04.123Z",
  "last_attempt_at": "2026-05-12T01:15:42.901Z",
  "total_attempts": 2,
  "final_status": "merged",
  "merged_at": "2026-05-12T01:15:50.000Z",
  "tasks_total": 9,
  "tasks_completed_best": 9,
  "tasks_reverted_total": 0,
  "branches_used": ["main"]
}
```

`final_status` ∈ `{in-progress, merged, abandoned}`. Promoted to `merged` by `/df:verify` when `doing-` → `done-` rename succeeds.

### Why per-attempt instead of single outcome

Single-shot `outcome.json` (pre-A6) overwrites on re-run, losing the journey. Multi-attempt captures the PR-style iteration signal: a spec needing 3 attempts to land is qualitatively different from one that lands first-try, and Mode B's proposer should see that. The schema is additive — adding `attempts/` directory does not break any consumer that only reads `aggregate.json`.

## Corpus-side: `pr_journey.json`

Built by `tools/harvest-pr-journey.js` from the source repo's git history (not by `eval-runner`). One per corpus spec at `corpus/{slug}/pr_journey.json`. Captures the **human journey to merge** for the ground-truth commit — Mode B's proposer reads this to learn iteration patterns.

```json
{
  "spec_id": "provably-fair-envelope",
  "merge_sha": "49eb010e44bd8d90e7703ffdf28a0a75245d94b1",
  "merge_type": "merge_commit",
  "first_commit_at": "2026-04-21T02:18:33Z",
  "merged_at": "2026-04-21T21:57:21Z",
  "wall_seconds": 70734,
  "commits_count": 63,
  "commits_by_type": {
    "feat": 38, "fix": 9, "test": 4, "chore": 3, "spike": 6, "docs": 2, "style": 1
  },
  "revert_count": 0,
  "commits": [
    { "sha": "abc123", "date": "2026-04-21T02:18:33Z", "type": "feat", "scope": "engine", "subject": "feat(engine): scaffold envelope module" },
    ...
  ],
  "github_pr": null
}
```

`merge_type` ∈ `{merge_commit, fast_forward_or_squash}`. When the spec was merged via a real GitHub PR, `github_pr` carries the augmentation:

```json
"github_pr": {
  "number": 42,
  "state": "MERGED",
  "title": "feat(rewards-ui): ...",
  "commits_count": 8,
  "comment_count": 3,
  "review_comment_count": 5,
  "force_push_count": 2,
  "failed_check_runs": [
    { "name": "lint", "conclusion": "failure" },
    { "name": "go-test", "conclusion": "failure" }
  ]
}
```

For most local-merge workflows (e.g. bingo-rgs), `github_pr` is `null` and the commit walk in `commits[]` is the primary journey signal.

## Stability

Until Mode B is in production, this schema is the contract. **Adding fields is fine** (proposers should ignore unknown fields). **Removing or renaming fields requires version bump** in `result.json.schema_version` (not yet present; introduce when first breaking change ships).

## Why traces, not summaries

The Meta-Harness paper's ablation (Table 3) tested three feedback regimes:
- Scores only: 34.6 / 41.3 median/best accuracy
- Scores + LLM summary: 34.9 / 38.7 (summary HURT performance)
- Full traces + scores + execution logs: **50.0 / 56.7**

Compression destroys diagnostic signal. The proposer needs raw failure context to form causal hypotheses about what to change in the harness. Hence: no summarization in this pipeline, only structured-but-faithful records.
