# /df:verify — Verify Specs Satisfied

## Purpose
Check that implemented code satisfies spec requirements and acceptance criteria.

## Usage
```
/df:verify
/df:verify image-upload    # Verify specific spec only
```

## Skills & Agents
- Skill: `code-completeness` — Find incomplete implementations
- Agent: `Explore` (Haiku) — Fast codebase scanning

## Behavior

### 1. LOAD CONTEXT

```
Load:
- specs/*.md (requirements to verify)
- PLAN.md (task completion status)
- Source code (actual implementation)
```

### 2. VERIFY EACH SPEC

For each spec file, check:

#### Requirements Coverage
```
For each REQ-N in spec:
  - Find implementation in code
  - Verify it meets the requirement
  - Mark: ✓ satisfied | ✗ missing | ⚠ partial
```

#### Acceptance Criteria
```
For each criterion:
  - Can it be verified? (testable)
  - Is there evidence it passes?
  - Mark: ✓ | ✗ | ⚠
```

#### Implementation Quality

Use `code-completeness` skill patterns to check for:
- Stub functions (not fully implemented)
- TODO/FIXME comments (incomplete work)
- Placeholder returns (fake implementations)
- Skipped tests (untested code)

### 3. GENERATE REPORT

**If all pass:**
```
✓ Verification complete

specs/image-upload.md
  Requirements: 4/4 ✓
  Acceptance criteria: 5/5 ✓
  Quality: No stubs or TODOs

specs/color-extraction.md
  Requirements: 2/2 ✓
  Acceptance criteria: 3/3 ✓
  Quality: No stubs or TODOs

All specs satisfied.
```

**If issues found:**
```
⚠ Verification found issues

specs/image-upload.md
  Requirements: 3/4
    ✗ REQ-4: Error handling for S3 failures
      Expected: Graceful error with retry option
      Found: No error handling in src/services/storage.ts

  Acceptance criteria: 4/5
    ⚠ "Upload shows progress bar"
      Found: Progress callback exists but UI not connected

  Quality:
    ⚠ src/services/image.ts:67 — TODO: optimize for large files

Action needed:
  1. Add S3 error handling (REQ-4)
  2. Connect progress UI
  3. Complete TODO in image.ts

Run /df:plan to generate fix tasks, or fix manually.
```

### 4. UPDATE STATE

Write findings to STATE.md:
```markdown
## Verification Log

### 2025-01-28 15:30
Verified: image-upload, color-extraction
Result: 1 spec gap, 2 quality issues
Action: Generated fix tasks
```

## Verification Levels

| Level | Check | Method |
|-------|-------|--------|
| L1: Exists | File/function exists | Glob/Grep |
| L2: Substantive | Real code, not stub | Read + analyze |
| L3: Wired | Integrated into system | Trace imports/calls |
| L4: Tested | Has passing tests | Run tests |

Default: L1-L3 (L4 optional, can be slow)

## Rules
- Verify against spec, not assumptions
- Flag partial implementations
- Report TODO/FIXME as quality issues
- Don't auto-fix — report findings for `/df:plan`

## Agent Usage

Spawn `Explore` agents (Haiku) for fast read-only scanning:
- 1-2 agents per spec (based on spec size)
- Cap: 10 parallel agents
- Read-only: safe to parallelize heavily

## Example

```
/df:verify

Verifying 2 specs...

specs/image-upload.md
  ├─ REQ-1: Upload endpoint ✓
  │    src/api/upload.ts exports POST /api/upload
  ├─ REQ-2: File validation ✓
  │    src/middleware/validate.ts checks type, size
  ├─ REQ-3: S3 storage ✓
  │    src/services/storage.ts implements uploadToS3()
  └─ REQ-4: Thumbnails ✓
       src/services/image.ts implements generateThumbnail()

  Acceptance: 5/5 ✓
  Quality: Clean

specs/color-extraction.md
  ├─ REQ-1: Extract colors ✓
  └─ REQ-2: Palette display ⚠
       Found: Component exists but not exported

  Acceptance: 2/3
  Quality: 1 TODO found

Summary:
  Specs: 2
  Passed: 1
  Issues: 1

Run /df:plan to generate fix tasks.
```
