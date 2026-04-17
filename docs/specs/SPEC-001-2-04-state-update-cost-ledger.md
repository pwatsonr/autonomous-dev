# SPEC-001-2-04: State Update After Session and Cost Ledger

## Metadata
- **Parent Plan**: PLAN-001-2
- **Tasks Covered**: Task 7 (State update after session), Task 8 (Cost ledger)
- **Estimated effort**: 6 hours

## Description
Implement post-session state update that handles success and error paths, writing to both `state.json` and `events.jsonl`. Implement the cost ledger subsystem that initializes, reads, and atomically updates per-session cost tracking with daily and monthly aggregation.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `update_request_state()`, `initialize_cost_ledger()`, `read_cost_ledger()`, and `update_cost_ledger()` functions.

## Implementation Details

### Task 7: State Update After Session

#### `update_request_state(request_id: string, project: string, outcome: string, session_cost: string, exit_code?: string) -> void`

- **Parameters**:
  - `request_id`: The request ID.
  - `project`: Absolute path to the project root.
  - `outcome`: Either `"success"` or `"error"`.
  - `session_cost`: Cost in USD as a decimal string (e.g., "2.50").
  - `exit_code` (optional): The exit code on error (e.g., "1", "2").

- **Paths**:
  ```bash
  local req_dir="${project}/.autonomous-dev/requests/${request_id}"
  local state_file="${req_dir}/state.json"
  local events_file="${req_dir}/events.jsonl"
  ```

- **Success Path** (`outcome == "success"`):
  1. Read current state:
     ```bash
     local current_state
     current_state=$(cat "${state_file}")
     ```
  2. Update `current_phase_metadata` to reflect completion:
     ```bash
     local ts
     ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
     local tmp="${state_file}.tmp"
     echo "${current_state}" | jq \
         --arg ts "${ts}" \
         --arg cost "${session_cost}" \
         '
         .current_phase_metadata.last_session_completed_at = $ts |
         .current_phase_metadata.session_active = false |
         .current_phase_metadata.retry_count = 0 |
         .current_phase_metadata.last_error = null |
         .cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber)) |
         .updated_at = $ts
         ' > "${tmp}"
     mv "${tmp}" "${state_file}"
     ```
  3. Append a `session_complete` event to `events.jsonl`:
     ```bash
     local event
     event=$(jq -n \
         --arg ts "${ts}" \
         --arg req "${request_id}" \
         --arg type "session_complete" \
         --arg cost "${session_cost}" \
         '{
             timestamp: $ts,
             type: $type,
             request_id: $req,
             details: {
                 session_cost_usd: ($cost | tonumber),
                 exit_code: 0
             }
         }')
     echo "${event}" >> "${events_file}"
     ```
  4. `log_info "State updated: request=${request_id} outcome=success cost=${session_cost}"`

- **Error Path** (`outcome == "error"`):
  1. Read current state.
  2. Increment `retry_count` and record `last_error`:
     ```bash
     local ts
     ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
     local tmp="${state_file}.tmp"
     echo "${current_state}" | jq \
         --arg ts "${ts}" \
         --arg cost "${session_cost}" \
         --arg exit_code "${exit_code:-unknown}" \
         '
         .current_phase_metadata.retry_count = ((.current_phase_metadata.retry_count // 0) + 1) |
         .current_phase_metadata.last_error = ("Session exited with code " + $exit_code) |
         .current_phase_metadata.last_error_at = $ts |
         .current_phase_metadata.session_active = false |
         .cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber)) |
         .updated_at = $ts
         ' > "${tmp}"
     mv "${tmp}" "${state_file}"
     ```
  3. Append a `session_error` event to `events.jsonl`:
     ```bash
     local event
     event=$(jq -n \
         --arg ts "${ts}" \
         --arg req "${request_id}" \
         --arg type "session_error" \
         --arg cost "${session_cost}" \
         --arg exit_code "${exit_code:-unknown}" \
         '{
             timestamp: $ts,
             type: $type,
             request_id: $req,
             details: {
                 session_cost_usd: ($cost | tonumber),
                 exit_code: ($exit_code | tonumber? // $exit_code),
                 error: ("Session exited with code " + $exit_code)
             }
         }')
     echo "${event}" >> "${events_file}"
     ```
  4. `log_warn "State updated: request=${request_id} outcome=error exit_code=${exit_code} retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")"`

- **Atomic writes**: All `state.json` writes use the `tmp` + `mv` pattern. `events.jsonl` writes use append (`>>`) which is atomic for single lines on POSIX systems.

### Task 8: Cost Ledger

#### `initialize_cost_ledger() -> void`

Called during init if the ledger does not exist.

```bash
initialize_cost_ledger() {
    if [[ ! -f "${COST_LEDGER_FILE}" ]]; then
        local tmp="${COST_LEDGER_FILE}.tmp"
        jq -n '{ daily: {} }' > "${tmp}"
        mv "${tmp}" "${COST_LEDGER_FILE}"
        log_info "Cost ledger initialized"
    fi
}
```

#### `read_cost_ledger() -> string`

Reads the ledger and outputs its content. Returns empty and logs error if corrupt.

```bash
read_cost_ledger() {
    if [[ ! -f "${COST_LEDGER_FILE}" ]]; then
        echo '{ "daily": {} }'
        return
    fi
    local content
    content=$(cat "${COST_LEDGER_FILE}")
    if ! echo "${content}" | jq empty 2>/dev/null; then
        log_error "Cost ledger is corrupt"
        echo ""
        return 1
    fi
    echo "${content}"
}
```

#### `update_cost_ledger(session_cost: string, request_id?: string) -> void`

- **Parameters**:
  - `session_cost`: Cost in USD as a decimal string.
  - `request_id` (optional): The request ID for the session entry.

- **Algorithm**:
  1. Read the current ledger:
     ```bash
     local ledger
     ledger=$(read_cost_ledger)
     if [[ -z "${ledger}" ]]; then
         log_error "Cannot update cost ledger (corrupt or unreadable)"
         return 1
     fi
     ```
  2. Compute today's date key:
     ```bash
     local today
     today=$(date -u +"%Y-%m-%d")
     ```
  3. Generate timestamp:
     ```bash
     local ts
     ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
     ```
  4. Update the ledger using `jq`:
     ```bash
     local tmp="${COST_LEDGER_FILE}.tmp"
     echo "${ledger}" | jq \
         --arg date "${today}" \
         --arg cost "${session_cost}" \
         --arg req "${request_id:-unknown}" \
         --arg ts "${ts}" \
         '
         .daily[$date] //= { total_usd: 0, sessions: [] } |
         .daily[$date].total_usd += ($cost | tonumber) |
         .daily[$date].sessions += [{
             request_id: $req,
             cost_usd: ($cost | tonumber),
             timestamp: $ts
         }]
         ' > "${tmp}"
     mv "${tmp}" "${COST_LEDGER_FILE}"
     ```
  5. `log_info "Cost ledger updated: +$${session_cost} for ${today}"`

### Cost Ledger JSON Schema

```json
{
  "daily": {
    "2026-04-08": {
      "total_usd": 15.00,
      "sessions": [
        {
          "request_id": "REQ-20260408-abcd",
          "cost_usd": 5.00,
          "timestamp": "2026-04-08T10:00:00Z"
        },
        {
          "request_id": "REQ-20260408-abcd",
          "cost_usd": 10.00,
          "timestamp": "2026-04-08T14:30:00Z"
        }
      ]
    },
    "2026-04-07": {
      "total_usd": 8.50,
      "sessions": [...]
    }
  }
}
```

### Integration with Main Loop

In the main loop body (SPEC-001-2-05), after `spawn_session`:

```bash
if [[ ${exit_code} -eq 0 ]]; then
    update_request_state "${request_id}" "${project}" "success" "${session_cost}"
else
    update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
fi
update_cost_ledger "${session_cost}" "${request_id}"
```

### Edge Cases
- `state.json` was modified by the claude session during execution: The update reads the current state (post-session), not the pre-session checkpoint. This is correct -- the session may have advanced the status or written metadata.
- `events.jsonl` does not exist yet: The `>>` append creates it.
- `session_cost` is "0" (free session): Valid. The ledger records a zero-cost entry.
- `session_cost` is non-numeric garbage: `jq`'s `tonumber` will fail. Wrap in a validation: default to 0 if non-numeric.
- Ledger grows indefinitely: Plan 3 (SPEC-001-3-04) handles log rotation and cleanup. The ledger itself is not rotated but daily entries from months ago could be archived. For TDD-001 scope, no ledger cleanup.
- Concurrent reads of `state.json` by external tools during atomic write: The `mv` is atomic. Readers see either the old or new state, never partial.

## Acceptance Criteria
1. [ ] After a successful session, `state.json` has `last_session_completed_at` set, `retry_count` reset to 0, `last_error` set to null, and `cost_accrued_usd` incremented
2. [ ] After a successful session, `events.jsonl` has a new entry with `type: "session_complete"`
3. [ ] After a failed session, `retry_count` is incremented by 1 in `state.json`
4. [ ] After a failed session, `last_error` contains the exit code in `state.json`
5. [ ] After a failed session, `events.jsonl` has a new entry with `type: "session_error"`
6. [ ] All `state.json` writes are atomic (tmp+mv pattern)
7. [ ] `events.jsonl` entries are valid JSON (one per line, parseable with `jq`)
8. [ ] `initialize_cost_ledger()` creates the ledger with `{ "daily": {} }` if not present
9. [ ] First session cost creates the ledger daily entry for today
10. [ ] Subsequent sessions accumulate cost in today's total
11. [ ] Reading cost for today returns the correct total
12. [ ] Reading cost for the month sums all daily entries in the current month
13. [ ] Cost ledger survives daemon restart (persisted to disk)
14. [ ] Non-numeric session cost defaults to 0 without crashing
15. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_update_state_success** -- Create a state.json fixture with `retry_count: 2` and `last_error: "previous"`. Call `update_request_state "REQ-001" "/tmp/proj" "success" "5.00"`. Assert `retry_count == 0`, `last_error == null`, `cost_accrued_usd` increased by 5.00.
2. **test_update_state_success_event** -- After success update, read `events.jsonl`. Assert last line parses as JSON with `.type == "session_complete"` and `.details.exit_code == 0`.
3. **test_update_state_error** -- Create a state.json with `retry_count: 0`. Call with outcome `"error"` and exit_code `"1"`. Assert `retry_count == 1`. Assert `last_error` contains "code 1".
4. **test_update_state_error_event** -- After error update, assert `events.jsonl` last line has `.type == "session_error"` and `.details.exit_code == 1`.
5. **test_update_state_error_increments** -- Call error twice. Assert `retry_count == 2` after the second call.
6. **test_update_state_cost_accumulates** -- Start with `cost_accrued_usd: 10`. Call success with cost "5.00". Assert `cost_accrued_usd == 15`.
7. **test_update_state_atomic_write** -- Verify `state.json.tmp` does not persist after the function completes.
8. **test_initialize_cost_ledger_creates** -- Ensure no ledger file exists. Call `initialize_cost_ledger`. Assert file exists and parses as `{ "daily": {} }`.
9. **test_initialize_cost_ledger_idempotent** -- Call twice. Assert the ledger is not overwritten (existing data preserved).
10. **test_update_cost_ledger_first_entry** -- Initialize ledger. Call `update_cost_ledger "5.00" "REQ-001"`. Assert today's entry has `total_usd == 5` and one session entry.
11. **test_update_cost_ledger_accumulates** -- Add two costs: 5.00 and 3.50. Assert today's `total_usd == 8.5` and two session entries.
12. **test_update_cost_ledger_multiple_days** -- Add an entry for today and manually add one for yesterday. Assert monthly sum includes both.
13. **test_update_cost_ledger_corrupt** -- Write "not json" to the ledger. Call `update_cost_ledger "5.00"`. Assert return 1 and log contains "corrupt".
14. **test_update_cost_ledger_zero_cost** -- Call `update_cost_ledger "0"`. Assert the ledger entry has `cost_usd: 0`.
15. **test_events_jsonl_created_on_first_event** -- Remove `events.jsonl`. Call `update_request_state` with success. Assert `events.jsonl` now exists with one line.
