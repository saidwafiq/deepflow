# example-task

## Objective

Create output artifacts for two tasks to demonstrate the pipeline works end-to-end.

## T1: Create greeting artifact

Write `output/T1/result.json` with `{ "status": "complete", "message": "hello" }`.

## T2: Create summary artifact

Write `output/T2/result.json` with `{ "status": "complete", "items": 2 }`.

## Acceptance Criteria

- [ ] `output/T1/result.json` exists and `status === "complete"`
- [ ] `output/T2/result.json` exists and `status === "complete"`
