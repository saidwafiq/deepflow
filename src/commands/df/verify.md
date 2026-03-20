---
name: df:verify
description: Check that implemented code satisfies spec requirements and acceptance criteria through machine-verifiable checks
context: fork
---

# /df:verify — Verify Specs Satisfied

**OUTPUT:** Terse. No narration. No reasoning. Only the compact report (section 3). One line per level, issues block if any, next step.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Usage
```
/df:verify                  # Verify doing-* specs with all tasks completed
/df:verify doing-upload     # Verify specific spec
/df:verify --re-verify      # Re-verify done-* specs (already merged)
```

## Spec File States
`specs/feature.md` → unplanned (skip) | `doing-*.md` → default target | `done-*.md` → `--re-verify` only

## Behavior

### 1. LOAD CONTEXT

Load: `!`ls specs/doing-*.md 2>/dev/null || echo 'NOT_FOUND'``, `!`cat PLAN.md 2>/dev/null || echo 'NOT_FOUND'``, source code. Load `specs/done-*.md` only if `--re-verify`.

**Readiness:** All tasks `[x]` → proceed. Some `[ ]` → warn incomplete, suggest `/df:execute`. No `doing-*` specs → report counts, suggest `/df:execute`.

### 1.5. DETECT PROJECT COMMANDS

Config override always wins (`quality.test_command` / `quality.build_command` in `!`cat .deepflow/config.yaml 2>/dev/null || echo 'NOT_FOUND'``).

**Auto-detection (first match wins):**

| File | Build | Test |
|------|-------|------|
| `package.json` with `scripts.build` | `npm run build` | `npm test` (if scripts.test not default placeholder) |
| `pyproject.toml` or `setup.py` | — | `pytest` |
| `Cargo.toml` | `cargo build` | `cargo test` |
| `go.mod` | `go build ./...` | `go test ./...` |
| `Makefile` with `test` target | `make build` (if target exists) | `make test` |

Nothing found → `⚠ No build/test commands detected. L0/L4 skipped. Set quality.test_command in .deepflow/config.yaml`

### 2. VERIFY EACH SPEC

**L0: Build** — Run build command. Exit 0 → pass. Non-zero → FAIL with last 30 lines, add fix task, skip L1-L4.

**L1: Files exist** — Compare `git diff main...HEAD --name-only` in worktree against PLAN.md `Files:` entries. All planned files in diff → pass. Missing → FAIL with list.

**L2: Coverage** — Detect coverage tool (first match wins):

| File/Config | Tool | Command |
|-------------|------|---------|
| `package.json` with `c8` in devDeps | c8 | `npx c8 --reporter=json-summary npm test` |
| `package.json` with `nyc` in devDeps | nyc | `npx nyc --reporter=json-summary npm test` |
| `.nycrc` or `.nycrc.json` exists | nyc | `npx nyc --reporter=json-summary npm test` |
| `pyproject.toml`/`setup.cfg` with coverage config | coverage.py | `python -m coverage run -m pytest && python -m coverage json` |
| `Cargo.toml` + `cargo-tarpaulin` installed | tarpaulin | `cargo tarpaulin --out json` |
| `go.mod` | go cover | `go test -coverprofile=coverage.out ./...` |

No tool → pass with warning. When available: stash changes → run coverage on baseline → stash pop → run coverage on current → compare. Drop → FAIL. Same/improved → pass.

**L3: Integration** — Subsumed by L0 + L4. No separate check.

**L4: Tests** — Run AFTER L0 passes. Run even if L1-L2 had issues. Exit 0 → pass. Non-zero → FAIL with last 50 lines + fix task. If `quality.test_retry_on_fail: true`: re-run once; second pass → warn (flaky); second fail → genuine failure.

**L5: Browser Verification** (if frontend detected)

Algorithm: detect frontend → resolve dev command/port → start server → poll readiness → read assertions from PLAN.md → auto-install Playwright Chromium → evaluate via `locator.ariaSnapshot()` → screenshot → retry once on failure → report.

**Step 1: Detect frontend.** Config `quality.browser_verify` overrides: `false` → always skip (`L5 — (no frontend)`), `true` → always run, absent → auto-detect from package.json (both deps and devDeps):

| Package(s) | Framework |
|------------|-----------|
| `next` | Next.js |
| `react`, `react-dom` | React |
| `nuxt` | Nuxt |
| `vue`, `@vue/*` | Vue |
| `@sveltejs/kit` | SvelteKit |
| `svelte`, `@sveltejs/*` | Svelte |

No frontend detected and no config override → `L5 — (no frontend)`, skip remaining L5 steps.

**Step 2: Dev server lifecycle.**
1. **Resolve dev command:** Config `quality.dev_command` wins → fallback to `npm run dev` if `scripts.dev` exists → none found → skip L5 with warning.
2. **Resolve port:** Config `quality.dev_port` wins → fallback to 3000.
3. **Check existing server:** curl localhost:{port}. If already responding, reuse it (do not kill on exit).
4. **Start & poll:** If not already running, start via `setsid ${DEV_COMMAND} &`. Poll with 0.5s interval up to `quality.browser_timeout` (default 30s). Timeout → FAIL + kill process group + fix task.
5. **Teardown (always runs):** trap EXIT kills the process group (SIGTERM → wait 5s → SIGKILL). No-op when reusing pre-existing server (`DEV_SERVER_PID` empty).

**Step 3: Read assertions from PLAN.md.** Extract `browser_assertions:` YAML block for current spec. Each assertion has `selector` + optional `role`, `name`, `visible`, `text`. No block found → `L5 — (no assertions)`, skip Playwright.

**Step 3.5: Playwright auto-install.** Check `$TMPDIR/.deepflow-pw-chromium-ok` marker. If absent, run `npx --yes playwright install --dry-run chromium` to detect, install if needed, cache marker. Install failure → `L5 ✗ (install failed)`, skip Steps 4-6.

**Step 4: Evaluate assertions.** Launch headless Chromium, navigate to `localhost:{port}`. For each assertion:
- `role`/`name` → check against `locator(selector).ariaSnapshot()` YAML output (NOT deprecated `page.accessibility.snapshot()`)
- `visible` → check `locator.boundingBox()` non-null with width/height > 0
- `text` → check `locator.innerText()` contains expected text

**Step 5: Screenshot.** Always capture full-page screenshot to `.deepflow/screenshots/{spec-name}/{timestamp}.png`.

**Step 6: Retry.** On first failure, retry FULL L5 once (re-navigate, re-evaluate all assertions, capture retry screenshot with `-retry` suffix). Compare failing selector sets between attempts (by selector string only, ignore detail text).

**Outcome matrix:**

| Attempt 1 | Attempt 2 | Result |
|-----------|-----------|--------|
| Pass | — (not run) | L5 ✓ |
| Fail | Pass | L5 ✓ with warning "(passed on retry)" |
| Fail | Fail — same selectors | L5 ✗ — genuine failure |
| Fail | Fail — different selectors | L5 ✗ (flaky) |

All L5 outcomes: `✓` pass | `⚠` passed on retry | `✗` both failed (same) | `✗ (flaky)` both failed (different) | `— (no frontend)` | `— (no assertions)` | `✗ (install failed)`

**Fix task on L5 failure:** Append to PLAN.md under spec section with next T{n} ID. Include: failing assertions (selector + detail), first 40 lines of `locator('body').ariaSnapshot()` DOM excerpt, screenshot path, flakiness note if assertion sets differed.

### 3. GENERATE REPORT

**Success:** `doing-upload.md: L0 ✓ | L1 ✓ (5/5 files) | L2 ⚠ (no coverage tool) | L3 — (subsumed) | L4 ✓ (12 tests) | L5 ✓ | 0 quality issues`

**Failure:**
```
doing-upload.md: L0 ✓ | L1 ✗ (3/5 files) | L2 ⚠ | L3 — | L4 ✗ (3 failed) | L5 ✗ (2 assertions failed)

Issues:
  ✗ L1: Missing files: src/api/upload.ts, src/services/storage.ts
  ✗ L4: 3 test failures
    FAIL src/upload.test.ts > should validate file type

Fix tasks added to PLAN.md:
  T10: Implement missing upload endpoint and storage service

Run /df:execute --continue to fix in the same worktree.
```

**Gate conditions (ALL must pass to merge):** L0 build (or no command) | L1 all files in diff | L2 coverage held (or no tool) | L4 tests pass (or no command) | L5 assertions pass (or no frontend/assertions).

**All pass →** Post-Verification merge. **Issues found →** Add fix tasks to worktree PLAN.md (IDs continue from last), register via TaskCreate/TaskUpdate, output report + "Run /df:execute --continue". Do NOT create new specs, worktrees, or merge with issues pending.

### 4. CAPTURE LEARNINGS

On success, if non-trivial approach used (not simple CRUD), write to `.deepflow/experiments/{domain}--{approach}--success.md`:
```
# {Approach} [SUCCESS]
Objective: ... | Approach: ... | Why it worked: ... | Files: ...
```

## Rules
- Verify against spec, not assumptions
- Flag partial implementations
- All checks machine-verifiable — no LLM judgment
- Don't auto-fix — add fix tasks to PLAN.md, then `/df:execute --continue`
- Capture learnings for significant approaches
- **Terse output** — Output ONLY the compact report format (section 3)

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL gates pass.**

1. **Discover worktree:** Read `.deepflow/checkpoint.json` for `worktree_branch`/`worktree_path`. Fallback: infer from `doing-*` spec name + `git worktree list --porcelain`. No worktree → "nothing to merge", exit.
2. **Merge:** `git checkout main && git merge ${BRANCH} --no-ff -m "feat({spec}): merge verified changes"`. On conflict → keep worktree, output "Resolve manually, run /df:verify --merge-only", exit.
3. **Cleanup:** `git worktree remove --force ${PATH} && git branch -d ${BRANCH} && rm -f .deepflow/checkpoint.json`
4. **Rename spec:** `mv specs/doing-${NAME}.md specs/done-${NAME}.md`
5. **Extract decisions:** Read done spec, extract `[APPROACH]`/`[ASSUMPTION]`/`[PROVISIONAL]` decisions, append to `.deepflow/decisions.md` as `### {date} — {spec}\n- [TAG] decision — rationale`. Delete done spec after successful write; preserve on failure.
6. **Clean PLAN.md:** Find the `### {spec-name}` section (match on name stem, strip `doing-`/`done-` prefix). Delete from header through the line before the next `### ` header (or EOF). Recalculate Summary table (recount `### ` headers for spec count, `- [ ]`/`- [x]` for task counts). If no spec sections remain, delete PLAN.md entirely. Skip silently if PLAN.md missing or section already gone.

Output: `✓ Merged → main | ✓ Cleaned worktree | ✓ Spec complete | ✓ Cleaned PLAN.md | Workflow complete! Ready: /df:spec <name>`
