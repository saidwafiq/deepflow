---
name: df:verify
description: Check that implemented code satisfies spec requirements and acceptance criteria through machine-verifiable checks
---

# /df:verify — Verify Specs Satisfied

## Purpose
Check that implemented code satisfies spec requirements and acceptance criteria. All checks are machine-verifiable — no LLM agents are used.

**NEVER:** use EnterPlanMode, use ExitPlanMode

## Usage
```
/df:verify                  # Verify doing-* specs with all tasks completed
/df:verify doing-upload     # Verify specific spec
/df:verify --re-verify      # Re-verify done-* specs (already merged)
```

## Spec File States

```
specs/
  feature.md        → Unplanned (skip)
  doing-auth.md     → Executed, ready for verification (default target)
  done-upload.md    → Already verified and merged (--re-verify only)
```

## Behavior

### 1. LOAD CONTEXT

Load: `specs/doing-*.md`, `PLAN.md`, source code. Load `specs/done-*.md` only if `--re-verify`.

**Readiness check:** For each `doing-*` spec, check PLAN.md:
- All tasks `[x]` → ready (proceed)
- Some tasks `[ ]` → warn: "⚠ {spec} has {n} incomplete tasks. Run /df:execute first."

If no `doing-*` specs found: report counts, suggest `/df:execute`.

### 1.5. DETECT PROJECT COMMANDS

**Config override always wins.** If `.deepflow/config.yaml` has `quality.test_command` or `quality.build_command`, use those.

**Auto-detection (first match wins):**

| File | Build | Test |
|------|-------|------|
| `package.json` with `scripts.build` | `npm run build` | `npm test` (if scripts.test is not default placeholder) |
| `pyproject.toml` or `setup.py` | — | `pytest` |
| `Cargo.toml` | `cargo build` | `cargo test` |
| `go.mod` | `go build ./...` | `go test ./...` |
| `Makefile` with `test` target | `make build` (if target exists) | `make test` |

- Commands found: `Build: npm run build | Test: npm test`
- Nothing found: `⚠ No build/test commands detected. L0/L4 skipped. Set quality.test_command in .deepflow/config.yaml`

### 2. VERIFY EACH SPEC

**L0: Build check** (if build command detected)

Run the build command in the worktree:
- Exit code 0 → L0 pass, continue to L1-L2
- Exit code non-zero → L0 FAIL: report "✗ L0: Build failed" with last 30 lines, add fix task to PLAN.md, stop (skip L1-L4)

**L1: Files exist** (machine-verifiable, via git)

Check that planned files appear in the worktree diff:

```bash
# Get files changed in worktree branch
CHANGED=$(cd ${WORKTREE_PATH} && git diff main...HEAD --name-only)

# Parse PLAN.md for spec's "Files:" entries
PLANNED=$(grep -A1 "Files:" PLAN.md | grep -v "Files:" | tr ',' '\n' | xargs)

# Each planned file must appear in diff
for file in ${PLANNED}; do
  echo "${CHANGED}" | grep -q "${file}" || MISSING+=("${file}")
done
```

- All planned files in diff → L1 pass
- Missing files → L1 FAIL: report "✗ L1: Files not in diff: {list}"

**L2: Coverage** (coverage tool)

**Step 1: Detect coverage tool** (first match wins):

| File/Config | Coverage Tool | Command |
|-------------|--------------|---------|
| `package.json` with `c8` in devDeps | c8 (Node) | `npx c8 --reporter=json-summary npm test` |
| `package.json` with `nyc` in devDeps | nyc (Node) | `npx nyc --reporter=json-summary npm test` |
| `.nycrc` or `.nycrc.json` exists | nyc (Node) | `npx nyc --reporter=json-summary npm test` |
| `pyproject.toml` or `setup.cfg` with coverage config | coverage.py | `python -m coverage run -m pytest && python -m coverage json` |
| `Cargo.toml` + `cargo-tarpaulin` installed | tarpaulin (Rust) | `cargo tarpaulin --out json` |
| `go.mod` | go cover (Go) | `go test -coverprofile=coverage.out ./...` |

**Step 2: No tool detected** → L2 passes with warning: "⚠ L2: No coverage tool detected, skipping coverage check"

**Step 3: Run coverage comparison** (when tool available):
```bash
# Baseline: coverage on main branch (or from ratchet snapshot)
cd ${WORKTREE_PATH}
git stash  # Temporarily remove changes
${COVERAGE_COMMAND}
BASELINE=$(parse_coverage_percentage)  # Extract total line coverage %
git stash pop

# Current: coverage with changes applied
${COVERAGE_COMMAND}
CURRENT=$(parse_coverage_percentage)

# Compare
if [ "${CURRENT}" -lt "${BASELINE}" ]; then
  echo "✗ L2: Coverage dropped ${BASELINE}% → ${CURRENT}%"
else
  echo "✓ L2: Coverage ${CURRENT}% (baseline: ${BASELINE}%)"
fi
```

- Coverage same or improved → L2 pass
- Coverage dropped → L2 FAIL: report "✗ L2: Coverage dropped {baseline}% → {current}%", add fix task

**L3: Integration** (subsumed by L0 + L4)

Subsumed by L0 (build) + L4 (tests). If code isn't imported/wired, build fails or tests fail. No separate verification needed.

**L4: Test execution** (if test command detected)

Run AFTER L0 passes and L1-L2 complete. Run even if L1-L2 found issues.

- Exit code 0 → L4 pass
- Exit code non-zero → L4 FAIL: capture last 50 lines, report "✗ L4: Tests failed (N of M)", add fix task

**Flaky test handling** (if `quality.test_retry_on_fail: true` in config):
- Re-run ONCE on failure. Second pass → "⚠ L4: Passed on retry (possible flaky test)". Second fail → genuine failure.

**L5: Browser Verification** (if frontend detected)

**Step 1: Detect frontend framework** (config override always wins):

```bash
BROWSER_VERIFY=$(yq '.quality.browser_verify' .deepflow/config.yaml 2>/dev/null)

if [ "${BROWSER_VERIFY}" = "false" ]; then
  # Explicitly disabled — skip L5 unconditionally
  echo "L5 — (no frontend)"
  L5_RESULT="skipped-no-frontend"
elif [ "${BROWSER_VERIFY}" = "true" ]; then
  # Explicitly enabled — proceed even without frontend deps
  FRONTEND_DETECTED=true
  FRONTEND_FRAMEWORK="configured"
else
  # Auto-detect from package.json (both dependencies and devDependencies)
  FRONTEND_DETECTED=false
  FRONTEND_FRAMEWORK=""

  if [ -f package.json ]; then
    # Check for React / Next.js
    if jq -e '(.dependencies + (.devDependencies // {})) | keys[] | select(. == "react" or . == "react-dom" or . == "next")' package.json >/dev/null 2>&1; then
      FRONTEND_DETECTED=true
      # Prefer Next.js label when next is present
      if jq -e '(.dependencies + (.devDependencies // {}))["next"]' package.json >/dev/null 2>&1; then
        FRONTEND_FRAMEWORK="Next.js"
      else
        FRONTEND_FRAMEWORK="React"
      fi
    # Check for Nuxt / Vue
    elif jq -e '(.dependencies + (.devDependencies // {})) | keys[] | select(. == "vue" or . == "nuxt" or startswith("@vue/"))' package.json >/dev/null 2>&1; then
      FRONTEND_DETECTED=true
      if jq -e '(.dependencies + (.devDependencies // {}))["nuxt"]' package.json >/dev/null 2>&1; then
        FRONTEND_FRAMEWORK="Nuxt"
      else
        FRONTEND_FRAMEWORK="Vue"
      fi
    # Check for Svelte / SvelteKit
    elif jq -e '(.dependencies + (.devDependencies // {})) | keys[] | select(. == "svelte" or startswith("@sveltejs/"))' package.json >/dev/null 2>&1; then
      FRONTEND_DETECTED=true
      if jq -e '(.dependencies + (.devDependencies // {}))["@sveltejs/kit"]' package.json >/dev/null 2>&1; then
        FRONTEND_FRAMEWORK="SvelteKit"
      else
        FRONTEND_FRAMEWORK="Svelte"
      fi
    fi
  fi

  if [ "${FRONTEND_DETECTED}" = "false" ]; then
    echo "L5 — (no frontend)"
    L5_RESULT="skipped-no-frontend"
  fi
fi
```

Packages checked in both `dependencies` and `devDependencies`:

| Package(s) | Detected Framework |
|------------|--------------------|
| `next` | Next.js |
| `react`, `react-dom` | React |
| `nuxt` | Nuxt |
| `vue`, `@vue/*` | Vue |
| `@sveltejs/kit` | SvelteKit |
| `svelte`, `@sveltejs/*` | Svelte |

Config key `quality.browser_verify`:
- `false` → always skip L5, output `L5 — (no frontend)`, even if frontend deps are present
- `true` → always run L5, even if no frontend deps detected
- absent → auto-detect from package.json as above

No frontend deps found and `quality.browser_verify` not set → output `L5 — (no frontend)`, skip all remaining L5 steps.

**Step 2: Dev server lifecycle**

**2a. Resolve dev command** (config override always wins):

```bash
# 1. Config override
DEV_COMMAND=$(yq '.quality.dev_command' .deepflow/config.yaml 2>/dev/null)

# 2. Auto-detect from package.json scripts.dev
if [ -z "${DEV_COMMAND}" ] || [ "${DEV_COMMAND}" = "null" ]; then
  if [ -f package.json ] && jq -e '.scripts.dev' package.json >/dev/null 2>&1; then
    DEV_COMMAND="npm run dev"
  fi
fi

# 3. No dev command found → skip L5 dev server steps
if [ -z "${DEV_COMMAND}" ]; then
  echo "⚠ L5: No dev command found (scripts.dev not in package.json, quality.dev_command not set). Skipping browser check."
  L5_RESULT="skipped-no-dev-command"
fi
```

**2b. Resolve port:**

```bash
# Config override wins; fallback to 3000
DEV_PORT=$(yq '.quality.dev_port' .deepflow/config.yaml 2>/dev/null)
if [ -z "${DEV_PORT}" ] || [ "${DEV_PORT}" = "null" ]; then
  DEV_PORT=3000
fi
```

**2c. Check if dev server is already running (port already bound):**

```bash
PORT_IN_USE=false
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${DEV_PORT}" | grep -q "200"; then
  PORT_IN_USE=true
  echo "ℹ L5: Port ${DEV_PORT} already bound — using existing dev server, will not kill on exit."
fi
```

**2d. Start dev server and poll for readiness:**

```bash
DEV_SERVER_PID=""
if [ "${PORT_IN_USE}" = "false" ]; then
  # Start in a new process group so all child processes can be killed together
  setsid ${DEV_COMMAND} &
  DEV_SERVER_PID=$!
fi

# Resolve timeout from config (default 30s)
TIMEOUT=$(yq '.quality.browser_timeout' .deepflow/config.yaml 2>/dev/null)
if [ -z "${TIMEOUT}" ] || [ "${TIMEOUT}" = "null" ]; then
  TIMEOUT=30
fi
POLL_INTERVAL=0.5
MAX_POLLS=$(echo "${TIMEOUT} / ${POLL_INTERVAL}" | bc)

HTTP_STATUS=""
for i in $(seq 1 ${MAX_POLLS}); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${DEV_PORT}" 2>/dev/null)
  [ "${HTTP_STATUS}" = "200" ] && break
  sleep ${POLL_INTERVAL}
done

if [ "${HTTP_STATUS}" != "200" ]; then
  # Kill process group before reporting failure
  if [ -n "${DEV_SERVER_PID}" ]; then
    kill -SIGTERM -${DEV_SERVER_PID} 2>/dev/null
  fi
  echo "✗ L5 FAIL: dev server did not start within ${TIMEOUT}s"
  # add fix task to PLAN.md
  exit 1
fi
```

**2e. Teardown — always runs on both pass and fail paths:**

```bash
cleanup_dev_server() {
  if [ -n "${DEV_SERVER_PID}" ]; then
    # Kill the entire process group to catch any child processes spawned by the dev server
    kill -SIGTERM -${DEV_SERVER_PID} 2>/dev/null
    # Give it up to 5s to exit cleanly, then force-kill
    for i in $(seq 1 10); do
      kill -0 ${DEV_SERVER_PID} 2>/dev/null || break
      sleep 0.5
    done
    kill -SIGKILL -${DEV_SERVER_PID} 2>/dev/null || true
  fi
}
# Register cleanup for both success and failure paths
trap cleanup_dev_server EXIT
```

Note: When `PORT_IN_USE=true` (dev server was already running before L5 began), `DEV_SERVER_PID` is empty and `cleanup_dev_server` is a no-op — the pre-existing server is left running.

**Step 3: Read assertions from PLAN.md**

Assertions are written into PLAN.md at plan-time (REQ-8). Extract them for the current spec:

```bash
# Parse structured browser assertions block from PLAN.md
# Format expected in PLAN.md under each spec section:
# browser_assertions:
#   - selector: "nav"
#     role: "navigation"
#     name: "Main navigation"
#   - selector: "button[type=submit]"
#     visible: true
#     text: "Submit"
ASSERTIONS=$(parse_yaml_block "browser_assertions" PLAN.md)
```

If no `browser_assertions` block found for the spec → L5 — (no assertions), skip Playwright step.

**Step 3.5: Playwright browser auto-install**

Before launching Playwright, verify the Chromium browser binary is available. Run this check once per session; cache the result to avoid repeated installs.

```bash
# Marker file path — presence means Playwright Chromium was verified this session
PW_MARKER="${TMPDIR:-/tmp}/.deepflow-pw-chromium-ok"

if [ ! -f "${PW_MARKER}" ]; then
  # Dry-run to detect whether the browser binary is already installed
  if ! npx --yes playwright install --dry-run chromium 2>&1 | grep -q "chromium.*already installed"; then
    echo "ℹ L5: Playwright Chromium not found — installing (one-time setup)..."
    if npx --yes playwright install chromium 2>&1; then
      echo "✓ L5: Playwright Chromium installed successfully."
      touch "${PW_MARKER}"
    else
      echo "✗ L5 FAIL: Playwright Chromium install failed. Browser verification skipped."
      L5_RESULT="skipped-install-failed"
      # Skip the remaining L5 steps for this run
    fi
  else
    # Already installed — cache for this session
    touch "${PW_MARKER}"
  fi
fi

# If install failed, skip Playwright launch and jump to L5 outcome reporting
if [ "${L5_RESULT}" = "skipped-install-failed" ]; then
  # No assertions can be evaluated — treat as a non-blocking skip with error notice
  : # fall through to report section
fi
```

Skip Steps 4–6 when `L5_RESULT="skipped-install-failed"`.

**Step 4: Playwright verification**

Launch Chromium headlessly via Playwright and evaluate each assertion deterministically — no LLM judgment:

```javascript
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:3000');

const failures = [];

for (const assertion of assertions) {
  const locator = page.locator(assertion.selector);

  // Capture accessibility tree (replaces deprecated page.accessibility.snapshot())
  // locator.ariaSnapshot() returns YAML-like text with roles, names, hierarchy
  const ariaSnapshot = await locator.ariaSnapshot();

  if (assertion.role && !ariaSnapshot.includes(`role: ${assertion.role}`)) {
    failures.push(`${assertion.selector}: expected role "${assertion.role}", not found in aria snapshot`);
  }
  if (assertion.name && !ariaSnapshot.includes(assertion.name)) {
    failures.push(`${assertion.selector}: expected name "${assertion.name}", not found in aria snapshot`);
  }

  // Capture bounding boxes for visible assertions
  if (assertion.visible !== undefined) {
    const box = await locator.boundingBox();
    const isVisible = box !== null && box.width > 0 && box.height > 0;
    if (assertion.visible !== isVisible) {
      failures.push(`${assertion.selector}: expected visible=${assertion.visible}, got visible=${isVisible}`);
    }
  }

  if (assertion.text) {
    const text = await locator.innerText();
    if (!text.includes(assertion.text)) {
      failures.push(`${assertion.selector}: expected text "${assertion.text}", got "${text}"`);
    }
  }
}
```

Note: `page.accessibility.snapshot()` was removed in Playwright 1.x. Always use `locator.ariaSnapshot()`, which returns YAML-like text describing roles, names, and hierarchy for the matched element subtree.

**Step 5: Screenshot capture**

After evaluation (pass or fail), capture a full-page screenshot:

```javascript
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const specName = 'doing-upload'; // derived from current spec filename
const screenshotPath = `.deepflow/screenshots/${specName}/${timestamp}.png`;
await fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
await page.screenshot({ path: screenshotPath, fullPage: true });
```

Screenshot path: `.deepflow/screenshots/{spec-name}/{timestamp}.png`

**Step 6: Retry logic**

On first failure, retry the FULL L5 check once (total 2 attempts). Re-navigate and re-evaluate all assertions from scratch on the retry:

```javascript
// attempt1_failures populated by Step 4 above
let attempt2_failures = [];

if (attempt1_failures.length > 0) {
  // Retry: re-navigate and re-evaluate all assertions (identical logic to Step 4)
  await page.goto('http://localhost:' + DEV_PORT);
  attempt2_failures = await evaluateAssertions(page, assertions); // same loop as Step 4

  // Capture a second screenshot for the retry attempt
  const retryTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const retryScreenshotPath = `.deepflow/screenshots/${specName}/${retryTimestamp}-retry.png`;
  await page.screenshot({ path: retryScreenshotPath, fullPage: true });
}
```

**Outcome matrix:**

| Attempt 1 | Attempt 2 | Result |
|-----------|-----------|--------|
| Pass | — (not run) | L5 ✓ |
| Fail | Pass | L5 ✓ with warning "(passed on retry)" |
| Fail | Fail — same assertions | L5 ✗ — genuine failure |
| Fail | Fail — different assertions | L5 ✗ (flaky) |

**Outcome reporting:**

- **First attempt passes:** `✓ L5: All assertions passed` — no retry needed.

- **First fails, retry passes:**
  ```
  ⚠ L5: Passed on retry (possible flaky render)
    First attempt failed on: {list of assertion selectors from attempt 1}
  ```
  → L5 pass with warning. No fix task added.

- **Both fail on SAME assertions** (identical set of failing selectors):
  ```
  ✗ L5: Browser assertions failed (both attempts)
    {selector}: {failure detail}
    {selector}: {failure detail}
    ...
  ```
  → L5 FAIL. Add fix task to PLAN.md.

- **Both fail on DIFFERENT assertions** (flaky — assertion sets differ between attempts):
  ```
  ✗ L5: Browser assertions failed (flaky — inconsistent failures across attempts)
    Attempt 1 failures:
      {selector}: {failure detail}
    Attempt 2 failures:
      {selector}: {failure detail}
  ```
  → L5 ✗ (flaky). Add fix task to PLAN.md noting flakiness.

**Fix task generation on L5 failure (both same and flaky):**

When both attempts fail (`L5_RESULT = 'fail'` or `L5_RESULT = 'fail-flaky'`), generate a fix task and append it to PLAN.md under the spec's section:

```javascript
// 1. Determine next task ID
// Scan PLAN.md for highest T{n} and increment
const planContent = fs.readFileSync('PLAN.md', 'utf8');
const taskIds = [...planContent.matchAll(/\bT(\d+)\b/g)].map(m => parseInt(m[1], 10));
const nextId = taskIds.length > 0 ? Math.max(...taskIds) + 1 : 1;
const taskId = `T${nextId}`;

// 2. Collect fix task context
// - Failing assertions: the structured assertion objects that failed
const failingAssertions = attempt2_failures.length > 0 ? attempt2_failures : attempt1_failures;

// - DOM snapshot excerpt: capture aria snapshot of body at the time of failure
const domSnapshotExcerpt = await page.locator('body').ariaSnapshot();

// - Screenshot path: already captured in Step 5 / Step 6 retry
// screenshotPath / retryScreenshotPath are available from those steps

// 3. Build task description
const isFlaky = L5_RESULT === 'fail-flaky';
const flakySuffix = isFlaky ? ' (flaky — inconsistent failures across attempts)' : '';
const screenshotRef = isFlaky ? retryScreenshotPath : screenshotPath;

const fixTaskBlock = `
- [ ] ${taskId}: Fix L5 browser assertion failures in ${specName}${flakySuffix}
  **Failing assertions:**
${failingAssertions.map(f => `    - ${f}`).join('\n')}
  **DOM snapshot (aria tree excerpt at failure):**
  \`\`\`
${domSnapshotExcerpt.split('\n').slice(0, 40).join('\n')}
  \`\`\`
  **Screenshot:** ${screenshotRef}
`;

// 4. Append fix task under spec section in PLAN.md
// Find the spec section and append before the next section header or EOF
const specSectionPattern = new RegExp(`(## ${specName}[\\s\\S]*?)(\n## |$)`);
const updated = planContent.replace(specSectionPattern, (_, section, next) => section + fixTaskBlock + next);
fs.writeFileSync('PLAN.md', updated);

console.log(`Fix task added to PLAN.md: ${taskId}: Fix L5 browser assertion failures in ${specName}`);
```

Fix task context included:
- **Failing assertions**: the structured assertion data (selector + failure detail) from whichever attempt(s) failed
- **DOM snapshot excerpt**: first 40 lines of `locator('body').ariaSnapshot()` output at time of failure (textual a11y tree)
- **Screenshot path**: `.deepflow/screenshots/{spec-name}/{timestamp}.png` (retry screenshot when available)
- **Flakiness note**: appended to task title when assertion sets differed between attempts

**Comparing assertion sets (same vs. different):**

```javascript
// Compare by selector strings only — ignore detail text differences
const attempt1_selectors = attempt1_failures.map(f => f.split(':')[0]).sort();
const attempt2_selectors = attempt2_failures.map(f => f.split(':')[0]).sort();
const same_assertions = JSON.stringify(attempt1_selectors) === JSON.stringify(attempt2_selectors);

if (attempt2_failures.length === 0) {
  // Retry passed
  L5_RESULT = 'pass-on-retry';
} else if (same_assertions) {
  // Genuine failure — same assertions failed both times
  L5_RESULT = 'fail';
} else {
  // Flaky — different assertions failed each time
  L5_RESULT = 'fail-flaky';
}
```

**L5 outcomes:**
- L5 ✓ — all assertions pass on first attempt
- L5 ⚠ — passed on retry (possible flaky render); first-attempt failures listed as context
- L5 ✗ — assertions failed on both attempts (same assertions), fix tasks added
- L5 ✗ (flaky) — assertions failed on both attempts but on different assertions; fix tasks added noting flakiness
- L5 — (no frontend) — no frontend deps detected and no config override
- L5 — (no assertions) — frontend detected but no `browser_assertions` in PLAN.md
- L5 ✗ (install failed) — Playwright Chromium install failed; browser verification skipped for this run

### 3. GENERATE REPORT

**Format on success:**
```
doing-upload.md: L0 ✓ | L1 ✓ (5/5 files) | L2 ⚠ (no coverage tool) | L3 — (subsumed) | L4 ✓ (12 tests) | L5 ✓ | 0 quality issues
```

**Format on failure:**
```
doing-upload.md: L0 ✓ | L1 ✗ (3/5 files) | L2 ⚠ | L3 — | L4 ✗ (3 failed) | L5 ✗ (2 assertions failed)

Issues:
  ✗ L1: Missing files: src/api/upload.ts, src/services/storage.ts
  ✗ L4: 3 test failures
    FAIL src/upload.test.ts > should validate file type
    FAIL src/upload.test.ts > should reject oversized files

Fix tasks added to PLAN.md:
  T10: Implement missing upload endpoint and storage service
  T11: Fix 3 failing tests in upload module

Run /df:execute --continue to fix in the same worktree.
```

**Gate conditions (ALL must pass to merge):**
- L0: Build passes (or no build command detected)
- L1: All planned files appear in diff
- L2: Coverage didn't drop (or no coverage tool detected)
- L4: Tests pass (or no test command detected)
- L5: Browser assertions pass (or no frontend detected, or no assertions defined)

**If all gates pass:** Proceed to Post-Verification merge.

**If issues found:** Add fix tasks to PLAN.md in the worktree and register as native tasks:
1. Discover worktree (same logic as Post-Verification step 1)
2. Write fix tasks to `{worktree_path}/PLAN.md` under existing spec section (IDs continue from last)
3. Register each fix task: `TaskCreate(subject: "T10: Fix {description}", ...)` + `TaskUpdate(addBlockedBy: [...])` if dependencies exist
4. Output report + "Run /df:execute --continue to fix in the same worktree."

**Do NOT** create new specs, new worktrees, or merge with issues pending.

### 4. CAPTURE LEARNINGS

On success, write to `.deepflow/experiments/{domain}--{approach}--success.md` when: non-trivial approach used, alternatives rejected, performance optimization made, or integration pattern discovered. Skip simple CRUD/standard patterns.

```markdown
# {Approach} [SUCCESS]
Objective: ...
Approach: ...
Why it worked: ...
Files: ...
```

## Verification Levels

| Level | Check | Method | Runner |
|-------|-------|--------|--------|
| L0: Builds | Code compiles/builds | Run build command | Orchestrator (Bash) |
| L1: Files exist | Planned files in diff | `git diff --name-only` vs PLAN.md | Orchestrator (Bash) |
| L2: Coverage | Coverage didn't drop | Coverage tool (before/after) | Orchestrator (Bash) |
| L3: Integration | Build + tests pass | Subsumed by L0 + L4 | — |
| L4: Tested | Tests pass | Run test command | Orchestrator (Bash) |
| L5: Browser | UI assertions pass | Playwright + `locator.ariaSnapshot()` | Orchestrator (Bash + Node) |

**Default: L0 through L5.** L0 and L4 skipped ONLY if no build/test command detected (see step 1.5). L5 skipped if no frontend detected and no config override. All checks are machine-verifiable. No LLM agents are used.

## Rules
- Verify against spec, not assumptions
- Flag partial implementations
- All checks machine-verifiable — no LLM judgment
- Don't auto-fix — add fix tasks to PLAN.md, then `/df:execute --continue`
- Capture learnings — Write experiments for significant approaches

## Post-Verification: Worktree Merge & Cleanup

**Only runs when ALL gates pass.** If any gate fails, fix tasks were added to PLAN.md instead (see step 3).

### 1. DISCOVER WORKTREE

Find worktree info (checkpoint → fallback to git):

```bash
# Strategy 1: checkpoint.json
if [ -f .deepflow/checkpoint.json ]; then
  WORKTREE_BRANCH=$(cat .deepflow/checkpoint.json | jq -r '.worktree_branch')
  WORKTREE_PATH=$(cat .deepflow/checkpoint.json | jq -r '.worktree_path')
fi

# Strategy 2: Infer from doing-* spec + git worktree list
if [ -z "${WORKTREE_BRANCH}" ]; then
  SPEC_NAME=$(basename specs/doing-*.md .md | sed 's/doing-//')
  WORKTREE_PATH=".deepflow/worktrees/${SPEC_NAME}"
  WORKTREE_BRANCH=$(git worktree list --porcelain | grep -A2 "${WORKTREE_PATH}" | grep 'branch' | sed 's|branch refs/heads/||')
fi

# No worktree found
if [ -z "${WORKTREE_BRANCH}" ]; then
  echo "No worktree found — nothing to merge. Workflow may already be on main."
  exit 0
fi
```

### 2. MERGE TO MAIN

```bash
git checkout main
git merge "${WORKTREE_BRANCH}" --no-ff -m "feat({spec}): merge verified changes"
```

**On merge conflict:** Keep worktree intact, output "Merge conflict detected. Resolve manually, then run /df:verify --merge-only", exit without cleanup.

### 3. CLEANUP WORKTREE

```bash
git worktree remove --force "${WORKTREE_PATH}"
git branch -d "${WORKTREE_BRANCH}"
rm -f .deepflow/checkpoint.json
```

### 4. RENAME SPEC

```bash
# Rename spec to done
mv specs/doing-${SPEC_NAME}.md specs/done-${SPEC_NAME}.md
```

### 5. EXTRACT DECISIONS

Read the renamed `specs/done-${SPEC_NAME}.md` file. Model-extract architectural decisions:
- Explicit choices → `[APPROACH]`
- Unvalidated assumptions → `[ASSUMPTION]`
- "For now" decisions → `[PROVISIONAL]`

Append to `.deepflow/decisions.md`:
```
### {YYYY-MM-DD} — {spec-name}
- [TAG] decision text — rationale
```

After successful append, delete `specs/done-${SPEC_NAME}.md`. If write fails, preserve the file.

Output:
```
✓ Merged df/upload to main
✓ Cleaned up worktree and branch
✓ Spec complete: doing-upload → done-upload

Workflow complete! Ready for next feature: /df:spec <name>
```
