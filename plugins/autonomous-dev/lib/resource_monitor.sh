#!/usr/bin/env bash
# resource_monitor.sh -- Disk, worktree, and session monitoring functions
# Part of SPEC-010-3-01: Disk Usage, Worktree Count, and Active Session Monitoring
#
# Dependencies: jq (1.6+), bc, bash 4+, git
#
# Usage:
#   source resource_monitor.sh
#   result=$(check_disk_usage "$effective_config")
#   result=$(check_worktree_count "$effective_config")
#   result=$(check_active_sessions "$effective_config")

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# Only define if not already defined (e.g., when sourced by supervisor-loop.sh)
# ---------------------------------------------------------------------------
if ! declare -F log_error >/dev/null 2>&1; then
  log_error() {
    local tag="$1"; shift
    echo "[${tag}] ERROR: $*" >&2
  }
fi

if ! declare -F log_warning >/dev/null 2>&1; then
  log_warning() {
    local tag="$1"; shift
    echo "[${tag}] WARNING: $*" >&2
  }
fi

if ! declare -F log_info >/dev/null 2>&1; then
  log_info() {
    local tag="$1"; shift
    echo "[${tag}] INFO: $*" >&2
  }
fi

# ---------------------------------------------------------------------------
# measure_disk_gb -- Cross-platform disk measurement
#
# Measures disk usage of a directory in GB with 2 decimal places.
# macOS: uses du -sk (kilobytes) with KB-to-bytes conversion
# Linux: uses du -sb (bytes)
#
# Arguments:
#   $1 - Path to measure
# Stdout: Usage in GB (2 decimal places)
# Exit code: 0 on success, 1 on failure
# ---------------------------------------------------------------------------
measure_disk_gb() {
  local path="$1"

  if [[ ! -d "$path" ]]; then
    echo "0"
    return 0
  fi

  local usage_bytes
  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: du -sk returns kilobytes
    local usage_kb
    usage_kb=$(du -sk "$path" 2>/dev/null | awk '{print $1}') || return 1
    usage_bytes=$((usage_kb * 1024))
  else
    # Linux: du -sb returns bytes
    usage_bytes=$(du -sb "$path" 2>/dev/null | awk '{print $1}') || return 1
  fi

  # Convert bytes to GB with 2 decimal places
  echo "scale=2; $usage_bytes / 1073741824" | bc -l
}

# ---------------------------------------------------------------------------
# measure_worktree_disk_total -- Aggregate worktree disk usage across all repos
#
# Iterates over all allowlisted repositories, enumerates their git worktrees
# (excluding the main working tree), and sums their disk usage.
#
# Arguments:
#   $1 - Effective config JSON
# Stdout: Total usage in GB (2 decimal places)
# Exit code: 0 on success, 1 on failure
# ---------------------------------------------------------------------------
measure_worktree_disk_total() {
  local effective_config="$1"
  local total_gb="0"

  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    # Get worktree paths from git worktree list
    local worktree_paths
    worktree_paths=$(cd "$repo" 2>/dev/null && git worktree list --porcelain 2>/dev/null | grep "^worktree " | sed 's/^worktree //') || continue
    while IFS= read -r wt_path; do
      [[ -z "$wt_path" ]] && continue
      # Skip the main working tree (it's the repo itself, not a worktree)
      [[ "$wt_path" == "$repo" ]] && continue
      local wt_gb
      wt_gb=$(measure_disk_gb "$wt_path" 2>/dev/null) || continue
      total_gb=$(echo "$total_gb + $wt_gb" | bc -l)
    done <<< "$worktree_paths"
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')

  printf "%.2f" "$total_gb"
}

# ---------------------------------------------------------------------------
# check_disk_usage -- Measures disk usage and compares against three thresholds
#
# Checks:
#   1. System-wide: ~/.autonomous-dev/ against governance.disk_usage_limit_gb
#   2. Worktree aggregate: all worktrees against parallel.disk_warning_threshold_gb
#      and parallel.disk_hard_limit_gb
#
# Arguments:
#   $1 - Effective config JSON
# Stdout: JSON result with status and checks array
# Exit code: 0 if pass, 1 if fail
# ---------------------------------------------------------------------------
check_disk_usage() {
  local effective_config="$1"

  local system_limit_gb worktree_warn_gb worktree_hard_gb
  system_limit_gb=$(echo "$effective_config" | jq -r '.governance.disk_usage_limit_gb')
  worktree_warn_gb=$(echo "$effective_config" | jq -r '.parallel.disk_warning_threshold_gb')
  worktree_hard_gb=$(echo "$effective_config" | jq -r '.parallel.disk_hard_limit_gb')

  local result='{"status":"pass","checks":[]}'

  # --- System-wide check: ~/.autonomous-dev/ ---
  local sys_dir="${HOME}/.autonomous-dev"
  local sys_usage_gb
  sys_usage_gb=$(measure_disk_gb "$sys_dir") || {
    log_warning "resource_monitor" "du failed on $sys_dir; skipping disk check"
    # Per Section 5.3: do NOT block work when measurement fails
    echo "$result"
    return 0
  }

  if (( $(echo "$sys_usage_gb >= $system_limit_gb" | bc -l) )); then
    result=$(echo "$result" | jq \
      --argjson usage "$sys_usage_gb" \
      --argjson limit "$system_limit_gb" \
      '.status = "fail" | .checks += [{"type":"system_disk","status":"exceeded","usage_gb":$usage,"limit_gb":$limit}]')
  else
    result=$(echo "$result" | jq \
      --argjson usage "$sys_usage_gb" \
      --argjson limit "$system_limit_gb" \
      '.checks += [{"type":"system_disk","status":"ok","usage_gb":$usage,"limit_gb":$limit}]')
  fi

  # --- Worktree aggregate check ---
  local worktree_usage_gb
  worktree_usage_gb=$(measure_worktree_disk_total "$effective_config") || {
    log_warning "resource_monitor" "Worktree disk measurement failed; skipping"
    echo "$result"
    return 0
  }

  if (( $(echo "$worktree_usage_gb >= $worktree_hard_gb" | bc -l) )); then
    result=$(echo "$result" | jq \
      --argjson usage "$worktree_usage_gb" \
      --argjson limit "$worktree_hard_gb" \
      '.status = "fail" | .checks += [{"type":"worktree_disk","status":"exceeded","usage_gb":$usage,"limit_gb":$limit}]')
  elif (( $(echo "$worktree_usage_gb >= $worktree_warn_gb" | bc -l) )); then
    result=$(echo "$result" | jq \
      --argjson usage "$worktree_usage_gb" \
      --argjson limit "$worktree_warn_gb" \
      '.checks += [{"type":"worktree_disk","status":"warning","usage_gb":$usage,"threshold_gb":$limit}]')
    log_warning "resource_monitor" "Worktree disk usage ${worktree_usage_gb}GB exceeds warning threshold ${worktree_warn_gb}GB"
  else
    result=$(echo "$result" | jq \
      --argjson usage "$worktree_usage_gb" \
      '.checks += [{"type":"worktree_disk","status":"ok","usage_gb":$usage}]')
  fi

  echo "$result"
  if echo "$result" | jq -e '.status == "fail"' >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# check_worktree_count -- Count worktrees across all allowlisted repos
#
# Enumerates worktrees via git worktree list --porcelain, subtracts 1 for
# the main working tree, and sums across all repos.
#
# Arguments:
#   $1 - Effective config JSON
# Stdout: JSON result with type, status, count, max
# Exit code: 0 if pass, 1 if fail
# ---------------------------------------------------------------------------
check_worktree_count() {
  local effective_config="$1"

  local max_worktrees
  max_worktrees=$(echo "$effective_config" | jq -r '.parallel.max_worktrees')

  local total_count=0

  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local repo_count
    if ! repo_count=$(cd "$repo" 2>/dev/null && git worktree list --porcelain 2>/dev/null | grep -c "^worktree "); then
      log_warning "resource_monitor" "git worktree list failed for $repo; assuming at max"
      # Per Section 5.3: assume max on failure (conservative)
      total_count=$max_worktrees
      break
    fi
    # Subtract 1 for the main working tree (which is not a created worktree)
    repo_count=$((repo_count > 0 ? repo_count - 1 : 0))
    total_count=$((total_count + repo_count))
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')

  local status="pass"
  if (( total_count >= max_worktrees )); then
    status="fail"
  fi

  jq -nc \
    --arg status "$status" \
    --argjson count "$total_count" \
    --argjson max "$max_worktrees" \
    '{"type":"worktree_count","status":$status,"count":$count,"max":$max}'

  if [[ "$status" == "fail" ]]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# check_active_sessions -- Count active Claude Code sessions by scanning state files
#
# Scans .autonomous-dev/requests/ directories in all allowlisted repos.
# Counts non-terminal requests with live PIDs as active sessions.
# Dead PIDs are detected and logged as stale (not counted).
# Terminal states (completed, cancelled, failed) are excluded.
#
# Arguments:
#   $1 - Effective config JSON
# Stdout: JSON result with type, status, count, max
# Exit code: 0 if pass, 1 if fail
# ---------------------------------------------------------------------------
check_active_sessions() {
  local effective_config="$1"

  local max_concurrent
  max_concurrent=$(echo "$effective_config" | jq -r '.governance.max_concurrent_requests')

  local active_count=0
  local terminal_states="completed cancelled failed"

  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local requests_dir="${repo}/.autonomous-dev/requests"
    [[ -d "$requests_dir" ]] || continue

    for req_dir in "$requests_dir"/*/; do
      [[ -d "$req_dir" ]] || continue
      local state_file="${req_dir}state.json"
      [[ -f "$state_file" ]] || continue

      local status pid
      status=$(jq -r '.status // "unknown"' "$state_file" 2>/dev/null) || continue

      # Skip terminal states
      case " $terminal_states " in
        *" $status "*) continue ;;
      esac

      # Check PID liveness
      pid=$(jq -r '.current_session_pid // "null"' "$state_file" 2>/dev/null)
      if [[ "$pid" != "null" ]] && [[ -n "$pid" ]]; then
        if kill -0 "$pid" 2>/dev/null; then
          ((active_count++))
        else
          log_warning "resource_monitor" "Stale PID $pid for request $(basename "$req_dir")"
          # Dead PID: not counted (stale state)
        fi
      else
        # No PID but non-terminal: count it as active (queued/paused)
        ((active_count++))
      fi
    done
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')

  local status="pass"
  if (( active_count >= max_concurrent )); then
    status="fail"
  fi

  jq -nc \
    --arg status "$status" \
    --argjson count "$active_count" \
    --argjson max "$max_concurrent" \
    '{"type":"active_sessions","status":$status,"count":$count,"max":$max}'

  if [[ "$status" == "fail" ]]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# check_rate_limit_state -- Pre-iteration rate-limit gate
#
# Checks the rate-limit state file for active backoff or kill switch.
# Per TDD-010 Section 5.3:
#   - Missing state file: treat as no active rate limit (return 0).
#   - Corrupted state file: delete and recreate; log warning (return 0).
#   - Kill switch active: log error, return 1.
#   - Backoff period still active: log info, return 1.
#   - Backoff expired: allow work to proceed (return 0).
#
# Arguments: none
# Stdout: none
# Exit code: 0 if clear to proceed, 1 if rate-limited
# ---------------------------------------------------------------------------
check_rate_limit_state() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  # Missing file: no active rate limit
  if [[ ! -f "$state_file" ]]; then
    return 0
  fi

  # Parse state file
  local state
  if ! state=$(jq '.' "$state_file" 2>/dev/null); then
    log_warning "rate_limit_handler" "Corrupted rate-limit state file. Deleting and recreating."
    rm -f "$state_file"
    return 0
  fi

  local active kill_switch retry_at
  active=$(echo "$state" | jq -r '.active')
  kill_switch=$(echo "$state" | jq -r '.kill_switch // false')
  retry_at=$(echo "$state" | jq -r '.retry_at // "null"')

  # Kill switch: do not proceed
  if [[ "$kill_switch" == "true" ]]; then
    log_error "rate_limit_handler" "Kill switch active. Manual restart required."
    return 1
  fi

  # Not active: proceed
  if [[ "$active" != "true" ]]; then
    return 0
  fi

  # Check if retry_at has passed
  if [[ "$retry_at" != "null" ]] && [[ -n "$retry_at" ]]; then
    local now_epoch retry_epoch
    now_epoch=$(date -u +%s)
    if [[ "$(uname)" == "Darwin" ]]; then
      retry_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$retry_at" +%s 2>/dev/null) || retry_epoch=0
    else
      retry_epoch=$(date -u -d "$retry_at" +%s 2>/dev/null) || retry_epoch=0
    fi

    if (( now_epoch < retry_epoch )); then
      local remaining=$((retry_epoch - now_epoch))
      log_info "rate_limit_handler" "Rate limit backoff active. ${remaining}s remaining until $retry_at"
      return 1  # Still in backoff period
    fi
  fi

  # Backoff expired: allow work to proceed (but state remains active until a successful session clears it)
  return 0
}

# ---------------------------------------------------------------------------
# check_resources -- Composite resource check orchestration
#
# Runs all resource checks in sequence and aggregates their results into a
# single JSON object. Any individual check failure causes the composite to
# return non-zero.
#
# Per TDD-010 Section 5.3:
#   - Each check's result is reported individually in the output JSON.
#   - Any single check failure causes the composite to return non-zero.
#   - No error case causes the system to crash or hang.
#   - Conservative assumptions are used when measurement data is unavailable.
#
# Arguments:
#   $1 - Effective config JSON
# Stdout: JSON with overall status and per-check results
# Exit code: 0 if all pass, 1 if any fail
# ---------------------------------------------------------------------------
check_resources() {
  local effective_config="$1"

  local overall_status="pass"
  local checks="[]"

  # 1. Disk usage
  local disk_result
  disk_result=$(check_disk_usage "$effective_config") || overall_status="fail"
  checks=$(echo "$checks" | jq --argjson disk "$disk_result" '. + [$disk]')

  # 2. Worktree count
  local worktree_result
  worktree_result=$(check_worktree_count "$effective_config") || overall_status="fail"
  checks=$(echo "$checks" | jq --argjson wt "$worktree_result" '. + [$wt]')

  # 3. Active sessions
  local session_result
  session_result=$(check_active_sessions "$effective_config") || overall_status="fail"
  checks=$(echo "$checks" | jq --argjson sess "$session_result" '. + [$sess]')

  # 4. Rate limit state
  local rate_status="pass"
  if ! check_rate_limit_state; then
    rate_status="fail"
    overall_status="fail"
  fi
  checks=$(echo "$checks" | jq --arg s "$rate_status" '. + [{"type":"rate_limit","status":$s}]')

  # Build composite result
  jq -nc \
    --arg status "$overall_status" \
    --argjson checks "$checks" \
    '{status: $status, checks: $checks}'

  if [[ "$overall_status" == "fail" ]]; then
    return 1
  fi
  return 0
}
