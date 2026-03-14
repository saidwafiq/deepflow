---
name: browse-verify
description: Verifies UI acceptance criteria by launching a headless browser, extracting the accessibility tree, and evaluating structured assertions deterministically. Use when a spec has browser-based ACs that need automated verification after implementation.
---

# Browse-Verify

Headless browser verification using Playwright's accessibility tree. Evaluates structured assertions from PLAN.md without LLM calls — purely deterministic matching.

## When to Use

After implementing a spec that contains browser-based acceptance criteria:
- Visual/layout checks (element presence, text content, roles)
- Interactive state checks (aria-checked, aria-expanded, aria-disabled)
- Structural checks (element within a container)

**Skip when:** The spec has no browser-facing ACs, or the implementation is backend-only.

## Prerequisites

- Node.js (preferred) or Bun
- Playwright 1.x (`npm install playwright` or `npx playwright install`)
- Chromium browser (auto-installed if missing)

## Runtime Detection

```bash
# Prefer Node.js; fall back to Bun
if which node > /dev/null 2>&1; then
  RUNTIME=node
elif which bun > /dev/null 2>&1; then
  RUNTIME=bun
else
  echo "Error: neither node nor bun found" && exit 1
fi
```

## Browser Auto-Install

Before running, ensure Chromium is available:

```bash
npx playwright install chromium
```

Run this once per environment. If it fails due to permissions, instruct the user to run it manually.

## Protocol

### 1. Read Assertions from PLAN.md

Assertions are written into PLAN.md by the `plan` skill during planning. Format:

```yaml
assertions:
  - role: button
    name: "Submit"
    check: visible
  - role: checkbox
    name: "Accept terms"
    check: state
    value: checked
  - role: heading
    name: "Dashboard"
    check: visible
    within: main
  - role: textbox
    name: "Email"
    check: value
    value: "user@example.com"
```

Assertion schema:

| Field    | Required | Description |
|----------|----------|-------------|
| `role`   | yes      | ARIA role (button, checkbox, heading, textbox, link, etc.) |
| `name`   | yes      | Accessible name (exact or partial match) |
| `check`  | yes      | One of: `visible`, `absent`, `state`, `value`, `count` |
| `value`  | no       | Expected value for `state` or `value` checks |
| `within` | no       | Ancestor role or selector to scope the search |

### 2. Launch Browser and Navigate

```javascript
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
```

`TARGET_URL` is read from the spec's metadata or passed as an argument.

### 3. Extract Accessibility Tree

Use `locator.ariaSnapshot()` — **NOT** `page.accessibility.snapshot()` (removed in Playwright 1.x):

```javascript
// Full-page aria snapshot (YAML-like role tree)
const snapshot = await page.locator('body').ariaSnapshot();

// Scoped snapshot within a container
const containerSnapshot = await page.locator('main').ariaSnapshot();
```

`ariaSnapshot()` returns a YAML-like string such as:

```yaml
- heading "Dashboard" [level=1]
- button "Submit" [disabled]
- checkbox "Accept terms" [checked]
- textbox "Email": user@example.com
```

### 4. Capture Bounding Boxes (optional)

For spatial/layout assertions or debugging:

```javascript
const element = page.getByRole(role, { name: assertionName });
const box = await element.boundingBox();
// box: { x, y, width, height } or null if not visible
```

### 5. Evaluate Assertions Deterministically

Parse the aria snapshot and evaluate each assertion. No LLM calls during this phase.

```javascript
function evaluateAssertion(snapshot, assertion) {
  const { role, name, check, value, within } = assertion;

  // Optionally scope to a sub-tree
  const tree = within
    ? extractSubtree(snapshot, within)
    : snapshot;

  switch (check) {
    case 'visible':
      return treeContains(tree, role, name);

    case 'absent':
      return !treeContains(tree, role, name);

    case 'state':
      // e.g., value: "checked", "disabled", "expanded"
      return treeContainsWithState(tree, role, name, value);

    case 'value':
      // Matches textbox/combobox displayed value
      return treeContainsWithValue(tree, role, name, value);

    case 'count':
      return countMatches(tree, role, name) === parseInt(value, 10);
  }
}
```

Matching rules:
- Role matching is case-insensitive
- Name matching is case-insensitive substring match (unless wrapped in quotes for exact match)
- State tokens (`[checked]`, `[disabled]`, `[expanded]`) are parsed from the snapshot line

### 6. Capture Screenshot

After evaluation, capture a screenshot for the audit trail:

```javascript
const screenshotDir = `.deepflow/screenshots/${specName}`;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const screenshotPath = `${screenshotDir}/${timestamp}.png`;

await fs.mkdir(screenshotDir, { recursive: true });
await page.screenshot({ path: screenshotPath, fullPage: true });
```

Screenshot path convention: `.deepflow/screenshots/{spec-name}/{timestamp}.png`

### 7. Report Results

Emit a structured result for each assertion:

```
[PASS] button "Submit" — visible ✓
[PASS] checkbox "Accept terms" — state: checked ✓
[FAIL] heading "Dashboard" — expected visible, not found in snapshot
[PASS] textbox "Email" — value: user@example.com ✓

Results: 3 passed, 1 failed
Screenshot: .deepflow/screenshots/login-form/2026-03-14T12-00-00-000Z.png
```

Exit with code 0 if all assertions pass, 1 if any fail.

### 8. Tear Down

```javascript
await browser.close();
```

Always close the browser, even on error (use try/finally).

## Full Script Template

```javascript
#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

async function main({ targetUrl, specName, assertions }) {
  // Auto-install chromium if needed
  // (handled by: npx playwright install chromium)

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    const snapshot = await page.locator('body').ariaSnapshot();

    const results = assertions.map(assertion => ({
      assertion,
      passed: evaluateAssertion(snapshot, assertion),
    }));

    // Screenshot
    const screenshotDir = path.join('.deepflow', 'screenshots', specName);
    await fs.mkdir(screenshotDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(screenshotDir, `${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Report
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    for (const { assertion, passed: ok } of results) {
      const status = ok ? '[PASS]' : '[FAIL]';
      console.log(`${status} ${assertion.role} "${assertion.name}" — ${assertion.check}${assertion.value ? ': ' + assertion.value : ''}`);
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    console.log(`Screenshot: ${screenshotPath}`);

    process.exit(failed > 0 ? 1 : 0);
  } finally {
    await browser.close();
  }
}
```

## Rules

- Never call an LLM during the verify phase — all assertion evaluation is deterministic
- Always use `locator.ariaSnapshot()`, never `page.accessibility.snapshot()` (removed)
- Always close the browser in a `finally` block
- Screenshot every run regardless of pass/fail outcome
- If Playwright is not installed, emit a clear error and instructions — don't silently skip
- Partial name matching is the default; use exact matching only when the assertion specifies it
- Report results to stdout in the structured format above for downstream parsing
