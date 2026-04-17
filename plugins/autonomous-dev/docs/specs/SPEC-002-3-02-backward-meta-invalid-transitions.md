# SPEC-002-3-02: Backward Transitions, Meta-State Transitions, and Invalid Transition Rejection

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 3 (Backward transitions), Task 4 (Meta-state transitions), Task 5 (Invalid transition rejection)
- **Estimated effort**: 12 hours

## Description
Implement the three remaining transition categories in the Lifecycle Engine: (1) the 5 backward (review_fail) transitions that regress from review states to generation states, (2) the 5 meta-state transitions (pause, resume, fail, retry, cancel) that operate across the pipeline, and (3) comprehensive invalid transition rejection with structured error messages. These handlers complete the full transition table from TDD Section 5.

## Files to Create/Modify
- **Path**: `lib/state/lifecycle_engine.sh`
- **Action**: Modify (append to file created in SPEC-002-3-01)
- **Description**: Add `_handle_review_fail()`, `_handle_pause()`, `_handle_resume()`, `_handle_fail()`, `_handle_retry()`, `_handle_cancel()`, and validation logic for all invalid transition cases.

## Implementation Details

### `_handle_review_fail(state_json, metadata_json, timestamp)`

```bash
# _handle_review_fail -- Process a "review_fail" event (backward transition)
#
# Valid from: prd_review, tdd_review, plan_review, spec_review, code_review
# Transitions to: prd, tdd, plan, spec, code (respectively)
#
# Preconditions:
#   - Current status must be a _review state
#   - retry_count < max_retries for the review phase
#
# State mutations:
#   1. If retry_count >= max_retries: trigger pause (escalation) instead
#   2. Close current phase history entry (exit_reason: "review_fail")
#   3. Append new entry for generation state with retry_count incremented
#   4. Preserve review_feedback in current_phase_metadata
#   5. Set status to generation state
#   6. Increment escalation_count if escalating to paused
#
# Arguments:
#   $1 -- state_json
#   $2 -- metadata_json: Expected to contain "review_feedback", "max_retries"
#   $3 -- timestamp
_handle_review_fail() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  # Validate: must be a review state
  if [[ -z "${REVIEW_REGRESSIONS[$current_status]+x}" ]]; then
    echo "_handle_review_fail: review_fail only valid from _review states, current: ${current_status}" >&2
    return 1
  fi

  local target_state="${REVIEW_REGRESSIONS[$current_status]}"

  # Get current retry count from the current phase history entry
  local current_retry_count
  current_retry_count="$(echo "$state_json" | jq '.phase_history[-1].retry_count // 0')"

  # Get max_retries from metadata (caller must provide) or default to 3
  local max_retries
  max_retries="$(echo "$metadata_json" | jq '.max_retries // 3')"

  # Check retry exhaustion
  if (( current_retry_count >= max_retries )); then
    # Escalate to paused instead of regressing
    echo "_handle_review_fail: retries exhausted (${current_retry_count}/${max_retries}), escalating to paused" >&2
    local pause_metadata
    pause_metadata="$(jq -n \
      --arg reason "review_retries_exhausted" \
      --arg phase "$current_status" \
      --argjson retry_count "$current_retry_count" \
      '{reason: $reason, phase: $phase, retry_count: $retry_count}')"
    _handle_pause "$state_json" "$pause_metadata" "$timestamp"
    return $?
  fi

  # Extract review feedback for passing to generation state
  local review_feedback
  review_feedback="$(echo "$metadata_json" | jq -r '.review_feedback // ""')"

  local new_retry_count=$(( current_retry_count + 1 ))

  echo "$state_json" | jq \
    --arg target "$target_state" \
    --arg timestamp "$timestamp" \
    --argjson new_retry "$new_retry_count" \
    --arg review_feedback "$review_feedback" \
    '
    # Close current review phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "review_fail" |

    # Append new generation phase entry with incremented retry
    .phase_history += [{
      state: $target,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: $new_retry,
      exit_reason: null
    }] |

    # Update state
    .status = $target |
    .updated_at = $timestamp |

    # Preserve review feedback in current_phase_metadata
    .current_phase_metadata = {
      review_feedback: $review_feedback
    }
    '
}
```

### `_handle_pause(state_json, metadata_json, timestamp)`

```bash
# _handle_pause -- Process a "pause" event
#
# Valid from: Any state except cancelled
# Transitions to: paused
#
# State mutations:
#   1. Set status to "paused"
#   2. Set paused_from to the current status
#   3. Set paused_reason from metadata
#   4. Increment escalation_count if review-triggered
#   5. Close current phase history entry (exit_reason: "paused")
#   6. Append new "paused" phase history entry
_handle_pause() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  # Already paused?
  if [[ "$current_status" == "paused" ]]; then
    echo "_handle_pause: already paused" >&2
    return 1
  fi

  local paused_reason
  paused_reason="$(echo "$metadata_json" | jq -r '.reason // "manual_pause"')"

  # Determine if this is review-triggered (should increment escalation_count)
  local is_review_triggered=false
  if [[ "$paused_reason" == "review_retries_exhausted" ]]; then
    is_review_triggered=true
  fi

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg paused_from "$current_status" \
    --arg paused_reason "$paused_reason" \
    --argjson increment_escalation "$( [[ "$is_review_triggered" == "true" ]] && echo 1 || echo 0 )" \
    '
    # Close current phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "paused" |

    # Append paused phase entry
    .phase_history += [{
      state: "paused",
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = "paused" |
    .paused_from = $paused_from |
    .paused_reason = $paused_reason |
    .updated_at = $timestamp |
    .escalation_count = (.escalation_count + $increment_escalation)
    '
}
```

### `_handle_resume(state_json, metadata_json, timestamp)`

```bash
# _handle_resume -- Process a "resume" event
#
# Valid from: paused ONLY
# Transitions to: the state stored in paused_from
#
# State mutations:
#   1. Restore status to paused_from
#   2. Clear paused_from and paused_reason
#   3. Close paused phase history entry
#   4. Append new entry for the restored state
_handle_resume() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  if [[ "$current_status" != "paused" ]]; then
    echo "_handle_resume: resume only valid from paused, current: ${current_status}" >&2
    return 1
  fi

  local paused_from
  paused_from="$(echo "$state_json" | jq -r '.paused_from')"

  if [[ -z "$paused_from" || "$paused_from" == "null" ]]; then
    echo "_handle_resume: paused_from is not set, cannot determine resume target" >&2
    return 1
  fi

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg restore_status "$paused_from" \
    '
    # Close paused phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "completed" |

    # Append restored state entry
    .phase_history += [{
      state: $restore_status,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = $restore_status |
    .paused_from = null |
    .paused_reason = null |
    .updated_at = $timestamp
    '
}
```

### `_handle_fail(state_json, metadata_json, timestamp)`

```bash
# _handle_fail -- Process a "fail" event
#
# Valid from: Any state except cancelled
# Transitions to: failed
#
# State mutations:
#   1. Set status to "failed"
#   2. Populate error object from metadata (code, message, phase, timestamp)
#   3. Set failure_reason from metadata
#   4. Close current phase history entry (exit_reason: "error")
#   5. Append new "failed" phase history entry
_handle_fail() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --argjson metadata "$metadata_json" \
    --arg current_status "$current_status" \
    '
    # Close current phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "error" |

    # Append failed phase entry
    .phase_history += [{
      state: "failed",
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = "failed" |
    .failure_reason = ($metadata.reason // "unknown") |
    .error = {
      message: ($metadata.message // "Request failed"),
      code: ($metadata.code // "unknown"),
      phase: $current_status,
      timestamp: $timestamp,
      session_id: ($metadata.session_id // null),
      details: ($metadata.details // {})
    } |
    .updated_at = $timestamp
    '
}
```

### `_handle_retry(state_json, metadata_json, timestamp)`

```bash
# _handle_retry -- Process a "retry" event
#
# Valid from: failed ONLY, and only when last_checkpoint is set
# Transitions to: the state stored in last_checkpoint
#
# State mutations:
#   1. Restore status to last_checkpoint
#   2. Clear error and failure_reason
#   3. Reset retry count for the target phase to 0
#   4. Close failed phase entry, append new entry for checkpoint state
_handle_retry() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  if [[ "$current_status" != "failed" ]]; then
    echo "_handle_retry: retry only valid from failed, current: ${current_status}" >&2
    return 1
  fi

  local last_checkpoint
  last_checkpoint="$(echo "$state_json" | jq -r '.last_checkpoint')"

  if [[ -z "$last_checkpoint" || "$last_checkpoint" == "null" ]]; then
    echo "_handle_retry: no checkpoint available for retry" >&2
    return 1
  fi

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg checkpoint "$last_checkpoint" \
    '
    # Close failed phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "completed" |

    # Append new entry for checkpoint state
    .phase_history += [{
      state: $checkpoint,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = $checkpoint |
    .error = null |
    .failure_reason = null |
    .updated_at = $timestamp
    '
}
```

### `_handle_cancel(state_json, metadata_json, timestamp)`

```bash
# _handle_cancel -- Process a "cancel" event
#
# Valid from: Any state except cancelled
# Transitions to: cancelled (terminal)
#
# State mutations:
#   1. Set status to "cancelled"
#   2. Close current phase history entry (exit_reason: "cancelled")
#   3. Append "cancelled" phase history entry
_handle_cancel() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    '
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "cancelled" |

    .phase_history += [{
      state: "cancelled",
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = "cancelled" |
    .updated_at = $timestamp
    '
}
```

### Invalid Transition Rejection Summary

The following invalid transitions are already handled by the dispatch logic:

| Rule | Implementation |
|------|----------------|
| From `cancelled`: any event | Checked at top of `state_transition()` |
| `monitor` + `advance` | `FORWARD_TRANSITIONS` has no entry for `monitor` |
| Skip states | `FORWARD_TRANSITIONS` only maps adjacent states |
| `review_fail` from non-review state | `REVIEW_REGRESSIONS` has no entry |
| `resume` from non-paused | Checked in `_handle_resume()` |
| `retry` from non-failed | Checked in `_handle_retry()` |
| `retry` without checkpoint | Checked in `_handle_retry()` |
| `advance` from paused/failed | Checked in `_handle_advance()` |
| Any event -> `intake` | No handler routes to `intake` (not in FORWARD_TRANSITIONS values for non-intake keys) |

All rejections produce specific error messages on stderr indicating both the attempted transition and the rule violated.

## Acceptance Criteria
1. [ ] All 5 backward transitions (`prd_review`->`prd`, `tdd_review`->`tdd`, `plan_review`->`plan`, `spec_review`->`spec`, `code_review`->`code`) produce correct target state
2. [ ] `review_fail` increments `retry_count` in the new phase history entry
3. [ ] `review_fail` preserves `review_feedback` in `current_phase_metadata`
4. [ ] `review_fail` with exhausted retries triggers `pause` (escalation) instead of regression
5. [ ] `pause` sets `paused_from`, `paused_reason`, and increments `escalation_count` when review-triggered
6. [ ] `resume` restores `status` to `paused_from`, clears pause fields
7. [ ] `resume` from non-paused state returns error
8. [ ] `fail` sets `error` object with `code`, `message`, `phase`, `timestamp` and sets `failure_reason`
9. [ ] `retry` restores state to `last_checkpoint`, clears error, resets retry count
10. [ ] `retry` from non-failed returns error; `retry` without checkpoint returns error
11. [ ] `cancel` sets `status: "cancelled"` and is terminal (no further transitions)
12. [ ] `cancel` works from any non-cancelled state (including `failed` and `paused`)
13. [ ] All invalid transitions produce specific error messages naming the violated rule
14. [ ] No handler routes any transition to `intake`

## Test Cases
1. **Review fail prd_review->prd** -- Input: state at `prd_review`, event `review_fail`. Assertion: status is `prd`, retry_count is 1.
2. **Review fail tdd_review->tdd** -- Same pattern for tdd. Assertion: correct regression.
3. **Review fail plan_review->plan** -- Same pattern. Assertion: correct regression.
4. **Review fail spec_review->spec** -- Same pattern. Assertion: correct regression.
5. **Review fail code_review->code** -- Same pattern. Assertion: correct regression.
6. **Review fail preserves feedback** -- Include `review_feedback: "needs more detail"` in metadata. Assertion: `current_phase_metadata.review_feedback` is `"needs more detail"`.
7. **Review fail retry exhaustion** -- Set `retry_count` to 3, `max_retries` to 3. Assertion: transitions to `paused`, not to generation state.
8. **Review fail from non-review** -- `review_fail` from `prd`. Assertion: returns 1.
9. **Pause from active state** -- `pause` from `code`. Assertion: status `paused`, `paused_from: "code"`.
10. **Pause increments escalation** -- `pause` with reason `review_retries_exhausted`. Assertion: `escalation_count` incremented by 1.
11. **Pause from already paused** -- `pause` from `paused`. Assertion: returns 1.
12. **Resume from paused** -- `resume` from `paused` with `paused_from: "tdd"`. Assertion: status restored to `tdd`.
13. **Resume from non-paused** -- `resume` from `code`. Assertion: returns 1.
14. **Fail from active state** -- `fail` from `spec` with error metadata. Assertion: status `failed`, error object populated.
15. **Retry from failed** -- `retry` from `failed` with `last_checkpoint: "prd"`. Assertion: status `prd`, error cleared.
16. **Retry from non-failed** -- `retry` from `code`. Assertion: returns 1.
17. **Retry without checkpoint** -- `retry` from `failed` with `last_checkpoint: null`. Assertion: returns 1.
18. **Cancel from active** -- `cancel` from `integration`. Assertion: status `cancelled`.
19. **Cancel from failed** -- `cancel` from `failed`. Assertion: status `cancelled`.
20. **Cancel from paused** -- `cancel` from `paused`. Assertion: status `cancelled`.
21. **Cancelled is terminal** -- After cancel, attempt `advance`. Assertion: returns 1.
22. **Failed rejects advance** -- `advance` from `failed`. Assertion: returns 1.
23. **Paused rejects advance** -- `advance` from `paused`. Assertion: returns 1.
24. **No transition to intake** -- Verify no handler can produce `status: "intake"` as output.
