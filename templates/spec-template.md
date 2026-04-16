---
# derives-from: done-{parent-spec-name}  # optional: links this spec to a parent for lineage/rework tracking
---

# {Name}

## Objective

[One sentence: what this achieves for the user]

## Requirements

- **REQ-1**: [Requirement description]
- **REQ-2**: [Requirement description]
- **REQ-3**: [Requirement description]

## Constraints

- [Constraint 1: e.g., "Max file size 10MB"]
- [Constraint 2: e.g., "Must work offline"]

## Dependencies

<!-- Optional. List specs that must be completed before this one. -->
<!-- - depends_on: doing-other-spec-name -->

## Interfaces

<!-- Optional but RECOMMENDED for multi-spec projects. Declare what this spec produces and consumes.
     /df:plan uses these to auto-generate integration tasks when specs share contracts. -->

<!-- ### Produces
- `POST /api/v1/auth/login` → `{ access_token: string, refresh_token: string }`
- `table: operators` columns: `id, api_key_hash, scopes`
- `type: SessionState` from `packages/shared/types.ts` -->

<!-- ### Consumes
- `POST /api/v1/auth/login` from done-auth-spec (expects `{ access_token }`)
- `table: operators` expects column `api_key_hash`
- `type: SessionState` from packages/shared -->

## Out of Scope

- [Explicitly excluded: e.g., "Video upload is NOT included"]

## Domain Model

<!-- Optional. Define the core entities and vocabulary. -->

### Key Types

```typescript
// Core domain types and entities
```

### Ubiquitous Language

- **Term**: Definition
- **Term**: Definition

_Note: Keep to max 15 terms for clarity._

## Acceptance Criteria

<!-- Each AC MUST start with "- [ ] **AC-N**" and trace to one or more REQ-N in parentheses.
     Never reuse REQ-N as the AC identifier — the lint flags both a missing **AC-N** marker
     AND a duplicate REQ-N ID (since the same REQ-N would appear in both sections). -->

- [ ] **AC-1** — (REQ-1) [Testable criterion: e.g., "User can upload jpg/png/webp files"]
- [ ] **AC-2** — (REQ-2) [Testable criterion: e.g., "Files over 10MB show clear error"]
- [ ] **AC-3** — (REQ-3) [Testable criterion: e.g., "Upload progress is visible"]

## Technical Notes

[Optional: implementation hints, preferred libraries, architectural decisions]

---

<!--
Spec Layers (onion model):
Specs don't need to be complete to be useful. The layer is computed
from which sections exist — /df:plan gates task generation accordingly.

  L0 (Objective only)                    → spikes only
  L1 (+ Requirements)                    → targeted spikes
  L2 (+ Acceptance Criteria)             → implementation tasks
  L3 (+ Constraints, Out of Scope, Tech) → full impact analysis + optimize

Start at L0. Let spikes deepen the spec. Each layer adds knowledge, not guesswork.

Other guidelines:
- Keep under 100 lines
- Requirements must be testable
- Acceptance criteria must be verifiable
- Be explicit about what's OUT of scope
-->
