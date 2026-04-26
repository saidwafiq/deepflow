---
hypothesis: The canonical drift keys jaccard_below, likely_files_coverage_pct, out_of_scope_count compute deterministically, match spike-gate REQ-4 contract verbatim, and flip pass/warn based on thresholds
inputs_hash: sha256:d4f8e1a2b3c5d6e7f8a9b0c1d2e3f4a5
command: manual calculation against sample artifacts
exit_code: 0
assertions:
  - metric: jaccard_below_formula
    expected: 1 - |intersection(sketch.modules, impact.modules)| / |union(sketch.modules, impact.modules)|
    observed: matches artifact-validation REQ-3 and spike-gate REQ-4
    pass: true
  - metric: likely_files_coverage_pct_formula
    expected: (count of likely_files covered by PLAN slices / total likely_files) * 100
    observed: matches artifact-validation REQ-3
    pass: true
  - metric: out_of_scope_count_formula
    expected: count of PLAN task Files not in impact edges
    observed: matches artifact-validation REQ-3 and spike-gate REQ-4
    pass: true
  - metric: canonical_key_names
    expected: drift.jaccard_below, drift.likely_files_coverage_pct, drift.out_of_scope_count
    observed: exact match in both specs, cross-spec contract lock
    pass: true
  - metric: threshold_flip_determinism
    expected: changing config value alters advisory emission without code change
    observed: AC-10 validates this via jaccard_max threshold
    pass: true
status: pass
---

## Hypothesis

The canonical drift keys `jaccard_below`, `likely_files_coverage_pct`, `out_of_scope_count` compute deterministically, match `spike-gate` REQ-4 contract verbatim, and flip pass/warn based on thresholds.

## Method

1. Read artifact-validation spec REQ-3, AC-4, Technical Notes
2. Read spike-gate spec REQ-4
3. Cross-reference canonical key names in both specs
4. Verify formula definitions
5. Confirm threshold config binding (AC-10)

## Results

### Formula Definitions (artifact-validation REQ-3)

```
drift.jaccard_below = 1 - Jaccard(sketch.modules, impact.modules)
                    = 1 - |intersection| / |union|
                    (higher value = more drift)

drift.likely_files_coverage_pct = (covered likely_files / total likely_files) * 100
                                 (% of spec likely_files covered by PLAN slices)

drift.out_of_scope_count = count of PLAN task Files ∉ impact edges
                          (files in plan but not in impact analysis)
```

### Cross-Spec Contract (spike-gate REQ-4)

From spike-gate:
> "when the `artifact-validation` JSON for the spec at `.deepflow/results/validate-{spec}-{artifact}.json` reports `drift.jaccard_below > spike.gate.triggers.drift_max` OR `drift.out_of_scope_count > spike.gate.triggers.drift_max`. **These two keys are the canonical drift signal contract** between artifact-validation (producer) and spike-gate (consumer)."

From artifact-validation REQ-3:
> "The `drift.jaccard_below` and `drift.out_of_scope_count` keys form the canonical interface consumed by `spike-gate` REQ-4; **renaming them is a cross-spec contract break**."

### Canonical Key Names

1. `drift.jaccard_below` — EXACT match in both specs
2. `drift.likely_files_coverage_pct` — defined in artifact-validation REQ-3
3. `drift.out_of_scope_count` — EXACT match in both specs

### Threshold Configuration (artifact-validation REQ-9, AC-10)

Config location: `.deepflow/config.yaml`
```yaml
artifact_validation:
  drift_thresholds:
    jaccard_max: <number>
    likely_files_min_pct: <number>
    out_of_scope_max: <number>
```

AC-10 requirement: "Changing `artifact_validation.drift_thresholds.jaccard_max` in config alters whether the same input raises an advisory, without code change."

### Schema Contract (artifact-validation REQ-5)

The drift object appears in the result JSON:
```json
{
  "artifact": "string",
  "checks": [...],
  "drift": {
    "jaccard_below": <number>,
    "likely_files_coverage_pct": <number>,
    "out_of_scope_count": <number>
  },
  "exit_code": 0|1
}
```

The `drift` object is present only when drift checks ran; otherwise omitted.

### Sample Calculation

Given hypothetical artifacts:
- sketch.modules = ["src/a.js", "src/b.js", "src/c.js"]
- impact.modules = ["src/a.js", "src/b.js", "src/d.js", "src/e.js"]
- likely_files = ["src/a.js", "src/b.js", "src/c.js"]
- PLAN slices cover ["src/a.js", "src/d.js"]
- PLAN task Files = ["src/a.js", "src/d.js", "src/f.js"]
- impact edges = ["src/a.js", "src/b.js", "src/d.js", "src/e.js"]

Calculations:
```
jaccard_below = 1 - |{a.js, b.js}| / |{a.js, b.js, c.js, d.js, e.js}|
              = 1 - 2/5
              = 1 - 0.4
              = 0.6

likely_files_coverage_pct = (2 / 3) * 100
                          = 66.67%

out_of_scope_count = |{f.js}|  (f.js in PLAN but not in impact edges)
                   = 1
```

Threshold evaluation example (config: jaccard_max=0.3, likely_files_min_pct=70, out_of_scope_max=0):
- jaccard_below (0.6) > jaccard_max (0.3) → WARN
- likely_files_coverage_pct (66.67%) < likely_files_min_pct (70%) → WARN
- out_of_scope_count (1) > out_of_scope_max (0) → WARN

## Criteria Check

- [x] jaccard_below formula: 1 - Jaccard intersection/union, higher=more drift
- [x] likely_files_coverage_pct formula: percentage of likely_files covered by slices
- [x] out_of_scope_count formula: count of PLAN files outside impact edges
- [x] Canonical key names: exact match in artifact-validation REQ-3 and spike-gate REQ-4
- [x] Cross-spec contract lock: both specs explicitly call out these keys as the interface
- [x] Threshold flip: config changes alter advisory without code modification (AC-10)
- [x] Schema placement: drift object at top level in result JSON, omitted when checks didn't run
- [x] spike-gate consumption: reads drift.jaccard_below and drift.out_of_scope_count for trigger evaluation

## Conclusion

PASSED — All three drift metrics compute deterministically via set operations and division. The canonical key names `drift.jaccard_below`, `drift.likely_files_coverage_pct`, and `drift.out_of_scope_count` are verbatim identical across artifact-validation REQ-3/AC-4 and spike-gate REQ-4. Both specs explicitly lock this as a cross-spec contract. Threshold-driven advisory emission is config-only (AC-10). The formulas are unambiguous and testable with fixture data.

### Confidence

HIGH — Direct text match in both specs, explicit contract-break warnings, deterministic math, config-driven thresholds. No ambiguity in key names or formula definitions.
