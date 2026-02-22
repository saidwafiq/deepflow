# /df:note — Capture Decisions from Free Conversations

## Orchestrator Role

You scan prior conversation context for candidate decisions, present them for user confirmation, and persist confirmed decisions to `.deepflow/decisions.md`.

**NEVER:** Spawn agents, use Task tool, use Glob/Grep on source code, run git, use TaskOutput, use EnterPlanMode, use ExitPlanMode

**ONLY:** Read `.deepflow/decisions.md` (if it exists), present candidates via `AskUserQuestion`, append confirmed decisions to `.deepflow/decisions.md`

---

## Purpose

Capture decisions that emerged during free conversations outside of deepflow commands. Surfaces candidate decisions from the current conversation, lets the user confirm or discard each, and persists confirmed ones to the shared decisions log.

## Usage

```
/df:note
```

No arguments required. Operates on the current conversation context.

---

## Behavior

### 1. EXTRACT CANDIDATES

Scan the prior conversation messages for candidate decisions. A decision is any resolved choice, adopted approach, or stated assumption that affects how the work is done. Look for:

- **Approaches chosen**: "we'll use X instead of Y", "let's go with X"
- **Provisional choices**: "for now we'll use X", "assuming X until we know more"
- **Stated assumptions**: "assuming X is true", "treating X as given"
- **Constraints accepted**: "we won't do X", "X is out of scope"
- **Naming or structural choices**: "we'll call it X", "X goes in the Y layer"

Extract **at most 4 candidates** from the conversation. Prioritize the most consequential or recent ones.

For each candidate, determine:
- **Tag**: one of `[APPROACH]`, `[PROVISIONAL]`, or `[ASSUMPTION]`
  - `[APPROACH]` — a deliberate design or implementation choice
  - `[PROVISIONAL]` — works for now, expected to revisit
  - `[ASSUMPTION]` — treating something as true without full validation
- **Decision text**: one concise line describing the choice
- **Rationale**: one sentence explaining why this was chosen

If fewer than 2 clear candidates are found, say so briefly and exit without calling `AskUserQuestion`.

### 2. CHECK FOR CONTRADICTIONS

Read `.deepflow/decisions.md` if it exists. For each candidate, check whether it contradicts a prior entry in the file.

If a contradiction is found:
- Keep the prior entry — never delete or modify it
- Amend the candidate's rationale to reference the prior decision: `was "X", now "Y" because Z`

### 3. PRESENT VIA AskUserQuestion

Present candidates as a multi-select question with at most 4 options (tool limit).

```json
{
  "questions": [
    {
      "question": "These decisions were detected in your conversation. Which should be saved to .deepflow/decisions.md?",
      "header": "Save notes?",
      "multiSelect": true,
      "options": [
        {
          "label": "[APPROACH] <decision text>",
          "description": "<rationale>"
        },
        {
          "label": "[PROVISIONAL] <decision text>",
          "description": "<rationale>"
        }
      ]
    }
  ]
}
```

Each option's `label` is the tag + decision text. Each `description` is the rationale (one sentence).

### 4. APPEND CONFIRMED DECISIONS

For each option the user selects:

1. If `.deepflow/decisions.md` does not exist, create it with a blank header:
   ```
   # Decisions
   ```

2. Append a new dated section using today's date in `YYYY-MM-DD` format and source `note`:

   ```markdown
   ### 2026-02-22 — note
   - [APPROACH] Use event sourcing over CRUD — append-only log matches audit requirements
   - [PROVISIONAL] Batch size = 50 — works for 4-game dataset, revisit at scale
   ```

3. If multiple decisions are confirmed in one invocation, group them under a single dated section.

4. Never modify or delete any prior entries.

### 5. CONFIRM

After writing, report to the user:

```
Saved N decision(s) to .deepflow/decisions.md
```

If the user selected nothing, respond:

```
No decisions saved.
```

---

## Decision Format

```
### YYYY-MM-DD — note
- [TAG] Decision text — rationale
```

**Tags:**
- `[APPROACH]` — deliberate design or implementation choice
- `[PROVISIONAL]` — works for now, will revisit at scale or with more information
- `[ASSUMPTION]` — treating something as true without full confirmation

**Contradiction handling:** Never delete prior entries. When a new decision contradicts an older one, include a reference in the rationale: `was "X", now "Y" because Z`.

---

## Rules

- **Maximum 4 candidates** per invocation (tool limit for AskUserQuestion options)
- **multiSelect: true** — user can confirm any subset, including all or none
- **Never invent decisions** — only extract what was genuinely discussed and resolved in the conversation
- **Never modify prior entries** in `.deepflow/decisions.md`
- **Create the file if absent** — first use initializes it with `# Decisions` header
- **Source is always `note`** — this distinguishes from decisions captured by other df commands
- **Date is today's date** — use the current date in `YYYY-MM-DD` format
- **One AskUserQuestion call** — present all candidates in a single call, not sequentially

---

## Example

```
USER: /df:note

CLAUDE: Let me scan our conversation for candidate decisions.

[Reads .deepflow/decisions.md — finds prior entry:
  "### 2026-02-10 — spec
  - [APPROACH] Use PostgreSQL for primary storage — team already knows it"]

[Extracts from conversation:
  1. [APPROACH] Use Redis for session state — avoids DB round-trips on hot path
  2. [PROVISIONAL] Skip auth for internal APIs — only 2 internal services for now
  3. [ASSUMPTION] Peak load is 500 req/s — based on current traffic, unvalidated
]

[No contradictions found with prior entries]

[Uses AskUserQuestion]
{
  "questions": [
    {
      "question": "These decisions were detected in your conversation. Which should be saved to .deepflow/decisions.md?",
      "header": "Save notes?",
      "multiSelect": true,
      "options": [
        {
          "label": "[APPROACH] Use Redis for session state",
          "description": "Avoids DB round-trips on hot path"
        },
        {
          "label": "[PROVISIONAL] Skip auth for internal APIs",
          "description": "Only 2 internal services for now, revisit when we open to more consumers"
        },
        {
          "label": "[ASSUMPTION] Peak load is 500 req/s",
          "description": "Based on current traffic patterns, not load-tested"
        }
      ]
    }
  ]
}

USER: [Selects: Use Redis for session state, Peak load is 500 req/s]

CLAUDE: [Appends to .deepflow/decisions.md:]

### 2026-02-22 — note
- [APPROACH] Use Redis for session state — avoids DB round-trips on hot path
- [ASSUMPTION] Peak load is 500 req/s — based on current traffic patterns, not load-tested

Saved 2 decision(s) to .deepflow/decisions.md
```
