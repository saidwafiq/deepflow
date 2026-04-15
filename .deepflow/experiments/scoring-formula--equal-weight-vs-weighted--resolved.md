# Experiment: Scoring Formula — Equal-Weight vs Weighted

**Topic:** scoring-formula
**Hypothesis:** equal-weight-vs-weighted
**Status:** resolved
**Date:** 2026-04-15

---

## Context

REQ-6 defines a 4-dimension aggregate score (D1..D4) but left the combination rule unspecified. This blocked AC-7 from being testable because fixture thresholds had no deterministic formula to validate against.

Open questions resolved in this spike:
1. Aggregate scoring formula for D1..D4
2. D3 "modified function block" boundary definition
3. Hook trigger event for "on each commit event"

---

## Decisions

### 1. Aggregate Scoring Formula: Equal-Weight Average

**Formula:** `score = (D1 + D2 + D3 + D4) / 4`

Where:
- D1 = `AC_test_ratio` — ratio of test files touched to source files touched
- D2 = `diff_sibling_ratio` — ratio of related files co-modified (siblings in same module)
- D3 = `complexity_proxy` — fraction of changed function blocks that stay within complexity budget
- D4 = `jsdoc_ratio` — fraction of changed public functions that have JSDoc

**Rationale:**
- No dimension has established empirical primacy over the others
- Equal weighting is maximally auditable — a human can verify a score by hand
- Weighted formulas require calibration data that does not exist yet; weights would be arbitrary opinion, not evidence
- If future data shows one dimension is more predictive of defects, weights can be introduced then with justification
- Keeps the formula deterministic: given D1..D4 ∈ [0,1], score ∈ [0,1]

**Decision tag:** [APPROACH] equal-weight-average scoring formula — no dimension has established primacy, keeps formula auditable

---

### 2. D3 Function Block Boundary: ±20-Line Heuristic

**Rule:** A "function block" for D3 purposes is defined as the set of lines starting at the first line of the changed hunk (as reported by `git diff`) and extending ±20 lines, capped at file boundaries (line 1 and EOF).

**Formal definition:**
```
function_block(hunk_start, hunk_end, file_lines) =
  lines[ max(1, hunk_start - 20) .. min(file_lines, hunk_end + 20) ]
```

**Rationale:**
- Brace-matching requires a full AST parser; adding a parser dependency to a hook creates fragility and latency
- Language-agnostic: works for JS/TS, Python, shell, and any future language without per-language rules
- ±20 lines captures typical short-to-medium functions (median JS function is ~15 lines per industry studies)
- Deterministic: two evaluators given the same diff will always produce the same boundary
- Edge cases are bounded: very large functions get sampled; very small functions get a stable context window

**Complexity proxy calculation using this boundary:**
A function block "passes" complexity budget if the number of logical branch keywords (`if`, `else`, `for`, `while`, `switch`, `catch`, `&&`, `||`, `??`) within the block is ≤ threshold (default: 10). D3 = (passing blocks) / (total changed blocks).

**Decision tag:** [APPROACH] D3 boundary = ±20 lines from hunk — avoids brace-matching, deterministic

---

### 3. Hook Trigger: PostToolUse — Bash with "git commit"

**Trigger:** `PostToolUse` hook event, filtered to:
- `tool_name == "Bash"`
- `tool_input.command` contains the substring `"git commit"`

**Hook configuration example:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/df-score-commit.js"
          }
        ]
      }
    ]
  }
}
```

The hook script reads `tool_input.command` from stdin (standard PostToolUse payload) and early-exits if the command does not contain `git commit`.

**Rationale:**
- `PostToolUse` with `Bash` is the most direct event — it fires exactly when the agent runs a bash command that commits
- Alternative `Stop` event fires too late (after the session ends) and cannot annotate the commit
- Alternative `PreToolUse` fires before the commit exists, so diff is unavailable
- The `git commit` substring check is simple and handles common forms: `git commit -m`, `git commit --amend`, `git commit -am`
- False positives (e.g. `echo "git commit"`) are harmless — scoring on a non-commit diff returns 0 gracefully

**Decision tag:** [APPROACH] hook trigger = PostToolUse Bash containing "git commit" — most direct commit detection

---

## AC-7 Now Testable

With the equal-weight-average formula pinned, AC-7 fixtures can be expressed as:

```
score = (AC_test_ratio + diff_sibling_ratio + complexity_proxy + jsdoc_ratio) / 4
```

Example fixture:
```
Given: D1=1.0, D2=0.5, D3=0.75, D4=1.0
Expected score = (1.0 + 0.5 + 0.75 + 1.0) / 4 = 0.8125
```

Test harness only needs to:
1. Provide a mock diff with known characteristics
2. Assert each dimension independently (unit tests for D1..D4)
3. Assert the aggregate (integration test for the formula)

No LLM judgment involved — all assertions are arithmetic comparisons.

---

## Conclusion

All three open questions are resolved with deterministic, auditable rules. The spike produces no prototype code — the decisions are sufficient to unblock implementation tasks that depend on them.
