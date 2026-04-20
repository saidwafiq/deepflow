# Spike: byte-identical round-trip on `standard-task` template

Status: **active** (PASS)
Spec: `specs/doing-extract-agent-prompt-templates.md` (ACs AC-2, AC-5)
Task: T7

## Hypothesis

A `{{TOKEN}}` placeholder strategy + a ~30-LOC `String.prototype.replace` resolver can
reproduce the current `src/commands/df/execute.md` **Standard Task** block
byte-for-byte given the right context object. Conditional blocks
(`reverted` / `spike_results` / `domain_model` / `existing_types`) collapse
cleanly when their tokens are empty strings.

## Result: **PASS**

Harness: `experiments/extract-agent-prompt-templates/roundtrip.js`
Template: `experiments/extract-agent-prompt-templates/standard-task.tmpl`
Fixtures:
  - `expected-minimal.txt` — all optional blocks collapsed, `TASK_BODY` uses fallback inline block (lines 443–445 of the original).
  - `expected-full.txt`    — all optional blocks populated, `TASK_BODY` is custom.

Both render paths produce output identical to the hand-authored expected files at the byte level:

```
[minimal (optional blocks collapsed)] byte-identical: true
[full    (all blocks present)]        byte-identical: true
```

## Token inventory (10 total)

| Token                       | Kind          | Origin in execute.md    | Notes                                                                 |
|-----------------------------|---------------|-------------------------|-----------------------------------------------------------------------|
| `{{TASK_ID}}`               | scalar        | `{task_id}` L423        | always present                                                        |
| `{{DESCRIPTION}}`           | scalar        | `{description}` L423    | always present                                                        |
| `{{FILES}}`                 | scalar        | `{files}` L423          | always present                                                        |
| `{{SPEC}}`                  | scalar        | `{spec}` L423           | always present                                                        |
| `{{ACS}}`                   | scalar        | `{ACs...}` L432         | always present                                                        |
| `{{REVERTED_BLOCK}}`        | pre-rendered  | `{If reverted: ...}` L424 | present => full line + trailing `\n`; absent => `""`                |
| `{{SPIKE_BLOCK}}`           | pre-rendered  | `{If spike insights...}` L425–431 | present => 5 yaml-ish lines + trailing `\n`; absent => `""` |
| `{{DOMAIN_MODEL_BLOCK}}`    | pre-rendered  | `{If WAVE_JSON[task].domain_model...}` L433–436 | present => header + body + `\n`; absent => `""` |
| `{{EXISTING_TYPES_BLOCK}}`  | pre-rendered  | `{If EXISTING_TYPES...}` L437–440 | present => header + body + `\n`; absent => `""`             |
| `{{TASK_BODY}}`             | scalar        | L442 (task_detail_body OR fallback inline L443–445) | caller picks custom body or fallback 3-line inline block |

## Gotchas discovered

1. **Trailing newlines belong to the VALUE, not the template.** Conditional
   token placements (`{{REVERTED_BLOCK}}{{SPIKE_BLOCK}}` flush on one line;
   `{{DOMAIN_MODEL_BLOCK}}{{EXISTING_TYPES_BLOCK}}--- MIDDLE ---` flush on one
   line) must have **no** hard newline between them in the template. The
   present-value string supplies its own trailing `\n`; an absent value is
   `""` and leaves zero whitespace residue. This is the key to "clean
   optional collapse".
2. **No em-dash surprises.** Both the template and the `execute.md` source
   use U+2014 (`—`) and U+2192 (`→`) literally; `utf8` file read + naïve
   `String.replace` preserves them with zero mangling.
3. **Nested triple-backticks.** The Standard Task block contains an inner
   AC_COVERAGE fenced block. The outer ``` that terminates the template in
   `execute.md` is NOT part of the rendered prompt, so we deliberately end
   the `.tmpl` file one line earlier (after `TASK_STATUS:...`). The inner
   fences stay verbatim in the template — nothing special needed.
4. **`TASK_BODY` is not a conditional; it's a selector.** Line 442 of the
   original isn't an if-block — it's "use `task_detail_body` if non-empty,
   else inline block". Caller decides which string to hand in. Keeping the
   selection in the caller (per the APPROACH decision) means the resolver
   stays a one-liner.

## Decisions

- **[APPROACH]** Caller pre-renders conditional blocks — keeps the resolver
  trivial (one regex + map lookup). Branching lives outside the template
  engine, so the template is pure text substitution.
- **[ASSUMPTION]** Empty token renders as empty string — enables clean
  optional collapse because present-values carry their own trailing `\n`.
- **[APPROACH]** `TASK_BODY` is a caller-supplied scalar (not a conditional),
  letting the caller pick `WAVE_JSON[task].task_detail_body` vs. the inline
  fallback without any template-side logic.

## What this spike does NOT do

- Does NOT extract the production `templates/agent-prompts/` directory (T9).
- Does NOT build the production `bin/prompt-compose.js` (T8).
- Only one template (`standard-task`) validated. Other blocks
  (Integration / Spike / Optimize / Wave Test) will use the same pattern in
  T8/T9 but are out of scope here.

## Files modified / created

- `experiments/extract-agent-prompt-templates/standard-task.tmpl`
- `experiments/extract-agent-prompt-templates/expected-minimal.txt`
- `experiments/extract-agent-prompt-templates/expected-full.txt`
- `experiments/extract-agent-prompt-templates/roundtrip.js`
- `experiments/extract-agent-prompt-templates--byte-identical-roundtrip--active.md` (this note)
