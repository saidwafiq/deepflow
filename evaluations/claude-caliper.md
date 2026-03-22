# Evaluation: claude-caliper

**Repository:** https://github.com/nikhilsitaram/claude-caliper
**Evaluated:** 2026-03-22
**Version:** 1.9.5 (29 commits, 78 merged PRs)

## Summary

claude-caliper is a Claude Code plugin that automates the feature development lifecycle — from design through PR merge — using a 10-skill pipeline with the motto "Measure twice, cut once." It chains design, review, planning, execution, and shipping into a mostly-autonomous workflow requiring only two human decisions: approve the design and review the final PR.

## Architecture & Design

**Pipeline (10 skills, auto-chained):**

| Phase | Skill | Purpose |
|-------|-------|---------|
| 1 | `design` | Challenge assumptions, propose 2-3 approaches with trade-offs |
| 2 | `design-review` | Fresh subagent validates against 8-point checklist |
| 3 | `draft-plan` | Generate structured `plan.json` with file paths, TDD steps, verification |
| 4 | `plan-review` | Catch vague steps, missing paths, design-plan drift |
| 5 | `orchestrate` | Dispatch fresh subagent per task; parallel phases via git worktrees |
| 6 | `implementation-review` | Cross-task holistic verification |
| 7 | `ship` | Automated PR creation with structured summaries |
| 8 | `merge-pr` | Fresh-eyes review, address comments, squash merge |

**Standalone tools:**
- `codebase-review` — Whole-repo parallel audit with cross-scope reconciliation
- `skill-eval` — Assertion-based grading, blind A/B comparison, adversarial scenarios

**Key architectural patterns:**
- **No self-review:** Every review uses a fresh subagent to eliminate confirmation bias
- **Integration branch model:** `integrate/<feature>` branch with per-phase worktrees
- **Phase DAG:** Phases declare dependencies; independent phases execute in parallel
- **Machine-readable plans:** `plan.json` is source of truth; `plan.md` is auto-rendered
- **Schema validation before LLM review:** Deterministic structural checks before spending tokens on LLM reviewers

## Tech Stack

- Markdown (primary) — skills, plans, docs (~17k+ lines)
- Bash — validate-plan script, hooks, tests (~2k+ lines)
- Python 3.10+ — eval runner and benchmark aggregator (~640 lines)
- No external package dependencies (stdlib only)
- Runtime requires: Claude Code, git, jq, bash, gh CLI

## Strengths

1. **Strong separation of concerns.** Each skill is concise (<1,000 words), has a clear workflow, and chains cleanly to the next stage. The fresh-subagent-per-review pattern is a genuine insight for avoiding confirmation bias.

2. **Thoughtful validation infrastructure.** The `validate-plan` script (680 lines) includes BFS cycle detection on phase dependency graphs, duplicate detection for task IDs and file paths, H1 header verification, and status enum validation. Schema validation runs deterministically before expensive LLM review.

3. **Real test suite.** 1,075 lines of bash tests across 8 files covering hooks (safe commands, permission requests) and validate-plan (schema, render, e2e, criteria, status updates). CI runs via GitHub Actions.

4. **Non-trivial hook system.** The `pretooluse-safe-commands.sh` (229 lines) implements a proper shell command parser handling quoted strings, subshells, parentheses, pipes, and semicolons — not a naive regex.

5. **Parallel execution via worktrees.** Using git worktrees for phase-level parallelism is a practical and clever approach — isolates work without branching complexity.

6. **Self-evaluation tooling.** The `skill-eval` skill with assertion-based grading, blind A/B testing, and variance analysis shows commitment to measuring plugin quality empirically.

7. **Excellent documentation.** README has mermaid diagrams, expandable sections, FAQ, and troubleshooting guide.

## Weaknesses

1. **Heavy jq usage in bash.** The `validate-plan` script calls `jq` repeatedly per field per task per phase. A single jq pass extracting all fields would be significantly more efficient on large plans.

2. **No Python tests.** The two Python scripts (`run_eval.py`, `aggregate_benchmark.py`) totaling ~640 lines have zero unit tests, despite the project's emphasis on verification.

3. **Token-heavy workflow.** The pipeline spawns many fresh subagents (design-review, plan-review, implementation-review, merge-pr review), each needing full context loading. For large features this could consume significant tokens with diminishing returns from later review stages.

4. **Solo project risk.** 29 commits, single author, 9 stars, 0 external contributors. No external validation of the workflow beyond the author's own use. The 78 merged PRs suggest dogfooding, but community adoption is absent.

5. **Version inconsistency.** marketplace.json says 1.9.5, README badge says 1.9.1 — minor but suggests manual version management.

6. **Unclear license provenance.** MIT license shows dual copyright: "2025 Jesse Vincent" and "2026 Nikhil Sitaram" — indicating derivation from another project without explicit attribution in README.

## Comparison with deepflow

| Dimension | deepflow | claude-caliper |
|-----------|----------|----------------|
| **Philosophy** | Spec-driven discovery; specs are living hypotheses | Pipeline-driven automation; design→ship in one flow |
| **Human touchpoints** | Multiple (discover, debate, spec, verify) | Two (approve design, review PR) |
| **Review model** | Objective health checks only ("metrics decide") | Fresh subagent reviews at each gate |
| **Parallel execution** | Worktrees (per-task) | Worktrees (per-phase DAG) |
| **Test philosophy** | Ratchet pattern (pre-existing tests only) | TDD (RED-GREEN-REFACTOR per task) |
| **Spec management** | File-rename lifecycle (planned→doing→done) | JSON plan with status fields |
| **Evaluation** | No LLM judges LLM | Has LLM review gates + assertion-based eval |
| **Maturity** | Framework with community potential | Solo project, early stage |

**Key philosophical difference:** deepflow explicitly rejects LLM-as-judge ("no LLM judges another LLM — only objective health checks determine success"), while claude-caliper embraces it with the fresh-subagent-review pattern. Both approaches have trade-offs: deepflow's is more deterministic but may miss design-level issues that tests don't catch; claude-caliper's catches more categories of issues but at higher token cost and with inherent LLM reliability concerns.

## Verdict

claude-caliper is a well-engineered Claude Code plugin with genuine architectural insights (fresh-subagent reviews, phase DAG parallelism, schema-before-LLM validation). The code quality is high, the test suite is real, and the documentation is thorough.

The main risks are: (1) token efficiency of the multi-review pipeline at scale, (2) single-author project with no community validation, and (3) philosophical reliance on LLM-as-reviewer which deepflow explicitly avoids.

**Worth watching.** The skill-eval framework and fresh-subagent pattern are ideas worth considering. The phase-DAG worktree execution is a complementary approach to deepflow's per-task worktrees.
