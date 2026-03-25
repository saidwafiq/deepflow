---
name: df:lineage
description: Query spec lineage — scan specs for derives-from relationships and print a lineage tree showing parent→child depth
allowed-tools: [Read, Glob, Grep]
---

# /df:lineage — Spec Lineage Tree

Scan `specs/*.md` for `derives-from` frontmatter and print a tree of parent→child relationships.

## Usage
```
/df:lineage [spec-name]
```

- **No argument**: print the full lineage forest (all roots and their descendants).
- **With spec-name**: print only that spec's subtree (descendants) plus its own parent chain (ancestors).

## Behavior

### 1. Collect all specs

Glob `specs/*.md` (and `specs/doing-*.md`, `specs/done-*.md`). For each file, parse the YAML frontmatter to extract `derives-from` if present.

Frontmatter parsing: read the file, extract the block between the first `---` and the second `---`, then match lines of the form `derives-from: <value>` or `derives-from: "<value>"`.

Strip the file extension and path prefix to get the bare spec name (e.g. `specs/done-auth.md` → `done-auth`).

### 2. Build the graph

Build two maps:
- `children`: parent name → list of child names
- `parent`: child name → parent name

### 3. Identify roots

Roots are specs with no `derives-from` entry **that have at least one child**, plus any spec requested explicitly that has no parent.

When a specific `spec-name` is given:
- Collect the ancestor chain upward (following `parent` links) — this becomes the path prefix.
- Then render the requested spec's subtree.

When no argument is given:
- Find all root nodes (specs with no parent). Render a forest: one tree per root.
- Also list any isolated specs (no parent, no children) as a flat list under `## Isolated specs` if there are any.

### 4. Render the tree

Use box-drawing characters:

```
done-auth
├── doing-auth-fix
└── done-auth-v2
    └── doing-auth-v3
```

- `├──` for non-last children, `└──` for the last child.
- Indent continuation lines with `│   ` (pipe + 3 spaces) under `├──`, and `    ` (4 spaces) under `└──`.
- Show depth counter: append `  (depth N)` on the root line where N = max depth of the subtree.

### 5. No-result cases

- If the requested `spec-name` is not found in any spec file: print `No spec named "<spec-name>" found in specs/*.md`.
- If no specs have `derives-from` at all: print `No lineage relationships found. Add derives-from: <parent> to spec frontmatter to track corrections.`

## Example output (no argument)

```
Spec lineage  (3 roots, 6 total)

done-auth  (depth 2)
├── doing-auth-fix
└── done-auth-v2
    └── doing-auth-v3

done-payments  (depth 1)
└── doing-payments-v2

Isolated specs (no lineage):
  spec-search
  spec-notifications
```

## Example output (with argument: `done-auth-v2`)

```
Ancestor chain:
  done-auth → done-auth-v2

done-auth-v2  (depth 1)
└── doing-auth-v3
```

## Implementation notes

Parse frontmatter manually — do not shell out. Use only Read + Glob + Grep tools.

Glob pattern: `specs/*.md`

Frontmatter extraction regex (per file):
```
/^---\n([\s\S]*?)\n---/
```

`derives-from` line regex:
```
/^derives-from:\s*["']?([^"'\n]+)["']?/m
```

Sort children alphabetically before rendering for deterministic output.
