Commit current changes with an intelligent message, then run the release script for bump/push/publish.

## Steps

1. **Check** — Run `git status` and `git diff`. If no changes to commit, skip to step 3.
2. **Review user-facing artifacts** — Before committing, check if changes affect user-facing behavior (new features, changed commands, moved files, new requirements). If so, verify that `README.md` and `bin/install.js` (install output + uninstall list) are up to date. Fix any stale references before committing.
3. **Commit** — Stage the changed files (specific files, not `-A`) and commit with a conventional commit message based on the diff. Follow the repo's existing style from `git log --oneline -5`.
4. **Release** — Run the release script in a single Bash call:

```bash
VERSION=$(npm version patch --no-git-tag-version | tr -d 'v') && git add package.json && git commit -m "$VERSION" && git tag "v$VERSION" && git push && git push origin "v$VERSION" && npm publish
```

5. **Report** — Output one line: `✓ published {name}@{version}`

## Rules

- Only the commit message requires intelligence. Everything else is the script above.
- If there are no changes, still run step 3 (user may want to bump+publish existing commits).
- Never modify the release script commands. Run them exactly as written.
