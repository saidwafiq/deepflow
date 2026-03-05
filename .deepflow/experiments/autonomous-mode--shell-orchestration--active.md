# Experiment: Shell Orchestration of claude -p with Worktree Isolation

## Hypothesis

A bash script can spawn multiple `claude -p` processes in separate git worktrees, poll their context.json for usage, and collect structured results (YAML files) upon completion.

## Method

1. Created a bash script (`spike-test.sh`) that:
   - Creates 2 test worktrees (`spike-test-approach-1` and `spike-test-approach-2`) under `.deepflow/worktrees/` in the main repo
   - Spawns `claude -p --dangerously-skip-permissions` in each with a trivial prompt to create test files and YAML results
   - Polls `.deepflow/context.json` in each worktree every 5s (up to 120s timeout)
   - Waits for both processes to complete using `wait`
   - Reads result YAMLs from each worktree
   - Tests sequential execution (simulating --parallel=1)
   - Cleans up all test worktrees and branches

2. Key implementation detail: `CLAUDECODE` environment variable must be unset before spawning child `claude -p` processes, otherwise Claude Code refuses to run (nested session protection).

3. Key implementation detail: `--dangerously-skip-permissions` (or equivalent permission mode) is required for `claude -p` to write files without interactive approval. Without it, processes exit 0 but produce no file output.

## Results

### Criterion 1: Worktree Creation
- **Target**: 2 worktrees with correct naming (`spike-test-approach-1`, `spike-test-approach-2`) and branches (`df/spike-test-approach-1`, `df/spike-test-approach-2`)
- **Actual**: Both worktrees created successfully at expected paths with correct branch names confirmed via `git branch --show-current`
- **Met**: YES

### Criterion 2: claude -p Exit Codes
- **Target**: Both processes exit 0 with output captured
- **Actual**: Both processes exited with code 0. Stdout captured successfully showing confirmation messages. Stderr was empty.
- **Met**: YES

### Criterion 3: Result YAML Files
- **Target**: Exist in each worktree's `.deepflow/results/`
- **Actual**: Both `spike-test.yaml` files existed with correct content:
  - approach-1: `task: spike-test, status: success, summary: created test file from approach 1`
  - approach-2: `task: spike-test, status: success, summary: created test file from approach 2`
  - Additionally, `test-output.txt` files created correctly in each worktree
- **Met**: YES

### Criterion 4: Context Monitoring
- **Target**: Behavior documented
- **Actual**: `context.json` is NOT written by `claude -p` mode. Polling every 5s for the full duration of both processes (approximately 20s) never detected a context.json file in either worktree. This means context-based usage monitoring is not available in `-p` mode. Alternative monitoring approaches would be needed, such as:
  - Using `--output-format stream-json` to get real-time token usage
  - Using `--max-budget-usd` to cap spending
  - Monitoring process liveness via `kill -0 $PID`
- **Met**: YES (behavior documented)

### Criterion 5: Parallel Execution
- **Target**: Job control (`&`, `wait`) works correctly
- **Actual**: Both processes ran in parallel using `&` and were successfully awaited with `wait`. Approach-1 completed at ~15s, approach-2 at ~20s, demonstrating true parallel execution. Sequential test (simulating --parallel=1) took 21s total for both, confirming sequential mode also works.
- **Met**: YES

## Additional Findings

1. **CLAUDECODE environment variable**: Must be unset (`unset CLAUDECODE`) before spawning child `claude -p` processes. Claude Code v2.1.69 detects nested sessions and refuses to run.

2. **Permission handling**: Without `--dangerously-skip-permissions`, `claude -p` exits 0 but cannot write files (no interactive approval possible). The `--permission-mode bypassPermissions` flag is also available as an alternative.

3. **Performance**: Parallel execution of 2 `claude -p` processes took ~20s wall time. Sequential execution of 2 similar prompts took ~21s. For trivial prompts the overhead is similar, but for real workloads parallel execution should provide significant speedup.

4. **Cleanup**: `git worktree remove --force` and `git branch -D` successfully clean up test artifacts.

## Conclusion

The hypothesis is **confirmed**. A bash script can successfully:
- Create isolated git worktrees for parallel work
- Spawn multiple `claude -p` processes with `&` and collect them with `wait`
- Capture exit codes and stdout/stderr
- Collect structured YAML result files from each worktree
- Clean up worktrees after completion

The main caveats are:
- `CLAUDECODE` must be unset for child processes
- `--dangerously-skip-permissions` or equivalent is needed for file writes
- `context.json` is not written in `-p` mode, so alternative monitoring is needed
