# Canary Async Write — Detached Subprocess Latency

**Spike:** T13  
**Status:** PASSED  
**Date:** 2026-04-22

## Hypothesis

A detached `child_process.spawn(..., { detached: true, stdio: 'ignore' }).unref()` from a PreToolUse hook keeps added latency <5ms p95 over 50 runs under `process.exit(0)` semantics. `setImmediate` is insufficient because `process.exit(0)` kills the event loop before the callback fires.

## Method

1. Examined `hooks/df-bash-rewrite.js` to confirm exit behavior: all code paths end in `process.exit(0)` (via `hooks/lib/hook-stdin.js` lines 36, 43)
2. Created latency probe at `/tmp/canary-latency-probe.js` measuring:
   - Baseline: empty loop overhead (50 runs)
   - Canary: detached `spawn('node', ...)` overhead (50 runs)
   - p95 delta calculation
3. Tested two spawn approaches:
   - Node.js subprocess: `spawn('node', ['-e', 'fs.appendFileSync...'])`
   - Shell subprocess: `spawn('sh', ['-c', 'echo ... >> file'])`
4. Created falsifier at `/tmp/setimmediate-falsifier.js` to confirm `setImmediate` + `process.exit(0)` fails to write

## Results

### Approach 1: Node.js Subprocess

```
Baseline (no spawn):
  Mean: 0.000 ms
  p95:  0.001 ms

Detached spawn (canary write):
  Mean: 8.403 ms
  p95:  21.097 ms

Delta (canary - baseline):
  Mean: 8.403 ms
  p95:  21.096 ms

Threshold: 5 ms
Result: FAIL (p95 delta 21.096 ms)

Canary output verification:
  Entries: 50 / 50 expected
  Verification: PASS (all writes completed after parent exit)
```

**Verdict:** Functional but too slow. Node.js startup overhead exceeds threshold.

### Approach 2: Shell Subprocess

```
Baseline (no spawn):
  Mean: 0.000 ms
  p95:  0.000 ms

Detached spawn (shell echo):
  Mean: 1.721 ms
  p95:  2.674 ms

Delta (canary - baseline):
  Mean: 1.721 ms
  p95:  2.674 ms

Threshold: 5 ms
Result: PASS (p95 delta 2.674 ms)

Canary output verification:
  Entries: 50 / 50 expected
  Verification: PASS (all writes completed after parent exit)
```

**Verdict:** PASSED. Shell-based spawn is 8x faster and meets latency requirement.

### setImmediate Falsifier

```
setImmediate callbacks scheduled (10 entries)
Calling process.exit(0) immediately...
FALSIFIER PASSED: No file created (setImmediate callbacks did not fire)
```

**Verdict:** Confirmed. `setImmediate` + `process.exit(0)` kills callbacks before execution.

## Criteria Check

- **p95 latency delta < 5ms:** PASS (2.674ms with shell spawn)
- **Detached write confirmed after parent exit:** PASS (50/50 entries written)
- **setImmediate approach confirmed to fail:** PASS (0 entries written)

## Conclusion

**PASSED** — Detached shell subprocess keeps PreToolUse latency under 5ms p95 while guaranteeing async writes complete after `process.exit(0)`.

### Confidence

**HIGH** — 50-run latency sample with consistent results; both approaches tested; falsifier confirms setImmediate is insufficient.

## Recommended Implementation Pattern for T22

```javascript
const { spawn } = require('child_process');

function writeCanaryAsync(filepath, data) {
  const jsonLine = JSON.stringify(data);
  spawn('sh', ['-c', `echo '${jsonLine}' >> ${filepath}`], {
    detached: true,
    stdio: 'ignore'
  }).unref();
}
```

**Key insights:**

1. Use shell (`sh -c echo >> file`) not Node.js (`node -e`) to minimize spawn overhead
2. `detached: true` + `stdio: 'ignore'` + `unref()` allows parent to exit without waiting
3. Shell process inherits nothing from parent, survives `process.exit(0)`
4. Added latency: ~2.7ms p95 (acceptable for PreToolUse hook)
5. Alternative approach (Node.js subprocess): 21ms p95 — too slow but functional if needed

**Trade-offs:**

- Shell dependency (requires `sh` in PATH, macOS/Linux only)
- No error feedback (stdio ignored, fire-and-forget)
- Race condition: canary write may not complete before Claude reads output (acceptable for async logging)
