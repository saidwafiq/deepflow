---
hypothesis: inputs_hash canonical formula produces stable output across file reorderings and whitespace-sensitive differences
inputs_hash: sha256:f73b4caa9d9b49d14d06003555d1f523972bf213f264fd9b311e8c788da3ce41
command: node test-hash.js
exit_code: 0
assertions:
  - metric: reorder_stability
    expected: identical_hash_despite_file_order_change
    observed: hash1 === hash2 === hash4 (all f73b4caa9d9b...)
    pass: true
  - metric: whitespace_sensitivity
    expected: different_hash_on_hypothesis_whitespace_change
    observed: hash3 (e49625b6...) !== hash1
    pass: true
  - metric: formula_verbatim_match
    expected: sha256(hypothesis + "\n" + sorted(blob_shas).join("\n") + "\n" + lockfile_sha)
    observed: implementation matches spike-gate REQ-5 and spike-isolation REQ-1 exactly
    pass: true
status: pass
---

## Hypothesis

The inputs_hash canonical formula `sha256(hypothesis + "\n" + sorted(touched_file_shas).join("\n") + "\n" + dep_lockfile_hash)` produces stable, deterministic output across file reorderings and correctly differentiates whitespace variants.

## Method

1. Implemented canonical formula per spike-gate REQ-5 and spike-isolation REQ-1
2. Computed hash for baseline: hypothesis "Validate foo behavior", files [README.md, package.json], lockfile package-lock.json
3. Reordered files [package.json, README.md], recomputed hash
4. Altered hypothesis whitespace ("Validate  foo  behavior"), recomputed hash
5. Verified hash identity for file-reorder cases, hash divergence for whitespace case

## Results

```
hash1 (baseline): f73b4caa9d9b49d14d06003555d1f523972bf213f264fd9b311e8c788da3ce41
hash2 (files reordered): f73b4caa9d9b49d14d06003555d1f523972bf213f264fd9b311e8c788da3ce41
hash2 === hash1: true
hash3 (whitespace diff): e49625b640cea5c7a010b033592a1e3fb32f09829a6065ef55d6d08c8788d5f0
hash3 === hash1: false
hash4 (reordered, same hypothesis): f73b4caa9d9b49d14d06003555d1f523972bf213f264fd9b311e8c788da3ce41
hash4 === hash1: true

Stability Checks:
Reordering files yields identical hash: true
Whitespace change yields different hash: true
```

## Criteria Check

- **Reorder stability**: PASS — hash1 === hash2 === hash4 despite [README.md, package.json] vs [package.json, README.md] ordering
- **Whitespace sensitivity**: PASS — hash3 diverges from hash1 when hypothesis contains extra spaces, confirming the formula treats hypothesis as verbatim (no normalization)
- **Formula verbatim match**: PASS — implementation `sha256(hypothesis + "\n" + sorted(blob_shas).join("\n") + "\n" + lockfile_sha)` matches both spike-gate REQ-5 and spike-isolation REQ-1 exactly; sorted ascending blob SHAs guarantee order independence

## Conclusion

**PASSED** — Formula is stable across file reorderings (ascending sort on blob SHAs), correctly sensitive to hypothesis whitespace differences, and verbatim-matches the contract in both spike-gate REQ-5 and spike-isolation REQ-1.

### Confidence

**HIGH** — Direct SHA256 comparison across controlled variants; formula documented identically in both cross-spec locations (spike-gate REQ-5, spike-isolation REQ-1); no ambiguity in sort order (ascending) or delimiter (newline).

### Implementation Notes

- Git blob SHAs computed via `git hash-object <file>` per file in touched set
- Lockfile hash is sha256 of entire lockfile content (package-lock.json / yarn.lock / pnpm-lock.yaml / go.sum / Cargo.lock / poetry.lock)
- Sort is ascending lexicographic on SHA strings
- Delimiters are literal `"\n"` characters between hypothesis, each blob SHA, and lockfile hash
- No normalization of hypothesis string (whitespace preserved)
