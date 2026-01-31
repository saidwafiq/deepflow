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

After successful verification, document significant learnings:

**When to write experiment:**
- Non-trivial implementation approach was used
- Alternative approaches were considered/rejected during planning
- Performance optimizations were made
- Integration patterns were discovered

**Write to:** `.deepflow/experiments/{domain}--{approach}--success.md`

**Format:**
```markdown
# {Approach} [SUCCESS]
Objective: {What was the goal}
Context: {Spec reference, why this was needed}
Approach: {What was implemented}
Why it worked: {Key insight}
Files: {Main files involved}
```

**Skip when:**
- Simple CRUD, no learnings
- Standard patterns, well-documented
- User declines ("No significant learnings")

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
