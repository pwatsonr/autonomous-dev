# SPEC-002-1-01: State File and Event Log Schema Definitions

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 1 (State file JSON schema), Task 2 (Event log JSONL schema)
- **Estimated effort**: 5 hours

## Description
Create the foundational JSON schema files that define the shape of every state file and event log entry in the system. These schemas are the single source of truth consumed by validation logic in `state_read()`, `event_append()`, and every downstream component. Getting these right is prerequisite to everything else -- every other spec in TDD-002 references these schemas.

## Files to Create/Modify
- **Path**: `lib/state/schema/state_v1.json`
- **Action**: Create
- **Description**: JSON Schema (draft 2020-12) for the `state.json` file format, version 1. Includes the `PhaseHistoryEntry` sub-schema in `$defs`. This is a data-only file (no executable code).

- **Path**: `lib/state/schema/event_v1.json`
- **Action**: Create
- **Description**: JSON Schema (draft 2020-12) for a single event line in `events.jsonl`, version 1. Includes enum constraints for all 25 `event_type` values.

## Implementation Details

### State Schema (`state_v1.json`)

The schema must match TDD Section 4.1 exactly. Key structural decisions:

**Required fields (all 16):**
```
schema_version, id, status, priority, title, repository, branch,
created_at, updated_at, cost_accrued_usd, turn_count,
escalation_count, blocked_by, phase_history,
current_phase_metadata, error, last_checkpoint
```

**`status` enum (17 values):**
```
intake, prd, prd_review, tdd, tdd_review, plan, plan_review,
spec, spec_review, code, code_review, integration, deploy,
monitor, paused, failed, cancelled
```

**`error.code` enum (14 values):**
```
timeout, timeout_exhausted, retries_exhausted, review_failed,
state_corruption, event_log_corruption, session_crash,
cost_cap_exceeded, turn_budget_exceeded, context_window_exhaustion,
rate_limited, dependency_failed, cancelled_by_operator, kill_switch, unknown
```

**`PhaseHistoryEntry` sub-schema (`$defs`):**
- Required fields: `state`, `entered_at`, `exited_at`, `session_id`, `turns_used`, `cost_usd`
- `exit_reason` enum: `completed`, `review_pass`, `review_fail`, `timeout`, `error`, `paused`, `cancelled`, `null`
- `retry_count`: integer, minimum 0, default 0

**`last_checkpoint` enum:**
All 14 pipeline states plus `null`. Does NOT include `paused`, `failed`, or `cancelled`.

**Optional fields (with defaults):**
- `description`: string, maxLength 10000
- `worktree_path`: string or null, default null
- `paused_from`: string or null, default null
- `paused_reason`: string or null, default null
- `failure_reason`: string or null, default null
- `generation`: integer, minimum 0, default 0
- `tags`: array of strings, default [], uniqueItems true

**Constraints enforced in schema:**
- `id` pattern: `^REQ-[0-9]{8}-[0-9a-f]{4}$`
- `branch` pattern: `^autonomous/REQ-[0-9]{8}-[0-9a-f]{4}$`
- `repository` pattern: `^/` (must be absolute path)
- `priority` range: 0-9
- `title` length: 1-200
- `schema_version` const: 1
- `additionalProperties: false` on the root object
- `additionalProperties: true` on `current_phase_metadata` (extensible)
- `error` required fields when non-null: `message`, `code`, `phase`, `timestamp`

### Event Schema (`event_v1.json`)

**Required fields (4):**
```
timestamp, event_type, request_id, session_id
```

**`event_type` enum (25 values):**
```
request_created, state_transition, phase_started, phase_completed,
review_pass, review_fail, retry, timeout, error, paused, resumed,
failed, cancelled, escalation, checkpoint_created,
checkpoint_restored, cost_update, context_window_warning,
dependency_resolved, dependency_blocked, session_started,
session_ended, artifact_created, pr_created, pr_merged,
cleanup_started, cleanup_completed
```

**Optional fields:**
- `from_state`: string or null
- `to_state`: string or null
- `metadata`: object, additionalProperties true (always present but structure varies by event_type)

**`request_id` pattern:** `^REQ-[0-9]{8}-[0-9a-f]{4}$`

**`session_id` type:** string or null (null for supervisor-generated events)

### Validation helpers (NOT in schema files -- used by tests)

Create a small helper function that can be used by tests to validate JSON against the schema using `jq`. This is a bash function, not part of the schema file itself:

```bash
# Validate a JSON string against key schema constraints
# Returns 0 if valid, 1 if invalid with error messages on stderr
validate_state_json() {
  local json="$1"
  local errors=""

  # Check required fields
  for field in schema_version id status priority title repository branch \
               created_at updated_at cost_accrued_usd turn_count \
               escalation_count blocked_by phase_history \
               current_phase_metadata error last_checkpoint; do
    if ! echo "$json" | jq -e "has(\"$field\")" > /dev/null 2>&1; then
      errors+="Missing required field: $field\n"
    fi
  done

  # ... additional checks per field ...
}
```

This validation function is specified in detail in SPEC-002-1-02.

## Acceptance Criteria
1. [ ] `state_v1.json` exists at `lib/state/schema/state_v1.json` and is valid JSON
2. [ ] `state_v1.json` defines all 16 required fields from TDD Section 4.1
3. [ ] `state_v1.json` includes `PhaseHistoryEntry` in `$defs` with all 8 properties
4. [ ] `state_v1.json` validates the example state file from TDD Section 4.3 (manual verification with `jq`)
5. [ ] `event_v1.json` exists at `lib/state/schema/event_v1.json` and is valid JSON
6. [ ] `event_v1.json` defines all 4 required fields and all 25 event_type enum values from TDD Section 4.2
7. [ ] `event_v1.json` validates all 10 example event log entries from TDD Section 4.4
8. [ ] Both schema files use JSON Schema draft 2020-12 (`$schema` field present)
9. [ ] No executable code in schema files -- they are pure data

## Test Cases
1. **Valid state file passes schema** -- Input: the TDD Section 4.3 example JSON. Expected: `jq` validation passes with exit 0. Assertion: all required fields present, all types match, all enums valid.
2. **Valid event entries pass schema** -- Input: each of the 10 JSONL lines from TDD Section 4.4. Expected: each line passes event schema validation. Assertion: `event_type` is in enum, `request_id` matches pattern, `timestamp` is present.
3. **Schema rejects extra root-level fields** -- Input: valid state JSON with an extra field `"foo": "bar"`. Expected: validation fails because `additionalProperties: false`. Assertion: error message mentions the unexpected field.
4. **Schema accepts extra current_phase_metadata fields** -- Input: valid state JSON with `current_phase_metadata: {"custom_key": "value"}`. Expected: validation passes because `additionalProperties: true` on that object. Assertion: no error.
5. **Schema enforces id pattern** -- Input: state JSON with `"id": "INVALID-ID"`. Expected: validation fails. Assertion: error references the pattern constraint.
6. **Schema enforces status enum** -- Input: state JSON with `"status": "nonexistent_state"`. Expected: validation fails. Assertion: error references the enum constraint.
7. **Schema enforces priority range** -- Input: state JSON with `"priority": 10`. Expected: validation fails (max is 9). Input with `"priority": -1`. Expected: validation fails (min is 0).
8. **PhaseHistoryEntry validates exit_reason enum** -- Input: phase history entry with `"exit_reason": "invalid_reason"`. Expected: validation fails. Assertion: error references the exit_reason enum.
