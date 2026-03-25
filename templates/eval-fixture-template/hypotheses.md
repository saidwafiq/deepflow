# Hypotheses

Each line is one hypothesis for the eval loop. `/df:eval` picks the next unused
hypothesis from this file when `--hypothesis` flag is not supplied.

Format: one hypothesis per line, plain English. Be specific about what to change and why.

---

Add explicit cache-priming instructions at the top of the skill prompt to front-load repeated context reads.
Reduce the number of tool calls by batching related file reads into a single step.
Reorder instructions to place the most frequently accessed context at the START zone of the prompt (attention U-curve).
Shorten the skill preamble to reduce input tokens on every invocation.
Replace prose descriptions of steps with numbered list format to improve instruction clarity and reduce re-reads.
