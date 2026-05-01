# Impact: {spec-name}

Generated: {timestamp}

## Caller Graph

{symbol} ({file}:{startLine}-{endLine})
  callers:
    - {caller-file}:{startLine}-{endLine} — {caller-symbol}
  fan-out: {count}

## Summary

touched_files: {count}
touched_symbols: {count}
max_fan_out: {symbol} ({count} callers)

---

<!--
Impact Guidelines:
- Written by /df:spec's blast-radius pass for L3 specs only; not produced for L0-L2
- Each caller entry must include file:startLine-endLine per symbol and fan-out count
- Consumed by subsequent stages via shell-injection: cat ... 2>/dev/null || echo 'NOT_FOUND'
- Missing file is the no-op default; presence is always additive
-->
