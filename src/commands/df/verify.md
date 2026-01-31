# /df:verify — Verify Specs Satisfied

## Purpose
Check that implemented code satisfies spec requirements and acceptance criteria.

## Usage
```
/df:verify                  # Verify all done-* specs
/df:verify --doing          # Also verify in-progress specs
/df:verify done-upload      # Verify specific spec
```

## Skills & Agents
- Skill: `code-completeness` — Find incomplete implementations
- Agent: `Explore` (Haiku) — Fast codebase scanning

## Spec File States

```
specs/
  feature.md        → Unplanned (skip)
  doing-auth.md     → In progress (verify with --doing)
  done-upload.md    → Completed (default verify target)
```

## Behavior

### 1. LOAD CONTEXT

```
Load:
- specs/done-*.md (completed specs to verify)
- specs/doing-*.md (if --doing flag)
- Source code (actual implementation)
```

If no done-* specs: report counts, suggest `--doing`.

### 2. VERIFY EACH SPEC

Check requirements, acceptance criteria, and quality (stubs/TODOs).
Mark each: ✓ satisfied | ✗ missing | ⚠ partial

### 3. GENERATE REPORT

Report per spec: requirements count, acceptance count, quality issues.
If issues: suggest creating fix spec or reopening (`mv done-* doing-*`).

### 4. CAPTURE LEARNINGS

On success, write significant learnings to `.deepflow/experiments/{domain}--{approach}--success.md`

**Write when:**
- Non-trivial approach used
- Alternatives rejected during planning
- Performance optimization made
- Integration pattern discovered

**Format:**
```markdown
# {Approach} [SUCCESS]
Objective: ...
Approach: ...
Why it worked: ...
Files: ...
```

**Skip:** Simple CRUD, standard patterns, user declines

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
- Capture learnings — Write experiments for significant approaches

## Agent Usage

Spawn `Explore` agents (Haiku), 1-2 per spec, cap 10.

## Example

```
/df:verify

done-upload.md: 4/4 reqs ✓, 5/5 acceptance ✓, clean
done-auth.md: 2/2 reqs ✓, 3/3 acceptance ✓, clean

✓ All specs verified

Learnings captured:
  → experiments/perf--streaming-upload--success.md
  → experiments/auth--jwt-refresh-rotation--success.md
```
