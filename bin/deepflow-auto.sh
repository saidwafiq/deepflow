#!/usr/bin/env bash
set -euo pipefail

# Required for spawning child `claude -p` processes.
# Without this, nested Claude Code instances conflict with the parent.
unset CLAUDECODE

# NOTE: Child `claude -p` processes will need `--dangerously-skip-permissions`
# to run without interactive approval prompts.

# Context window monitoring is handled by run_claude_monitored(), which parses
# stream-json output for token usage and restarts when hitting the threshold.

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PARALLEL=0          # 0 = unlimited
HYPOTHESES=2
MAX_CYCLES=0        # 0 = unlimited
CONTINUE=false
FRESH=false
INTERRUPTED=false

# Context window monitoring threshold (percentage). When token usage reaches
# this fraction of the context window, the claude -p process is killed and
# restarted with --resume to get a fresh context window.
CONTEXT_THRESHOLD_PCT=50

# Per-spec status/winner tracking (bash 3.2 compatible, no associative arrays)
# Uses a temp directory with one file per key.
_SPEC_MAP_DIR=""
_spec_map_init() {
  if [[ -z "$_SPEC_MAP_DIR" ]]; then
    _SPEC_MAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deepflow-spec-map.XXXXXX")"
  fi
}
_spec_set() {   # usage: _spec_set STATUS myspec converged
  _spec_map_init
  printf '%s' "$3" > "${_SPEC_MAP_DIR}/${1}__${2}"
}
_spec_get() {   # usage: _spec_get STATUS myspec [default]
  _spec_map_init
  local f="${_SPEC_MAP_DIR}/${1}__${2}"
  if [[ -f "$f" ]]; then cat "$f"; else printf '%s' "${3:-}"; fi
}
_spec_isset() { # usage: _spec_isset STATUS myspec
  _spec_map_init
  [[ -f "${_SPEC_MAP_DIR}/${1}__${2}" ]]
}
_spec_map_cleanup() {
  [[ -n "$_SPEC_MAP_DIR" && -d "$_SPEC_MAP_DIR" ]] && rm -rf "$_SPEC_MAP_DIR"
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

auto_log() {
  local msg="$1"
  mkdir -p "${PROJECT_ROOT}/.deepflow"
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $msg" >> "${PROJECT_ROOT}/.deepflow/auto-decisions.log"
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: deepflow-auto.sh [OPTIONS]

Core orchestration loop for autonomous deepflow execution.
Discovers specs/doing-*.md files and runs hypothesis-select-reject cycles.

Options:
  --parallel=N      Cap concurrent processes (default: unlimited, 0 = unlimited)
  --hypotheses=N    Number of hypotheses per spec (default: 2)
  --max-cycles=N    Cap hypothesis-select-reject cycles (default: unlimited, 0 = unlimited)
  --continue        Resume from checkpoint (placeholder)
  --fresh           Ignore checkpoint, start fresh (placeholder)
  --help            Show this help message
USAGE
}

# ---------------------------------------------------------------------------
# Flag parsing
# ---------------------------------------------------------------------------

parse_flags() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --parallel=*)
        PARALLEL="${1#*=}"
        ;;
      --hypotheses=*)
        HYPOTHESES="${1#*=}"
        ;;
      --max-cycles=*)
        MAX_CYCLES="${1#*=}"
        ;;
      --continue)
        CONTINUE=true
        ;;
      --fresh)
        FRESH=true
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        echo "Error: unknown flag '$1'" >&2
        usage >&2
        exit 1
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Spec discovery
# ---------------------------------------------------------------------------

discover_specs() {
  local specs_dir="${PROJECT_ROOT}/specs"
  local -a found=()

  if [[ ! -d "$specs_dir" ]]; then
    echo "Error: specs/ directory not found at ${specs_dir}" >&2
    exit 1
  fi

  # Collect doing-*.md files
  for f in "${specs_dir}"/doing-*.md; do
    [[ -e "$f" ]] || continue
    found+=("$f")
  done

  # Auto-promote plain specs (not doing-*, done-*, or .debate-*) to doing-*
  for f in "${specs_dir}"/*.md; do
    [[ -e "$f" ]] || continue
    local base
    base="$(basename "$f")"
    # Skip already-prefixed and auxiliary files
    case "$base" in
      doing-*|done-*|.debate-*|.*) continue ;;
    esac
    local new_path="${specs_dir}/doing-${base}"
    mv "$f" "$new_path"
    auto_log "Auto-promoted spec: ${base} -> doing-${base}"
    echo "Promoted: ${base} -> doing-${base}" >&2
    found+=("$new_path")
  done

  if [[ ${#found[@]} -eq 0 ]]; then
    echo "Error: no specs found in ${specs_dir}" >&2
    exit 1
  fi

  # Return the list via stdout
  printf '%s\n' "${found[@]}"
}

# ---------------------------------------------------------------------------
# Context-monitored claude -p wrapper
# ---------------------------------------------------------------------------

# run_claude_monitored <working_dir> <prompt_text>
#
# Runs `claude -p --output-format stream-json` and monitors token usage in
# real time. If usage reaches CONTEXT_THRESHOLD_PCT% of the context window the
# process is killed and restarted with a fresh context (same prompt, clean
# session). Prior work persists in the worktree via committed files.
#
# The final result text is written to stdout. A side-effect context.json is
# written to <working_dir>/.deepflow/context.json for statusline consumption.
run_claude_monitored() {
  local working_dir="$1"
  local prompt_text="$2"

  local result_tmp
  result_tmp="$(mktemp)"
  local error_log
  error_log="$(mktemp)"

  # Outer loop: restart with fresh context when threshold is hit
  while true; do
    # Build command arguments
    local -a cmd_args=(claude -p --output-format stream-json --dangerously-skip-permissions)

    # Accumulated token count and context window size across events
    local total_tokens=0
    local context_window=0
    local current_session_id=""
    local threshold_hit=false
    local claude_pid=""

    # Use a FIFO so we can read line-by-line while holding the PID for killing
    local fifo_path
    fifo_path="$(mktemp -u)"
    mkfifo "$fifo_path"

    echo "$prompt_text" | "${cmd_args[@]}" > "$fifo_path" 2>>"$error_log" &
    claude_pid=$!

    # Read the FIFO line-by-line (set +e to tolerate EINTR from signals)
    local capturing_result=false
    set +e
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue

      local parsed
      parsed="$(node -e "
        try {
          const e = JSON.parse(process.argv[1]);
          if (e.session_id) {
            console.log('SESSION_ID:' + e.session_id);
          }
          if (e.type === 'assistant' && e.message && e.message.usage) {
            const u = e.message.usage;
            const tokens = (u.input_tokens||0) + (u.cache_creation_input_tokens||0) + (u.cache_read_input_tokens||0) + (u.output_tokens||0);
            console.log('TOKENS:' + tokens);
          } else if (e.type === 'result') {
            const mu = e.modelUsage || {};
            const model = Object.keys(mu)[0];
            const cw = model ? mu[model].contextWindow : 0;
            console.log('CONTEXT_WINDOW:' + cw);
            console.log('RESULT_START');
            console.log(e.result || '');
            console.log('RESULT_END');
          }
        } catch(err) {}
      " "$line" 2>/dev/null)" || true

      # Parse the node output
      local IFS_save="$IFS"
      IFS=$'\n'
      for pline in $parsed; do
        case "$pline" in
          SESSION_ID:*)
            current_session_id="${pline#SESSION_ID:}"
            ;;
          TOKENS:*)
            total_tokens="${pline#TOKENS:}"
            ;;
          CONTEXT_WINDOW:*)
            context_window="${pline#CONTEXT_WINDOW:}"
            ;;
          RESULT_START)
            capturing_result=true
            ;;
          RESULT_END)
            capturing_result=false
            ;;
          *)
            if [[ "$capturing_result" == "true" ]]; then
              echo "$pline" >> "$result_tmp"
            fi
            ;;
        esac
      done
      IFS="$IFS_save"

      # Check threshold
      if [[ "$context_window" -gt 0 && "$total_tokens" -gt 0 ]]; then
        local pct=$(( total_tokens * 100 / context_window ))

        # Write context.json for statusline
        mkdir -p "${working_dir}/.deepflow"
        printf '{"percentage": %d, "timestamp": "%s"}\n' "$pct" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "${working_dir}/.deepflow/context.json"

        if [[ "$pct" -ge "$CONTEXT_THRESHOLD_PCT" ]]; then
          auto_log "Context threshold hit: ${pct}% >= ${CONTEXT_THRESHOLD_PCT}% (tokens=${total_tokens}, window=${context_window}). Restarting with --resume."
          threshold_hit=true
          kill "$claude_pid" 2>/dev/null || true
          wait "$claude_pid" 2>/dev/null || true
          break
        fi
      fi
    done < "$fifo_path"
    set -e

    # Clean up FIFO
    rm -f "$fifo_path"

    # Wait for claude process to finish (if it hasn't been killed)
    wait "$claude_pid" 2>/dev/null || true

    # Log stderr if any
    if [[ -s "$error_log" ]]; then
      auto_log "claude stderr: $(cat "$error_log")"
      : > "$error_log"
    fi

    if [[ "$threshold_hit" == "true" ]]; then
      # Restart with fresh context — the prompt is re-sent but prior work
      # persists in the worktree (committed files, etc.)
      auto_log "Restarting claude -p with fresh context (prior work is in worktree)"
      continue
    fi

    # Normal exit — break out of the restart loop
    break
  done

  rm -f "$error_log"

  # Write final context.json
  if [[ "$context_window" -gt 0 && "$total_tokens" -gt 0 ]]; then
    local final_pct=$(( total_tokens * 100 / context_window ))
    mkdir -p "${working_dir}/.deepflow"
    printf '{"percentage": %d, "timestamp": "%s"}\n' "$final_pct" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "${working_dir}/.deepflow/context.json"
  fi

  # Output the result text
  if [[ -f "$result_tmp" ]]; then
    cat "$result_tmp"
    rm -f "$result_tmp"
  fi
}

# ---------------------------------------------------------------------------
# Stub functions — to be implemented by T3–T7
# ---------------------------------------------------------------------------

generate_hypotheses() {
  local spec_file="$1"
  local spec_name="$2"
  local cycle="$3"
  local hypotheses_count="$4"

  auto_log "generate_hypotheses called for ${spec_file} (spec_name=${spec_name}, cycle=${cycle}, count=${hypotheses_count})"

  # 1. Read spec content (read-only)
  local spec_content
  spec_content="$(cat "$spec_file")"

  # 2. Gather failed experiment context
  local failed_context=""
  local experiments_dir="${PROJECT_ROOT}/.deepflow/experiments"
  if [[ -d "$experiments_dir" ]]; then
    for failed_file in "${experiments_dir}/${spec_name}--"*"--failed.md"; do
      [[ -e "$failed_file" ]] || continue
      local hypothesis_section=""
      local conclusion_section=""
      # Extract hypothesis section (between ## Hypothesis and next ##)
      hypothesis_section="$(sed -n '/^## Hypothesis/,/^## /{ /^## Hypothesis/p; /^## [^H]/!{ /^## Hypothesis/!p; }; }' "$failed_file")"
      # Extract conclusion section (between ## Conclusion and next ## or EOF)
      conclusion_section="$(sed -n '/^## Conclusion/,/^## /{ /^## Conclusion/p; /^## [^C]/!{ /^## Conclusion/!p; }; }' "$failed_file")"
      if [[ -n "$hypothesis_section" || -n "$conclusion_section" ]]; then
        failed_context="${failed_context}
--- Failed experiment: $(basename "$failed_file") ---
${hypothesis_section}
${conclusion_section}
"
      fi
    done
  fi

  # 3. Build the prompt for claude -p
  local failed_prompt=""
  if [[ -n "$failed_context" ]]; then
    failed_prompt="
The following hypotheses have already been tried and FAILED. Do NOT repeat them or suggest similar approaches:

${failed_context}
"
  fi

  local prompt
  prompt="You are helping with an autonomous development workflow. Given the following spec, generate exactly ${hypotheses_count} approach hypotheses for implementing it.

--- SPEC CONTENT ---
${spec_content}
--- END SPEC ---
${failed_prompt}
Generate exactly ${hypotheses_count} hypotheses as a JSON array. Each object must have:
- \"slug\": a URL-safe lowercase hyphenated short name (e.g. \"stream-based-parser\")
- \"hypothesis\": a one-sentence description of the approach
- \"method\": a one-sentence description of how to validate this approach

Output ONLY the JSON array. No markdown fences, no explanation, no extra text. Just the raw JSON array."

  # 4. Spawn claude -p and capture output
  mkdir -p "${PROJECT_ROOT}/.deepflow/hypotheses"

  local raw_output
  raw_output="$(run_claude_monitored "${PROJECT_ROOT}" "$prompt")" || {
    auto_log "ERROR: claude -p failed for generate_hypotheses (spec=${spec_name}, cycle=${cycle})"
    echo "Error: claude -p failed for hypothesis generation" >&2
    return 1
  }

  # 5. Extract JSON array from output (strip any accidental wrapping)
  local json_output
  # Try to extract JSON array if surrounded by other text
  json_output="$(echo "$raw_output" | sed -n '/^\[/,/^\]/p')"
  if [[ -z "$json_output" ]]; then
    # Fallback: maybe it's all on one line
    json_output="$(echo "$raw_output" | grep -o '\[.*\]')" || true
  fi
  if [[ -z "$json_output" ]]; then
    auto_log "ERROR: could not parse JSON from claude output for spec=${spec_name}, cycle=${cycle}"
    echo "Error: failed to parse hypothesis JSON from claude output" >&2
    echo "Raw output was: ${raw_output}" >&2
    return 1
  fi

  # 6. Write hypotheses to file
  local hypotheses_file="${PROJECT_ROOT}/.deepflow/hypotheses/${spec_name}-cycle-${cycle}.json"
  echo "$json_output" > "$hypotheses_file"

  # 7. Log each hypothesis
  local count
  count="$(echo "$json_output" | grep -o '"slug"' | wc -l | tr -d ' ')"
  auto_log "Generated ${count} hypotheses for ${spec_name} cycle ${cycle} -> ${hypotheses_file}"

  # Log individual hypotheses
  # Parse slugs from JSON for logging
  echo "$json_output" | grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' | while read -r line; do
    local slug
    slug="$(echo "$line" | sed 's/.*"slug"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
    auto_log "  Hypothesis: ${slug} (spec=${spec_name}, cycle=${cycle})"
  done

  if [[ "$count" -lt "$hypotheses_count" ]]; then
    auto_log "WARNING: requested ${hypotheses_count} hypotheses but got ${count} for ${spec_name} cycle ${cycle}"
    echo "Warning: got ${count} hypotheses instead of requested ${hypotheses_count}" >&2
  fi

  echo "Generated ${count} hypotheses -> ${hypotheses_file}"
  return 0
}

run_single_spike() {
  local spec_name="$1"
  local slug="$2"
  local hypothesis="$3"
  local method="$4"
  local spec_file="$5"

  local worktree_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"
  local branch_name="df/${spec_name}-${slug}"

  auto_log "Starting spike for ${spec_name}/${slug}"

  # Create worktree and branch
  if [[ -d "$worktree_path" ]]; then
    auto_log "Worktree already exists at ${worktree_path}, reusing"
  else
    local wt_err
    wt_err="$(git -C "$PROJECT_ROOT" worktree add -b "$branch_name" "$worktree_path" HEAD 2>&1)" || {
      auto_log "worktree add -b failed: ${wt_err}"
      # Branch may already exist from a previous run
      wt_err="$(git -C "$PROJECT_ROOT" worktree add "$worktree_path" "$branch_name" 2>&1)" || {
        auto_log "ERROR: failed to create worktree for ${slug}: ${wt_err}"
        echo "Worktree error for ${slug}: ${wt_err}" >&2
        return 1
      }
    }
  fi

  # Extract acceptance criteria from spec (the human's judgment proxy)
  local acceptance_criteria=""
  if [[ -f "$spec_file" ]]; then
    acceptance_criteria="$(sed -n '/^## Acceptance Criteria/,/^## /{ /^## Acceptance Criteria/d; /^## /d; p; }' "$spec_file")"
  fi

  # Build spike prompt
  local spike_prompt
  spike_prompt="You are running a spike experiment to validate a hypothesis for spec '${spec_name}'.

--- HYPOTHESIS ---
Slug: ${slug}
Hypothesis: ${hypothesis}
Method: ${method}
--- END HYPOTHESIS ---

--- ACCEPTANCE CRITERIA (from spec — the human's judgment proxy) ---
${acceptance_criteria}
--- END ACCEPTANCE CRITERIA ---

Your tasks:
1. Validate this hypothesis by implementing the minimum necessary to prove or disprove it.
   The spike must demonstrate that the approach can satisfy the acceptance criteria above.
2. Write an experiment file at: .deepflow/experiments/${spec_name}--${slug}--active.md
   The experiment file should contain:
   - ## Hypothesis: restate the hypothesis
   - ## Method: what you did to validate
   - ## Results: what you observed
   - ## Criteria Check: for each acceptance criterion, can this approach satisfy it? (yes/no/unclear)
   - ## Conclusion: PASSED or FAILED with reasoning
3. Write a result YAML file at: .deepflow/results/spike-${slug}.yaml
   The YAML must contain:
   - slug: ${slug}
   - spec: ${spec_name}
   - status: passed OR failed
   - summary: one-line summary of the result
4. Stage and commit all changes with message: spike(${spec_name}): validate ${slug}

Important:
- Create the .deepflow/experiments and .deepflow/results directories if they don't exist.
- Be concise and focused — this is a spike, not a full implementation.
- If the hypothesis is not viable, mark it as failed and explain why."

  # Run claude -p in the worktree with context monitoring
  (
    cd "$worktree_path"
    run_claude_monitored "$worktree_path" "$spike_prompt" > /dev/null
  )
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    auto_log "ERROR: claude -p exited with code ${exit_code} for spike ${slug}"
  else
    auto_log "Spike ${slug} claude -p completed successfully"
  fi

  return $exit_code
}

run_spikes() {
  local spec_file="$1"
  local spec_name="$2"
  local cycle="$3"

  local hypotheses_file="${PROJECT_ROOT}/.deepflow/hypotheses/${spec_name}-cycle-${cycle}.json"

  if [[ ! -f "$hypotheses_file" ]]; then
    auto_log "ERROR: hypotheses file not found: ${hypotheses_file}"
    echo "Error: hypotheses file not found: ${hypotheses_file}" >&2
    return 1
  fi

  auto_log "run_spikes starting for ${spec_name} cycle ${cycle}"

  # Parse hypotheses from JSON — extract slug, hypothesis, method for each entry
  local -a slugs=()
  local -a hypotheses_arr=()
  local -a methods_arr=()

  # Use a while loop to parse the JSON entries
  while IFS= read -r slug; do
    slugs+=("$slug")
  done < <(grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' "$hypotheses_file" | sed 's/.*"slug"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  while IFS= read -r hyp; do
    hypotheses_arr+=("$hyp")
  done < <(grep -o '"hypothesis"[[:space:]]*:[[:space:]]*"[^"]*"' "$hypotheses_file" | sed 's/.*"hypothesis"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  while IFS= read -r meth; do
    methods_arr+=("$meth")
  done < <(grep -o '"method"[[:space:]]*:[[:space:]]*"[^"]*"' "$hypotheses_file" | sed 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  local count=${#slugs[@]}
  if [[ "$count" -eq 0 ]]; then
    auto_log "ERROR: no hypotheses parsed from ${hypotheses_file}"
    echo "Error: no hypotheses found in ${hypotheses_file}" >&2
    return 1
  fi

  auto_log "Parsed ${count} hypotheses for spiking"

  # Create required directories
  mkdir -p "${PROJECT_ROOT}/.deepflow/experiments"
  mkdir -p "${PROJECT_ROOT}/.deepflow/results"

  # Spawn spikes with semaphore pattern for --parallel=N
  local -a pids=()
  local i
  for ((i = 0; i < count; i++)); do
    local slug="${slugs[$i]}"
    local hypothesis="${hypotheses_arr[$i]}"
    local method="${methods_arr[$i]}"

    # Semaphore: if PARALLEL > 0 and we have hit the limit, wait for one to finish
    if [[ $PARALLEL -gt 0 ]] && [[ ${#pids[@]} -ge $PARALLEL ]]; then
      wait -n 2>/dev/null || true
      # Remove finished PIDs
      local -a new_pids=()
      local pid
      for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          new_pids+=("$pid")
        fi
      done
      pids=("${new_pids[@]}")
    fi

    auto_log "Spawning spike for ${slug} (hypothesis ${i}/${count})"
    echo "Spawning spike: ${slug}"

    run_single_spike "$spec_name" "$slug" "$hypothesis" "$method" "$spec_file" &
    pids+=($!)
  done

  # Wait for all remaining spikes with progress heartbeat
  auto_log "Waiting for all ${#pids[@]} spike(s) to complete..."
  local wait_start=$SECONDS
  while true; do
    local -a still_running=()
    local pid
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        still_running+=("$pid")
      fi
    done
    if [[ ${#still_running[@]} -eq 0 ]]; then
      break
    fi
    local elapsed=$(( SECONDS - wait_start ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))
    printf "\r  ⏳ %d spike(s) running... [%dm%02ds]  " "${#still_running[@]}" "$mins" "$secs"
    pids=("${still_running[@]}")
    sleep 5
  done
  printf "\r                                        \r"
  wait 2>/dev/null || true
  auto_log "All spikes completed for ${spec_name} cycle ${cycle}"

  # Collect results and process
  local -a passed_slugs=()
  for ((i = 0; i < count; i++)); do
    local slug="${slugs[$i]}"
    local worktree_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"
    local result_file="${worktree_path}/.deepflow/results/spike-${slug}.yaml"
    local experiment_active="${worktree_path}/.deepflow/experiments/${spec_name}--${slug}--active.md"

    if [[ -f "$result_file" ]]; then
      # Read status from result YAML
      local status
      status="$(grep -m1 '^status:' "$result_file" | sed 's/^status:[[:space:]]*//' | tr -d '[:space:]')" || status="unknown"

      if [[ "$status" == "passed" ]]; then
        auto_log "PASSED spike: ${slug} (spec=${spec_name}, cycle=${cycle})"
        echo "Spike PASSED: ${slug}"
        passed_slugs+=("$slug")
      else
        auto_log "FAILED spike: ${slug} status=${status} (spec=${spec_name}, cycle=${cycle})"
        echo "Spike FAILED: ${slug}"
        # Rename active experiment to failed
        if [[ -f "$experiment_active" ]]; then
          local experiment_failed="${worktree_path}/.deepflow/experiments/${spec_name}--${slug}--failed.md"
          mv "$experiment_active" "$experiment_failed"
          # Also copy the failed experiment to the main project for future reference
          mkdir -p "${PROJECT_ROOT}/.deepflow/experiments"
          cp "$experiment_failed" "${PROJECT_ROOT}/.deepflow/experiments/"
        fi
      fi
    else
      auto_log "MISSING result for spike: ${slug} — treating as failed (spec=${spec_name}, cycle=${cycle})"
      echo "Spike MISSING RESULT: ${slug} (treating as failed)"
      # Rename active experiment to failed if it exists
      if [[ -f "$experiment_active" ]]; then
        local experiment_failed="${worktree_path}/.deepflow/experiments/${spec_name}--${slug}--failed.md"
        mv "$experiment_active" "$experiment_failed"
        mkdir -p "${PROJECT_ROOT}/.deepflow/experiments"
        cp "$experiment_failed" "${PROJECT_ROOT}/.deepflow/experiments/"
      fi
    fi
  done

  # Write passed hypotheses to a file for the implementation phase
  local passed_file="${PROJECT_ROOT}/.deepflow/hypotheses/${spec_name}-cycle-${cycle}-passed.json"
  if [[ ${#passed_slugs[@]} -gt 0 ]]; then
    # Build a filtered JSON array of passed hypotheses
    local passed_json="["
    local first=true
    for slug in "${passed_slugs[@]}"; do
      if [[ "$first" == "true" ]]; then
        first=false
      else
        passed_json="${passed_json},"
      fi
      # Extract the full object for this slug from the original hypotheses file
      local hyp_text method_text
      hyp_text="$(grep -A1 "\"slug\"[[:space:]]*:[[:space:]]*\"${slug}\"" "$hypotheses_file" | grep '"hypothesis"' | sed 's/.*"hypothesis"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || hyp_text=""
      method_text="$(grep -A2 "\"slug\"[[:space:]]*:[[:space:]]*\"${slug}\"" "$hypotheses_file" | grep '"method"' | sed 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || method_text=""
      passed_json="${passed_json}{\"slug\":\"${slug}\",\"hypothesis\":\"${hyp_text}\",\"method\":\"${method_text}\"}"
    done
    passed_json="${passed_json}]"
    echo "$passed_json" > "$passed_file"
    auto_log "Wrote ${#passed_slugs[@]} passed hypotheses to ${passed_file}"
    echo "${#passed_slugs[@]} spike(s) passed -> ${passed_file}"
  else
    echo "[]" > "$passed_file"
    auto_log "No spikes passed for ${spec_name} cycle ${cycle}"
    echo "No spikes passed for ${spec_name} cycle ${cycle}"
  fi

  return 0
}

run_implementations() {
  local spec_file="$1"
  local spec_name="$2"
  local cycle="$3"

  local passed_file="${PROJECT_ROOT}/.deepflow/hypotheses/${spec_name}-cycle-${cycle}-passed.json"

  if [[ ! -f "$passed_file" ]]; then
    auto_log "No passed hypotheses file found: ${passed_file} — skipping implementations"
    echo "No passed hypotheses to implement for ${spec_name} cycle ${cycle}"
    return 0
  fi

  # Parse passed slugs
  local -a slugs=()
  while IFS= read -r slug; do
    slugs+=("$slug")
  done < <(grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' "$passed_file" | sed 's/.*"slug"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  local count=${#slugs[@]}
  if [[ "$count" -eq 0 ]]; then
    auto_log "No passed hypotheses found in ${passed_file} — skipping implementations"
    echo "No passed hypotheses to implement for ${spec_name} cycle ${cycle}"
    return 0
  fi

  auto_log "run_implementations starting for ${spec_name} cycle ${cycle} with ${count} passed spike(s)"

  # Read spec content once for all implementation prompts
  local spec_content
  spec_content="$(cat "$spec_file")"

  # Spawn implementation agents in parallel
  local -a pids=()
  local -a impl_slugs=()
  local i
  for ((i = 0; i < count; i++)); do
    local slug="${slugs[$i]}"
    local worktree_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"
    local experiment_file=".deepflow/experiments/${spec_name}--${slug}--passed.md"

    if [[ ! -d "$worktree_path" ]]; then
      auto_log "ERROR: worktree not found for implementation: ${worktree_path}"
      echo "Skipping implementation for ${slug}: worktree not found" >&2
      continue
    fi

    # Semaphore: if PARALLEL > 0 and we have hit the limit, wait for one to finish
    if [[ $PARALLEL -gt 0 ]] && [[ ${#pids[@]} -ge $PARALLEL ]]; then
      wait -n 2>/dev/null || true
      # Remove finished PIDs
      local -a new_pids=()
      local pid
      for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          new_pids+=("$pid")
        fi
      done
      pids=("${new_pids[@]}")
    fi

    # Build implementation prompt
    local impl_prompt
    impl_prompt="You are implementing tasks for spec '${spec_name}' in an autonomous development workflow.
The spike experiment for approach '${slug}' has passed validation. Now implement the full solution.

--- SPEC CONTENT ---
${spec_content}
--- END SPEC ---

The validated experiment file is at: ${experiment_file}
Review it to understand the approach that was validated during the spike.

Your tasks:
1. Read the spec carefully and generate a list of implementation tasks from it.
2. Implement each task with atomic commits. Each commit message must follow the format:
   feat(${spec_name}): {task description}
3. For each completed task, write a result YAML file at:
   .deepflow/results/{task-slug}.yaml
   Each YAML must contain:
   - task: short task name
   - spec: ${spec_name}
   - status: passed OR failed
   - summary: one-line summary of what was implemented
4. Create the .deepflow/results directory if it does not exist.

Important:
- Build on top of the spike commits already in this worktree.
- Be thorough — this is the full implementation, not a spike.
- Stage and commit each task separately for clean atomic commits."

    auto_log "Spawning implementation for ${slug} (spec=${spec_name}, cycle=${cycle})"
    echo "Spawning implementation: ${slug}"

    (
      cd "$worktree_path"
      run_claude_monitored "$worktree_path" "$impl_prompt" > /dev/null
    ) &
    pids+=($!)
    impl_slugs+=("$slug")
  done

  # Wait for all implementations with progress heartbeat
  auto_log "Waiting for all ${#pids[@]} implementation(s) to complete..."
  local wait_start=$SECONDS
  while true; do
    local -a still_running=()
    local pid
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        still_running+=("$pid")
      fi
    done
    if [[ ${#still_running[@]} -eq 0 ]]; then
      break
    fi
    local elapsed=$(( SECONDS - wait_start ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))
    printf "\r  ⏳ %d implementation(s) running... [%dm%02ds]  " "${#still_running[@]}" "$mins" "$secs"
    pids=("${still_running[@]}")
    sleep 5
  done
  printf "\r                                              \r"
  wait 2>/dev/null || true
  auto_log "All implementations completed for ${spec_name} cycle ${cycle}"

  # Collect results
  for slug in "${impl_slugs[@]}"; do
    local worktree_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"
    local results_dir="${worktree_path}/.deepflow/results"

    if [[ -d "$results_dir" ]]; then
      local result_count=0
      local pass_count=0
      local fail_count=0

      for result_file in "${results_dir}"/*.yaml; do
        [[ -e "$result_file" ]] || continue
        result_count=$((result_count + 1))

        local status
        status="$(grep -m1 '^status:' "$result_file" | sed 's/^status:[[:space:]]*//' | tr -d '[:space:]')" || status="unknown"

        local task_name
        task_name="$(basename "$result_file" .yaml)"

        if [[ "$status" == "passed" ]]; then
          pass_count=$((pass_count + 1))
          auto_log "PASSED implementation task: ${task_name} (slug=${slug}, spec=${spec_name})"
        else
          fail_count=$((fail_count + 1))
          auto_log "FAILED implementation task: ${task_name} status=${status} (slug=${slug}, spec=${spec_name})"
        fi
      done

      auto_log "Implementation results for ${slug}: ${result_count} tasks, ${pass_count} passed, ${fail_count} failed"
      echo "Implementation ${slug}: ${result_count} tasks (${pass_count} passed, ${fail_count} failed)"
    else
      auto_log "No result files found for implementation ${slug} (spec=${spec_name})"
      echo "Implementation ${slug}: no result files found"
    fi
  done

  return 0
}

run_selection() {
  local spec_file="$1"
  local spec_name="$2"
  local cycle="$3"

  auto_log "run_selection called for ${spec_name} cycle ${cycle}"

  # -----------------------------------------------------------------------
  # 1. Gather artifacts from all implementation worktrees for this spec+cycle
  # -----------------------------------------------------------------------
  local -a approach_slugs=()
  local artifacts_block=""

  # Parse slugs from the hypotheses file for this cycle
  local hypotheses_file="${PROJECT_ROOT}/.deepflow/hypotheses/${spec_name}-cycle-${cycle}.json"
  if [[ ! -f "$hypotheses_file" ]]; then
    auto_log "ERROR: hypotheses file not found for selection: ${hypotheses_file}"
    echo "Error: no hypotheses file for selection" >&2
    return 1
  fi

  while IFS= read -r slug; do
    approach_slugs+=("$slug")
  done < <(grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' "$hypotheses_file" | sed 's/.*"slug"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  if [[ ${#approach_slugs[@]} -eq 0 ]]; then
    auto_log "ERROR: no approaches found for selection (spec=${spec_name}, cycle=${cycle})"
    echo "Error: no approaches to select from" >&2
    return 1
  fi

  local approach_index=0
  for slug in "${approach_slugs[@]}"; do
    approach_index=$((approach_index + 1))
    local worktree_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"

    artifacts_block="${artifacts_block}
=== APPROACH ${approach_index}: ${slug} ===
"

    # Collect result YAMLs from worktree
    local results_dir="${worktree_path}/.deepflow/results"
    if [[ -d "$results_dir" ]]; then
      for yaml_file in "${results_dir}"/*.yaml; do
        [[ -e "$yaml_file" ]] || continue
        artifacts_block="${artifacts_block}
--- Result: $(basename "$yaml_file") ---
$(cat "$yaml_file")
"
      done
    else
      artifacts_block="${artifacts_block}
[No result YAML files found]
"
    fi

    # Collect experiment files (passed experiments from main project dir)
    local experiment_file="${PROJECT_ROOT}/.deepflow/experiments/${spec_name}--${slug}--passed.md"
    if [[ -f "$experiment_file" ]]; then
      artifacts_block="${artifacts_block}
--- Experiment: $(basename "$experiment_file") ---
$(cat "$experiment_file")
"
    fi

    artifacts_block="${artifacts_block}
=== END APPROACH ${approach_index} ===
"
  done

  # -----------------------------------------------------------------------
  # 2. Build selection prompt
  # -----------------------------------------------------------------------

  # Extract acceptance criteria from spec (the human's judgment proxy)
  local acceptance_criteria=""
  if [[ -f "$spec_file" ]]; then
    acceptance_criteria="$(sed -n '/^## Acceptance Criteria/,/^## /{ /^## Acceptance Criteria/d; /^## /d; p; }' "$spec_file")"
  fi

  local selection_prompt
  selection_prompt="You are an adversarial quality judge in an autonomous development workflow.
Your job is to compare implementation approaches for spec '${spec_name}' and select the best one — or reject all if quality is insufficient.

IMPORTANT:
- This selection phase ALWAYS runs, even with only 1 approach. With a single approach you act as a quality gate.
- You CAN and SHOULD reject all approaches if the quality is insufficient. Do not rubber-stamp poor work.
- Base your judgment ONLY on the artifacts provided below. Do NOT read code files.
- Judge each approach against the ACCEPTANCE CRITERIA below — these represent the human's intent.

--- ACCEPTANCE CRITERIA (from spec) ---
${acceptance_criteria}
--- END ACCEPTANCE CRITERIA ---

There are ${#approach_slugs[@]} approach(es) to evaluate:

${artifacts_block}

Respond with ONLY a JSON object (no markdown fences, no explanation). The JSON must have this exact structure:

{
  \"winner\": \"slug-of-winner-or-empty-string-if-rejecting-all\",
  \"rankings\": [
    {\"slug\": \"approach-slug\", \"rank\": 1, \"rationale\": \"why this rank\"},
    {\"slug\": \"approach-slug\", \"rank\": 2, \"rationale\": \"why this rank\"}
  ],
  \"reject_all\": false,
  \"rejection_rationale\": \"\"
}

Rules for the JSON:
- rankings must include ALL approaches, ranked from best (1) to worst
- If reject_all is true, winner must be an empty string and rejection_rationale must explain why
- If reject_all is false, winner must be the slug of the rank-1 approach
- Output ONLY the JSON object. No other text."

  # -----------------------------------------------------------------------
  # 3. Spawn fresh claude -p (NOT in any worktree)
  # -----------------------------------------------------------------------
  auto_log "Spawning fresh claude -p for selection (spec=${spec_name}, cycle=${cycle})"

  local raw_output
  raw_output="$(run_claude_monitored "${PROJECT_ROOT}" "$selection_prompt")" || {
    auto_log "ERROR: claude -p failed for selection (spec=${spec_name}, cycle=${cycle})"
    echo "Error: claude -p failed for selection" >&2
    return 1
  }

  # Parse JSON from output
  local json_output
  json_output="$(echo "$raw_output" | sed -n '/^{/,/^}/p')"
  if [[ -z "$json_output" ]]; then
    json_output="$(echo "$raw_output" | grep -o '{.*}')" || true
  fi
  if [[ -z "$json_output" ]]; then
    auto_log "ERROR: could not parse JSON from selection output (spec=${spec_name}, cycle=${cycle})"
    echo "Error: failed to parse selection JSON" >&2
    echo "Raw output: ${raw_output}" >&2
    return 1
  fi

  # Extract fields from JSON
  local reject_all winner rejection_rationale
  reject_all="$(echo "$json_output" | grep -o '"reject_all"[[:space:]]*:[[:space:]]*[a-z]*' | sed 's/.*:[[:space:]]*//')" || reject_all="false"
  winner="$(echo "$json_output" | grep -o '"winner"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"winner"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || winner=""
  rejection_rationale="$(echo "$json_output" | grep -o '"rejection_rationale"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"rejection_rationale"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || rejection_rationale=""

  # -----------------------------------------------------------------------
  # 4. Process verdict
  # -----------------------------------------------------------------------
  if [[ "$reject_all" == "true" ]]; then
    auto_log "REJECTED ALL approaches for ${spec_name} cycle ${cycle}: ${rejection_rationale}"
    echo "Selection REJECTED ALL approaches for ${spec_name}: ${rejection_rationale}"

    # Find the best-ranked slug to keep
    local best_slug=""
    best_slug="$(echo "$json_output" | grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"slug"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || true

    # Clean up worktrees — keep only the best-ranked one
    for slug in "${approach_slugs[@]}"; do
      if [[ "$slug" == "$best_slug" ]]; then
        auto_log "Keeping best-ranked rejected worktree: ${slug}"
        continue
      fi
      local wt_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"
      if [[ -d "$wt_path" ]]; then
        git worktree remove --force "$wt_path" 2>/dev/null || true
        git branch -D "df/${spec_name}-${slug}" 2>/dev/null || true
        auto_log "Cleaned up rejected worktree: ${slug}"
      fi
    done

    return 1
  fi

  # Winner selected
  if [[ -z "$winner" ]]; then
    auto_log "ERROR: no winner slug in selection output (spec=${spec_name}, cycle=${cycle})"
    echo "Error: selection returned no winner" >&2
    return 1
  fi

  auto_log "SELECTED winner '${winner}' for ${spec_name} cycle ${cycle}"
  echo "Selection WINNER: ${winner} for ${spec_name}"

  # Store winner
  mkdir -p "${PROJECT_ROOT}/.deepflow/selection"
  cat > "${PROJECT_ROOT}/.deepflow/selection/${spec_name}-winner.json" <<WINNER_EOF
{
  "spec": "${spec_name}",
  "cycle": ${cycle},
  "winner": "${winner}",
  "selection_output": $(echo "$json_output" | head -50)
}
WINNER_EOF
  auto_log "Wrote winner file: .deepflow/selection/${spec_name}-winner.json"

  # Clean up non-winner worktrees
  for slug in "${approach_slugs[@]}"; do
    if [[ "$slug" == "$winner" ]]; then
      continue
    fi
    local wt_path="${PROJECT_ROOT}/.deepflow/worktrees/${spec_name}-${slug}"
    if [[ -d "$wt_path" ]]; then
      git worktree remove --force "$wt_path" 2>/dev/null || true
      git branch -D "df/${spec_name}-${slug}" 2>/dev/null || true
      auto_log "Cleaned up non-winner worktree: ${slug}"
    fi
  done

  return 0
}

generate_report() {
  auto_log "generate_report called (INTERRUPTED=${INTERRUPTED})"

  local report_file="${PROJECT_ROOT}/.deepflow/auto-report.md"
  mkdir -p "${PROJECT_ROOT}/.deepflow"

  # -----------------------------------------------------------------
  # Determine overall status and build per-spec status table
  # -----------------------------------------------------------------
  local overall_status="converged"
  local -a all_spec_names=()

  # Discover all spec names from doing-*.md files
  local specs_dir="${PROJECT_ROOT}/specs"
  if [[ -d "$specs_dir" ]]; then
    for f in "${specs_dir}"/doing-*.md; do
      [[ -e "$f" ]] || continue
      local sname
      sname="$(basename "$f" .md)"
      all_spec_names+=("$sname")

      # If status was not set by the main loop, determine it now
      if ! _spec_isset STATUS "$sname"; then
        # Check if winner file exists
        if [[ -f "${PROJECT_ROOT}/.deepflow/selection/${sname}-winner.json" ]]; then
          _spec_set STATUS "$sname" "converged"
          # Extract winner slug
          local w_slug
          w_slug="$(grep -o '"winner"[[:space:]]*:[[:space:]]*"[^"]*"' "${PROJECT_ROOT}/.deepflow/selection/${sname}-winner.json" | sed 's/.*"winner"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || w_slug=""
          _spec_set WINNER "$sname" "$w_slug"
        elif [[ "$INTERRUPTED" == "true" ]]; then
          _spec_set STATUS "$sname" "in-progress"
        else
          _spec_set STATUS "$sname" "halted"
        fi
      fi
    done
  fi

  # If interrupted, override any unfinished specs
  if [[ "$INTERRUPTED" == "true" ]]; then
    for sname in "${all_spec_names[@]}"; do
      if [[ "$(_spec_get STATUS "$sname")" != "converged" ]]; then
        _spec_set STATUS "$sname" "in-progress"
      fi
    done
    overall_status="in-progress"
  else
    # Determine overall status from per-spec statuses
    for sname in "${all_spec_names[@]}"; do
      local s="$(_spec_get STATUS "$sname")"
      if [[ "$s" == "halted" ]]; then
        overall_status="halted"
      elif [[ "$s" == "in-progress" ]]; then
        overall_status="in-progress"
      fi
    done
  fi

  # -----------------------------------------------------------------
  # Build report
  # -----------------------------------------------------------------
  {
    # Section 1: Resultado
    echo "## Resultado"
    echo ""
    echo "Status: ${overall_status}"
    echo ""

    # Winner info (if converged)
    if [[ "$overall_status" == "converged" ]]; then
      for sname in "${all_spec_names[@]}"; do
        local w="$(_spec_get WINNER "$sname")"
        if [[ -n "$w" ]]; then
          local summary=""
          local winner_file="${PROJECT_ROOT}/.deepflow/selection/${sname}-winner.json"
          if [[ -f "$winner_file" ]]; then
            summary="$(grep -o '"winner"[[:space:]]*:[[:space:]]*"[^"]*"' "$winner_file" | sed 's/.*"\([^"]*\)".*/\1/')" || summary=""
          fi
          echo "Winner: ${w} (spec: ${sname})"
        fi
      done
      echo ""
    fi

    # Per-spec status table
    echo "| Spec | Status | Winner |"
    echo "|------|--------|--------|"
    for sname in "${all_spec_names[@]}"; do
      local s="$(_spec_get STATUS "$sname" "unknown")"
      local w="$(_spec_get WINNER "$sname" "-")"
      echo "| ${sname} | ${s} | ${w} |"
    done
    echo ""

    # Section 2: Mudancas
    echo "## Mudancas"
    echo ""

    local has_changes=false
    for sname in "${all_spec_names[@]}"; do
      local w="$(_spec_get WINNER "$sname")"
      if [[ -n "$w" ]]; then
        has_changes=true
        local branch_name="df/${sname}-${w}"
        echo "### ${sname} (winner: ${w})"
        echo ""
        echo '```'
        git diff --stat "main...${branch_name}" 2>/dev/null || echo "(branch ${branch_name} not found)"
        echo '```'
        echo ""
      fi
    done
    if [[ "$has_changes" == "false" ]]; then
      echo "No changes selected"
      echo ""
    fi

    # Section 3: Decisoes
    echo "## Decisoes"
    echo ""

    local decisions_log="${PROJECT_ROOT}/.deepflow/auto-decisions.log"
    if [[ -f "$decisions_log" ]]; then
      cat "$decisions_log"
    else
      echo "No decisions logged"
    fi
    echo ""
  } > "$report_file"

  auto_log "Report written to ${report_file}"
  echo "Report written to ${report_file}"
  return 0
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

run_spec_cycle() {
  local spec_file="$1"
  local cycle=0

  auto_log "Starting cycles for spec: ${spec_file} (max_cycles=${MAX_CYCLES}, hypotheses=${HYPOTHESES})"

  while true; do
    # Check cycle cap (0 = unlimited)
    if [[ "$MAX_CYCLES" -gt 0 && "$cycle" -ge "$MAX_CYCLES" ]]; then
      auto_log "Reached max_cycles=${MAX_CYCLES} for ${spec_file}. Halting."
      echo "Reached max cycles (${MAX_CYCLES}) for $(basename "$spec_file")"
      break
    fi

    local spec_name
    spec_name="$(basename "$spec_file" .md)"

    auto_log "Cycle ${cycle} for ${spec_file}"
    echo "--- Cycle ${cycle} for $(basename "$spec_file") ---"

    generate_hypotheses "$spec_file" "$spec_name" "$cycle" "$HYPOTHESES"
    run_spikes "$spec_file" "$spec_name" "$cycle"
    run_implementations "$spec_file" "$spec_name" "$cycle"

    if run_selection "$spec_file" "$spec_name" "$cycle"; then
      auto_log "Selection accepted for ${spec_file} at cycle ${cycle}"
      echo "Selection accepted for $(basename "$spec_file") at cycle ${cycle}"
      # Track convergence
      _spec_set STATUS "$spec_name" "converged"
      local w_slug
      w_slug="$(grep -o '"winner"[[:space:]]*:[[:space:]]*"[^"]*"' "${PROJECT_ROOT}/.deepflow/selection/${spec_name}-winner.json" | sed 's/.*"winner"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')" || w_slug=""
      _spec_set WINNER "$spec_name" "$w_slug"
      break
    fi

    auto_log "Selection rejected for ${spec_file} at cycle ${cycle}. Continuing."
    cycle=$((cycle + 1))
  done

  # If we exited the loop without converging, mark as halted
  if [[ "$(_spec_get STATUS "$spec_name")" != "converged" ]]; then
    _spec_set STATUS "$spec_name" "halted"
  fi
}

main() {
  parse_flags "$@"

  # Ensure git repository exists (needed for worktree-based parallel spikes)
  if ! git -C "$PROJECT_ROOT" rev-parse --git-dir &>/dev/null; then
    echo "Initializing git repository in ${PROJECT_ROOT}..."
    git -C "$PROJECT_ROOT" init -q
    git -C "$PROJECT_ROOT" add -A
    git -C "$PROJECT_ROOT" commit -q -m "initial commit"
    auto_log "Auto-initialized git repository in ${PROJECT_ROOT}"
  fi

  auto_log "deepflow-auto started (parallel=${PARALLEL}, hypotheses=${HYPOTHESES}, max_cycles=${MAX_CYCLES}, continue=${CONTINUE}, fresh=${FRESH})"

  echo "deepflow-auto: discovering specs..."

  local specs
  specs="$(discover_specs)"

  local spec_count
  spec_count="$(echo "$specs" | wc -l | tr -d ' ')"
  echo "Found ${spec_count} spec(s):"
  echo "$specs" | while read -r s; do echo "  - $(basename "$s")"; done

  auto_log "Discovered ${spec_count} spec(s)"

  # Process each spec
  echo "$specs" | while read -r spec_file; do
    local spec_name
    spec_name="$(basename "$spec_file" .md)"

    # Validate spec before processing
    local lint_script=""
    if [[ -f "${PROJECT_ROOT}/bin/df-spec-lint.js" ]]; then
      lint_script="${PROJECT_ROOT}/bin/df-spec-lint.js"
    elif [[ -f "${PROJECT_ROOT}/hooks/df-spec-lint.js" ]]; then
      lint_script="${PROJECT_ROOT}/hooks/df-spec-lint.js"
    elif [[ -f "${PROJECT_ROOT}/.claude/hooks/df-spec-lint.js" ]]; then
      lint_script="${PROJECT_ROOT}/.claude/hooks/df-spec-lint.js"
    elif [[ -f "${HOME}/.claude/hooks/df-spec-lint.js" ]]; then
      lint_script="${HOME}/.claude/hooks/df-spec-lint.js"
    fi

    if [[ -n "$lint_script" ]]; then
      if command -v node &>/dev/null; then
        if node "$lint_script" "$spec_file" --mode=auto 2>/dev/null; then
          auto_log "PASS: Spec $spec_name passed validation"
        else
          auto_log "SKIP: Spec $spec_name failed validation"
          echo "⚠ Skipping $spec_name: spec validation failed"
          continue
        fi
      else
        auto_log "WARN: node not available, skipping spec validation for $spec_name"
      fi
    else
      auto_log "WARN: df-spec-lint.js not found, skipping spec validation for $spec_name"
    fi

    run_spec_cycle "$spec_file"
  done

  generate_report

  auto_log "deepflow-auto finished"
  echo "deepflow-auto: done."
}

# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------

handle_signal() {
  echo ""
  echo "deepflow-auto: interrupted, generating report..."
  INTERRUPTED=true
  generate_report
  auto_log "deepflow-auto interrupted by signal, exiting"
  exit 130
}

trap handle_signal SIGINT SIGTERM
trap _spec_map_cleanup EXIT

# Safety assertions: this script must never modify spec files or push to remotes.
# These constraints are enforced by design — no write/push commands exist in this script.

main "$@"
