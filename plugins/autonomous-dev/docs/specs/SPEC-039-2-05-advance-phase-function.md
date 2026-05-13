# SPEC-039-2-05: `advance_phase()` state machine

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-012, TASK-017
- **Dependencies**: SPEC-039-1-06, SPEC-039-2-03
- **Estimated effort**: 7 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Implement `advance_phase()` — the daemon's state-transition function. Reads `phase-result-<phase>.json`, decides the next phase per TDD §7.1 transition table, atomically updates `state.json` (`current_phase`, `status`, `updated_at`), appends to `events.jsonl`, and triggers portal sync (consumed in SPEC-039-3-01). Implements retry budget enforcement: on `MAX_RETRIES_PER_PHASE` exhaustion, mark `status='failed'` per SPEC-039-1-06.

## Acceptance Criteria

1. (AC-038-13) Successful phase transition writes new phase + status atomically to state.json and appends an event to events.jsonl.
2. (AC-038-14) Review-phase failure: increment `escalation_count`, re-enter the prior author phase up to `MAX_RETRIES_PER_PHASE` (default 3); on exhaustion → `status=failed` per SPEC-039-1-06.
3. Missing phase-result.json → treat as `pass` and log WARN with request_id + phase (per TDD MAJOR-2 mitigation: synthesized by SPEC-039-2-07 before this point).
4. `pass` from an author phase → advance to its `*_review` counterpart with `status=gate`.
5. `pass` from a review phase → advance to the next author phase OR `done` if the review was the last (deploy_review).
6. State writes use `${file}.tmp.$$` + rename (atomicity).
7. Events.jsonl is append-only; never rewritten.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — add `advance_phase()`.

**Transition table** — per TDD §7.1:
- `prd` pass → `prd_review` (status=gate)
- `prd_review` pass → `tdd`
- `prd_review` fail → `prd` (escalate)
- `tdd` pass → `tdd_review` (status=gate)
- `tdd_review` pass → `plan`
- `tdd_review` fail → `tdd` (escalate)
- (... continues for plan, spec, code, deploy)
- `deploy` pass → `done` (status=done, terminal)

**Function contract**
```bash
# advance_phase <request_id>
#   reads phase-result-<current_phase>.json, computes next state, writes atomically.
advance_phase() {
  local request_id="$1"
  local state_file="$(state_file_for "$request_id")"
  local cur_phase
  cur_phase=$(jq -r '.current_phase' "$state_file")
  local result_file="${state_file%state.json}phase-result-${cur_phase}.json"

  local result_status
  if [[ -f "$result_file" ]]; then
    result_status=$(jq -r '.status' "$result_file")
  else
    log_warn "phase-result missing for $request_id phase $cur_phase — treating as pass"
    result_status="pass"
  fi

  local next_phase next_status
  case "$result_status" in
    pass) next_phase=$(compute_next_phase "$cur_phase"); next_status=$(compute_status_for_phase "$next_phase");;
    fail) handle_phase_failure "$request_id" "$cur_phase" "$state_file"; return ;;
    error) handle_phase_failure "$request_id" "$cur_phase" "$state_file"; return ;;
    *) log_warn "unknown phase-result.status: $result_status — treating as pass"; next_phase=$(compute_next_phase "$cur_phase");;
  esac

  atomic_state_update "$state_file" "$next_phase" "$next_status"
  append_event "$request_id" "phase_advance" "$cur_phase" "$next_phase"
  write_portal_request_action "$request_id"
}
```

**`handle_phase_failure`** — increments `escalation_count`; if `>= MAX_RETRIES_PER_PHASE`: atomic-update `status='failed'`, `error='MAX_RETRIES_EXCEEDED'`, append `failed` event; else: set `current_phase` back to the author phase, log retry attempt.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/advance_phase.bats`

**Test cases**
1. (AC-038-13) `success_path_prd_to_prd_review` — pass result advances to next phase with gate status.
2. (AC-038-14) `review_failure_retries` — fail result returns to author phase; escalation_count++.
3. `retry_exhausted_to_failed` — 3 consecutive fails → status=failed.
4. `missing_result_treated_as_pass` — no phase-result.json → next phase + WARN log.
5. `deploy_done_terminal` — `deploy` pass → status=done.
6. `atomic_update_no_partial_writes` — concurrent reader never observes partial state.json.
7. `events_jsonl_appends_only` — multiple transitions append; existing entries untouched.
8. `portal_action_written_each_transition` — every successful advance triggers a write_portal_request_action call.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `shellcheck bin/supervisor-loop.sh`
- `bats tests/bats/advance_phase.bats`
- Manual: drive a full smoke run and observe expected state-machine progression in events.jsonl.
