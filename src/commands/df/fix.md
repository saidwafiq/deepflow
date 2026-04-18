---
name: df:fix
description: Create a new spec derived from a completed spec to address issues, regressions, or unmet acceptance criteria
allowed-tools: [Read, Write, AskUserQuestion]
---

# /df:fix {done-spec-name} — Create Fix Spec from Completed Spec

## Purpose

Creates a new spec file pre-populated with lineage from a `done-*` spec. Use when a completed feature has regressions, unmet ACs, or needs targeted fixes without reopening the original spec.

## Behavior

### 1. VALIDATE ARGUMENT

The command receives one argument: `{done-spec-name}` (e.g., `done-auth`).

If no argument is provided, ask:
```
Which completed spec needs a fix? (e.g., done-auth)
```

### 2. READ PARENT SPEC

Resolve the parent spec using a dual-path lookup. Given `{done-spec-name}` (e.g., `done-auth`):

1. Try `.deepflow/specs-done/{done-spec-name}.md` (canonical location — written here by verify after T2).
2. If not found, try `specs/{done-spec-name}.md` (legacy location — repos that haven't run verify since upgrading).

In shell terms:
```
SPEC_PATH=""
if [ -f ".deepflow/specs-done/{done-spec-name}.md" ]; then
  SPEC_PATH=".deepflow/specs-done/{done-spec-name}.md"
elif [ -f "specs/{done-spec-name}.md" ]; then
  SPEC_PATH="specs/{done-spec-name}.md"
fi
```

If neither path exists, show:
```
Error: {done-spec-name}.md not found in .deepflow/specs-done/ or specs/.
Make sure the spec exists and uses the done-* prefix.
```
Then stop.

Read the file at `SPEC_PATH`.

Extract from the parent spec:
- **Objective** (from `## Objective` section)
- **Acceptance Criteria** (all items from `## Acceptance Criteria` section)

### 3. ASK WHAT NEEDS FIXING

Use `AskUserQuestion` to ask (max 4 questions per call):

1. What is broken or not working as expected?
2. Which acceptance criteria from the original spec are failing or incomplete? (show the extracted ACs as reference)
3. Any new constraints or scope boundaries for this fix?

### 4. CREATE FIX SPEC

Determine a short name for the fix spec. Default: `fix-{done-spec-name-without-done-prefix}` (e.g., `fix-auth`).

Create `specs/{fix-name}.md`:

```markdown
---
derives-from: {done-spec-name}
---

# Fix: {Title derived from done-spec-name}

## Objective

Fix issues in `{done-spec-name}`: {one sentence summarizing what needs to be fixed, from user input}

## Requirements

- **REQ-1**: [Requirement based on user-described issue]

## Constraints

- Scope limited to fixing regressions/gaps from `{done-spec-name}`
- Must not break passing ACs from the parent spec

## Acceptance Criteria

<!-- Failing ACs carried over from parent spec (preserve their **AC-N** ids) -->
{carried-over failing ACs as unchecked items}

<!-- New ACs for this fix — format MUST be `- [ ] **AC-N** — (REQ-M) ...`.
     Continue AC numbering from the parent spec's last AC; never reuse REQ-N as the AC id. -->
- [ ] **AC-{next}** — (REQ-1) {new criterion from user input, if any}

## Technical Notes

Parent spec: `specs/{done-spec-name}.md`
Parent objective: {parent objective text}
```

### 5. CONFIRM

```
Created specs/{fix-name}.md

derives-from: {done-spec-name}
Carried over {N} ACs from parent spec

Next: Run /df:plan {fix-name} to generate fix tasks
```

## Rules

- Always set `derives-from` in the frontmatter — this is the lineage anchor
- Carry over only ACs that are failing or unverified; do not duplicate passing ones
- Keep fix specs narrowly scoped — no scope creep beyond the stated issue
- Do not reopen or modify the parent `done-*` spec
- Fix spec name must start with `fix-` by default; user may override
- **Protected files — do not touch**: `verify.md`, `.deepflow/decisions.md`, `.deepflow/auto-memory.yaml`, `.deepflow/execution-history.jsonl`, `.deepflow/context.json`, and anything under `.deepflow/experiments/`. The only file this command may write is `specs/{fix-name}.md`.
