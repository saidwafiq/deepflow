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

## Out of Scope

- [Explicitly excluded: e.g., "Video upload is NOT included"]

## Acceptance Criteria

- [ ] [Testable criterion: e.g., "User can upload jpg/png/webp files"]
- [ ] [Testable criterion: e.g., "Files over 10MB show clear error"]
- [ ] [Testable criterion: e.g., "Upload progress is visible"]

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
