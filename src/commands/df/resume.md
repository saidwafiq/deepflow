# /df:resume — Session Continuity Briefing

## Orchestrator Role

You are a context synthesizer. Your ONLY job is to read project state from multiple sources and produce a concise, structured briefing so developers can resume work after a break.

**NEVER:** Write files, create files, modify files, append to files, run git with write operations, use AskUserQuestion, spawn agents, use TaskOutput, use EnterPlanMode, use ExitPlanMode

**ONLY:** Read files (Bash read-only git commands, Read tool, Glob, Grep), write briefing to stdout

---

## Purpose

Synthesize project state into a 200-500 word briefing covering what happened, what decisions are live, and what to do next. Pure read-only — writes nothing.

## Usage

```
/df:resume
```

## Behavior

### 1. GATHER SOURCES

Read these sources in parallel (all reads, no writes):

| Source | Command/Path | Purpose |
|--------|-------------|---------|
| Git timeline | `git log --oneline -20` | What changed and when |
| Decisions | `.deepflow/decisions.md` | Current [APPROACH], [PROVISIONAL], [ASSUMPTION] entries |
| Plan | `PLAN.md` | Task status (checked vs unchecked) |
| Spec headers | `specs/doing-*.md` (first 20 lines each) | What features are in-flight |
| Experiments | `.deepflow/experiments/` (file listing + names) | Validated and failed approaches |

**Token budget:** Read only what's needed — ~2500 tokens total across all sources.

If a source does not exist, skip it silently (do not error or warn).

### 2. SYNTHESIZE BRIEFING

Produce a 200-500 word briefing with exactly three sections:

---

**## Timeline**

Summarize what happened and when, derived from `git log --oneline -20` and spec/PLAN.md state. Describe the arc of work: what was completed, what is in-flight, notable milestones. Reference dates or commit messages where informative. Aim for 3-6 sentences.

**## Live Decisions**

List all current `[APPROACH]`, `[PROVISIONAL]`, and `[ASSUMPTION]` entries from `.deepflow/decisions.md`. Present each as a bullet with its tag, the decision text, and a brief rationale if available.

If `.deepflow/decisions.md` does not exist or is empty: state "No decisions recorded yet."

Do not filter or editorialize — report all live decision entries as found. If a decision has been contradicted (a newer entry supersedes it), show only the newest entry for that topic.

**## Next Steps**

Derive next steps from `PLAN.md` task status:
- List unchecked tasks (`- [ ]`) that are not blocked
- Note blocked tasks and what they are blocked by
- If no PLAN.md exists: suggest running `/df:plan` to generate tasks

Prioritize: unblocked tasks first, then blocked tasks with their blockers, then any tasks with no explicit status.

---

### 3. OUTPUT

Print the briefing directly to stdout. No file writes. No file creation.

Format:

```
## Timeline
[3-6 sentences on what happened]

## Live Decisions
- [APPROACH] ...
- [PROVISIONAL] ...
- [ASSUMPTION] ...

## Next Steps
- T1: ... (ready)
- T2: ... (blocked by T1)
```

Word count target: 200-500 words. Do not pad. Do not truncate important information to hit limits.

---

## Rules

- **NEVER write any file** — not decisions.md, not PLAN.md, not any new file
- **NEVER use AskUserQuestion** — this command is read-only, no interaction
- **NEVER spawn agents** — read directly using Bash (git log) and Read tool
- **NEVER use TaskOutput** — returns full transcripts that explode context
- **NEVER use EnterPlanMode or ExitPlanMode**
- Read sources in a single pass — do not loop or re-read
- If a source file is missing, skip it and note it only if relevant
- Contradicted decisions: show newest entry per topic only
- Token budget: stay within ~2500 tokens of input to produce ~500 words of output

## Example

```
USER: /df:resume

CLAUDE:

## Timeline
Work began on the session-continuity feature on 2026-02-20, with the spec
formalized after a discover and debate phase. The plan was generated with
5 tasks across two areas: decision capture in existing commands and two new
commands (note, resume). Tasks T1-T3 are complete (decisions.md format,
discover capture, plan capture). T4 (execute capture) and T5 (resume command)
remain in progress.

## Live Decisions
- [APPROACH] Store decisions in .deepflow/decisions.md as append-only markdown — chosen over database to keep diffs readable and avoid new dependencies
- [PROVISIONAL] Max 4 candidates per AskUserQuestion call — matches tool limit, revisit if UX feels too chunked
- [ASSUMPTION] Worktree execute writes to main tree .deepflow/ path — valid as long as main tree is always the parent

## Next Steps
- T4: Add decision capture to /df:execute (ready — unblocked)
- T5: Create /df:resume command (ready — unblocked)
- T6: Add decision capture to /df:verify (blocked by T4)
```
