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
| `spec-outcomes/{date}-{spec}/outcome.json` | `/df:execute` v2 | `{tasks_total, tasks_completed, tasks_reverted, tasks_blocked, merged, branch}` |

## Stability

Until Mode B is in production, this schema is the contract. **Adding fields is fine** (proposers should ignore unknown fields). **Removing or renaming fields requires version bump** in `result.json.schema_version` (not yet present; introduce when first breaking change ships).

## Why traces, not summaries

The Meta-Harness paper's ablation (Table 3) tested three feedback regimes:
- Scores only: 34.6 / 41.3 median/best accuracy
- Scores + LLM summary: 34.9 / 38.7 (summary HURT performance)
- Full traces + scores + execution logs: **50.0 / 56.7**

Compression destroys diagnostic signal. The proposer needs raw failure context to form causal hypotheses about what to change in the harness. Hence: no summarization in this pipeline, only structured-but-faithful records.
