---
name: browse-verify
description: Verifies UI acceptance criteria by launching a headless browser, extracting the accessibility tree, and evaluating structured assertions deterministically. Use when a spec has browser-based ACs that need automated verification after implementation.
context: fork
---

# Browse-Verify

Headless browser verification using Playwright's accessibility tree. Evaluates structured assertions from PLAN.md without LLM calls — purely deterministic matching.

**Use when:** Spec has browser-based ACs (element presence, text content, roles, interactive states, structure).
**Skip when:** No browser-facing ACs or backend-only implementation.

**Prerequisites:** Node.js or Bun + Playwright 1.x. Runtime detection and browser auto-install follow the same protocol as browse-fetch (`which node || which bun`; `npx playwright install chromium`).

---

## Protocol

### 1. Read Assertions from PLAN.md

Assertions are written by the `plan` skill. Format:

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
```

Assertion schema:

| Field    | Required | Description |
|----------|----------|-------------|
| `role`   | yes      | ARIA role (button, checkbox, heading, textbox, link, etc.) |
| `name`   | yes      | Accessible name (exact or partial match) |
| `check`  | yes      | One of: `visible`, `absent`, `state`, `value`, `count` |
| `value`  | no       | Expected value for `state`, `value`, or `count` checks |
| `within` | no       | Ancestor role or selector to scope the search |

### 2. Launch Browser and Navigate

```javascript
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
```

`TARGET_URL` from spec metadata or passed as argument.

### 3. Extract Accessibility Tree

Use `locator.ariaSnapshot()` — **NOT** `page.accessibility.snapshot()` (removed in Playwright 1.x):

```javascript
const snapshot = await page.locator('body').ariaSnapshot();
// Scoped: await page.locator('main').ariaSnapshot();
```

Returns YAML-like role tree:
```yaml
- heading "Dashboard" [level=1]
- button "Submit" [disabled]
- checkbox "Accept terms" [checked]
- textbox "Email": user@example.com
```

### 4. Bounding Boxes (optional)

For spatial/layout assertions: `await page.getByRole(role, { name }).boundingBox()` returns `{ x, y, width, height }` or null.

### 5. Evaluate Assertions

Parse the aria snapshot and evaluate each assertion deterministically (no LLM calls).

| Check | Logic |
|-------|-------|
| `visible` | Role+name found in tree |
| `absent` | Role+name NOT found in tree |
| `state` | Role+name found with state token (e.g., `[checked]`, `[disabled]`, `[expanded]`) |
| `value` | Role+name found with matching displayed value (textbox/combobox) |
| `count` | Number of role+name matches equals `parseInt(value)` |

Matching rules:
- Role matching: case-insensitive
- Name matching: case-insensitive substring (exact match only when assertion wraps name in quotes)
- If `within` specified, scope to that ancestor's subtree first

### 6. Screenshot

Capture after every run regardless of pass/fail:
```
.deepflow/screenshots/{spec-name}/{ISO-timestamp}.png
```
Use `page.screenshot({ path, fullPage: true })`.

### 7. Report Results

```
[PASS] button "Submit" — visible
[FAIL] heading "Dashboard" — expected visible, not found in snapshot

Results: 1 passed, 1 failed
Screenshot: .deepflow/screenshots/login-form/2026-03-14T12-00-00-000Z.png
```

Exit code 0 if all pass, 1 if any fail.

### 8. Tear Down

Always `browser.close()` in a `finally` block.

---

## Rules

- Never call an LLM during the verify phase — all evaluation is deterministic.
- Always use `locator.ariaSnapshot()`, never `page.accessibility.snapshot()` (removed).
- Always close browser in `finally`.
- Screenshot every run regardless of outcome.
- If Playwright not installed, emit clear error with instructions — don't silently skip.
- Partial name matching is default; exact only when assertion specifies it.
- Report results in structured format above for downstream parsing.
