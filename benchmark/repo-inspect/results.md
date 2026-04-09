# Repo-Inspect Benchmark Results

Run at: 2026-04-09T04:42:25.275Z
Timeout per approach: 300s

## Comparison Table

> **Bold** values indicate the winner for that metric.

| Approach         | Status  | Total Tokens | Tool Calls | Wall Time (ms) | Quality (0-8) | Cache Ratio   | Context Burn % |
| ---------------- | ------- | ------------ | ---------- | -------------- | ------------- | ------------- | -------------- |
| A (browse-fetch) | success | 1107460      | 68         | 295332         | 6             | 64811.412     | 11             |
| B (WebFetch+gh)  | success | **23957**    | **17**     | **54533**      | **7**         | 7772.333      | **2**          |
| C (local-clone)  | success | 777631       | 33         | 105450         | 0             | **70403.909** | 11             |

## Winners by Metric

- **Total Tokens**: B
- **Tool Calls**: B
- **Wall Time**: B
- **Quality Score**: B
- **Cache Ratio**: C
- **Context Burn**: B

## Notes

- Quality score: 0–8 checks (see `score.js`). Higher is better.
- Cache ratio: cache_read_tokens / total_tokens. Higher is better.
- Context burn: estimated % of context window consumed. Lower is better.
- Tool calls: total tool invocations. Lower is better.
