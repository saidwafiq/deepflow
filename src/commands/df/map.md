---
name: df:map
description: Pre-compute codebase documentation artifacts (STACK, ARCHITECTURE, CONVENTIONS, STRUCTURE, TESTING, INTEGRATIONS) under .deepflow/codebase/ with hash-based staleness tracking
allowed-tools: [Glob, Read, Write, Bash]
---

# /df:map — Generate Codebase Map Artifacts

Pre-compute lazy-loaded codebase documentation under `.deepflow/codebase/` so agents can read only what they need. Each artifact has YAML frontmatter with `sources:` and `hashes:` for deterministic staleness detection.

**NEVER:** Edit source files, run git, use Task/Agent, use EnterPlanMode, use ExitPlanMode
**ONLY:** Read source files, glob, run sha256 via Bash, write `.deepflow/codebase/*.md` artifacts

## Usage

```
/df:map               # Generate (or regenerate) all six artifacts
/df:map --only STACK  # Regenerate a single artifact (case-insensitive name, no .md)
```

## Flag Parsing (Prologue)

Parse the raw argument string (`ARGS`) at invocation time:

```
ONLY_TARGET = ""   # default: generate all

if ARGS contains "--only":
    extract the word immediately after "--only"
    ONLY_TARGET = that word (uppercase, strip .md suffix if present)
    valid values: STACK | ARCHITECTURE | CONVENTIONS | STRUCTURE | TESTING | INTEGRATIONS
    invalid value → print error and stop:
      "Unknown artifact '{value}'. Valid: STACK ARCHITECTURE CONVENTIONS STRUCTURE TESTING INTEGRATIONS"
```

## Behavior

### 1. SETUP

Create the output directory if it does not exist:

```bash
mkdir -p .deepflow/codebase
```

Load the project config for context:

```
!`cat .deepflow/config.yaml 2>/dev/null || echo 'NOT_FOUND'`
```

Detect the primary source directory from config (`source_dir`) or default to `src/`.

### 2. COLLECT KEY FILES

Glob and read only the structural files needed for artifact generation. Read each with `Read` (offset/limit where the file is large — never read more than needed).

**Always-needed files (all artifacts):**
- `CLAUDE.md` — always-on project rules
- `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` — dependency manifest (first found)
- `.deepflow/config.yaml` — deepflow config
- `README.md` (if present)

**Per-artifact additional files:**

| Artifact | Additional sources |
|----------|--------------------|
| STACK | Dependency manifest, lock file (first 50 lines), `package.json` scripts |
| ARCHITECTURE | `src/` top-level dirs, entry point files (max 30 lines each), `bin/*.js` list |
| CONVENTIONS | 3–5 representative source files showing naming/error-handling patterns |
| STRUCTURE | `src/` directory tree (2 levels deep via Bash `find`), `hooks/` listing, `templates/` listing |
| TESTING | `package.json` scripts.test, existing test files list, `.deepflow/auto-snapshot.txt` (if exists) |
| INTEGRATIONS | External API references in source (grep for `https://`, env vars in `.env.example` if present) |

### 3. COMPUTE HASHES

For each artifact's key source files, compute sha256 using Bash. Use this exact command pattern per file:

```bash
shasum -a 256 <path> 2>/dev/null | awk '{print $1}'
```

If the file does not exist, use the string `"absent"` as its hash value.

Build a `hashes:` map keyed by file path → sha256 string.

**Key files to hash per artifact:**

| Artifact | Hashed files |
|----------|-------------|
| STACK | `package.json` (or primary manifest), `CLAUDE.md` |
| ARCHITECTURE | `CLAUDE.md`, `bin/install.js` (first entry), `src/commands/df/` directory marker (`CLAUDE.md` as proxy) |
| CONVENTIONS | `CLAUDE.md`, 2–3 representative source files actually read |
| STRUCTURE | `CLAUDE.md`, `package.json` |
| TESTING | `package.json`, `.deepflow/auto-snapshot.txt` |
| INTEGRATIONS | `package.json`, `.env.example` (or `"absent"` if missing) |

### 4. CHECK IDEMPOTENCY

Before writing each artifact, check if an existing version is present:

```bash
test -f .deepflow/codebase/{NAME}.md && echo EXISTS || echo NEW
```

If `EXISTS`: read the existing artifact's frontmatter `hashes:` block. Compare each hash value against the freshly computed hashes from §3. If ALL hashes match → **skip writing** this artifact and report `{NAME}: unchanged (hashes match)`. This is the idempotency guarantee (AC-9).

If `NEW` or any hash differs → generate and write the artifact.

### 5. GENERATE ARTIFACTS

For each artifact in scope (all six, or the single `ONLY_TARGET`):

#### 5.1 STACK.md

Sources: `package.json` / manifest, `CLAUDE.md`, `README.md`

Content to generate:

```markdown
---
sources:
  - package.json
  - CLAUDE.md
  - README.md
hashes:
  package.json: {sha256}
  CLAUDE.md: {sha256}
generated: {ISO-8601 timestamp}
---

# Stack

## Runtime

- Language: {detected from manifest}
- Runtime: Node.js {version from engines or package.json}, or Python, Go, Rust, etc.
- Package manager: npm / yarn / pnpm / pip / cargo / go (detected from lock file presence)

## Dependencies

### Production
{list top-level dependencies from manifest with version}

### Development
{list devDependencies from manifest with version}

## Scripts

{list scripts from package.json scripts field, or equivalent}

## Toolchain Notes

{any noteworthy toolchain constraints from CLAUDE.md or README}
```

#### 5.2 ARCHITECTURE.md

Sources: `CLAUDE.md`, `bin/` listing, `src/` top-level dirs, entry point files

Content to generate:

```markdown
---
sources:
  - CLAUDE.md
  - bin/
  - src/
hashes:
  CLAUDE.md: {sha256}
  bin/install.js: {sha256}
generated: {ISO-8601 timestamp}
---

# Architecture

## Overview

{One paragraph synthesizing the system's purpose and structure from CLAUDE.md}

## Component Map

{Table or bullets: component → directory → purpose, derived from CLAUDE.md ##Architecture section and actual directory listing}

## Data Flow

{Narrative or diagram-in-prose of how data moves through the system, derived from CLAUDE.md}

## Key Entry Points

{List: file → role, derived from bin/ and src/ actual files}

## Design Patterns

{Bullets from CLAUDE.md "Key Design Patterns" section — verbatim or lightly reformatted}
```

#### 5.3 CONVENTIONS.md

Sources: `CLAUDE.md`, representative source files

Content to generate:

```markdown
---
sources:
  - CLAUDE.md
  - src/commands/df/
  - hooks/
hashes:
  CLAUDE.md: {sha256}
  {source_file_1}: {sha256}
  {source_file_2}: {sha256}
generated: {ISO-8601 timestamp}
---

# Conventions

## File Naming

{Derived from CLAUDE.md Conventions section and observed patterns}
- Spec files: `{name}.md` → `doing-{name}.md` → `done-{name}.md`
- Command files: `src/commands/df/{name}.md` with YAML frontmatter
- Hook files: `hooks/df-{name}.js`
- Test files: `{module}.test.js` co-located with module

## YAML Frontmatter (Commands)

{Required fields and example, from CLAUDE.md}

## Commit Format

{Commit type and scope rules from CLAUDE.md}

## Decision Tags

{Tag list from CLAUDE.md decisions.md section}

## Error Handling Patterns

{Observed from hook source files: try/catch at boundary, always exit 0 from hooks}

## API/Module Structure

{Observed from source files: CommonJS require, no build step, markdown-as-code pattern}

## Shell Injection Pattern

{From CLAUDE.md: backtick injection for state loading}
```

#### 5.4 STRUCTURE.md

Sources: directory tree (2 levels), `CLAUDE.md`

Content to generate — run this to gather the tree:

```bash
find . -maxdepth 2 -not -path './.git/*' -not -path './node_modules/*' -not -path './.deepflow/worktrees/*' | sort
```

```markdown
---
sources:
  - "."
  - CLAUDE.md
hashes:
  CLAUDE.md: {sha256}
  package.json: {sha256}
generated: {ISO-8601 timestamp}
---

# Structure

## Directory Tree (2 levels)

```
{output of find command above, formatted as a tree}
```

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/commands/df/` | User-facing slash commands |
| `src/skills/` | Reusable agent skill modules |
| `src/agents/` | Agent definitions |
| `hooks/` | PreToolUse/PostToolUse event hooks |
| `hooks/lib/` | Shared hook utilities |
| `templates/` | Scaffolding templates |
| `bin/` | CLI utilities and installer |
| `.deepflow/` | Runtime state (decisions, experiments, worktrees) |
| `.deepflow/codebase/` | Pre-computed documentation artifacts (this directory) |
| `specs/` | Feature specifications |

## State Files

| File | Purpose |
|------|---------|
| `.deepflow/decisions.md` | Extracted architectural decisions |
| `.deepflow/auto-memory.yaml` | Cross-cycle autonomous mode state |
| `.deepflow/auto-snapshot.txt` | Pre-existing test ratchet baseline |
| `.deepflow/config.yaml` | Project configuration |
| `PLAN.md` | Active task plan |
```

#### 5.5 TESTING.md

Sources: `package.json`, `.deepflow/auto-snapshot.txt`, test file listing

Run to gather test info:
```bash
find . -name '*.test.js' -not -path './node_modules/*' -not -path './.deepflow/worktrees/*' | sort
```

Run to gather parallel-safety data for the `## Parallel Safety` section:
```bash
# Detect hardcoded ports in test files
grep -rn 'localhost:[0-9]\+\|port[[:space:]]*:[[:space:]]*[0-9]\+\|PORT[[:space:]]*=[[:space:]]*[0-9]\+' \
  --include='*.test.js' --include='*.test.ts' --include='*.spec.js' --include='*.spec.ts' \
  . 2>/dev/null | grep -v node_modules | grep -v .deepflow/worktrees | head -30
```

```bash
# Detect shared DB references in test files
grep -rn 'createDatabase\|knex(\|sequelize\|mongoose\|sqlite\|\.db\b\|beforeAll.*db\|afterAll.*db' \
  --include='*.test.js' --include='*.test.ts' --include='*.spec.js' --include='*.spec.ts' \
  . 2>/dev/null | grep -v node_modules | grep -v .deepflow/worktrees | head -30
```

```bash
# Detect process.env mutations in test files (env var races)
grep -rn 'process\.env\.' \
  --include='*.test.js' --include='*.test.ts' --include='*.spec.js' --include='*.spec.ts' \
  . 2>/dev/null | grep -v node_modules | grep -v .deepflow/worktrees | head -30
```

```bash
# Detect shared filesystem paths in test setup/teardown
grep -rn "tmp\|__fixtures__\|writeFileSync\|mkdirSync\|rmSync\|unlink\|fs\." \
  --include='*.test.js' --include='*.test.ts' --include='*.spec.js' --include='*.spec.ts' \
  . 2>/dev/null | grep -v node_modules | grep -v .deepflow/worktrees | head -30
```

```bash
# Detect fixture ownership — beforeEach/afterEach vs beforeAll/afterAll patterns
grep -rn 'beforeAll\|afterAll\|beforeEach\|afterEach' \
  --include='*.test.js' --include='*.test.ts' --include='*.spec.js' --include='*.spec.ts' \
  . 2>/dev/null | grep -v node_modules | grep -v .deepflow/worktrees | head -40
```

```markdown
---
sources:
  - package.json
  - .deepflow/auto-snapshot.txt
  - "**/*.test.js"
hashes:
  package.json: {sha256}
  .deepflow/auto-snapshot.txt: {sha256 or "absent"}
generated: {ISO-8601 timestamp}
---

# Testing

## Test Command

{scripts.test from package.json, or detected test command from config}

## Test Files

{List of all *.test.js files found, grouped by directory}

## Ratchet Pattern

Pre-existing test files are snapshotted in `.deepflow/auto-snapshot.txt` before each execution cycle. The snapshot contains the baseline test count. Agents cannot satisfy the health gate by writing new trivial tests — only tests that were already in the snapshot count toward the ratchet.

**Ratchet baseline:** {contents of auto-snapshot.txt, or "not yet established"}

## Parallel Safety

This section governs when `[P]` (parallel) markers are legal in PLAN.md task waves. `df:plan` reads this section to decide parallelism. Each subsection is populated by the map agent scanning test files at generation time. `df:plan` MUST treat any non-empty entry under a "BLOCKED" row as a veto on `[P]` for the affected task pair.

### Per-Suite Resource Ownership

Map each test suite to the resources it owns. This table is the primary input for `df:plan`'s `[P]` gate.

| Test Suite (file) | DB / Tables | Port | Env Vars Mutated | Fixture Files/Dirs | Cleanup Scope |
|-------------------|-------------|------|------------------|--------------------|---------------|
{For each *.test.js found: one row. Populate each column from grep results above, or write "none" if not detected. Cleanup Scope = "per-test" if beforeEach/afterEach present, "per-suite" if only beforeAll/afterAll, "none" if absent.}

### Database Isolation

- **Rule:** Each test suite must use a separate DB name or an in-memory store. Tests that share a mutable DB table cannot run in parallel.
- **Declared shared resources:** {list any shared DB fixtures found in test files, or "none detected"}
- **Isolation mechanism:** {detected from test setup: e.g., in-memory sqlite, test-specific DB prefix, transaction rollback}
- **`[P]` legal when:** Test suites do not share any mutable DB resource.
- **`[P]` BLOCKED when:** Two tasks touch the same declared-shared DB table without per-test isolation.

### Port Namespacing

- **Rule:** Tests that start a server must use a unique port or a random available port. Tests sharing a fixed port cannot run in parallel.
- **Fixed ports detected:** {list of `file:line port=NNNN` entries from grep above, or "none detected"}
- **`[P]` legal when:** No two parallel tasks bind the same port.
- **`[P]` BLOCKED when:** Two tasks bind the same hardcoded port.

### Environment Variables

- **Rule:** Tests that mutate `process.env` keys without restoring them after each test contaminate sibling suites running in the same process. Tests in separate worker processes are isolated by OS-level fork, but shared-process runners (e.g., Jest `--runInBand`) are not.
- **Env vars mutated:** {list of `FILE: process.env.KEY = ...` entries from grep above, or "none detected"}
- **Restore pattern detected:** {`afterEach(() => { delete process.env.KEY })` or equivalent, or "not detected"}
- **`[P]` legal when:** Each suite either runs in an isolated worker process OR restores all mutated env vars in afterEach.
- **`[P]` BLOCKED when:** Two tasks mutate the same env key in a shared-process runner without per-test restore.

### Filesystem Races

- **Rule:** Tests that write to shared temp paths (e.g., `/tmp/fixture`, `__fixtures__/output`) without unique-per-test filenames race when run in parallel.
- **Shared paths detected:** {list of `FILE: fs.writeFileSync('path', ...)` entries where path is a static string, or "none detected"}
- **Uniqueness mechanism:** {detected e.g., `path.join(tmpdir(), uuid())`, `os.tmpdir() + testId`, or "none detected"}
- **`[P]` legal when:** Each suite writes to a unique path (per-test tmp prefix or test-name-scoped dir).
- **`[P]` BLOCKED when:** Two tasks write to the same static filesystem path without locking.

### Shared Fixture Cleanup

- **Rule:** Shared fixture state (files, env vars, global singletons) must be cleaned up per-test (beforeEach/afterEach). Table-level cleanup (truncate/drop) is acceptable between suites but not within a parallel wave.
- **Suites with per-test cleanup (safe):** {list of test files that use beforeEach/afterEach for all shared state, or "none detected"}
- **Suites with per-suite cleanup only (risky):** {list of test files using only beforeAll/afterAll for shared state, or "none detected"}
- **`[P]` legal when:** Each task's tests perform full fixture cleanup via beforeEach/afterEach.
- **`[P]` BLOCKED when:** A task relies on leftover state from a previous task's test run.

### Summary Gate

`df:plan` MUST check this checklist before emitting `[P]` for any task pair (Task A, Task B):

- [ ] **DB**: Neither A nor B shares a DB table with the other unless both have per-test isolation (transaction rollback or in-memory DB)
- [ ] **Port**: A and B do not bind the same hardcoded port number
- [ ] **Env**: A and B do not mutate the same `process.env` key in a shared-process runner without per-test restore
- [ ] **FS**: A and B do not write to the same static filesystem path without unique-per-test scoping
- [ ] **Fixture**: A's test setup does not depend on state left by B's teardown (or vice versa) — i.e., both suites use `beforeEach`/`afterEach` for all shared state, not `beforeAll`/`afterAll` only

`[P]` is legal for the task pair only when ALL five boxes above can be checked. If ANY box cannot be checked, `[P]` MUST be omitted for that pair.
```

#### 5.6 INTEGRATIONS.md

Sources: `package.json`, env var patterns, external URL references

Run to gather integration points:
```bash
grep -r 'https://' src/ hooks/ bin/ --include='*.js' --include='*.md' -l 2>/dev/null | head -20
```

```bash
test -f .env.example && cat .env.example || echo 'NOT_FOUND'
```

```markdown
---
sources:
  - package.json
  - .env.example
  - src/
  - hooks/
hashes:
  package.json: {sha256}
  .env.example: {sha256 or "absent"}
generated: {ISO-8601 timestamp}
---

# Integrations

## External Services

{List external services detected from package.json dependencies, .env.example vars, and URL patterns in source}

| Service | Evidence | Config key |
|---------|----------|------------|
{rows derived from grep results and .env.example}

## Environment Variables

{List from .env.example (if present) or inferred from source grep for process.env references}

| Variable | Purpose | Required |
|----------|---------|---------|
{rows}

## Claude / Anthropic SDK

- Model access: via Claude Code's built-in Agent/Task tool (no direct SDK calls in deepflow source)
- Hook protocol: stdin JSON → stdout JSON (PreToolUse / PostToolUse)
- Skill injection: markdown files consumed by Claude Code's skill system

## Notable External URLs Referenced

{List from grep results, deduped}
```

### 6. WRITE ARTIFACTS

For each artifact being generated (skipped if idempotent per §4):

1. Render the full markdown content with the correct YAML frontmatter (including freshly computed `hashes:`)
2. Write to `.deepflow/codebase/{NAME}.md`
3. Verify the write succeeded by reading back the first 5 lines and confirming the YAML fence `---` is present

**Write format requirement:** The file MUST start with `---` on line 1 (YAML frontmatter fence). The content body begins after the closing `---`.

### 7. REPORT

After all artifacts are processed, print a summary:

```
/df:map complete

Artifacts:
  STACK.md         {written | unchanged}
  ARCHITECTURE.md  {written | unchanged}
  CONVENTIONS.md   {written | unchanged}
  STRUCTURE.md     {written | unchanged}
  TESTING.md       {written | unchanged}
  INTEGRATIONS.md  {written | unchanged}

Location: .deepflow/codebase/
Regenerate single artifact: /df:map --only {NAME}
```

## Idempotency Contract (AC-9)

Running `/df:map` twice without any code changes MUST produce byte-identical artifacts on the second run. This is achieved by:
1. Computing fresh hashes from disk
2. Comparing against hashes stored in existing artifact frontmatter
3. Skipping write when ALL hashes match (§4)

The `generated:` timestamp in frontmatter is set ONCE at first write and preserved on skip. It is NOT updated on re-read.

## Rules

- **Hash-only staleness** — no AST parsing, no git dependency. sha256 of file content only.
- **No collisions** — write only to `.deepflow/codebase/`. Never overwrite any other `.deepflow/` file.
- **Non-blocking errors** — if a source file is missing, record `"absent"` as its hash and note the absence in the artifact body. Do not abort.
- **Frontmatter required** — every artifact MUST have valid YAML frontmatter with `sources:` (list) and `hashes:` (map with at least one entry). Malformed frontmatter blocks staleness detection and injection hooks.
- **Body non-empty** — each artifact MUST have non-empty content below the closing `---` frontmatter fence.
- **`--only` regenerates unconditionally** — when `--only` is specified, skip the idempotency hash check and always write the target artifact fresh. This allows forcing a refresh after edits.
