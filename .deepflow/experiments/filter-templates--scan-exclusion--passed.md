# Experiment: Filter Template Auto-Wiring Exclusion

## Hypothesis

`scanHookEvents` in `hooks/lib/installer-utils.js` relies on `@hook-event` tags to discover hooks. Files under `hooks/filters/templates/**` without an `@hook-event` tag will NOT be auto-wired into `settings.json` hooks by the installer.

## Method

1. Read `hooks/lib/installer-utils.js` to understand the scanning logic.
2. Created two probe files:
   - `hooks/filters/templates/_probe.js` — no `@hook-event` tag, placed in subdirectory
   - `hooks/_probe-direct.js` — `@hook-owner: deepflow` but no `@hook-event` tag, placed directly in `hooks/`
3. Ran `scanHookEvents('hooks', 'deepflow')` from the worktree installer-utils.
4. Verified which files appeared in the `eventMap` (auto-wired) vs `untagged` array vs not scanned at all.
5. Cleaned up probe files after experiment.

## Results

### How scanHookEvents Discovers Hooks

**Source:** `hooks/lib/installer-utils.js` lines 42-86

**Mechanism:**
1. **File pattern:** `fs.readdirSync(hooksSourceDir)` — only scans files directly in the `hooks/` directory, NOT subdirectories.
2. **File filter:** Must end with `.js` AND NOT end with `.test.js` (line 49).
3. **Owner filter:** When `filterOwner` is provided, file must have `// @hook-owner: <filterOwner>` tag in first 10 lines, otherwise skipped (lines 55-58).
4. **Event detection:** Regex `/\/\/\s*@hook-event:\s*(.+)/` matches tags in first 10 lines (line 60).
5. **Event validation:** Events must be in `VALID_HOOK_EVENTS` set, otherwise warnings issued (lines 71-74).
6. **Return structure:**
   - `eventMap`: Map of event → [filenames] for files WITH valid `@hook-event` tags
   - `untagged`: Array of filenames that passed owner filter but have NO valid `@hook-event` tag

### Probe Results

**Subdirectory probe (`hooks/filters/templates/_probe.js`):**
- **Scanned:** NO
- **In eventMap:** NO
- **In untagged:** NO
- **Reason:** `fs.readdirSync` is non-recursive — subdirectories are never scanned.

**Direct probe (`hooks/_probe-direct.js`):**
- Has `@hook-owner: deepflow`
- Has NO `@hook-event` tag
- **Scanned:** YES
- **In eventMap:** NO
- **In untagged:** YES
- **Reason:** Passed owner filter, failed event detection, correctly added to untagged array.

## Criteria Check

- **Subdirectory exclusion:** PASS — `hooks/filters/templates/` is NOT scanned (non-recursive scan)
- **Tag absence exclusion:** PASS — files without `@hook-event` tag are NOT auto-wired (added to untagged, not eventMap)
- **Owner filter behavior:** PASS — files without matching `@hook-owner` are skipped entirely when filter is active

## Conclusion

**PASSED** — Filter template files placed in `hooks/filters/templates/` will NOT be auto-wired by the installer because:
1. `scanHookEvents` only scans files directly in `hooks/`, not subdirectories.
2. Even if a file were placed directly in `hooks/`, the absence of `@hook-event` tag prevents auto-wiring (file would appear in untagged list but NOT in eventMap).

### Confidence

**HIGH** — Evidence is based on:
- Source code reading (exact scanning logic)
- Empirical testing with probe files in both scenarios
- Confirmed behavior matches code logic exactly

### Recommendation for T16

Filter template files in `hooks/filters/templates/` do NOT need special naming conventions to avoid auto-wiring. The subdirectory location alone is sufficient to prevent scanning.

**Safe to:**
- Place any `.js` file in `hooks/filters/templates/` without risk of auto-wiring
- Use any naming convention (e.g., `base.js`, `filter-template.js`, etc.)
- Omit `@hook-event` tags from template files (best practice for clarity)

**Not needed:**
- Special file naming patterns (e.g., `_template-*.js`)
- Path exclusion logic in installer
- Explicit "do not scan" markers

**Best practice:**
- DO include `@hook-owner: deepflow` in template files for ownership clarity
- DO NOT include `@hook-event` tags in template files (they are templates, not active hooks)
- Place all filter templates in `hooks/filters/templates/` to keep them organized and auto-excluded
