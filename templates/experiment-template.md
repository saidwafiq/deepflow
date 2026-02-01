# Experiment: {hypothesis-slug}

> **Filename convention**: `{topic}--{hypothesis-slug}--{status}.md`
> Status: `active` | `passed` | `failed`

## Topic

{Spec name or feature area this experiment relates to}

<!--
What problem or feature does this experiment address?
Link to relevant spec if applicable.
-->

## Hypothesis

{What we believe will work and why}

<!--
Be specific and testable:
- "Using approach X will achieve Y because Z"
- "The bottleneck is in component A, not B"
- Should be falsifiable in a single experiment
-->

## Method

{Minimal steps to validate the hypothesis}

<!--
Keep it minimal - fastest path to prove/disprove:
1. Step one (e.g., "Create test file with X")
2. Step two (e.g., "Run command Y")
3. Step three (e.g., "Observe output Z")

Time-box: ideally under 30 minutes
-->

## Result

**Status**: {pass | fail}

{Actual outcome with evidence}

<!--
Include concrete evidence:
- Error messages, output logs
- Metrics or measurements
- Screenshots if applicable
- What specifically happened vs. expected
-->

## Conclusion

{What we learned from this experiment}

<!--
Answer these:
- Why did it pass/fail?
- What assumption was validated/invalidated?
- If failed: What's the next hypothesis? (don't repeat same approach)
- If passed: What's ready for implementation?
-->

---

<!--
Experiment Guidelines:
- One hypothesis per experiment
- Failed experiments are valuable - they inform the next hypothesis
- Never repeat a failed approach without a new insight
- Keep experiments small and fast (under 30 min)
- Link related experiments in conclusions
-->
