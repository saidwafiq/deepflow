# Explore Agent Pattern

## Spawn Rules

**NEVER use `run_in_background`** — causes late "Agent completed" notifications.
**NEVER use TaskOutput** — returns full transcripts (100KB+) that explode context.

Spawn ALL agents in ONE message (non-background, parallel):
```python
Task(subagent_type="Explore", model="haiku", prompt="Find: ...")
Task(subagent_type="Explore", model="haiku", prompt="Find: ...")
# Returns final message only; blocks until all complete; no late notifications
```

## Search Protocol

Exploration follows three named phases:

### DIVERSIFY
- **Goal**: Find ALL potential matches across the codebase quickly
- **Method**: Launch 5–8 parallel tool calls in a single message
- **Tools**: Glob (broad patterns), Grep (regex searches), Read (file content verification)
- **Result**: Narrow down to 2–5 candidate files

Example: Search for "config" + "settings" + "env" patterns in parallel, not sequentially.

### CONVERGE
- **Goal**: Validate matches against the search criteria
- **Method**: Read only the matched files; extract relevant line ranges
- **Result**: Eliminate false positives, confirm relevance

### EARLY STOP
- **Goal**: Avoid wasting tokens on exhaustive searches
- **Rule**: Stop as soon as **>= 2 relevant files found** that answer the question
- **Exception**: If searching for a single unique thing (e.g., "the entry point file"), find just 1

## Prompt Structure

```
Find: [specific question]

Return ONLY:
- filepath:startLine-endLine -- why relevant
- Integration points (if asked)

DO NOT: read/summarize specs, make recommendations, propose solutions, generate tables, narrate your search process.

Max response: 500 tokens (configurable via .deepflow/config.yaml explore.max_tokens)
```

## Examples

### GOOD: Parallel search (2 turns total)

**Turn 1 (DIVERSIFY):**
```
- Glob: "src/**/*.ts" pattern="config" (search in all TS files)
- Glob: "src/**/*.js" pattern="config" (search in all JS files)
- Grep: pattern="export.*config", type="ts" (find exports)
- Grep: pattern="interface.*Config", type="ts" (find type definitions)
- Grep: pattern="class.*Settings", type="ts" (alternative pattern)
- Read: src/index.ts (verify entry point structure)
```

**Turn 2 (CONVERGE):**
Return only confirmed matches:
```
src/config/app.ts:1-45 -- main config export with environment settings
src/config/types.ts:10-30 -- Config interface definition
src/utils/settings.ts:1-20 -- Settings helper functions
```

### DO NOT: Sequential search (antipattern, 5+ turns)

```
Turn 1: Glob for config files
Turn 2: Read the first file
Turn 3: Grep for config patterns
Turn 4: Read results
Turn 5: Another Grep search
... (narrating each step)
```

This pattern wastes tokens and breaks context efficiency.

## Fallback

Search dependency directories **only when not found in app code**:
- `node_modules/` — npm packages
- `vendor/` — vendored dependencies
- `site-packages/` — Python packages

Fallback instruction: "Check node_modules/ only if target not found in src/ or lib/"

## Scope Restrictions

MUST only report factual findings: files found, patterns/conventions, integration points.

MUST NOT: make recommendations, propose architectures, summarize specs, draw conclusions.
