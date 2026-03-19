# Dashboard: Claude Code ~/.claude/ File Schemas

**Status:** Active (T11)
**Date:** 2026-03-19
**Hypothesis:** All source files in ~/.claude/ have stable schemas mappable to SQLite tables

## Summary

Documented file schemas across ~/.claude/ and project-local .deepflow/ directories. Found stable JSONL formats for:
- Global metrics (history, quota, tokens)
- Session & agent records (conversations)
- Project-level tracking (token history, context)

All files are append-only JSONL where each line is a valid JSON object.

---

## Files Documented

### 1. ~/.claude/history.jsonl
**Purpose:** Command/tool execution history
**Location:** ~/.claude/history.jsonl
**Format:** JSONL (append-only)
**Example Records:** 3 records examined

**Schema:**
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| display | string | "/init", "option B" | UI display label |
| pastedContents | object | {} | Pasted clipboard content (empty in examples) |
| timestamp | number | 1760566419279 | Unix epoch milliseconds |
| project | string | "/Users/saidsalles" | Project root path |

**Sample Record:**
```json
{
  "display": "/init",
  "pastedContents": {},
  "timestamp": 1760566419279,
  "project": "/Users/saidsalles"
}
```

**Status:** FOUND - Active, growing (1.7MB as of 2026-03-19)

---

### 2. ~/.claude/quota-history.jsonl
**Purpose:** Token quota tracking and session lifecycle
**Location:** ~/.claude/quota-history.jsonl
**Format:** JSONL (append-only)
**Example Records:** 3 records examined

**Schema:**
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| timestamp | ISO 8601 string | "2026-03-12T02:50:36.918Z" | UTC timestamp |
| event | string | "SessionStart", "SessionEnd" | Event type |
| session_id | string | "e2c36e0d-a217-4265-b176-0026a340110c", null | Session UUID or null |
| project | string | "/Users/saidsalles/apps/agentSkills/deepflow", null | Project path or null |
| five_hour | object | {utilization: 11, resets_at: "..."} | 5-hour quota window |
| seven_day | object | {utilization: 41, resets_at: "..."} | 7-day quota window |
| seven_day_sonnet | object | {utilization: 3, resets_at: "..."} | Sonnet-specific 7-day window |
| extra_usage | object | {is_enabled: bool, monthly_limit: num, used_credits: num, utilization: %} | Extra usage tracking |

**Window Structure (for five_hour/seven_day/etc):**
| Field | Type | Example |
|-------|------|---------|
| utilization | number | 11 (percent) |
| resets_at | ISO 8601 | "2026-03-12T06:00:00.244178+00:00" |

**Sample Record:**
```json
{
  "timestamp": "2026-03-12T02:50:36.918Z",
  "event": "SessionStart",
  "session_id": null,
  "project": null,
  "five_hour": {
    "utilization": 11,
    "resets_at": "2026-03-12T06:00:00.244178+00:00"
  },
  "seven_day": {
    "utilization": 41,
    "resets_at": "2026-03-13T15:00:00.244198+00:00"
  },
  "seven_day_sonnet": {
    "utilization": 3,
    "resets_at": "2026-03-13T23:00:00.244205+00:00"
  },
  "extra_usage": {
    "is_enabled": true,
    "monthly_limit": 27500,
    "used_credits": 6796,
    "utilization": 24.71272727272727
  }
}
```

**Status:** FOUND - Active, growing (80KB as of 2026-03-19)

---

### 3. .deepflow/token-history.jsonl
**Purpose:** Per-session token usage metrics (input, cache creation, cache read)
**Location:** /Users/saidsalles/apps/agentSkills/deepflow/.deepflow/token-history.jsonl
**Format:** JSONL (append-only)
**Example Records:** 3 records examined

**Schema:**
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| timestamp | ISO 8601 | "2026-03-18T03:36:46.285Z" | UTC timestamp |
| input_tokens | number | 1 | Raw input tokens |
| cache_creation_input_tokens | number | 692 | Tokens written to cache |
| cache_read_input_tokens | number | 18578 | Tokens read from cache |
| context_window_size | number | 1000000 | Model context size |
| used_percentage | number | 2 | % of context used |
| model | string | "claude-opus-4-6[1m]" | Model identifier |
| session_id | UUID string | "a5ecc9ba-e880-46bd-a468-e4d04cbde3fa" | Session UUID |

**Sample Record:**
```json
{
  "timestamp": "2026-03-18T03:36:46.285Z",
  "input_tokens": 1,
  "cache_creation_input_tokens": 692,
  "cache_read_input_tokens": 18578,
  "context_window_size": 1000000,
  "used_percentage": 2,
  "model": "claude-opus-4-6[1m]",
  "session_id": "a5ecc9ba-e880-46bd-a468-e4d04cbde3fa"
}
```

**Status:** FOUND - Active, project-local (200KB as of 2026-03-19)

---

### 4. .deepflow/context.json
**Purpose:** Cross-session context snapshot
**Location:** /Users/saidsalles/apps/agentSkills/deepflow/.deepflow/context.json
**Format:** JSON object (latest state)
**Example Records:** 1 record examined

**Schema:**
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| percentage | number | 9 | Context usage % |
| timestamp | number | 1773891436650 | Unix epoch milliseconds |

**Sample Record:**
```json
{
  "percentage": 9,
  "timestamp": 1773891436650
}
```

**Status:** FOUND - Active, project-local (42 bytes)

---

### 5. ~/.claude/projects/{project-id}/{session-id}.jsonl
**Purpose:** Session-level conversation & tool execution records (subagent transcripts)
**Location:** ~/.claude/projects/-Users-saidsalles-apps-agentSkills-deepflow/{session-uuid}.jsonl
**Format:** JSONL (append-only)
**Example Records:** 3 records examined from agent session

**Schema (User Message):**
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| parentUuid | UUID string | null | Parent message UUID |
| isSidechain | boolean | true | Is this a subagent? |
| agentId | string | "afd37c254dcd75950" | Agent identifier |
| type | string | "user" | Message type |
| message | object | {role, content} | Message content |
| uuid | UUID string | "4f78e1a1-597a-4278-910d-1e7bbc726f4e" | Message UUID |
| timestamp | ISO 8601 | "2026-03-17T20:46:03.991Z" | UTC timestamp |
| userType | string | "external" | User type |
| cwd | string | "/Users/.../worktree/..." | Working directory |
| sessionId | UUID string | "361cebb0-458d-462e-85b8-3645f3897cde" | Session UUID |
| version | string | "2.1.77" | Claude version |
| gitBranch | string | "main" | Git branch |
| slug | string | "starry-noodling-parasol" | Session slug |

**Schema (Assistant Response):**
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| message.model | string | "claude-haiku-4-5-20251001" | Model used |
| message.id | string | "msg_01TpKTcczKVj3biVEZqMbdxe" | Message ID |
| message.usage | object | {input_tokens, cache_*, output_tokens} | Token usage |
| requestId | string | "req_011CZ9Jk1CuyPdWnjM9cwVb3" | API request ID |
| type | string | "assistant" | Message type |
| (all common fields) | | | Same as user message |

**Sample Record (User):**
```json
{
  "parentUuid": null,
  "isSidechain": true,
  "agentId": "afd37c254dcd75950",
  "type": "user",
  "message": {
    "role": "user",
    "content": "You MUST be maximally efficient..."
  },
  "uuid": "4f78e1a1-597a-4278-910d-1e7bbc726f4e",
  "timestamp": "2026-03-17T20:46:03.991Z",
  "userType": "external",
  "cwd": "/Users/saidsalles/apps/agentSkills/deepflow/.deepflow/worktrees/skills-2.0",
  "sessionId": "361cebb0-458d-462e-85b8-3645f3897cde",
  "version": "2.1.77",
  "gitBranch": "main",
  "slug": "starry-noodling-parasol"
}
```

**Status:** FOUND - Active, multiple sessions (100+ sessions in deepflow project)

---

### 6. ~/.claude/projects/{project-id}/subagents/agent-{id}.jsonl
**Purpose:** Nested subagent conversation transcripts
**Location:** ~/.claude/projects/.../subagents/agent-{agentId}.jsonl
**Format:** JSONL (append-only)
**Example Records:** Shares schema with main session.jsonl

**Status:** FOUND - Active, multiple per session

---

## Missing/Not Yet Found

| File | Purpose | Status |
|------|---------|--------|
| cache-history.jsonl | Cache hit/miss metrics | NOT FOUND (may be created by T4 cache monitoring) |
| tool-usage.jsonl | Per-tool execution stats | FOUND AS .tmp (0 bytes, being created by T6) |
| conversations/*.jsonl | Per-conversation transcripts | NOT FOUND (records stored in session-level .jsonl files) |

---

## Data Flow for Dashboard

```
User Session
  ↓
~/.claude/projects/{project-id}/{session-id}.jsonl
  ├─ User messages (type=user)
  ├─ Assistant responses (type=assistant)
  └─ Tool invocations (type=tool_use embedded in message)

  └─ Subagents
      └─ ~/.claude/projects/{project-id}/subagents/agent-{id}.jsonl
          └─ Nested conversations

Metrics Collection (parallel)
  ├─ ~/.claude/quota-history.jsonl (session lifecycle)
  ├─ ~/.claude/history.jsonl (command history)
  ├─ .deepflow/token-history.jsonl (token accounting)
  └─ .deepflow/context.json (snapshot)
```

---

## SQLite Mapping Strategy

### Tables (7 total)

1. **sessions** — from session-level .jsonl uuids
2. **messages** — from session jsonl (user/assistant/tool records)
3. **message_content** — from message.message.content (array of content blocks)
4. **quota_events** — from quota-history.jsonl
5. **token_history** — from .deepflow/token-history.jsonl
6. **command_history** — from history.jsonl
7. **subagents** — from subagent .jsonl files

### Key Relationships
- messages.session_id → sessions.id
- message_content.message_id → messages.uuid
- quota_events.session_id → sessions.id
- token_history.session_id → sessions.id

---

## Implementation Readiness

All file schemas are:
- ✅ Stable (no schema breaking changes observed)
- ✅ Documented (field types, examples provided)
- ✅ Mappable (can create normalized SQLite schema)
- ✅ Append-only (except context.json which is ephemeral)

**Next step for dashboard:** Schema generator to convert JSONL → SQLite, with normalization for nested objects (message.content arrays, quota windows, etc.)
