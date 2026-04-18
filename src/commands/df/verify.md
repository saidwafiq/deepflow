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
/df:verify                        # Verify doing-* specs with all tasks completed
/df:verify doing-upload           # Verify specific spec
/df:verify --re-verify            # Re-verify done-* specs (already merged)
/df:verify --diagnostic doing-upload  # L0-L4 only; write results to diagnostics yaml; no merge/fix/rename
/df:verify --no-auto-fix          # Add fix tasks but do NOT invoke /df:execute --continue automatically
/df:verify --from-execute         # Internal flag set by df:execute; disables auto-fix to prevent recursion
```

## Flag Parsing (Prologue)

Parse `ARGS` (the raw argument string passed to this command) at invocation time. Set the following variables before any other step:

```
AUTO_FIX_ENABLED = true   # default
FROM_EXECUTE     = false  # default

if ARGS contains "--no-auto-fix":
    AUTO_FIX_ENABLED = false

if ARGS contains "--from-execute":
    FROM_EXECUTE     = true
    AUTO_FIX_ENABLED = false   # disable auto-fix regardless of other flags; prevents recursion
```

These variables govern §3 (GENERATE REPORT) behavior:
- When `AUTO_FIX_ENABLED = true` AND issues are found: after adding fix tasks, invoke `/df:execute --continue` automatically.
- When `AUTO_FIX_ENABLED = false` AND issues are found: add fix tasks as usual, but print `Run /df:execute --continue` instead of invoking it.
- `FROM_EXECUTE` is informational (logged in report header as `[from-execute]`) and forces `AUTO_FIX_ENABLED = false`.

## Spec File States
`specs/feature.md` → unplanned (skip) | `doing-*.md` → default target | `done-*.md` → `--re-verify` only

## Diagnostic Mode (`--diagnostic`)

When invoked with `--diagnostic`:

- Run **L0-L4.5 only** (skip L5 entirely, even if frontend detected).
- Write results to `.deepflow/results/final-test-{spec}.yaml` under a `diagnostics:` key:
  ```yaml
  diagnostics:
    spec: doing-upload
    timestamp: 2024-01-15T10:30:00Z
    L0: pass          # or fail
    L1: pass          # or fail
    L2: pass          # or warn (no tool)
    L4: fail          # or pass
    L4.5: pass        # or fail or skip (no deps)
    summary: "L0 ✓ | L1 ✓ | L2 ⚠ | L3 — | L4 ✗ | L4.5 ✓"
  ```
- Prefix all report output with `[DIAGNOSTIC]`.
- **Skip entirely:** Post-Verification merge (§4), fix task creation, spec rename, decision extraction, PLAN.md cleanup (step 6).
- Does **not** count as a revert for the circuit breaker.
- Does **not** modify `auto-snapshot.txt`.

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

**L3: AC coverage verification** — Verify that agent-reported acceptance criteria coverage matches the spec's acceptance criteria section. Parse spec file for `## Acceptance Criteria` section, extract all ACs. For each AC, verify that agent execution explicitly claimed coverage (via agent output or PLAN.md task completion notes). Missing or uncovered ACs → FAIL with list of uncovered ACs. All ACs claimed → pass.

**L4: Tests** — Run AFTER L0 passes. Run even if L1-L2 had issues. Exit 0 → pass. Non-zero → FAIL with last 50 lines + fix task. If `quality.test_retry_on_fail: true`: re-run once; second pass → warn (flaky); second fail → genuine failure.

**L4.5: Cross-Spec Integration** (if integration tasks exist)

**Trigger:** Current spec's PLAN.md section contains `[INTEGRATION]` tasks, OR spec has `depends_on` referencing `done-*` specs.

**Check:** Load dependent specs (`specs/done-*.md` referenced in `depends_on` or connected via integration tasks). For each:
1. Re-run L0 (build) — already covered by standard L0, skip
2. Re-run L4 (tests) — already covered by standard L4, skip
3. **Contract verification (code-first, not spec-first):**
   - For each `Produces` interface in dependent specs, verify against the ACTUAL CODE, not the spec declaration:
     - API routes: grep for the handler, read the response struct/type → this is the real contract
     - DB tables: read the latest migration files → actual column names and types
     - Shared types: read the type definition → actual fields
   - If the spec declaration differs from the code, the CODE is the source of truth (specs may be stale after fix cycles)
   - Then verify that the CURRENT spec's consumers match the code's actual shape
4. **Stale spec detection** — if a done-* spec's `## Interfaces` section doesn't match the code, emit advisory warning:
   ```
   ⚠ Stale interface: done-auth-spec declares POST /login → { access_token, refresh_token }
     but code returns { token, refresh }. Spec should be updated.
   ```
5. **Migration idempotency** — if migrations exist: run `{build_command}` twice (the build already runs migrations in most Go/Node projects). If a dedicated migration command exists in config (`quality.migration_command`), run it twice and verify exit 0 both times.

**Outcome:** Pass if all contracts verified against code. Fail with specific mismatches:
```
✗ L4.5: Contract mismatch
  - done-auth code returns POST /api/v1/auth/login → { token: string }
    but operator SPA sends { api_key } in body (expected { token })
  - done-backend code stores rounds.result_json as TEXT
    but current spec reads it with JSONB operators
⚠ L4.5: Stale spec (advisory, not blocking)
  - done-auth-spec declares { access_token } but code returns { token }
```

Fix task on L4.5 failure: prescriptive — names the exact contract from CODE (not spec), the producer, the consumer, and which side should change (prefer changing consumer to match producer's actual implementation).

**L5: Browser Verification** (if frontend detected)

Algorithm: detect frontend → resolve dev command/port → start server → poll readiness → read assertions from PLAN.md → auto-install Playwright Chromium → evaluate via `locator.ariaSnapshot()` → screenshot → retry once on failure → report.

**Step 1: Detect frontend.** Config `quality.browser_verify` overrides: `false` → always skip (`L5 — (no frontend)`), `true` → always run, absent → auto-detect using BOTH conditions:

1. Frontend framework found in package.json (deps or devDeps):

| Package(s) | Framework |
|------------|-----------|
| `next` | Next.js |
| `react`, `react-dom` | React |
| `nuxt` | Nuxt |
| `vue`, `@vue/*` | Vue |
| `@sveltejs/kit` | SvelteKit |
| `svelte`, `@sveltejs/*` | Svelte |

2. A `browser_assertions:` block exists in PLAN.md scoped to the current spec.

**Auto-detect outcomes (no config override):**
- No frontend detected → `L5 — (no frontend)`, skip remaining L5 steps.
- Frontend detected but no `browser_assertions:` block in PLAN.md for current spec → `L5 — (no browser_assertions in PLAN.md)`, skip remaining L5 steps.
- Both conditions met → proceed to Steps 2–6.

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

All L5 outcomes: `✓` pass | `⚠` passed on retry | `✗` both failed (same) | `✗ (flaky)` both failed (different) | `— (no frontend)` | `— (no browser_assertions in PLAN.md)` | `— (no assertions)` | `✗ (install failed)`

**Fix task on L5 failure:** Append to PLAN.md under spec section with next T{n} ID. Include: failing assertions (selector + detail), first 40 lines of `locator('body').ariaSnapshot()` DOM excerpt, screenshot path, flakiness note if assertion sets differed.

### 3. GENERATE REPORT

**Success:** `doing-upload.md: L0 ✓ | L1 ✓ (5/5 files) | L2 ⚠ (no coverage tool) | L3 — (subsumed) | L4 ✓ (12 tests) | L4.5 ✓ (3 contracts) | L5 ✓ | 0 quality issues`

**Failure:**
```
doing-upload.md: L0 ✓ | L1 ✗ (3/5 files) | L2 ⚠ | L3 — | L4 ✗ (3 failed) | L4.5 ✗ (1 mismatch) | L5 ✗ (2 assertions failed)

Issues:
  ✗ L1: Missing files: src/api/upload.ts, src/services/storage.ts
  ✗ L4: 3 test failures
    FAIL src/upload.test.ts > should validate file type
  ✗ L4.5: Contract mismatch — done-auth produces { access_token } but operator sends { api_key }

Fix tasks added to PLAN.md:
  T10: Implement missing upload endpoint and storage service
  T11: Fix operator login to send access_token per auth spec contract

Run /df:execute --continue to fix in the same worktree.
```

**Gate conditions (ALL must pass to merge):** L0 build (or no command) | L1 all files in diff | L2 coverage held (or no tool) | L4 tests pass (or no command) | L4.5 contracts match (or no dependencies/integration tasks) | L5 assertions pass (or no frontend/assertions).

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
- **No LSP diagnostics** — Use ONLY build/test command exit codes and output for L0/L4. Do NOT use the LSP tool to collect TypeScript diagnostics — worktree environments have incomplete `node_modules` symlinks that produce false-positive module-resolution errors (2307, 2875). If the build command exits 0, L0 passes — do not second-guess it with LSP.
- **No narration of false positives** — Never output diagnostics and then explain they are false positives. If you know they are false positives, suppress them entirely. Wasted output tokens cost money.

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL gates pass AND `--diagnostic` was NOT used.**

1. **Discover worktree:** Read `.deepflow/checkpoint.json` for `worktree_branch`/`worktree_path`. Fallback: infer from `doing-*` spec name + `git worktree list --porcelain`. No worktree → "nothing to merge", exit.
2. **Merge:** `git checkout main && git merge ${BRANCH} --no-ff -m "feat({spec}): merge verified changes"`. On conflict → keep worktree, output "Resolve manually, run /df:verify --merge-only", exit.
3. **Cleanup:** `git worktree remove --force ${PATH} && git branch -d ${BRANCH} && rm -f .deepflow/checkpoint.json`
4. **Rename spec & archive:** `mv specs/doing-${NAME}.md specs/done-${NAME}.md`, then:
   ```sh
   mkdir -p .deepflow/specs-done/
   if [ -f "specs/done-${NAME}.md" ]; then
     mv "specs/done-${NAME}.md" ".deepflow/specs-done/"
   fi
   ```
5. **Delete per-spec auto-snapshot:** `rm -f ".deepflow/auto-snapshot-${NAME}.txt"`
6. **Cleanup stale plans:** `rm -f .deepflow/plans/doing-${NAME}.md`
6a. **Delete per-spec result files:** Extract task IDs from the plan file (now renamed to `done-${NAME}.md`) and delete their result artifacts:
   ```sh
   TIDS=$(grep -oE '\*\*T[0-9]+\*\*' ".deepflow/plans/done-${NAME}.md" 2>/dev/null | tr -d '*' | sort -u)
   for TID in $TIDS; do
     rm -f ".deepflow/results/${TID}.yaml"
   done
   ```
   Scoped to this spec's task IDs only — never globs all results. Missing plan file → empty `$TIDS` → silent no-op (idempotent).
6b. **Delete per-spec plan files:** Delete both the done and doing plan files (doing already deleted at step 6, confirm and delete done):
   ```sh
   rm -f ".deepflow/plans/done-${NAME}.md" ".deepflow/plans/doing-${NAME}.md"
   ```
   Idempotent: missing files are silent no-ops.
7. **Extract decisions (additive):** Read done spec, extract `[APPROACH]`/`[ASSUMPTION]`/`[PROVISIONAL]`/`[FUTURE]`/`[UPDATE]` decisions, append to `.deepflow/decisions.md` under `### {date} — {spec}` header. If the header already exists (decisions were captured incrementally during execution via §5.5.1), append only NEW decisions not already present (deduplicate by comparing decision text). Delete done spec after successful write; preserve on failure.
8. **Clean PLAN.md:** Find the `### {spec-name}` section (match on name stem, strip `doing-`/`done-` prefix). Delete from header through the line before the next `### ` header (or EOF). Recalculate Summary table (recount `### ` headers for spec count, `- [ ]`/`- [x]` for task counts). If no spec sections remain, delete PLAN.md entirely. Skip silently if PLAN.md missing or section already gone.

Output: `✓ Merged → main | ✓ Cleaned worktree | ✓ Spec → done | ✓ Decisions extracted | ✓ Cleaned PLAN.md | Workflow complete! Ready: /df:spec <name>`
