---
name: atomic-commits
description: Makes atomic commits with clean messages. Use when committing code, implementing tasks, or preparing git history. Ensures one logical change per commit for easy review and rollback.
---

# Atomic Commits

One task = one commit. Clean history, easy rollback.

## Format

```
{type}({scope}): {description}

- {detail}
- {detail}

Task: {id}
```

### Types

| Type | Use |
|------|-----|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change (no behavior change) |
| `test` | Adding/fixing tests |
| `docs` | Documentation |

### Example

```
feat(image-upload): create upload API endpoint

- Add POST /api/upload route
- Implement multer middleware
- Add file type validation

Task: T1
```

## Process

1. Implement task completely
2. Verify it works (tests, types, lint)
3. Stage specific files (`git add {files}`, not `-A`)
4. Commit with proper format
5. Return hash

## Pre-Commit

- [ ] Code runs without errors
- [ ] No debug logs left
- [ ] No commented code
- [ ] No TODO added
- [ ] Tests pass

## Rules

- Never commit broken code
- Never commit partial work
- Never commit unrelated changes
- One logical change per commit
