# SPEC-039-2-09: Daemon main-loop integration

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-025
- **Dependencies**: SPEC-039-2-03, SPEC-039-2-05, SPEC-039-2-06, SPEC-039-3-01
- **Estimated effort**: 2 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Wire the new functions (`resolve_agent`, `dispatch_phase_session`, `advance_phase`, `intake_to_prd` auto-transition, `write_portal_request_action`, `reconcile_orphans`) into the daemon's `main_loop()`. Establishes the canonical order: reconcile (periodic) → select_request → intake-auto-transition (if applicable) → dispatch → advance → portal-sync → idle/backoff. Resolves OQ-039-4 with FIFO ordering by SQLite `created_at` ASC.

## Acceptance Criteria

1. `main_loop()` calls `dispatch_phase_session()`, NOT any legacy/parallel `spawn_session` invocation (deletes dead code paths if present).
2. After each dispatch, `advance_phase()` is called.
3. FIFO order: `select_request()` returns oldest `queued` row by `created_at ASC` (OQ-039-4).
4. `reconcile_orphans()` (SPEC-039-1-04) runs at startup + every `RECONCILE_EVERY_N_POLLS` polls.
5. Daemon survives any single iteration's failures (try/trap around each step) — proven by `dispatch_phase.bats` tests.
6. Idle path (no `queued` rows) sleeps the configured backoff before next poll.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — `main_loop()`.

**Loop shape**
```bash
main_loop() {
  local poll_count=0
  reconcile_orphans  # startup

  while ! shutdown_requested; do
    poll_count=$((poll_count + 1))

    if (( poll_count % ${RECONCILE_EVERY_N_POLLS:-60} == 0 )); then
      reconcile_orphans
    fi

    local request_id
    request_id=$(select_request_fifo)  # SELECT ... WHERE status='queued' ORDER BY created_at ASC LIMIT 1
    if [[ -z "$request_id" ]]; then
      sleep "${IDLE_BACKOFF_SECONDS:-2}"
      continue
    fi

    if intake_to_prd_if_needed "$request_id"; then
      continue  # next poll picks up under prd
    fi

    dispatch_phase_session "$request_id"
    local rc=$?
    advance_phase "$request_id"
  done
}
```

**Select function** — extracted as `select_request_fifo` to make the FIFO contract testable. Existing `select_request` may be renamed or wrapped.

**Trap** — `trap 'log_error "main loop iteration error"; continue' ERR` inside the loop (with `set -E`) so an error in any single helper does not kill the daemon.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/main_loop_integration.bats`

**Test cases**
1. `fifo_ordering` — submit 3 requests in sequence, run daemon `--once-N=3`, assert dispatch order matches submit order.
2. `intake_auto_transition_taken_first` — new request: first poll auto-transitions; second poll dispatches.
3. `reconcile_runs_at_startup` — `--once` boot triggers reconcile_orphans (observed in log).
4. `dispatch_failure_does_not_crash_daemon` — mock dispatch returns 1; loop continues to next iteration.
5. `idle_path_sleeps` — empty queue: daemon sleeps `IDLE_BACKOFF_SECONDS` before next poll.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `shellcheck bin/supervisor-loop.sh`
- `bats tests/bats/main_loop_integration.bats`
- Manual: submit 2 requests, run daemon `--once-N=4`, observe correct ordering + transitions in logs and events.jsonl.

## Open Questions resolved

- OQ-039-4 — resolved by FIFO `created_at ASC` selection.
