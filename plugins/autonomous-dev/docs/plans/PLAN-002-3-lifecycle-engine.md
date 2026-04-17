# PLAN-002-3: Lifecycle Engine

## Metadata
- **Parent TDD**: TDD-002-state-machine
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-002-1, PLAN-002-2]
- **Blocked by**: [PLAN-002-1, PLAN-002-2]
- **Priority**: P0

## Objective
Deliver the Lifecycle Engine: the pure-function core of the state machine that validates and executes all state transitions. This is the most complex component in TDD-002 -- it encodes the full transition table (forward, backward, meta-state), timeout enforcement, retry accounting, and dependency evaluation. The engine must satisfy the non-negotiable constraint that `state_transition(state, event) -> new_state` is a pure function testable without spawning Claude Code sessions (NFR-09). This plan also wires the engine into the supervisor loop interface defined in TDD-001.

## Scope
### In Scope
- `state_transition()` function: the central transition dispatcher (TDD Section 3.4.1)
- Forward transitions: all 13 `advance` events through the pipeline (TDD Section 5.1)
- Backward transitions: all 5 `review_fail` regressions from `_review` states to generation states (TDD Section 5.2)
- Meta-state transitions: `pause`, `resume`, `fail`, `retry`, `cancel` (TDD Section 5.3)
- Invalid transition rejection: all cases in TDD Section 5.4
- Automatic error-state transitions: session crash, timeout, corruption, cost cap, kill switch, dependency failure, rate limit (TDD Section 5.5)
- Timeout enforcement: per-phase configurable timeouts, timeout detection, retry-or-fail logic (TDD Section 3.4.3)
- Retry accounting: per-phase retry counters, increment/reset/exhaustion logic (TDD Section 3.4.4)
- Dependency evaluation: `blocked_by` resolution, circular dependency detection (TDD Section 3.4.5)
- Phase history management: append new `PhaseHistoryEntry` on transition, set `exited_at` on previous entry
- `current_phase_metadata` lifecycle: clear and repopulate on each transition
- Integration with `state_write_atomic()`, `state_checkpoint()`, and `event_append()` from PLAN-002-1/2
- Unit tests: 75+ tests covering the complete transition table
- Supervisor loop integration interface (functions callable from TDD-001's supervisor loop)

### Out of Scope
- Supervisor loop implementation itself (TDD-001)
- Agent spawning and session management (TDD-001, TDD-005)
- Document pipeline integration (TDD-003)
- Review gate logic / quality criteria evaluation (TDD-004)
- Cleanup and archival (PLAN-002-4)
- Schema migration (PLAN-002-4)
- Performance benchmarking (PLAN-002-4)

## Tasks

1. **Implement the transition dispatcher `state_transition()`** -- Central function that accepts `(current_state_json, event_type, metadata_json, timestamp)` and routes to the appropriate transition handler. Returns new state JSON on stdout (exit 0) or error on stderr (exit non-zero).
   - Files to create: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Dispatches to correct handler based on `event_type`. (b) Returns well-formed error for unrecognized event types. (c) Updates `updated_at` timestamp on every successful transition. (d) Is a pure function: same inputs always produce same outputs.
   - Estimated effort: 3 hours

2. **Implement forward transitions (advance)** -- 13 transition handlers for the sequential pipeline: `intake->prd`, `prd->prd_review`, ..., `deploy->monitor`. Each validates preconditions from TDD Section 5.1 (e.g., "PRD document exists on branch" for `prd->prd_review`).
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Each of the 13 forward transitions produces correct `to_state`. (b) Previous phase history entry gets `exited_at` set and `exit_reason: "completed"` (or `"review_pass"` for review states). (c) New phase history entry is appended with `entered_at`, null `exited_at`, zero `turns_used` and `cost_usd`. (d) `last_checkpoint` is updated. (e) Attempting to skip a state (e.g., `intake->tdd`) returns error.
   - Estimated effort: 5 hours

3. **Implement backward transitions (review_fail)** -- 5 regression handlers: `prd_review->prd`, `tdd_review->tdd`, `plan_review->plan`, `spec_review->spec`, `code_review->code`. Each validates `retry_count < max_retries`.
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Each of the 5 backward transitions produces correct `to_state`. (b) `retry_count` in the new phase history entry is incremented from the review phase's count. (c) `review_feedback` from the review phase is preserved in `current_phase_metadata`. (d) If `retry_count >= max_retries`, transition is rejected and an escalation/pause transition is triggered instead. (e) Previous phase history entry gets `exit_reason: "review_fail"`.
   - Estimated effort: 4 hours

4. **Implement meta-state transitions** -- Handlers for `pause`, `resume`, `fail`, `retry`, `cancel` per TDD Section 5.3.
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria:
     - **pause**: Sets `status: "paused"`, `paused_from` to original state, `paused_reason` from metadata. Increments `escalation_count` when review-triggered. Works from any non-cancelled state.
     - **resume**: Restores `status` to `paused_from` value. Clears `paused_from` and `paused_reason`. Only valid from `paused`.
     - **fail**: Sets `status: "failed"`, populates `error` object and `failure_reason`. Works from any non-cancelled state.
     - **retry**: Restores state to `last_checkpoint`. Resets phase retry count. Clears `error`. Only valid from `failed` when `last_checkpoint` is set.
     - **cancel**: Sets `status: "cancelled"`. Works from any state except `cancelled`. Is terminal -- no further transitions accepted.
   - Estimated effort: 5 hours

5. **Implement invalid transition rejection** -- Validate all transitions against the rules in TDD Section 5.4. Return structured `TransitionError` with descriptive message.
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Transitioning from `cancelled` returns error. (b) `monitor` rejects `advance`. (c) Skipping states returns error. (d) `paused` rejects transitions to states other than `paused_from`. (e) `failed` rejects transitions other than `retry` (to checkpoint) and `cancel`. (f) No state transitions back to `intake`. (g) Error messages specify both the attempted transition and the rule that was violated.
   - Estimated effort: 3 hours

6. **Implement timeout enforcement** -- `check_phase_timeout()` function that compares `now - current_phase.entered_at` against the configured timeout for the phase. Returns whether a timeout has occurred and the recommended action (retry or fail).
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Correctly identifies timed-out phases. (b) Returns "retry" when `retry_count < max_retries`. (c) Returns "fail" (or "pause" for review phases) when retries exhausted. (d) `monitor` state is exempt from timeout checks (indefinite timeout). (e) Timeout thresholds are read from configuration, not hardcoded.
   - Estimated effort: 3 hours

7. **Implement retry accounting** -- Per-phase retry counters within phase history entries. Increment on re-entry, reset when advancing past a phase, exhaustion detection.
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) `retry_count` increments on each re-entry to the same phase. (b) `retry_count` resets to 0 when the request advances past the phase (review passes). (c) When `retry_count >= max_retries`, the engine triggers pause/fail instead of allowing re-entry. (d) `max_retries` is configurable per phase.
   - Estimated effort: 2 hours

8. **Implement dependency evaluation** -- `is_blocked()` function that checks `blocked_by` array against other requests' states. `detect_circular_dependencies()` that follows the `blocked_by` chain and returns error if a cycle exists.
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Request with empty `blocked_by` is never blocked. (b) Request blocked by an active (non-completed) request returns true. (c) Request blocked by a completed request (`deploy`, `monitor`, `cancelled`) returns false. (d) Unknown dependency (state file not found) is treated as blocked. (e) Failed dependency transitions the blocked request to `failed` with `dependency_failed`. (f) Circular dependency is detected and rejected at submit time.
   - Estimated effort: 3 hours

9. **Implement automatic error-state transitions** -- Handlers for all triggers in TDD Section 5.5: session exit non-zero, phase timeout, state corruption, cost cap, kill switch, dependency failure, rate limit.
   - Files to modify: `lib/state/lifecycle_engine.sh`
   - Acceptance criteria: (a) Each trigger produces the correct target state per the table. (b) Appropriate `error` object is populated with correct `code`, `message`, `phase`, and `timestamp`. (c) Events are emitted for each automatic transition.
   - Estimated effort: 3 hours

10. **Implement supervisor integration interface** -- Public functions that the supervisor loop (TDD-001) calls: `process_request()` (read state, check timeout, check blocked, determine next action), `complete_phase()` (advance after successful session), `handle_session_failure()` (retry or fail after session crash).
    - Files to create: `lib/state/supervisor_interface.sh`
    - Acceptance criteria: (a) `process_request()` returns the action the supervisor should take (spawn session, skip, wait). (b) `complete_phase()` calls `state_transition()` with `advance` and writes checkpoint. (c) `handle_session_failure()` calls `state_transition()` with appropriate fail/retry event. (d) All three functions emit events via `event_append()`.
    - Estimated effort: 3 hours

11. **Unit tests: valid transitions** -- 13 forward + 5 backward + 12 meta-state = 30 transition tests.
    - Files to create: `tests/unit/test_lifecycle_transitions.sh`
    - Acceptance criteria: Each of the 30 valid transitions is tested with fixture data. Tests verify: correct `to_state`, correct phase history mutation, correct side effects (checkpoint, retry counter, escalation count).
    - Estimated effort: 5 hours

12. **Unit tests: invalid transitions and edge cases** -- 15+ rejection tests + 5 timeout + 6 retry + 5 dependency = 31+ tests.
    - Files to create: `tests/unit/test_lifecycle_edge_cases.sh`
    - Acceptance criteria: Each invalid transition from TDD Section 5.4 is tested. Timeout detection, retry exhaustion, dependency blocking/unblocking, and circular dependency detection are all covered. Error messages are verified for specificity.
    - Estimated effort: 6 hours

13. **Property-based transition validation** -- Implement the 5 properties from TDD Section 10.3 as test assertions that can be run against randomized state+event pairs.
    - Files to create: `tests/unit/test_lifecycle_properties.sh`
    - Acceptance criteria: (a) Any valid state + valid event -> valid state or well-formed error. (b) `cancelled` is absorbing. (c) Phase history only grows. (d) `updated_at` is monotonically non-decreasing. (e) `cost_accrued_usd` is monotonically non-decreasing. Tests generate at least 50 random state+event combinations.
    - Estimated effort: 4 hours

## Dependencies & Integration Points
- **Depends on PLAN-002-1**: Sources `lib/state/state_file_manager.sh` for `state_read()`, `state_write_atomic()`, `state_checkpoint()`, `state_restore_checkpoint()`, and schema validation.
- **Depends on PLAN-002-2**: Sources `lib/state/event_logger.sh` for `event_append()`. Sources `lib/state/request_tracker.sh` for `discover_requests()` and `validate_request_id()`.
- **Consumed by TDD-001 (Supervisor Loop)**: The supervisor calls `process_request()`, `complete_phase()`, and `handle_session_failure()` on each iteration.
- **Consumed by TDD-003 (Document Pipeline)**: Document pipeline reads state to determine which document to produce, and calls `complete_phase()` when done.
- **Consumed by TDD-004 (Review Gates)**: Review gates call the backward transition handler on review failure and forward transition on review pass.

## Testing Strategy
- All transition logic is tested as pure functions: construct a state JSON fixture, invoke `state_transition()`, verify the output JSON.
- No file I/O in transition unit tests -- the pure function operates on JSON strings, not files. File I/O is tested separately via the supervisor interface integration tests.
- Property-based tests use a bash function that generates random valid states and events, feeds them through the transition function, and asserts the 5 invariant properties.
- Dependency evaluation tests create mock state files in a temporary directory to simulate multi-request scenarios.
- Tests target 75+ total test cases as specified in TDD Section 10.1.

## Risks
1. **Complexity of the transition function.** With 17 states, 7 event types, and numerous conditional rules, the bash implementation could become unwieldy. Mitigation: decompose into small, focused handler functions (one per event type) with a clean dispatch table. Each handler is independently testable.
2. **Pure-function constraint in bash.** Bash functions naturally have side effects (file I/O, global variables). Mitigation: the `state_transition()` function takes JSON on stdin and produces JSON on stdout with no file access. All file I/O is in the supervisor interface layer, not the transition logic.
3. **Timeout accuracy.** Bash date arithmetic can have edge cases around timezone handling and leap seconds. Mitigation: use UTC throughout (`date -u`), compare ISO-8601 timestamps as strings only after converting to epoch seconds via `date -d` or `date -j -f`.
4. **Circular dependency detection performance.** Following `blocked_by` chains requires reading multiple state files. With many interdependent requests, this could be slow. Mitigation: limit chain depth to 10 (matching PRD's generation depth limit). Log warning if chain is suspiciously deep.

## Definition of Done
- [ ] `state_transition()` handles all 7 event types: `advance`, `review_fail`, `pause`, `resume`, `fail`, `retry`, `cancel`
- [ ] All 13 forward transitions work correctly per TDD Section 5.1
- [ ] All 5 backward transitions work correctly per TDD Section 5.2
- [ ] All meta-state transitions (`pause`/`resume`/`fail`/`retry`/`cancel`) work per TDD Section 5.3
- [ ] All invalid transitions from TDD Section 5.4 are rejected with descriptive errors
- [ ] All automatic error-state transitions from TDD Section 5.5 are implemented
- [ ] Timeout enforcement reads from configuration and exempts `monitor`
- [ ] Retry accounting increments, resets, and detects exhaustion correctly
- [ ] Dependency evaluation resolves `blocked_by`, detects cycles, and handles missing/failed deps
- [ ] Supervisor interface functions (`process_request`, `complete_phase`, `handle_session_failure`) are implemented
- [ ] Phase history entries are correctly managed (appended, never removed, `exited_at` set on transition)
- [ ] `current_phase_metadata` is cleared and repopulated on each transition
- [ ] 75+ unit tests pass
- [ ] Property-based tests validate all 5 invariants with 50+ random inputs
- [ ] All transition logic is pure-function (no file I/O in `state_transition()` itself)
- [ ] Code reviewed and merged
