# Experiment: Stable Issue-Signature Hashing

**Hypothesis:** A stable hash of sorted, normalized `(level, file, rule)` tuples yields
identical output across two verify runs that produce the same logical issue set, and
differs when any tuple changes.

**Status: PASS** — all assertions confirmed by running `hash.js`.

---

## 1. Normalization Rules

| Field  | Rule |
|--------|------|
| `level` | `trim()` + `toLowerCase()` — e.g. `"L4 "` → `"l4"` |
| `file`  | `trim()` + replace `\` with `/` + strip line/col suffix (`:\d+.*$` removed) + `toLowerCase()` — e.g. `"src/Foo.ts:42:1"` → `"src/foo.ts"` |
| `rule`  | `trim()` + `toLowerCase()` — e.g. `"TS2345"` → `"ts2345"` |

**Why strip line numbers?** The same rule can shift lines between cycles while the
underlying issue is unchanged (e.g. a test failure moves because a helper was refactored).
Keeping line numbers would produce false "progress" signals. No-progress detection cares
about *which rules in which files*, not *where in the file*.

**Why lowercase everything?** File-system paths on macOS are case-insensitive; rule IDs
can vary in casing across tool versions. Normalizing avoids spurious mismatches.

---

## 2. Hash Algorithm

**SHA-256, 16-char hex prefix (64-bit)**

- MD5: rejected — known collision attacks, deprecated in security contexts.
- SHA-1: rejected — deprecated by NIST, git is moving away from it.
- SHA-256: standard, collision-free for practical input sizes, available in Node `crypto`
  with no dependencies.
- 16-char prefix (64 bits): collision probability ≈ 1/2^64 for any two distinct issue
  sets — astronomically safe for a build system tracking dozens of issues.

---

## 3. Serialization Format

Steps before hashing:
1. Normalize each tuple (see §1).
2. Deduplicate: same `(level, file, rule)` seen twice → counted once.
3. Sort: lexicographic on `"level|file|rule"` string key.
4. Join: `\n`-separated `"level|file|rule"` lines.
5. Hash the UTF-8 bytes with SHA-256, take `[0..16]` of hex digest.

**Why not JSON?** JSON with sorted keys is verbose and key-order guarantees require
explicit sorting. The pipe-delimited format is simpler, unambiguous (none of level/file/rule
contain `|`), and smaller.

**Why sort before hashing?** Issue extraction order can vary across runs (parallel tool
output). Sorting makes the signature order-independent.

---

## 4. Collision Concerns & Falsing Scenarios

| Scenario | Signature behavior | Correct? |
|----------|-------------------|----------|
| Same rule, same file, different line | **Same** — line numbers stripped | Yes — same issue, no progress |
| Same rule, different file | **Different** — file is part of key | Yes — different issue location |
| Different rule, same file+line | **Different** — rule is part of key | Yes — new failure category |
| Duplicate issue in one run | **Same as single** — deduped | Yes — idempotent |
| Run order differs between cycles | **Same** — sorted before hashing | Yes — order-independent |
| Two distinct issue sets that collide | Probability ≈ 1/2^64 | Acceptable — astronomically rare |

**False "no-progress" risk:** If a fix resolves one issue but introduces a different issue
in the same file with a similar rule name that happens to hash-collide — impossible in
practice given 64-bit prefix.

**False "progress" risk:** If an agent changes only line numbers (e.g. inserts blank lines)
without fixing the actual failure, the signature stays the same and the loop correctly
halts. This is the desired behavior.

---

## 5. Demo — Computed Signatures

**Input A1** (run 1):
```
{ level: "L4 ", file: "src/Foo.ts:42:1", rule: "TS2345" }
{ level: "l0",  file: "src/bar.ts:7",    rule: "build-error" }
```

**Input A2** (run 2 — same issues, different casing/line numbers):
```
{ level: "l0",  file: "SRC/bar.ts",      rule: "BUILD-ERROR" }
{ level: "L4",  file: "src/foo.ts:99:3", rule: "ts2345" }
```

**Input B** (different rule `TS2304` instead of `TS2345`):
```
{ level: "L4",  file: "src/foo.ts:42:1", rule: "TS2304" }
{ level: "l0",  file: "src/bar.ts:7",    rule: "build-error" }
```

```
sig(A1) = 7e4f870d0fde7372
sig(A2) = 7e4f870d0fde7372   ← identical (same logical issues)
sig(B)  = 7d27762c7e3df5df   ← different (rule changed)

A1 === A2 → true  ✓
A1 === B  → false ✓
Determinism (A1 run twice) → true ✓
Order independence (reversed) → true ✓
```

---

## 6. Proposed auto-memory.yaml Fields

```yaml
# Written by /df:verify after each blocking-issue check.
# Reset to null / 0 on clean verify or spec transition.
auto_fix_last_signature: "7e4f870d0fde7372"   # 16-char SHA-256 prefix
auto_fix_iteration: 1                           # increments each auto-fix cycle
```

**No-progress detection logic (pseudocode):**
```
current_sig = computeSignature(blocking_issues)
if current_sig == auto_fix_last_signature:
    halt("no progress — same blocking issue signature as last cycle")
else:
    write auto_fix_last_signature = current_sig
    write auto_fix_iteration += 1
    invoke /df:execute --continue
```

---

## DECISIONS

- [APPROACH] Strip line numbers from file paths before hashing — same rule shifting lines is not progress; keeping line numbers would produce false progress signals.
- [APPROACH] SHA-256 with 16-char prefix — no dependencies, no known collisions, 64-bit collision resistance is sufficient for build-failure tracking.
- [APPROACH] Pipe-delimited `level|file|rule` serialization — simpler and smaller than JSON; `|` is safe because none of the three fields contain it in practice.
- [PROVISIONAL] Deduplication before hashing — if the same (level, file, rule) appears twice in one run (e.g. two test failures for the same rule), count once; avoids count-sensitivity in the signature.
- [ASSUMPTION] File paths will not contain the `|` character — this holds for all realistic source paths; if needed, escape with `%7C` before serialization.
