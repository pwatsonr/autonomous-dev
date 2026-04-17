# SPEC-002-3-03: Timeout Enforcement, Retry Accounting, and Dependency Evaluation

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 6 (Timeout enforcement), Task 7 (Retry accounting), Task 8 (Dependency evaluation)
- **Estimated effort**: 8 hours

## Description
Implement three interrelated safeguard mechanisms: (1) timeout enforcement that detects phases exceeding their configured duration and triggers retry or fail, (2) retry accounting that tracks per-phase retry counters with increment/reset/exhaustion logic, and (3) dependency evaluation that checks `blocked_by` arrays against other requests' states and detects circular dependencies. These mechanisms are called by the supervisor interface before and during request processing.

## Files to Create/Modify
- **Path**: `lib/state/lifecycle_engine.sh`
- **Action**: Modify (append to file from SPEC-002-3-01 and SPEC-002-3-02)
- **Description**: Add `check_phase_timeout()`, `get_retry_count()`, `is_retry_exhausted()`, `is_blocked()`, and `detect_circular_dependencies()` functions.

## Implementation Details

### Timeout Enforcement

```bash
# check_phase_timeout -- Determine if the current phase has exceeded its timeout
#
# Arguments:
#   $1 -- state_json:         Complete state JSON
#   $2 -- timeouts_json:      JSON object mapping phase names to timeout seconds
#                              e.g., {"prd": 3600, "prd_review": 1800, "monitor": -1}
#                              -1 means indefinite (no timeout)
#   $3 -- current_timestamp:  ISO-8601 UTC timestamp (now)
#
# Stdout:
#   JSON object: {"timed_out": bool, "action": "retry"|"fail"|"pause"|"none",
#                 "elapsed_seconds": N, "timeout_seconds": N}
#
# Returns:
#   0 always (result is in the stdout JSON)
#
# Logic:
#   1. Get current phase from last phase_history entry
#   2. Look up timeout for that phase
#   3. If timeout is -1 (indefinite), return not timed out
#   4. Compute elapsed = current_timestamp - entered_at
#   5. If elapsed > timeout:
#      a. If retry_count < max_retries -> action: "retry"
#      b. If review phase -> action: "pause" (escalation)
#      c. Else -> action: "fail"
#   6. If not timed out -> action: "none"
check_phase_timeout() {
  local state_json="$1"
  local timeouts_json="$2"
  local current_timestamp="$3"

  local current_phase
  current_phase="$(echo "$state_json" | jq -r '.phase_history[-1].state')"

  local entered_at
  entered_at="$(echo "$state_json" | jq -r '.phase_history[-1].entered_at')"

  local retry_count
  retry_count="$(echo "$state_json" | jq '.phase_history[-1].retry_count // 0')"

  # Look up timeout for this phase (-1 = indefinite)
  local timeout_seconds
  timeout_seconds="$(echo "$timeouts_json" | jq --arg phase "$current_phase" '.[$phase] // 3600')"

  # Monitor is exempt
  if [[ "$current_phase" == "monitor" ]] || (( timeout_seconds < 0 )); then
    jq -n '{timed_out: false, action: "none", elapsed_seconds: 0, timeout_seconds: -1}'
    return 0
  fi

  # Convert timestamps to epoch seconds for comparison
  local entered_epoch current_epoch
  entered_epoch="$(_timestamp_to_epoch "$entered_at")"
  current_epoch="$(_timestamp_to_epoch "$current_timestamp")"

  local elapsed=$(( current_epoch - entered_epoch ))

  if (( elapsed > timeout_seconds )); then
    # Timed out -- determine action
    local max_retries
    max_retries="$(echo "$timeouts_json" | jq --arg phase "$current_phase" '.max_retries // 3')"

    local action
    if (( retry_count < max_retries )); then
      action="retry"
    elif [[ "$current_phase" == *"_review" ]]; then
      action="pause"
    else
      action="fail"
    fi

    jq -n \
      --argjson timed_out true \
      --arg action "$action" \
      --argjson elapsed "$elapsed" \
      --argjson timeout "$timeout_seconds" \
      '{timed_out: $timed_out, action: $action, elapsed_seconds: $elapsed, timeout_seconds: $timeout}'
  else
    jq -n \
      --argjson elapsed "$elapsed" \
      --argjson timeout "$timeout_seconds" \
      '{timed_out: false, action: "none", elapsed_seconds: $elapsed, timeout_seconds: $timeout}'
  fi
}

# _timestamp_to_epoch -- Convert ISO-8601 UTC timestamp to epoch seconds
#
# Arguments:
#   $1 -- timestamp: ISO-8601 string (e.g., "2026-04-08T09:15:00Z")
#
# Stdout:
#   Epoch seconds as integer
#
# Portability:
#   macOS: date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%s"
#   Linux: date -d "$ts" "+%s"
_timestamp_to_epoch() {
  local ts="$1"
  if date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%s" 2>/dev/null; then
    return 0
  elif date -d "$ts" "+%s" 2>/dev/null; then
    return 0
  else
    echo "0"
    return 1
  fi
}
```

### Retry Accounting

Retry accounting is distributed across the transition handlers rather than centralized. The key behaviors are:

```bash
# get_retry_count -- Get the retry count for the current phase
#
# Arguments:
#   $1 -- state_json: Complete state JSON
#
# Stdout:
#   Integer retry count
get_retry_count() {
  local state_json="$1"
  echo "$state_json" | jq '.phase_history[-1].retry_count // 0'
}

# is_retry_exhausted -- Check if retries are exhausted for the current phase
#
# Arguments:
#   $1 -- state_json: Complete state JSON
#   $2 -- max_retries: Maximum allowed retries for this phase
#
# Returns:
#   0 if exhausted (retry_count >= max_retries)
#   1 if retries remain
is_retry_exhausted() {
  local state_json="$1"
  local max_retries="${2:-3}"

  local retry_count
  retry_count="$(get_retry_count "$state_json")"

  if (( retry_count >= max_retries )); then
    return 0
  else
    return 1
  fi
}
```

**Retry counter lifecycle:**

| Event | Retry Counter Behavior |
|-------|----------------------|
| `review_fail` (regression) | Increment: new phase entry has `retry_count = previous + 1` |
| `advance` (review passes) | Reset: new phase entry starts at `retry_count = 0` |
| `retry` (from failed) | Reset: new phase entry starts at `retry_count = 0` |
| `resume` (from paused) | Reset: new phase entry starts at `retry_count = 0` |
| Phase timeout retry | Increment: handled via the transition that re-enters the phase |

### Dependency Evaluation

```bash
# is_blocked -- Check if a request is blocked by its dependencies
#
# Arguments:
#   $1 -- state_json: Complete state JSON of the request to check
#   $2 -- state_reader_func: Name of a function that reads state JSON given a request ID
#          Signature: func(request_id) -> state_json on stdout, returns 0/non-zero
#          This indirection preserves the pure-function constraint:
#          the caller (supervisor_interface) provides the I/O function.
#
# Stdout:
#   JSON: {"blocked": bool, "blocking_ids": [...], "reason": "..."}
#
# Returns:
#   0 always (result in stdout JSON)
#
# Logic per TDD Section 3.4.5:
#   - Empty blocked_by -> not blocked
#   - For each dep_id in blocked_by:
#     - If dep state cannot be read -> blocked (unknown = blocked, safe default)
#     - If dep status NOT in {deploy, monitor, cancelled} -> blocked
#     - If dep status in {deploy, monitor, cancelled} -> not blocking
#   - If dep status is "failed" -> the blocked request should fail too
readonly -a COMPLETED_STATES=(deploy monitor cancelled)

is_blocked() {
  local state_json="$1"
  local state_reader_func="$2"

  local blocked_by
  blocked_by="$(echo "$state_json" | jq -r '.blocked_by[]' 2>/dev/null)"

  if [[ -z "$blocked_by" ]]; then
    jq -n '{blocked: false, blocking_ids: [], reason: "no dependencies"}'
    return 0
  fi

  local -a blocking_ids=()
  local -a failed_ids=()

  while IFS= read -r dep_id; do
    [[ -z "$dep_id" ]] && continue

    local dep_state_json
    if ! dep_state_json="$("$state_reader_func" "$dep_id" 2>/dev/null)"; then
      # Cannot read -> treat as blocked (safe default)
      blocking_ids+=("$dep_id")
      continue
    fi

    local dep_status
    dep_status="$(echo "$dep_state_json" | jq -r '.status')"

    # Check if dependency is completed
    local is_completed=false
    for cs in "${COMPLETED_STATES[@]}"; do
      if [[ "$dep_status" == "$cs" ]]; then
        is_completed=true
        break
      fi
    done

    if [[ "$is_completed" == "false" ]]; then
      blocking_ids+=("$dep_id")
    fi

    if [[ "$dep_status" == "failed" ]]; then
      failed_ids+=("$dep_id")
    fi
  done <<< "$blocked_by"

  if [[ ${#failed_ids[@]} -gt 0 ]]; then
    local ids_json
    ids_json="$(printf '%s\n' "${failed_ids[@]}" | jq -R . | jq -s .)"
    jq -n --argjson ids "$ids_json" '{blocked: true, blocking_ids: $ids, reason: "dependency_failed"}'
  elif [[ ${#blocking_ids[@]} -gt 0 ]]; then
    local ids_json
    ids_json="$(printf '%s\n' "${blocking_ids[@]}" | jq -R . | jq -s .)"
    jq -n --argjson ids "$ids_json" '{blocked: true, blocking_ids: $ids, reason: "dependency_not_completed"}'
  else
    jq -n '{blocked: false, blocking_ids: [], reason: "all_dependencies_completed"}'
  fi
}

# detect_circular_dependencies -- Follow blocked_by chains to detect cycles
#
# Arguments:
#   $1 -- request_id: The starting request ID
#   $2 -- state_reader_func: Function to read state JSON by request ID
#   $3 -- max_depth: Maximum chain depth (default: 10)
#
# Returns:
#   0 if no cycle detected
#   1 if cycle detected (cycle path on stderr)
detect_circular_dependencies() {
  local request_id="$1"
  local state_reader_func="$2"
  local max_depth="${3:-10}"

  local -a visited=()

  _follow_dependency_chain "$request_id" "$state_reader_func" "$max_depth" visited
}

_follow_dependency_chain() {
  local current_id="$1"
  local state_reader_func="$2"
  local max_depth="$3"
  local -n visited_ref="$4"

  # Check depth limit
  if (( ${#visited_ref[@]} >= max_depth )); then
    echo "detect_circular_dependencies: chain depth exceeds ${max_depth}, possible cycle" >&2
    return 1
  fi

  # Check for cycle
  for v in "${visited_ref[@]}"; do
    if [[ "$v" == "$current_id" ]]; then
      echo "detect_circular_dependencies: cycle detected: ${visited_ref[*]} -> ${current_id}" >&2
      return 1
    fi
  done

  visited_ref+=("$current_id")

  # Read state for current request
  local state_json
  if ! state_json="$("$state_reader_func" "$current_id" 2>/dev/null)"; then
    return 0  # Cannot read state; not a cycle, just missing
  fi

  # Follow each dependency
  local deps
  deps="$(echo "$state_json" | jq -r '.blocked_by[]' 2>/dev/null)"
  while IFS= read -r dep_id; do
    [[ -z "$dep_id" ]] && continue
    if ! _follow_dependency_chain "$dep_id" "$state_reader_func" "$max_depth" visited_ref; then
      return 1
    fi
  done <<< "$deps"

  return 0
}
```

## Acceptance Criteria
1. [ ] `check_phase_timeout()` correctly identifies timed-out phases
2. [ ] `check_phase_timeout()` returns `action: "retry"` when retries remain
3. [ ] `check_phase_timeout()` returns `action: "fail"` when retries exhausted (non-review)
4. [ ] `check_phase_timeout()` returns `action: "pause"` when retries exhausted (review phase)
5. [ ] `check_phase_timeout()` exempts `monitor` state (returns `timed_out: false`)
6. [ ] `check_phase_timeout()` handles indefinite timeout (`-1`) correctly
7. [ ] Timeout thresholds are read from configuration JSON, not hardcoded
8. [ ] `get_retry_count()` returns correct count from current phase history entry
9. [ ] `is_retry_exhausted()` returns 0 when `retry_count >= max_retries`
10. [ ] Retry counter increments on `review_fail` regression
11. [ ] Retry counter resets to 0 on `advance`, `retry`, and `resume`
12. [ ] `is_blocked()` returns `blocked: false` for empty `blocked_by` array
13. [ ] `is_blocked()` returns `blocked: true` for active (non-completed) dependencies
14. [ ] `is_blocked()` returns `blocked: false` when all deps are in `{deploy, monitor, cancelled}`
15. [ ] `is_blocked()` treats unreadable dependencies as blocked (safe default)
16. [ ] `is_blocked()` detects failed dependencies and reports `dependency_failed`
17. [ ] `detect_circular_dependencies()` returns 0 for acyclic chains
18. [ ] `detect_circular_dependencies()` returns 1 for cycles, with cycle path on stderr
19. [ ] `detect_circular_dependencies()` limits chain depth to 10

## Test Cases
1. **Phase not timed out** -- Phase entered 30 seconds ago, timeout is 3600. Assertion: `timed_out: false`.
2. **Phase timed out, retries remain** -- Phase entered 4000 seconds ago, timeout 3600, retry_count 0, max 3. Assertion: `timed_out: true, action: "retry"`.
3. **Phase timed out, retries exhausted (non-review)** -- retry_count 3, max 3. Assertion: `action: "fail"`.
4. **Phase timed out, retries exhausted (review)** -- `prd_review`, retries exhausted. Assertion: `action: "pause"`.
5. **Monitor exempt from timeout** -- `monitor` phase, any elapsed time. Assertion: `timed_out: false`.
6. **Indefinite timeout** -- Phase with timeout -1, large elapsed. Assertion: `timed_out: false`.
7. **Retry count from state** -- State with `retry_count: 2` in last entry. Assertion: `get_retry_count` returns 2.
8. **Retry exhausted** -- `is_retry_exhausted` with count 3, max 3. Assertion: returns 0.
9. **Retry not exhausted** -- count 1, max 3. Assertion: returns 1.
10. **Not blocked (empty deps)** -- `blocked_by: []`. Assertion: `blocked: false`.
11. **Blocked by active request** -- Dep in `prd` state. Assertion: `blocked: true`.
12. **Not blocked (dep completed)** -- Dep in `monitor`. Assertion: `blocked: false`.
13. **Blocked by unknown dep** -- Dep state unreadable. Assertion: `blocked: true`.
14. **Failed dependency** -- Dep in `failed`. Assertion: `blocked: true, reason: "dependency_failed"`.
15. **No circular dependency** -- A->B->C, no cycle. Assertion: returns 0.
16. **Circular dependency** -- A->B->A. Assertion: returns 1, stderr mentions cycle.
17. **Deep chain within limit** -- Chain of 8 deps, max 10. Assertion: returns 0.
18. **Deep chain exceeds limit** -- Chain of 12, max 10. Assertion: returns 1, stderr mentions depth.
