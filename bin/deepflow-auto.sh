#!/usr/bin/env bash
set -euo pipefail

# Required for spawning child `claude -p` processes.
# Without this, nested Claude Code instances conflict with the parent.
unset CLAUDECODE

# NOTE: Child `claude -p` processes will need `--dangerously-skip-permissions`
# to run without interactive approval prompts.

# NOTE: context.json is NOT available in `-p` mode. Alternative monitoring
# (e.g., token counting in output) will be needed for context window management.

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PARALLEL=0          # 0 = unlimited
HYPOTHESES=2
MAX_CYCLES=0        # 0 = unlimited
CONTINUE=false
FRESH=false

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

  # Collect doing-*.md files (read-only — we never modify these)
  for f in "${specs_dir}"/doing-*.md; do
    [[ -e "$f" ]] || continue
    found+=("$f")
  done

  if [[ ${#found[@]} -eq 0 ]]; then
    echo "Error: no specs/doing-*.md files found in ${specs_dir}" >&2
    exit 1
  fi

  # Return the list via stdout
  printf '%s\n' "${found[@]}"
}

# ---------------------------------------------------------------------------
# Stub functions — to be implemented by T3–T7
# ---------------------------------------------------------------------------

generate_hypotheses() {
  local spec_file="$1"
  auto_log "STUB generate_hypotheses called for ${spec_file}"
  echo "[stub] generate_hypotheses: ${spec_file}" >&2
  return 0
}

run_spikes() {
  local spec_file="$1"
  auto_log "STUB run_spikes called for ${spec_file}"
  echo "[stub] run_spikes: ${spec_file}" >&2
  return 0
}

run_implementations() {
  local spec_file="$1"
  auto_log "STUB run_implementations called for ${spec_file}"
  echo "[stub] run_implementations: ${spec_file}" >&2
  return 0
}

run_selection() {
  local spec_file="$1"
  auto_log "STUB run_selection called for ${spec_file}"
  echo "[stub] run_selection: ${spec_file}" >&2
  # Return 1 to indicate "not accepted" (keeps cycling).
  # When implemented, return 0 for accepted.
  return 1
}

generate_report() {
  local spec_file="$1"
  auto_log "STUB generate_report called for ${spec_file}"
  echo "[stub] generate_report: ${spec_file}" >&2
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

    auto_log "Cycle ${cycle} for ${spec_file}"
    echo "--- Cycle ${cycle} for $(basename "$spec_file") ---"

    generate_hypotheses "$spec_file"
    run_spikes "$spec_file"
    run_implementations "$spec_file"

    if run_selection "$spec_file"; then
      auto_log "Selection accepted for ${spec_file} at cycle ${cycle}"
      echo "Selection accepted for $(basename "$spec_file") at cycle ${cycle}"
      break
    fi

    auto_log "Selection rejected for ${spec_file} at cycle ${cycle}. Continuing."
    cycle=$((cycle + 1))
  done

  generate_report "$spec_file"
}

main() {
  parse_flags "$@"

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
    run_spec_cycle "$spec_file"
  done

  auto_log "deepflow-auto finished"
  echo "deepflow-auto: done."
}

# Safety assertions: this script must never modify spec files or push to remotes.
# These constraints are enforced by design — no write/push commands exist in this script.

main "$@"
