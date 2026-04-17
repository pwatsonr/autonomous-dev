#!/usr/bin/env bash
# state_builder.sh -- Build valid state fixtures for testing
# Part of SPEC-002-3-05: Lifecycle Engine Unit Tests
# Usage: source this file, then call build_state with options
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

_SB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SB_PROJECT_ROOT="$(cd "${_SB_DIR}/../.." && pwd)"

# Source state_file_manager for constants (PIPELINE_ORDER, ALL_STATUSES)
source "${_SB_PROJECT_ROOT}/lib/state/state_file_manager.sh"

# build_state -- Construct a valid state JSON at a given pipeline position
#
# Arguments (all optional, via named flags):
#   --status STATUS          Target status (default: intake)
#   --id ID                  Request ID (default: REQ-20260408-a3f1)
#   --priority N             Priority (default: 5)
#   --retry-count N          Retry count for current phase (default: 0)
#   --last-checkpoint STATE  Last checkpoint state (default: null)
#   --paused-from STATE      For paused states (default: null)
#   --paused-reason REASON   For paused states (default: null)
#   --failure-reason REASON  For failed states (default: null)
#   --blocked-by '["ID"]'   Blocked by array (default: [])
#   --escalation-count N     Escalation count (default: 0)
#   --cost N                 Cost accrued USD (default: 0)
#   --error-json '{...}'     Error object (default: null)
#   --created-at TS          Created timestamp (default: 2026-04-08T09:00:00Z)
#   --entered-at TS          Current phase entered_at (default: auto)
#
# Stdout:
#   Valid state JSON
build_state() {
  local status="intake" id="REQ-20260408-a3f1" priority=5
  local retry_count=0 last_checkpoint="null" paused_from="null"
  local paused_reason="null" failure_reason="null" blocked_by="[]"
  local escalation_count=0 cost=0 error_json="null"
  local created_at="2026-04-08T09:00:00Z" entered_at=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) status="$2"; shift 2 ;;
      --id) id="$2"; shift 2 ;;
      --priority) priority="$2"; shift 2 ;;
      --retry-count) retry_count="$2"; shift 2 ;;
      --last-checkpoint) last_checkpoint="\"$2\""; shift 2 ;;
      --paused-from) paused_from="\"$2\""; shift 2 ;;
      --paused-reason) paused_reason="\"$2\""; shift 2 ;;
      --failure-reason) failure_reason="\"$2\""; shift 2 ;;
      --blocked-by) blocked_by="$2"; shift 2 ;;
      --escalation-count) escalation_count="$2"; shift 2 ;;
      --cost) cost="$2"; shift 2 ;;
      --error-json) error_json="$2"; shift 2 ;;
      --created-at) created_at="$2"; shift 2 ;;
      --entered-at) entered_at="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  [[ -z "$entered_at" ]] && entered_at="$created_at"

  # Build phase history leading up to the target status
  local phase_history
  phase_history="$(_build_phase_history "$status" "$created_at" "$entered_at" "$retry_count")"

  jq -n \
    --argjson sv 1 \
    --arg id "$id" \
    --arg status "$status" \
    --argjson priority "$priority" \
    --arg created_at "$created_at" \
    --arg updated_at "$entered_at" \
    --argjson blocked_by "$blocked_by" \
    --argjson escalation_count "$escalation_count" \
    --argjson cost "$cost" \
    --argjson error "$error_json" \
    --argjson last_checkpoint "$last_checkpoint" \
    --argjson paused_from "$paused_from" \
    --argjson paused_reason "$paused_reason" \
    --argjson failure_reason "$failure_reason" \
    --argjson phase_history "$phase_history" \
    '{
      schema_version: $sv,
      id: $id,
      status: $status,
      priority: $priority,
      title: "Test request",
      description: "A test request for unit testing",
      repository: "/tmp/test-repo",
      branch: ("autonomous/" + $id),
      worktree_path: null,
      created_at: $created_at,
      updated_at: $updated_at,
      cost_accrued_usd: $cost,
      turn_count: 0,
      escalation_count: $escalation_count,
      blocked_by: $blocked_by,
      phase_history: $phase_history,
      current_phase_metadata: {},
      error: $error,
      last_checkpoint: $last_checkpoint,
      paused_from: $paused_from,
      paused_reason: $paused_reason,
      failure_reason: $failure_reason,
      generation: 0,
      tags: []
    }'
}

# _build_phase_history -- Generate phase history entries leading to the target status
#
# For pipeline states: builds completed entries from intake up to the phase before
# target, then the target as the active (open) entry.
# For meta-states (paused, failed, cancelled): builds up to a reasonable prior
# pipeline state, then appends the meta-state entry.
_build_phase_history() {
  local target_status="$1"
  local created_at="$2"
  local entered_at="$3"
  local retry_count="$4"

  local -a entries=()
  local base_ts="$created_at"

  # Determine if target is a pipeline state or a meta-state
  local is_pipeline=false
  local pipeline_idx=-1
  for ((i=0; i<${#PIPELINE_ORDER[@]}; i++)); do
    if [[ "${PIPELINE_ORDER[$i]}" == "$target_status" ]]; then
      is_pipeline=true
      pipeline_idx=$i
      break
    fi
  done

  if [[ "$is_pipeline" == "true" ]]; then
    # Build completed entries for all phases before the target
    for ((i=0; i<pipeline_idx; i++)); do
      local phase="${PIPELINE_ORDER[$i]}"
      local exit_reason="completed"
      if [[ "$phase" == *"_review" ]]; then
        exit_reason="review_pass"
      fi
      entries+=("$(jq -n \
        --arg state "$phase" \
        --arg entered_at "$base_ts" \
        --arg exited_at "$base_ts" \
        --arg exit_reason "$exit_reason" \
        '{
          state: $state,
          entered_at: $entered_at,
          exited_at: $exited_at,
          session_id: null,
          turns_used: 0,
          cost_usd: 0,
          retry_count: 0,
          exit_reason: $exit_reason
        }')")
    done
    # Append the active target entry
    entries+=("$(jq -n \
      --arg state "$target_status" \
      --arg entered_at "$entered_at" \
      --argjson retry_count "$retry_count" \
      '{
        state: $state,
        entered_at: $entered_at,
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: $retry_count,
        exit_reason: null
      }')")
  elif [[ "$target_status" == "paused" ]]; then
    # Build up to prd (a reasonable active state), then paused
    entries+=("$(jq -n \
      --arg entered_at "$base_ts" \
      --arg exited_at "$base_ts" \
      '{
        state: "intake",
        entered_at: $entered_at,
        exited_at: $exited_at,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: "completed"
      }')")
    entries+=("$(jq -n \
      --arg entered_at "$base_ts" \
      --arg exited_at "$base_ts" \
      '{
        state: "prd",
        entered_at: $entered_at,
        exited_at: $exited_at,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: "paused"
      }')")
    entries+=("$(jq -n \
      --arg entered_at "$entered_at" \
      --argjson retry_count "$retry_count" \
      '{
        state: "paused",
        entered_at: $entered_at,
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: $retry_count,
        exit_reason: null
      }')")
  elif [[ "$target_status" == "failed" ]]; then
    # Build up to code, then failed
    entries+=("$(jq -n \
      --arg entered_at "$base_ts" \
      --arg exited_at "$base_ts" \
      '{
        state: "intake",
        entered_at: $entered_at,
        exited_at: $exited_at,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: "completed"
      }')")
    entries+=("$(jq -n \
      --arg entered_at "$base_ts" \
      --arg exited_at "$base_ts" \
      '{
        state: "code",
        entered_at: $entered_at,
        exited_at: $exited_at,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: "error"
      }')")
    entries+=("$(jq -n \
      --arg entered_at "$entered_at" \
      --argjson retry_count "$retry_count" \
      '{
        state: "failed",
        entered_at: $entered_at,
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: $retry_count,
        exit_reason: null
      }')")
  elif [[ "$target_status" == "cancelled" ]]; then
    # Build up to spec, then cancelled
    entries+=("$(jq -n \
      --arg entered_at "$base_ts" \
      --arg exited_at "$base_ts" \
      '{
        state: "intake",
        entered_at: $entered_at,
        exited_at: $exited_at,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: "completed"
      }')")
    entries+=("$(jq -n \
      --arg entered_at "$base_ts" \
      --arg exited_at "$base_ts" \
      '{
        state: "spec",
        entered_at: $entered_at,
        exited_at: $exited_at,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: "cancelled"
      }')")
    entries+=("$(jq -n \
      --arg entered_at "$entered_at" \
      --argjson retry_count "$retry_count" \
      '{
        state: "cancelled",
        entered_at: $entered_at,
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: $retry_count,
        exit_reason: null
      }')")
  else
    # Unknown status -- just create a single entry
    entries+=("$(jq -n \
      --arg state "$target_status" \
      --arg entered_at "$entered_at" \
      --argjson retry_count "$retry_count" \
      '{
        state: $state,
        entered_at: $entered_at,
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: $retry_count,
        exit_reason: null
      }')")
  fi

  # Combine entries into a JSON array
  local json_array="["
  local first=true
  for entry in "${entries[@]}"; do
    if [[ "$first" == "true" ]]; then
      first=false
    else
      json_array+=","
    fi
    json_array+="$entry"
  done
  json_array+="]"

  echo "$json_array"
}
