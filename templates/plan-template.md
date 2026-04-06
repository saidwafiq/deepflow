# Plan

Generated: {timestamp}

## Summary

| Metric | Count |
|--------|-------|
| Specs analyzed | 0 |
| Tasks created | 0 |
| Ready (no blockers) | 0 |
| Blocked | 0 |

## Spec Gaps

[Issues found in specs that need clarification]

- [ ] `specs/example.md`: [Gap description]

## Tasks

### {spec-name}

- [ ] **T1**: {Task description}
  - Files: {files to create or modify}
  - Blocked by: none

- [ ] **T2**: {Task description}
  - Files: {files}
  - Blocked by: T1

### Spike Task Example

When no experiments exist to validate an approach, start with a minimal validation spike:

- [ ] **T1** (spike): Validate [hypothesis] approach
  - Files: [minimal files needed]
  - Blocked by: none
  - Blocks: T2, T3, T4 (full implementation)
  - Description: Minimal test to verify [approach] works before full implementation

- [ ] **T2**: Implement [feature] based on spike results
  - Files: [implementation files]
  - Blocked by: T1 (spike)

Spike tasks are 1-2 tasks to validate an approach before committing to full implementation.

### integration

Auto-generated when multiple specs share interfaces (APIs, DB tables, types).

- [ ] **T5** [INTEGRATION]: Verify auth ↔ operator contracts — opus/high | Blocked by: T2, T4
  - Files: internal/auth/login.go, apps/operator/src/auth/AuthProvider.tsx
  - Integration ACs:
    - End-to-end: operator login → token → player bootstrap works
    - Contract: POST /api/v1/auth/login response matches operator SPA expectations
    - Migrations: 001→005 run twice without error (idempotent)

---

<!--
Plan Guidelines:
- One task = one atomic commit
- Tasks should be 15-60 min of work
- Blocked by references task IDs (T1, T2, etc.)
- Mark complete with [x] and commit hash
- Example completed: [x] **T1**: Create API ✓ (abc1234)
- Spike tasks: If no experiments validate the approach, first task should be a minimal validation spike
- Spike tasks block full implementation tasks until the hypothesis is validated
-->
