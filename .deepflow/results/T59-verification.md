# T59 Verification Report

**Date:** 2026-03-21
**Spec:** doing-orchestrator-v2
**Task:** T59 — Verification of wave-runner + ratchet --task + execute.md changes

---

## Results

### AC-1 (REQ-1): wave-runner basic output, exit 0
**PASS**

Created `/tmp/test-plan.md` with tasks T1–T4 and deps. Ran:
```
node bin/wave-runner.js --plan /tmp/test-plan.md
```
Output:
```
Wave 1: T1 — First task
Wave 2: T2 — Second task, T3 — Third task
Wave 3: T4 — Fourth task
```
Exit code: 0. Output contains wave numbers and task assignments.

---

### AC-2 (REQ-1): task ordering respects deps
**PASS**

From AC-1 output:
- T1 (no deps) → Wave 1
- T2 (blocked by T1), T3 (blocked by T1) → Wave 2 (after T1)
- T4 (blocked by T2, T3) → Wave 3 (after both T2 and T3)

No task appears before its blocking dependency's wave.

---

### AC-3 (REQ-2): --recalc --failed excludes dependents
**PASS**

Ran:
```
node bin/wave-runner.js --recalc --failed T3 --plan /tmp/test-plan.md
```
Output:
```
Wave 1: T1 — First task
Wave 2: T2 — Second task
```
T3 and its dependent T4 are excluded. Exit code: 0.

---

### AC-4 (REQ-3): Wave test section uses Read tool; IMPL_DIFF not built inline
**FAIL**

- "Read" appears in section 5.6 (line 205: `Read .deepflow/auto-snapshot.txt`), satisfying the first condition.
- However, `{IMPL_DIFF}` appears at line 364 as a template variable in the Wave Test prompt. The spec (REQ-3) requires replacing the push model (`IMPL_DIFF` injected into prompt) with a pull model (wave test agent reads diff itself via Read tool). Section 5.6 step 1 still injects the diff as an opaque string from a haiku fork into `{IMPL_DIFF}` — the push model is partially mitigated (not stored in orchestrator context) but the placeholder is still present and being filled. The AC requires "no inline IMPL_DIFF variable is built or injected into the prompt" — but it IS injected via haiku fork.

Evidence: `execute.md` line 364 `{IMPL_DIFF}` in Wave Test prompt template. No "Read tool" instruction for the wave test agent to self-retrieve the diff.

---

### AC-5 (REQ-4): PLAN.md [ ] → [x] with commit hash on ratchet PASS + --task
**PASS**

Code analysis of `bin/ratchet.js` `updatePlanMd()` function (lines 303–330):
- Called only when `cliArgs.task` is set (line 386–388): `if (cliArgs.task) { updatePlanMd(...) }`
- Called only after `process.stdout.write(JSON.stringify({ result: 'PASS' }))` (line 385)
- Replaces `- [ ]` with `- [x]` (line 322)
- Appends ` (${hash})` where hash = `git rev-parse --short HEAD` output (lines 307–316, 323)

Logic confirmed in source. The 7-char hash is the default `--short` format from git.

---

### AC-6 (REQ-4): ratchet.js JSON output with result field, exit codes 0/1/2
**PASS**

Ran `node bin/ratchet.js` (no snapshot, no tests → PASS):
```
{"result":"PASS"}
Exit code: 0
```
Source confirms:
- Exit 0 + `{"result":"PASS"}` (line 385, 389)
- Exit 1 + `{"result":"FAIL","stage":"...","log":"..."}` (line 379–380)
- Exit 2 + `{"result":"SALVAGEABLE","stage":"...","log":"..."}` (line 375–376)

Backward compatible JSON structure maintained.

---

### AC-7 (REQ-5): execute.md uses haiku context-fork for git diff/stash
**PASS**

Section 5.8 (lines 261–289) is titled "HAIKU GIT-OPS (context-fork)" and explicitly states:
> "Git operations that produce large output (diff, stash, cherry-pick conflict output) MUST be delegated to a context-forked haiku subagent. Raw output never enters the orchestrator context."

The AC-7 comment at line 262 confirms: `<!-- AC-7: git diff/stash/cherry-pick run in a haiku context-fork; orchestrator receives one-line summary -->`.

Section 5.6 step 1 references §5.8 for post-implementation diff capture.

---

### AC-8 (REQ-6): execute.md uses isolation: "worktree" for intra-wave parallel agents
**PASS**

Line 112:
> "For standard (non-spike, non-optimize) parallel tasks, use `isolation: "worktree"` so each agent works in its own isolated branch."

---

### AC-9 (REQ-6): execute.md cherry-picks intra-wave agent commits before next wave
**PASS**

Section 5.1 (lines 119–141) explicitly describes "INTRA-WAVE CHERRY-PICK MERGE":
> "After ALL wave-N agents complete, collect their commits and cherry-pick into the shared worktree BEFORE wave N+1 begins."

Wave gate enforced: "Wave N+1 MUST NOT start until all wave-N cherry-picks complete."

---

### AC-10 (REQ-7): execute.md checks Files: lists for overlap; logs deferred.*file conflict
**PASS**

Line 114:
> "**File conflicts (1 file = 1 writer):** Check `Files:` lists. Overlap → spawn lowest-numbered only; rest stay pending. Log: `"⏳ T{N} deferred — file conflict with T{M} on {filename}"`"

The log pattern contains "deferred" followed by "file conflict" matching the AC requirement.

---

## Summary

| AC | Status | Notes |
|----|--------|-------|
| AC-1 | PASS | wave-runner outputs waves, exit 0 |
| AC-2 | PASS | task ordering respects deps |
| AC-3 | PASS | --recalc --failed excludes transitive dependents |
| AC-4 | FAIL | {IMPL_DIFF} still injected into Wave Test prompt; pull model not implemented |
| AC-5 | PASS | ratchet --task marks [x] + appends commit hash |
| AC-6 | PASS | JSON {"result":...} + exit codes 0/1/2 confirmed |
| AC-7 | PASS | haiku context-fork §5.8 documented in execute.md |
| AC-8 | PASS | isolation: "worktree" in §5 spawn section |
| AC-9 | PASS | cherry-pick merge in §5.1 before next wave |
| AC-10 | PASS | deferred log with file conflict pattern in §5 |

**9/10 ACs pass. AC-4 fails.**
