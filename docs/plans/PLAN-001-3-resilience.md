# PLAN-001-3: Resilience and Recovery

## Metadata
- **Parent TDD**: TDD-001-daemon-engine
- **Estimated effort**: 3 days
- **Dependencies**: [PLAN-001-1-supervisor-core, PLAN-001-2-loop-engine]
- **Blocked by**: [PLAN-001-2]
- **Priority**: P0

## Objective
Make the daemon engine fault-tolerant. This plan adds crash counting with persistent state, the circuit breaker mechanism, per-request exponential error backoff, sleep/wake recovery for interrupted sessions, state file corruption recovery, graceful shutdown timeout escalation for hung child processes, and log rotation. After this plan, the daemon can survive crashes, sleep/wake cycles, hung sessions, corrupt state files, and unbounded log growth -- all autonomously.

## Scope
### In Scope
- Crash counter: persistent `crash-state.json` with load/save/increment/reset
- Circuit breaker: trip at threshold, block iterations when tripped, alert emission (stub: log + write alert file; actual notification channels are a separate concern)
- Circuit breaker gate check integration into `check_gates()` (replacing the Plan 2 stub)
- Per-request error backoff: compute `next_retry_after` using exponential formula, write to `current_phase_metadata` in state.json, skip requests whose `next_retry_after` is in the future during selection
- Retry flow: max retries per phase, escalation when retries exhausted (transition to `paused` state, emit alert)
- Turn budget exhaustion detection: parse session output for turns-exhausted indicator (exit code 2 or output field), treat as soft failure (retry consumed but phase not marked failed)
- Sleep/wake recovery: on startup, if heartbeat is stale, scan all active requests for `session_active = true` in metadata, restore from checkpoint, do NOT increment crash counter for sleep events
- State file corruption recovery: if `state.json` parse fails, attempt restore from `checkpoint.json`; if both corrupt, transition to `failed` with `state_corruption` reason
- Cost ledger corruption recovery: if parse fails, refuse to process work (safe default), log error with recovery instructions
- Graceful shutdown timeout escalation: when `SHUTDOWN_REQUESTED=true` and a child is running, wait up to `graceful_shutdown_timeout_seconds`, then SIGTERM, wait 10s, then SIGKILL
- Log rotation: size-based rotation within the supervisor loop (daemon.log -> daemon.log.1 -> daemon.log.2 -> delete)
- Log retention cleanup: delete log files older than `log_retention_days`

### Out of Scope
- Notification channel integration (Slack, email, webhook) -- separate subsystem
- External watchdog cron job (documented in TDD as optional Phase 2; can be delivered independently)
- OS supervisor configuration (launchd/systemd) -- Plan 4
- CLI commands for circuit-breaker reset and kill-switch -- Plan 4 (the underlying functions are implemented here; CLI wrappers are in Plan 4)

## Tasks

1. **Implement crash counter persistence** -- `load_crash_state()` and `save_crash_state()` per TDD Section 3.5.1. Load from `crash-state.json` on startup. Save after every session exit. Schema matches TDD Section 4.2 including `last_crash_exit_code`, `last_crash_request_id`, `last_crash_phase`. Atomic tmp+mv writes.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: After a session failure, `crash-state.json` shows `consecutive_crashes` incremented by 1 and includes the exit code, request ID, and phase. After a success, `consecutive_crashes` resets to 0. After daemon restart, crash counter is loaded from file (not reset to 0). File is valid JSON after every write.
   - Estimated effort: 2h

2. **Implement circuit breaker trip and gate check** -- `record_crash()` checks if `consecutive_crashes >= circuit_breaker_threshold` and sets `circuit_breaker_tripped = true`. `record_success()` resets both counter and breaker. Add circuit breaker condition to `check_gates()` replacing the Plan 2 stub. When tripped, emit an alert via `emit_alert()`.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With threshold=3, three consecutive failures trip the breaker. Log contains "CIRCUIT BREAKER TRIPPED". Subsequent gate checks return 1 with "Circuit breaker is tripped" logged. A single success after reset clears the breaker. Gate check passes after reset.
   - Estimated effort: 2h

3. **Implement alert emission stub** -- `emit_alert()` function that writes an alert to `~/.autonomous-dev/alerts/` as a timestamped JSON file and logs at ERROR level. This is the local stub; external notification integration (webhooks, etc.) is out of scope.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: `emit_alert "circuit_breaker" "message"` creates a JSON file in `alerts/` with type, message, timestamp. File is valid JSON. Directory is created if missing. Alerts are also logged.
   - Estimated effort: 1h

4. **Implement per-request error backoff** -- After a session failure, compute `next_retry_after` using exponential formula: `min(base_seconds * 2^(retry_count - 1), max_backoff_seconds)`. Write `next_retry_after` as an ISO-8601 timestamp to `current_phase_metadata` in state.json. Modify `select_request()` to skip requests whose `next_retry_after` is in the future.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: First failure: `next_retry_after` is ~30s from now (base). Second failure: ~60s. Third: ~120s. Capped at `error_backoff_max_seconds` (900s default). During backoff, the request is not selected. After backoff expires, the request is selectable again. Config values for base and max are respected.
   - Estimated effort: 3h

5. **Implement retry exhaustion escalation** -- When `retry_count` exceeds a per-phase max (configurable, default 3), escalate: transition request to `paused` status, emit alert with request ID, phase, and error details, append escalation event to `events.jsonl`.
   - Files to modify: `bin/supervisor-loop.sh`
   - Files to modify: `config/defaults.json` (add `daemon.max_retries_per_phase` with defaults)
   - Acceptance criteria: After 3 retries (default) for the same phase, request status transitions to `paused`. Alert is emitted. `events.jsonl` contains an escalation event. No further sessions are spawned for the paused request.
   - Estimated effort: 2h

6. **Implement turn budget exhaustion detection** -- After session exit, check if exit code is 2 or if session output contains a turns-exhausted indicator (e.g., `"reason": "max_turns_reached"`). If so, treat as soft failure: consume a retry but do not mark the phase as failed. Log a warning suggesting the operator increase the turn budget for that phase.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: Exit code 2 is detected as turn exhaustion. Session output with `max_turns_reached` is detected. Retry counter increments. Phase is not marked failed. Log contains a recommendation to increase the turn budget. The request remains actionable for the next iteration (after backoff).
   - Estimated effort: 1.5h

7. **Implement sleep/wake recovery** -- Extend Plan 1's `recover_from_stale_heartbeat()` stub. On stale heartbeat detection: (a) cleanup orphaned processes (already in Plan 1), (b) scan all active requests for `session_active: true` in `current_phase_metadata`, (c) for each interrupted request, restore `state.json` from `checkpoint.json`, set `session_active: false`, append a `session_interrupted` event, (d) do NOT increment the crash counter (heuristic: staleness > 10 minutes with no recent crash-state update implies sleep, not code failure).
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: After simulating a sleep event (backdate heartbeat by 30 minutes, set `session_active: true` on a request), daemon startup restores from checkpoint, sets `session_active: false`, appends recovery event, and does NOT increment crash counter. Request is selectable on next iteration.
   - Estimated effort: 3h

8. **Implement state file corruption recovery** -- Before parsing `state.json` for any operation (selection, spawn, update), wrap in a validation function `validate_state_file()`. On JSON parse failure: (a) check if `checkpoint.json` exists and is valid, (b) if yes, restore state.json from checkpoint, log warning, continue, (c) if no, transition request to `failed` with reason `state_corruption`, emit alert. Same pattern for `checkpoint.json` corruption (unrecoverable).
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With a corrupt `state.json` and a valid `checkpoint.json`, the daemon restores and continues. Log contains "Restored state.json from checkpoint". With both files corrupt, request transitions to `failed` and alert is emitted. With valid `state.json`, no recovery runs (fast path).
   - Estimated effort: 2h

9. **Implement cost ledger corruption recovery** -- In `check_cost_caps()` and `update_cost_ledger()`, if `cost-ledger.json` fails to parse: (a) refuse to process any work (return 1 from gate check), (b) log error with instructions: "Cost ledger is corrupt. Run 'autonomous-dev config init --reset-ledger' to reinitialize." (c) emit alert.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With a corrupt `cost-ledger.json`, gate check fails and no sessions are spawned. Log contains the recovery instruction. Alert is emitted. With a valid or missing ledger, normal operation continues.
   - Estimated effort: 1h

10. **Implement graceful shutdown timeout escalation** -- `graceful_shutdown_child()` per TDD Section 3.3.5. When `SHUTDOWN_REQUESTED=true` and `CURRENT_CHILD_PID` is set: wait up to `graceful_shutdown_timeout_seconds` (default 300s) for child to exit naturally. If still running, send SIGTERM, wait 10s, then SIGKILL. Integrate into the signal handler and post-wait logic.
    - Files to modify: `bin/supervisor-loop.sh`
    - Acceptance criteria: With a child that exits within grace period, no signals are sent and daemon exits cleanly. With a child that hangs past the grace period, SIGTERM is sent, and if still hanging, SIGKILL is sent. Log records each escalation step. Daemon exits 0 after child cleanup.
    - Estimated effort: 2.5h

11. **Implement log rotation** -- `rotate_logs_if_needed()` per TDD Section 6.1. Size-based rotation: when `daemon.log` exceeds `log_max_size_mb`, rotate (daemon.log -> daemon.log.1, daemon.log.1 -> daemon.log.2, daemon.log.2 -> delete). `cleanup_old_logs()` per TDD Section 6.2: delete `daemon.log.*` and `session-*.json` files older than `log_retention_days`. Both called at the end of each loop iteration.
    - Files to modify: `bin/supervisor-loop.sh`
    - Acceptance criteria: With a log exceeding max size, rotation produces daemon.log.1 and daemon.log.2 correctly (no data loss, no race with concurrent writes). With log files older than retention days, cleanup deletes them. Rotation is logged. Session output files are also cleaned up.
    - Estimated effort: 2h

12. **Write unit and integration tests** -- Tests for all resilience components.
    - Files to create: `tests/test_resilience.bats`
    - Files to modify: `tests/test_helpers.bash`
    - Acceptance criteria: Tests cover: crash counter (increment, reset, persist across restart), circuit breaker (trip at threshold, gate rejects, reset clears), error backoff (exponential timing, cap, selection skip), retry exhaustion (escalation to paused), turn exhaustion (soft failure detection), sleep/wake recovery (stale heartbeat with active session), state corruption (restore from checkpoint, unrecoverable case), cost ledger corruption (gate block), graceful shutdown escalation (normal exit, SIGTERM escalation, SIGKILL escalation), log rotation (size trigger, file naming), log cleanup (retention policy).
    - Estimated effort: 6h

## Dependencies & Integration Points

**Consumes from Plan 1:**
- Logging functions, heartbeat mechanism, signal handler framework, config loading
- `SHUTDOWN_REQUESTED`, `CURRENT_CHILD_PID` variables

**Consumes from Plan 2:**
- `check_gates()` call site (adds circuit breaker condition)
- `select_request()` (adds `next_retry_after` filtering)
- `spawn_session()` (adds shutdown escalation)
- `update_request_state()` (adds retry backoff, escalation, turn exhaustion handling)
- `update_cost_ledger()` (adds corruption recovery)
- `mock-claude.sh` test fixture (extended with new behaviors)

**Exposes to Plan 4:**
- `crash-state.json` contract read by `daemon status` and `circuit-breaker reset` commands
- `record_success()` and `record_crash()` functions that the circuit breaker reset command needs to understand
- Alert files in `alerts/` directory that could be surfaced by status commands
- Log rotation ensures log files remain manageable for `daemon status` and operator inspection

## Testing Strategy

- **Unit tests (bats):** Each resilience function tested in isolation. Crash counter tested with controlled crash-state.json files. Circuit breaker tested by simulating N consecutive failures. Error backoff tested by comparing computed `next_retry_after` against expected values. State corruption tested with invalid JSON fixtures.
- **Integration tests (bats + mock-claude):** Extended mock-claude with `turns_exhausted` and `hang` behaviors. Full-cycle tests: (1) three consecutive failures trip breaker, reset clears it, next iteration succeeds; (2) sleep/wake simulation: backdate heartbeat, mark session active, restart daemon, verify recovery without crash counter increment; (3) corrupt state.json, verify checkpoint restore.
- **Stress test (manual):** Run 20+ iterations with alternating success/failure mock behaviors. Verify crash counter and circuit breaker behave correctly through the full cycle. Verify log rotation triggers when log grows.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sleep/wake vs. crash heuristic misclassifies events | Medium | Medium -- crash counter increments incorrectly on sleep, potentially tripping breaker prematurely | Use the TDD's heuristic (staleness > 10 min + no recent crash-state update = sleep). Log the classification decision so operators can audit. Add a `force-reset-crashes` command as an escape hatch. |
| Exponential backoff timer drift due to `date` precision or timezone issues | Low | Low -- backoff may be slightly shorter or longer than intended | Use UTC for all timestamp comparisons. Test with clock skew scenarios (manually set future/past timestamps in state files). |
| Log rotation race: log entry written during rotation could be lost | Low | Low -- single log entry lost during rotation | The `mv` operation is atomic. Log rotation happens at the end of the loop iteration, not mid-operation. The first log entry after rotation goes to the new daemon.log file. |
| SIGKILL escalation kills a claude session that was about to write state, leaving state stale | Medium | Medium -- state reflects pre-session, losing session work | This is acceptable: the checkpoint was taken before the session started. The session's work is lost, but the state is consistent. The next iteration retries from the checkpoint. This is documented as expected behavior. |

## Definition of Done

- [ ] Crash counter persists to `crash-state.json` and survives daemon restarts
- [ ] Crash counter increments on failure and resets to 0 on success
- [ ] Circuit breaker trips at configured threshold and blocks all iterations
- [ ] Circuit breaker state can be reset (function exists; CLI wrapper is Plan 4)
- [ ] Alert is emitted on circuit breaker trip and retry exhaustion
- [ ] Per-request error backoff computes correct exponential delays and writes `next_retry_after`
- [ ] Request selection skips requests in backoff period
- [ ] Retry exhaustion escalates request to `paused` status after max retries
- [ ] Turn budget exhaustion is detected and treated as a soft failure
- [ ] Sleep/wake recovery restores interrupted sessions from checkpoints without incrementing crash counter
- [ ] Corrupt `state.json` is recovered from `checkpoint.json`; both corrupt transitions to `failed`
- [ ] Corrupt `cost-ledger.json` blocks all processing with a clear error message
- [ ] Graceful shutdown escalates from wait -> SIGTERM -> SIGKILL for hung child processes
- [ ] Log rotation triggers at configured size threshold and produces correctly named rotated files
- [ ] Old logs are cleaned up per retention policy
- [ ] All unit and integration tests pass (`bats tests/test_resilience.bats`)
- [ ] No shellcheck warnings at `--severity=warning` level
