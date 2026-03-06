#!/usr/bin/env bash
set -euo pipefail

# Spike test: Shell script orchestration of claude -p with worktree isolation
# This script creates 2 worktrees, spawns claude -p in each, monitors context, collects results.

MAIN_REPO="/Users/saidsalles/apps/agentSkills/deepflow"
WORKTREE_BASE="$MAIN_REPO/.deepflow/worktrees"
APPROACHES=("spike-test-approach-1" "spike-test-approach-2")
TIMEOUT=120
POLL_INTERVAL=5
LOG_DIR="/tmp/spike-test-logs"
mkdir -p "$LOG_DIR"

echo "=== PHASE 1: Create worktrees ==="
for approach in "${APPROACHES[@]}"; do
  wt_path="$WORKTREE_BASE/$approach"
  branch="df/$approach"

  # Clean up if exists
  if [ -d "$wt_path" ]; then
    echo "Removing existing worktree: $wt_path"
    git -C "$MAIN_REPO" worktree remove --force "$wt_path" 2>/dev/null || true
    git -C "$MAIN_REPO" branch -D "$branch" 2>/dev/null || true
  fi

  echo "Creating worktree: $approach -> $wt_path (branch: $branch)"
  git -C "$MAIN_REPO" worktree add -b "$branch" "$wt_path" main

  # Create results directory in each worktree
  mkdir -p "$wt_path/.deepflow/results"

  echo "  Worktree created: $(git -C "$wt_path" branch --show-current)"
done

echo ""
echo "=== PHASE 2: Spawn claude -p processes in parallel ==="
PIDS=()
for i in "${!APPROACHES[@]}"; do
  approach="${APPROACHES[$i]}"
  n=$((i + 1))
  wt_path="$WORKTREE_BASE/$approach"

  prompt="Create a file called test-output.txt with the content 'hello from approach $n'. Then create a YAML file at .deepflow/results/spike-test.yaml with this exact content:
task: spike-test
status: success
summary: created test file from approach $n"

  echo "Spawning claude -p for $approach (approach $n)..."

  (
    cd "$wt_path"
    unset CLAUDECODE
    claude -p --dangerously-skip-permissions "$prompt" > "$LOG_DIR/$approach.stdout" 2> "$LOG_DIR/$approach.stderr"
    echo $? > "$LOG_DIR/$approach.exitcode"
  ) &
  PIDS+=($!)
  echo "  PID: ${PIDS[$i]}"
done

echo ""
echo "=== PHASE 2b: Poll context.json files ==="
CONTEXT_FINDINGS=""
elapsed=0
all_done=false
while [ $elapsed -lt $TIMEOUT ] && [ "$all_done" = "false" ]; do
  echo "[${elapsed}s] Polling..."
  all_done=true
  for i in "${!APPROACHES[@]}"; do
    approach="${APPROACHES[$i]}"
    wt_path="$WORKTREE_BASE/$approach"
    pid="${PIDS[$i]}"

    # Check if context.json exists
    ctx_file="$wt_path/.deepflow/context.json"
    if [ -f "$ctx_file" ]; then
      ctx_content=$(cat "$ctx_file" 2>/dev/null || echo "unreadable")
      echo "  $approach context.json: $ctx_content"
      CONTEXT_FINDINGS="context.json found in worktree"
    else
      echo "  $approach: no context.json"
      CONTEXT_FINDINGS="context.json NOT found in worktree (not written in -p mode)"
    fi

    # Check if process still running
    if kill -0 "$pid" 2>/dev/null; then
      all_done=false
      echo "  $approach: still running (PID $pid)"
    else
      echo "  $approach: completed"
    fi
  done

  if [ "$all_done" = "false" ]; then
    sleep $POLL_INTERVAL
    elapsed=$((elapsed + POLL_INTERVAL))
  fi
done

echo ""
echo "=== PHASE 3: Wait for completion ==="
EXIT_CODES=()
for i in "${!APPROACHES[@]}"; do
  approach="${APPROACHES[$i]}"
  pid="${PIDS[$i]}"

  echo "Waiting for $approach (PID $pid)..."
  wait "$pid" 2>/dev/null
  actual_exit=$?

  # Also check the saved exit code
  saved_exit=$(cat "$LOG_DIR/$approach.exitcode" 2>/dev/null || echo "$actual_exit")
  EXIT_CODES+=("$saved_exit")
  echo "  Exit code: $saved_exit"
  echo "  Stdout (first 5 lines):"
  head -5 "$LOG_DIR/$approach.stdout" 2>/dev/null | sed 's/^/    /'
  echo "  Stderr (first 5 lines):"
  head -5 "$LOG_DIR/$approach.stderr" 2>/dev/null | sed 's/^/    /'
done

echo ""
echo "=== PHASE 4: Check results ==="
for approach in "${APPROACHES[@]}"; do
  wt_path="$WORKTREE_BASE/$approach"
  result_file="$wt_path/.deepflow/results/spike-test.yaml"
  test_file="$wt_path/test-output.txt"

  echo "--- $approach ---"
  if [ -f "$result_file" ]; then
    echo "  Result YAML: EXISTS"
    echo "  Content:"
    cat "$result_file" | sed 's/^/    /'
  else
    echo "  Result YAML: MISSING"
    echo "  Checking .deepflow/results/ contents:"
    ls -la "$wt_path/.deepflow/results/" 2>/dev/null | sed 's/^/    /'
  fi

  if [ -f "$test_file" ]; then
    echo "  test-output.txt: EXISTS ($(cat "$test_file"))"
  else
    echo "  test-output.txt: MISSING"
  fi
done

echo ""
echo "=== PHASE 5: Sequential test ==="
echo "Testing sequential execution (simulating --parallel=1)..."
SEQ_START=$(date +%s)
for i in "${!APPROACHES[@]}"; do
  approach="${APPROACHES[$i]}"
  wt_path="$WORKTREE_BASE/$approach"
  echo "  Sequential run for $approach..."
  (cd "$wt_path" && unset CLAUDECODE && claude -p --dangerously-skip-permissions "Write 'sequential test ok' to sequential-test.txt" > "$LOG_DIR/$approach-seq.stdout" 2> "$LOG_DIR/$approach-seq.stderr")
  seq_exit=$?
  echo "  Exit code: $seq_exit"
done
SEQ_END=$(date +%s)
echo "  Sequential total time: $((SEQ_END - SEQ_START))s"

echo ""
echo "=== SUMMARY ==="
echo "Worktrees created: ${#APPROACHES[@]}"
echo "Exit codes: ${EXIT_CODES[*]}"
echo "Context monitoring: $CONTEXT_FINDINGS"
echo "Parallel execution: completed (used & and wait)"

echo ""
echo "=== PHASE 6: Cleanup worktrees ==="
for approach in "${APPROACHES[@]}"; do
  wt_path="$WORKTREE_BASE/$approach"
  branch="df/$approach"
  echo "Removing worktree: $wt_path"
  git -C "$MAIN_REPO" worktree remove --force "$wt_path" 2>/dev/null || true
  git -C "$MAIN_REPO" branch -D "$branch" 2>/dev/null || true
done
echo "Cleanup complete."
