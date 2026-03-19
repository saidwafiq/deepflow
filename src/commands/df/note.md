---
name: df:note
description: Capture decisions that emerged during free conversations outside of deepflow commands
---

# /df:note — Capture Decisions from Free Conversations

## Orchestrator Role

Scan conversation for candidate decisions, present for user confirmation, persist to `.deepflow/decisions.md`.

**NEVER:** Spawn agents, use Task tool, use Glob/Grep on source code, run git, use TaskOutput, EnterPlanMode, ExitPlanMode

**ONLY:** Read `.deepflow/decisions.md`, present candidates via `AskUserQuestion`, append confirmed decisions

## Behavior

### 1. EXTRACT CANDIDATES

Scan prior messages for resolved choices, adopted approaches, or stated assumptions. Look for:
- **Approaches chosen**: "we'll use X instead of Y"
- **Provisional choices**: "for now we'll use X"
- **Stated assumptions**: "assuming X is true"
- **Constraints accepted**: "X is out of scope"
- **Naming/structural choices**: "we'll call it X", "X goes in the Y layer"

Extract **at most 4 candidates**. For each, determine:

| Field | Value |
|-------|-------|
| Tag | `[APPROACH]` (deliberate choice), `[PROVISIONAL]` (revisit later), or `[ASSUMPTION]` (unvalidated) |
| Decision | One concise line describing the choice |
| Rationale | One sentence explaining why |

If <2 clear candidates found, say so and exit.

### 2. CHECK FOR CONTRADICTIONS

Read `.deepflow/decisions.md` if it exists. If a candidate contradicts a prior entry: keep prior entry unchanged, amend candidate rationale to `was "X", now "Y" because Z`.

### 3. PRESENT VIA AskUserQuestion

Single multi-select call. Each option: `label` = tag + decision text, `description` = rationale.

### 4. APPEND CONFIRMED DECISIONS

For each selected option:
1. Create `.deepflow/decisions.md` with `# Decisions` header if absent
2. Append a dated section: `### YYYY-MM-DD — note`
3. Group all confirmed decisions under one section: `- [TAG] Decision text — rationale`
4. Never modify or delete prior entries

### 5. CONFIRM

Report: `Saved N decision(s) to .deepflow/decisions.md` or `No decisions saved.`

## Decision Tags

| Tag | Meaning | Source |
|-----|---------|--------|
| `[APPROACH]` | Firm decision | /df:note, auto-extraction |
| `[PROVISIONAL]` | Revisit later | /df:note, auto-extraction |
| `[ASSUMPTION]` | Unverified | /df:note, auto-extraction |
| `[DEBT]` | Needs revisiting | /df:consolidate only, never manually assigned |

## Rules

- Max 4 candidates per invocation (AskUserQuestion tool limit)
- multiSelect: true — user confirms any subset
- Never invent decisions — only extract what was discussed and resolved
- Never modify prior entries in `.deepflow/decisions.md`
- Source is always `note`; date is today (YYYY-MM-DD)
- One AskUserQuestion call — all candidates in a single call
