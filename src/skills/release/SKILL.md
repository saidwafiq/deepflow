---
name: release
description: Commit, bump, push & publish. Use after completing changes that need releasing to npm.
---

# Release

Commit current changes with an intelligent message, then run the release script for bump/push/publish.

## Steps

1. **Check** — Run `git status` and `git diff`. If no changes to commit, skip to step 3 (there may be a version to release).
2. **Commit** — Stage the changed files (specific files, not `-A`) and commit with a conventional commit message based on the diff. Follow the repo's existing style from `git log --oneline -5`.
3. **Release** — Run the release script in a single Bash call:

```bash
npm version patch --no-git-tag-version && git add package.json && git commit -m "$(node -p "require('./package.json').version")" && git push && npm publish
```

4. **Report** — Output one line: `✓ published {name}@{version}`

## Rules

- Only the commit message requires intelligence. Everything else is the script above.
- If `git diff` is empty and there are no staged/untracked changes, still run step 3 (user may want to bump+publish existing commits).
- Never modify the release script commands. Run them exactly as written.
