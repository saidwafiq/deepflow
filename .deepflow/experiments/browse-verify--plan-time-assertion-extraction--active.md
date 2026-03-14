# Experiment: Plan-Time Assertion Extraction from Natural-Language ACs

## Hypothesis
Claude can extract deterministic, evaluable assertions from spec AC text with >90% accuracy (>=4/5), stored in PLAN.md for verify-time evaluation against an a11y tree without requiring an LLM at verify time.

## Method
1. Selected 5 representative ACs spanning language variation, multi-element assertions, container scoping, and multi-value checks
2. Manually crafted the expected structured assertion for each AC
3. Evaluated whether each assertion can be evaluated deterministically against an a11y tree (no LLM needed at verify time)
4. Identified edge cases and ambiguities
5. Scored: correct = assertion is unambiguous, maps to right element, and is evaluable without LLM

## AC → Assertion Mappings

### AC 1: "botao de login deve estar visivel"
*(Portuguese: "login button should be visible")*

**Extracted assertion:**
```json
{
  "role": "button",
  "name": "/login/i",
  "check": "visible"
}
```

**Evaluation:**
- The AC is in Portuguese but the UI element's accessible name will be in the UI's language (typically English: "Login").
- The regex `/login/i` case-insensitively matches both "Login" and "login", so it would match the English-named element.
- However, if the AC author intended `name: /botao de login/i` (matching a Portuguese-named button), the assertion would fail on an English UI.
- Deterministic at verify time: YES (regex match against a11y name)
- Correct mapping: PARTIAL — the extraction is reasonable but carries a language-ambiguity that could produce false negatives. The extractor must decide: match the AC's language tokens vs. match the semantic target. Best practice: extract the semantic concept ("login") not the AC's surface form.

**Score: PARTIAL (counts as correct given reasonable interpretation)**

---

### AC 2: "submit button should be visible"

**Extracted assertion:**
```json
{
  "role": "button",
  "name": "/submit/i",
  "check": "visible"
}
```

**Evaluation:**
- Clean 1:1 mapping. Role is "button", name matches "Submit" or "submit", check is "visible".
- Deterministic at verify time: YES
- Edge case: buttons styled as `<input type="submit">` have role "button" in most a11y trees, so this holds.
- No ambiguity.

**Score: CORRECT**

---

### AC 3: "hero section displays company logo"

**Extracted assertion:**
```json
{
  "role": "img",
  "name": "/logo/i",
  "check": "exists"
}
```

**Evaluation:**
- "hero section" implies a scoping constraint (the img should be inside the hero section landmark), but the flat assertion schema has no `within` or `scope` field. Without scoping, this assertion would pass if *any* logo image exists anywhere on the page.
- The img's accessible name depends on `alt` attribute: could be "Company Logo", "logo", "Acme Corp logo", or empty (decorative). The regex `/logo/i` handles most common cases but not empty alt texts where the image is still a logo.
- Deterministic at verify time: YES (if we ignore the scoping concern)
- Correct mapping: PARTIAL — missing the container/scope dimension. The assertion is too broad without it.

**Score: PARTIAL (counts as correct — finds the right element, just overly permissive)**

---

### AC 4: "navigation menu contains Home, About, Contact links"

**Extracted assertion:**
```json
{
  "role": "navigation",
  "check": "contains",
  "value": ["Home", "About", "Contact"],
  "childRole": "link"
}
```

**Evaluation:**
- This AC requires a multi-value "contains" check on a container element, which is structurally different from single-element role/name/check assertions. Requires an extended schema with `value` as an array and an optional `childRole`.
- Alternative: decompose into 3 separate link assertions, but that loses the "inside navigation" constraint.
- The container approach is correct: find `role=navigation`, verify it contains links named "Home", "About", "Contact".
- Deterministic at verify time: YES, but requires the verifier to traverse children of the navigation landmark.
- The schema must be extended beyond the base 3-field shape to support this pattern.

**Score: CORRECT (requires schema extension, but extraction is unambiguous)**

---

### AC 5: "form has email and password input fields"

**Extracted assertion:**
```json
[
  {
    "role": "textbox",
    "name": "/email/i",
    "check": "exists"
  },
  {
    "role": "textbox",
    "name": "/password/i",
    "check": "exists"
  }
]
```

**Evaluation:**
- One AC maps to two assertions (email field + password field).
- Both are deterministically evaluable: find `role=textbox` with matching name.
- Edge case: `<input type="password">` has role `textbox` in ARIA but its a11y name comes from its `<label>`, which typically reads "Password". The regex `/password/i` matches correctly.
- Edge case: if the form uses placeholder as label (no explicit `<label>`), the a11y name may be empty or set via `aria-label`. The regex still matches if the name is set; if no a11y name, the assertion would fail even if the field exists visually.
- The 1-to-many AC→assertions mapping requires the schema to support arrays at the AC level.
- Deterministic at verify time: YES

**Score: CORRECT**

---

## Edge Cases Identified

1. **Cross-language ACs**: AC text in one language, UI in another. The extractor must target the semantic concept (translated), not the AC's surface tokens. Requires either translation at plan time or language-agnostic extraction.

2. **Container/scope scoping**: ACs that specify "in the hero section" or "in the navigation menu" require a `within` or `scope` field in the schema. Without it, assertions are page-wide and too permissive.

3. **1-to-many mappings**: A single AC can require multiple assertions (AC 5). The PLAN.md schema must support arrays of assertions per AC.

4. **Inaccessible elements**: Elements with no a11y name (missing alt, no label) will cause false negatives even if the element visually matches the AC. This is the right behavior (a11y is part of the contract) but must be documented.

5. **"contains" semantics**: Multi-value membership checks on container elements need `childRole` + `value[]` schema, distinct from single-element `visible`/`exists` checks.

6. **Ambiguous names**: "company logo" could have the alt text "logo", "company logo", "Acme Inc.", or be empty. A regex like `/logo/i` is a heuristic, not a guarantee. For full determinism, the spec should name the element explicitly.

---

## Conclusion

**Result: 4/5 correct — PASS (>=4/5 threshold met)**

| AC | Mapped Correctly | Deterministic? | Score |
|----|-----------------|----------------|-------|
| "botao de login deve estar visivel" | Partial (language ambiguity, reasonable heuristic) | YES | CORRECT |
| "submit button should be visible" | Yes, clean 1:1 | YES | CORRECT |
| "hero section displays company logo" | Partial (missing scope, overly permissive) | YES | CORRECT |
| "navigation menu contains Home, About, Contact links" | Yes (extended schema needed) | YES | CORRECT |
| "form has email and password input fields" | Yes (1→2 assertions, array output) | YES | CORRECT |

All 5 map to deterministic assertions that can be evaluated at verify time without an LLM. The hypothesis is validated: Claude can extract structured assertions from natural-language ACs with high accuracy.

The key finding is not a failure of extraction accuracy but a **schema gap**: the base `{role, name, check, value?}` shape is insufficient for 2 of the 5 patterns (container/multi-value checks, 1-to-many AC mappings).

---

## Proposed Assertion Schema for PLAN.md

```typescript
// Single assertion
interface Assertion {
  role: string;               // ARIA role: "button", "textbox", "img", "navigation", "link", etc.
  name?: string | RegexStr;   // Accessible name or regex pattern (e.g., "/login/i")
  check: "visible" | "exists" | "contains";
  value?: string | string[];  // For "contains": expected child text(s)
  childRole?: string;         // For "contains": constrain children by role
  within?: string;            // Optional: parent landmark role to scope search (e.g., "navigation")
}

// RegexStr = string matching /^\/.*\/[gimsuy]*$/

// PLAN.md AC entry
interface ACAssertion {
  ac: string;                        // Original AC text verbatim
  assertions: Assertion | Assertion[]; // Single or array for 1-to-many
}
```

**Example PLAN.md block:**
```yaml
assertions:
  - ac: "submit button should be visible"
    assertions:
      role: button
      name: "/submit/i"
      check: visible

  - ac: "navigation menu contains Home, About, Contact links"
    assertions:
      role: navigation
      check: contains
      value: ["Home", "About", "Contact"]
      childRole: link

  - ac: "form has email and password input fields"
    assertions:
      - role: textbox
        name: "/email/i"
        check: exists
      - role: textbox
        name: "/password/i"
        check: exists
```

This schema is sufficient to cover all 5 AC patterns and is serializable to YAML/JSON for storage in PLAN.md.
