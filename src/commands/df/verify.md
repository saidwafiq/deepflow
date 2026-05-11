---
name: df:verify
description: Check that implemented code satisfies spec requirements and acceptance criteria through machine-verifiable checks
context: fork
allowed-tools: [Read, Bash, Write]
---

# /df:verify — Verify Specs Satisfied

**OUTPUT:** Terse. No narration. No reasoning. Only the compact report (section 3). One line per level, issues block if any, next step. No emojis (✓/✗/⚠/— only). No post-merge commentary beyond the single merge-status line in §4.

**NEVER:**
- use EnterPlanMode or ExitPlanMode
- call the LSP tool, `mcp__ide__getDiagnostics`, or any other diagnostics tool — L0/L4 rely SOLELY on build/test command exit codes. Worktrees have symlinked `node_modules` that produce false-positive module-resolution errors (TS 2307, 2875). If the build exits 0, L0 passes — do not second-guess it.
- output diagnostics and then explain they are false positives. If you know they would be false positives, do not collect or display them at all. This rule applies to the parent context after the skill returns as well: do not invoke diagnostics tools on worktree paths post-merge.

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
- **Skip entirely:** Post-Verification merge (§4), fix task creation, spec rename, decision extraction, cleanup (step 6).
- Does **not** count as a revert for the circuit breaker.
- Does **not** modify `auto-snapshot.txt`.

## Behavior

### 1. LOAD CONTEXT

Load: `!`ls specs/doing-*.md 2>/dev/null || echo 'NOT_FOUND'``, source code. Load `specs/done-*.md` only if `--re-verify`.

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

**L1: Files exist** — Parse `## Tasks (curated)` in the spec file; collect the union of all `**Slice:**` paths listed across all task entries. Run `git diff main...HEAD --name-only` on the current branch. All planned slice paths present in the diff → pass. Missing → FAIL with list.

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

**L3: AC test-tag lint** — Parse the spec for `## Acceptance Criteria` and extract all AC identifiers (e.g. `AC-1`, `AC-2`, …). For each AC, the spec MUST satisfy one of:
  1. At least one test file (listed in `.deepflow/auto-snapshot.txt`, falling back to `git ls-files` filtered by the standard test-file glob) contains the literal string `specs/<slug>.md#AC-<n>` where `<slug>` is the spec basename without `doing-`/`done-`/`.md`. Reference may appear anywhere in the file (test name, comment, JSDoc, string literal). Presence of the tag is the signal; the test passing is verified by L4.
  2. The AC's bullet in the spec contains the marker `[advisory]`, declaring it intentionally not machine-verifiable.

Invocation: `node "${HOME}/.claude/hooks/ac-coverage.js" --spec {spec_path} --snapshot .deepflow/auto-snapshot.txt --status pass`. Exit 0 → pass. Exit 2 → FAIL, listing untagged non-advisory ACs. No agent self-report is consulted; correctness of each AC is verified by its tagged test under L4.

**L4: Tests** — Run AFTER L0 passes. Run even if L1-L2 had issues. Exit 0 → pass. Non-zero → FAIL with last 50 lines + fix task. If `quality.test_retry_on_fail: true`: re-run once; second pass → warn (flaky); second fail → genuine failure.

**L4.5: Cross-Spec Integration** (if integration tasks exist)

**Trigger:** Current spec's `## Tasks (curated)` section contains a task with a `[INTEGRATION]` title marker, OR the spec declares `depends_on: done-*`. Otherwise emit `L4.5 — (no integration tasks)` and skip.

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

Algorithm: detect frontend → resolve dev command/port → start server → poll readiness → read assertions from spec or config → auto-install Playwright Chromium → evaluate via `locator.ariaSnapshot()` → screenshot → retry once on failure → report.

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

2. A `## Browser assertions` YAML block exists in the spec body, OR `quality.browser_assertions.<spec>` is set in `.deepflow/config.yaml`.

**Auto-detect outcomes (no config override):**
- No frontend detected → `L5 — (no frontend)`, skip remaining L5 steps.
- Frontend detected but no assertions source found → `L5 — (no assertions)`, skip remaining L5 steps.
- Both conditions met → proceed to Steps 2–6.

**Step 2: Dev server lifecycle.**
1. **Resolve dev command:** Config `quality.dev_command` wins → fallback to `npm run dev` if `scripts.dev` exists → none found → skip L5 with warning.
2. **Resolve port:** Config `quality.dev_port` wins → fallback to 3000.
3. **Check existing server:** curl localhost:{port}. If already responding, reuse it (do not kill on exit).
4. **Start & poll:** If not already running, start via `setsid ${DEV_COMMAND} &`. Poll with 0.5s interval up to `quality.browser_timeout` (default 30s). Timeout → FAIL + kill process group + fix task.
5. **Teardown (always runs):** trap EXIT kills the process group (SIGTERM → wait 5s → SIGKILL). No-op when reusing pre-existing server (`DEV_SERVER_PID` empty).

**Step 3: Read assertions.** Look first for a `## Browser assertions` YAML block in the spec body; if absent, look for `quality.browser_assertions.<spec>` in `.deepflow/config.yaml`. If both are absent → `L5 — (no assertions)`, skip Playwright. Each assertion has `selector` + optional `role`, `name`, `visible`, `text`.

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

**Fix task on L5 failure:** Append to the spec's `## Tasks (curated)` section as a new `### T<n+1>:` entry (continuing from the highest existing task ID in that section). Include: failing assertions (selector + detail), first 40 lines of `locator('body').ariaSnapshot()` DOM excerpt, screenshot path, flakiness note if assertion sets differed.

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

Fix tasks added to ## Tasks (curated):
  T10: Implement missing upload endpoint and storage service
  T11: Fix operator login to send access_token per auth spec contract

Run /df:execute --continue to fix in the same worktree.
```

**Blocking-issue classification (REQ-3):**

Before running no-progress detection or auto-invoke, classify all issues found into two buckets:

- **Blocking** (eligible for auto-invoke): L0 build failures | L1 spec-scope violations (missing files) | L4 test failures
- **Non-blocking** (never trigger auto-invoke): L2 coverage drop | L3 AC-coverage gaps | L4.5 contract mismatches | L5 browser assertion failures | advisory warnings

If issues exist but ALL of them are non-blocking → skip no-progress detection, skip auto-invoke, and exit cleanly (print the standard failure report with fix tasks if any, then `Run /df:execute --continue to fix T{n}` as the legacy message; do NOT invoke the command). This is not a user-facing auto-fix terminal path; do NOT print the final status summary block.

Only when at least one **blocking** issue exists does execution continue to the no-progress check and auto-invoke logic below.

**No-progress detection (run before auto-invoke, when blocking issues exist):**

Compute a stable issue signature from all blocking issues:
1. Collect all blocking issues as tuples of `(level, file, rule)` — e.g. `("L1", "src/api/upload.ts", "missing-file")`, `("L4", "src/upload.test.ts", "test-failure")`. Use the level name, the primary file path (or empty string if none), and a short rule/category label derived from the issue type.
2. Sort tuples lexicographically by `(level, file, rule)`.
3. Join to a single string: `CURRENT_SIG = level:file:rule|level:file:rule|...`

Read the last known signature via shell injection:
```
LAST_SIG = !`grep '^auto_fix_last_signature:' .deepflow/auto-memory.yaml 2>/dev/null | sed 's/^auto_fix_last_signature: *//' | tr -d '"'`
```
If the grep returns empty (key absent or file missing), treat `LAST_SIG` as empty string.

Compare:
- If `CURRENT_SIG == LAST_SIG` (and `LAST_SIG` is non-empty): **no-progress halt** — print `No progress detected — same blocking issues as last cycle. Halting auto-fix loop.` then print the final status summary and stop. Do NOT invoke `/df:execute --continue`. Do NOT update auto-memory.yaml.

  Final status summary for no-progress halt:
  ```
  HALT_ITER = !`grep '^auto_fix_iteration:' .deepflow/auto-memory.yaml 2>/dev/null | sed 's/^auto_fix_iteration:[[:space:]]*//' | tr -d ' "'` || echo 0`
  ```
  If empty, treat as `0`.
  ```
  Auto-fix halted: no progress after ${HALT_ITER} iterations. Remaining: {blocking issue category list}
  ```
  Where `{blocking issue category list}` lists each blocking category present (e.g. `L0 build, L4 tests`), or `none` if no blocking issues remain.
- If `CURRENT_SIG != LAST_SIG`: update `auto_fix_last_signature` in `.deepflow/auto-memory.yaml` using:
  ```
  # If key exists, replace it; if file/key absent, append it
  if grep -q '^auto_fix_last_signature:' .deepflow/auto-memory.yaml 2>/dev/null; then
    sed -i '' 's|^auto_fix_last_signature:.*|auto_fix_last_signature: "'"${CURRENT_SIG}"'"|' .deepflow/auto-memory.yaml
  else
    echo 'auto_fix_last_signature: "'"${CURRENT_SIG}"'"' >> .deepflow/auto-memory.yaml
  fi
  ```
  Then proceed to auto-invoke logic below.

**On clean verify (no blocking issues):** Read the iteration counter before resetting it:
```
CLEAN_ITER = !`grep '^auto_fix_iteration:' .deepflow/auto-memory.yaml 2>/dev/null | sed 's/^auto_fix_iteration:[[:space:]]*//' | tr -d ' "'` || echo 0`
```
If empty, treat as `0`. Then reset both persistence keys:
```
sed -i '' '/^auto_fix_last_signature:/d' .deepflow/auto-memory.yaml 2>/dev/null
sed -i '' '/^auto_fix_iteration:/d' .deepflow/auto-memory.yaml 2>/dev/null
```
(Silently skip if file absent.)

Print the final status summary for clean verify:
```
Auto-fix: ${CLEAN_ITER} iterations, 0 blocking issues remaining.
```

**Auto-invoke logic (after no-progress check and fix tasks are added):**

Read the iteration cap and current counter via shell injection:
```
MAX_ITER = !`grep 'auto_fix_max_iterations' .deepflow/config.yaml 2>/dev/null | sed 's/.*auto_fix_max_iterations[[:space:]]*:[[:space:]]*//' | tr -d ' "' | grep -E '^[0-9]+$'` || echo 3`
CURRENT_ITER = !`grep '^auto_fix_iteration:' .deepflow/auto-memory.yaml 2>/dev/null | sed 's/^auto_fix_iteration:[[:space:]]*//' | tr -d ' "'` || echo 0`
```
If the grep returns empty for `MAX_ITER`, treat it as `3`. If empty for `CURRENT_ITER`, treat it as `0`.

Before invoking (when `AUTO_FIX_ENABLED = true` and no-progress halt did NOT trigger):

1. **Cap check:** If `CURRENT_ITER >= MAX_ITER` → print `Auto-fix cap reached (${CURRENT_ITER}/${MAX_ITER} iterations). Run /df:execute --continue manually.` then print the final status summary and stop. Do NOT invoke `/df:execute --continue`. Do NOT update auto-memory.yaml.

   Final status summary for cap hit:
   ```
   Auto-fix cap reached (${CURRENT_ITER}/${MAX_ITER}). Remaining: {blocking issue category list}
   ```
   Where `{blocking issue category list}` lists each blocking category present (e.g. `L0 build, L4 tests`), or `none` if no blocking issues remain.
2. **Increment:** If proceeding past the cap check, increment `auto_fix_iteration` in `.deepflow/auto-memory.yaml` using:
   ```
   NEW_ITER=$((CURRENT_ITER + 1))
   if grep -q '^auto_fix_iteration:' .deepflow/auto-memory.yaml 2>/dev/null; then
     sed -i '' "s|^auto_fix_iteration:.*|auto_fix_iteration: ${NEW_ITER}|" .deepflow/auto-memory.yaml
   else
     echo "auto_fix_iteration: ${NEW_ITER}" >> .deepflow/auto-memory.yaml
   fi
   ```
   Then print the auto-invoke banner:
   ```
   echo "=== Auto-fix: invoking /df:execute --continue (iteration ${NEW_ITER}/${MAX_ITER}) ==="
   echo "Triggering issues: {L0 build | L1 scope | L4 tests} — Tasks: T{n}, T{m}"
   ```
   Where `{L0 build | L1 scope | L4 tests}` lists only the blocking issue categories that are actually present (e.g. `L0 build, L4 tests`), and `T{n}, T{m}` lists the IDs of the fix tasks just added to the spec's `## Tasks (curated)` section for those blocking issues.

   Then invoke `/df:execute --continue` automatically (do NOT print "Run /df:execute --continue" — just invoke the command).

- If `AUTO_FIX_ENABLED = false` (set by `--no-auto-fix`): print `Run /df:execute --continue to fix T{n}` as the legacy message, then print the final status summary. Do NOT invoke the command.

  Final status summary for `--no-auto-fix` opt-out:
  ```
  OPT_ITER = !`grep '^auto_fix_iteration:' .deepflow/auto-memory.yaml 2>/dev/null | sed 's/^auto_fix_iteration:[[:space:]]*//' | tr -d ' "'` || echo 0`
  ```
  If empty, treat as `0`.
  ```
  Auto-fix skipped (--no-auto-fix): ${OPT_ITER} iterations so far. Remaining: {blocking issue category list}
  ```
  Where `{blocking issue category list}` lists each blocking category present (e.g. `L0 build, L4 tests`), or `none` if none.

- If `FROM_EXECUTE = true` (set by `--from-execute`): print `Run /df:execute --continue to fix T{n}` as the legacy message only. Do NOT print the final status summary (recursion guard — not user-facing). Do NOT invoke the command.

**Gate conditions (ALL must pass to merge):** L0 build (or no command) | L1 all files in diff | L2 coverage held (or no tool) | L4 tests pass (or no command) | L4.5 contracts match (or no dependencies/integration tasks) | L5 assertions pass (or no frontend/assertions).

**All pass →** Post-Verification merge. **Issues found →** Add fix tasks to the spec's `## Tasks (curated)` section (IDs continue from the highest existing `T<n>` in that section), register via TaskCreate/TaskUpdate, then apply no-progress check and auto-invoke logic above. Do NOT create new specs, worktrees, or merge with issues pending.

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
- Don't auto-fix — add fix tasks to the spec's `## Tasks (curated)` section, then `/df:execute --continue`
- Capture learnings for significant approaches
- **Terse output** — Output ONLY the compact report format (section 3); obey the top-of-file OUTPUT and NEVER contracts (including the LSP/diagnostics prohibition).

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL gates pass AND `--diagnostic` was NOT used.**

1. **Discover worktree:** Read `.deepflow/checkpoint.json.worktree` (the worktree path) and `.deepflow/checkpoint.json.branch` (the branch name) per the curator checkpoint schema. Fallback: infer from `doing-*` spec name + `git worktree list --porcelain`. No worktree → "nothing to merge", exit.
2. **Merge:** `git checkout main && git merge ${BRANCH} --no-ff -m "feat({spec}): merge verified changes"`. On conflict → keep worktree, output "Resolve manually, run /df:verify --merge-only", exit.
3. **Cleanup:** `git worktree remove --force ${PATH} && git branch -d ${BRANCH} && rm -f .deepflow/checkpoint.json.worktree .deepflow/checkpoint.json.branch`
4. **Rename spec & archive:** `mv specs/doing-${NAME}.md specs/done-${NAME}.md`, then:
   ```sh
   mkdir -p .deepflow/specs-done/
   if [ -f "specs/done-${NAME}.md" ]; then
     mv "specs/done-${NAME}.md" ".deepflow/specs-done/"
   fi
   ```
5. **Delete shared auto-snapshot (conditional):** After the doing→done rename, check if any doing specs remain: `ls specs/doing-*.md 2>/dev/null`. If none remain (all specs have completed), delete the shared snapshot: `rm -f .deepflow/auto-snapshot.txt`. If doing specs still exist, skip deletion — the snapshot is still in use.
6c. **Invalidate spec map directory:** Remove `.deepflow/maps/${NAME}/` so stale sketch/impact/findings artifacts from this spec don't persist after completion:
   ```sh
   rm -rf ".deepflow/maps/${NAME}/"
   ```
   Idempotent: missing directory is a silent no-op. This is the canonical doing→done invalidation hook for REQ-7.
7. **Extract decisions (additive):** Read done spec, extract `[APPROACH]`/`[ASSUMPTION]`/`[PROVISIONAL]`/`[FUTURE]`/`[UPDATE]` decisions, append to `.deepflow/decisions.md` under `### {date} — {spec}` header. For each extracted decision line, guard against duplicates with a grep check before appending — never read the full file first:
   ```sh
   grep -Fxq -- "- [TAG] {decision_text}" .deepflow/decisions.md 2>/dev/null || \
     printf -- '- [TAG] %s\n' "{decision_text}" >> .deepflow/decisions.md
   ```
   Where `[TAG]` is the actual tag (`[APPROACH]`, `[ASSUMPTION]`, `[PROVISIONAL]`, `[FUTURE]`, or `[UPDATE]`). Apply one guard per decision line. Delete done spec after successful write; preserve on failure.
Output (exactly one line, no emojis beyond `✓`, no commentary before or after):
`✓ Merged → main | ✓ Cleaned worktree | ✓ Spec → done | ✓ Decisions extracted | ✓ Cleaned up | Ready: /df:spec <name>`

**Do NOT** append congratulatory text (e.g. "🎉 Spec merged successfully"), explanations of LSP/worktree behavior, or any other narration after this line. After printing the merge-status line, end the turn.

<!--
## T26 Integration Validation — AC-1 through AC-9 (verify-auto-continue)
Date: 2026-04-18

Structural review of verify.md (T18–T24) and execute.md (T25) against all acceptance criteria.

AC-1:done
  AUTO_FIX_ENABLED defaults true. §3 auto-invoke logic calls /df:execute --continue when
  blocking issues exist and AUTO_FIX_ENABLED=true.

AC-2:done
  No-progress detection computes CURRENT_SIG from blocking issues, reads LAST_SIG from
  auto-memory.yaml via shell injection. If CURRENT_SIG==LAST_SIG (non-empty): prints
  "No progress detected — same blocking issues as last cycle. Halting auto-fix loop."
  Does NOT invoke execute. Does NOT update auto-memory.yaml.

AC-3:done
  Blocking-issue filter classifies L2/L3/L4.5/L5/advisory as non-blocking. Explicit gate:
  "If issues exist but ALL of them are non-blocking → skip no-progress detection, skip
  auto-invoke, and exit cleanly." Prints standard report + legacy message only.

AC-4:done
  --no-auto-fix sets AUTO_FIX_ENABLED=false in prologue. §3: "If AUTO_FIX_ENABLED=false
  (set by --no-auto-fix): print 'Run /df:execute --continue...' as the legacy message...
  Do NOT invoke the command." Fix tasks are still added to ## Tasks (curated) as required.

AC-5:done
  Auto-invoke step 2 prints:
    === Auto-fix: invoking /df:execute --continue (iteration N/MAX) ===
    Triggering issues: {categories} — Tasks: T{n}, T{m}
  before the /df:execute --continue invocation.

AC-6:done
  MAX_ITER read from config.yaml via shell injection. Cap check: CURRENT_ITER >= MAX_ITER →
  prints "Auto-fix cap reached (N/M iterations). Run /df:execute --continue manually."
  then final status summary. Does NOT invoke execute.

AC-7:done
  Shell injection for MAX_ITER uses `|| echo 3` fallback. Spec states: "If the grep returns
  empty for MAX_ITER, treat it as 3." Missing key or missing file both resolve to default 3.

AC-8:done
  All four terminal paths emit final status summary:
  (a) Clean verify  → "Auto-fix: N iterations, 0 blocking issues remaining."
  (b) No-progress   → "Auto-fix halted: no progress after N iterations. Remaining: ..."
  (c) Cap hit       → "Auto-fix cap reached (N/M). Remaining: ..."
  (d) --no-auto-fix → "Auto-fix skipped (--no-auto-fix): N iterations so far. Remaining: ..."
  --from-execute path intentionally omits the summary (recursion guard, not user-facing).

AC-9:done
  --from-execute sets FROM_EXECUTE=true AND AUTO_FIX_ENABLED=false in prologue.
  §3: "If FROM_EXECUTE=true: print legacy message only. Do NOT print final status summary.
  Do NOT invoke the command."
  execute.md §8 passes the flag: skill: "df:verify", args: "doing-{name} --from-execute"
  — confirms end-to-end recursion prevention.

DECISIONS: [APPROACH] FROM_EXECUTE forces AUTO_FIX_ENABLED=false at parse time rather than
  at invoke time — ensures no code path can accidentally re-enable it downstream.
  [APPROACH] Non-blocking issues (L2/L3/L4.5/L5) never trigger no-progress computation —
  signature is computed only from blocking issues, preventing spurious halt on flapping
  non-blocking checks.
-->

