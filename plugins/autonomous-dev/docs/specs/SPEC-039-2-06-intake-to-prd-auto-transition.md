# SPEC-039-2-06: `intake` → `prd` auto-transition

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-013
- **Dependencies**: SPEC-039-2-05
- **Estimated effort**: 1 hour
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Implement the bookkeeping-only `intake` → `prd` transition. Per PRD FR-019-09, `intake` is not an agent-driven phase; it's the initial state set by the submit handler. On first daemon pickup, transition `queued/intake` → `running/prd` WITHOUT spawning a session, and record the transition in events.jsonl.

## Acceptance Criteria

1. (AC-038-09) On first daemon poll, a `queued/intake` request transitions to `running/prd` without invoking `dispatch_phase_session()`.
2. Events.jsonl records the transition with `event=intake_to_prd`.
3. After the transition, the next poll picks the request up under phase `prd` and routes through normal dispatch.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — branch in `main_loop()` BEFORE calling `dispatch_phase_session()`.

**Wiring**
```bash
# In main_loop(), after select_request:
local cur_phase status
cur_phase=$(jq -r '.current_phase' "$state_file")
status=$(jq -r '.status' "$state_file")

if [[ "$cur_phase" == "intake" && "$status" == "queued" ]]; then
  atomic_state_update "$state_file" "prd" "running"
  append_event "$request_id" "intake_to_prd" "intake" "prd"
  write_portal_request_action "$request_id"
  continue  # poll again to pick up under phase prd
fi

# else: proceed to dispatch_phase_session
```

**Atomicity** — uses the same `atomic_state_update` helper from SPEC-039-2-05.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/intake_to_prd.bats`

**Test cases**
1. (AC-038-09) `first_poll_transitions_queued_intake_to_running_prd` — seed queued/intake, run daemon `--once`, assert state.json.
2. `event_recorded` — events.jsonl contains `event=intake_to_prd` entry with correct from/to.
3. `no_session_spawned` — daemon `--once` over the intake row does not invoke `spawn_session_typed` (mock binding observes zero calls).
4. `second_poll_dispatches_prd_normally` — after auto-transition, the next poll cycle does invoke dispatch with agent=prd-author.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `bats tests/bats/intake_to_prd.bats`
- Manual: submit, run `daemon --once` twice, observe state progression `queued/intake → running/prd → running/prd (after dispatch)`.
