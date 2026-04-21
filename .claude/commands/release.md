Commit current changes with an intelligent message, then run the release script for bump/push/publish.

## Steps

1. **Check** — Run `git status` and `git diff`. If no changes to commit, skip to step 3.
2. **Review user-facing artifacts** — Before committing, check if changes affect user-facing behavior (new features, changed commands, moved files, new requirements). If so, verify that `README.md` and `bin/install.js` (install output + uninstall list) are up to date. Fix any stale references before committing.
3. **Commit** — Stage the changed files (specific files, not `-A`) and commit with a conventional commit message based on the diff. Follow the repo's existing style from `git log --oneline -5`.
4. **Write release notes** — Read `git log --oneline {prev_tag}..HEAD` to get all commits since the last tag. Write human-readable release notes with:
   - A short intro sentence summarising the release theme (1 line)
   - A `### What's new` section with bullet points grouped by area (commands, skills, agents, infra) — write from the user's perspective ("You can now…", "Fixed…"), not from the commit message perspective
   - A `### Fixes & internals` section for non-user-facing changes (optional, omit if empty)
   - Keep it to ≤15 bullets total
   Store the notes in a shell variable `RELEASE_NOTES` for use in step 5.
5. **Update CHANGELOG.md** — Prepend the new version block to `CHANGELOG.md` (create the file if it doesn't exist):
   ```
   ## v{VERSION} — {YYYY-MM-DD}

   {RELEASE_NOTES}
   ```
   Stage and commit: `git add CHANGELOG.md && git commit -m "chore: update CHANGELOG for v{VERSION}"`
6. **Release** — Run the release script in a single Bash call, passing the release notes body inline:

```bash
VERSION=$(npm version patch --no-git-tag-version | tr -d 'v') && if npm view "deepflow@$VERSION" version >/dev/null 2>&1; then echo "ERROR: deepflow@$VERSION already exists on npm. Aborting." && exit 1; fi && git add package.json && git commit -m "$VERSION" && git tag "v$VERSION" && git push && git push origin "v$VERSION" && npm publish && gh release create "v$VERSION" --title "v$VERSION" --notes "$RELEASE_NOTES"
```

7. **Report** — Output one line: `✓ published {name}@{version}`

## Rules

- Only the commit message and release notes require intelligence. The release script itself runs exactly as written.
- If there are no changes, still run steps 4–6 (user may want to bump+publish existing commits).
- Release notes must be user-facing: describe what changed from the user's perspective, not from git internals.
- Never use `--generate-notes` — it produces raw commit lists that are useless to end users.
- CHANGELOG.md is the canonical history for existing users; always update it before publishing.
