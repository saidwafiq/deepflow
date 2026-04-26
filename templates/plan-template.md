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

### Artifact-chain Fields Example

Optional per-task fields sourced from `.deepflow/maps/{spec}/`. Tasks that omit them execute normally via `Files:`.

- [ ] **T0** (example): {Task with all optional fields}
  - Files: {files}
  - Blocked by: none

```
Slice: {code region label, e.g. "auth/login flow"}
Symbols: {key exported symbols modified, e.g. "LoginHandler, AuthToken"}
Impact edges: {callers from impact.md, e.g. "SessionManager (auth.go:42-61) fan-out:3"}
```

The fields above are optional. A minimal task block needs only `Files:` and `Blocked by:`.

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
- Optional artifact-chain fields (omit freely — tasks without them still execute via Files:):
  - Slice: human-readable label for the code region this task touches
  - Symbols: comma-separated list of key exported symbols being modified
  - Impact edges: caller/dependent list sourced from .deepflow/maps/{spec}/impact.md
-->
