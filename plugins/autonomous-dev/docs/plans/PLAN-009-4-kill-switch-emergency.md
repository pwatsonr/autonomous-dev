# PLAN-009-4: Kill Switch & Emergency Controls

## Metadata
- **Parent TDD**: TDD-009-trust-escalation
- **Estimated effort**: 7 days
- **Dependencies**: [PLAN-009-1 (trust engine), PLAN-009-5 (audit trail interface)]
- **Blocked by**: [PLAN-009-1 (needs request context types)]
- **Priority**: P0

## Objective

Implement the Kill Switch subsystem providing emergency halt capability with two modes (graceful and hard), per-request cancel, pause/resume controls, and comprehensive state preservation. The kill switch is the highest-priority safety mechanism: it must halt all active pipeline execution within 5 seconds and preserve enough state for forensic analysis and potential resumption. After a kill, the system enters a `HALTED` state that requires explicit human action to re-enable.

## Scope

### In Scope

- `/kill graceful` command: signal all active requests to stop at the next atomic operation boundary (< 5 seconds to signal, < 30 seconds to fully halt)
- `/kill hard` command: immediately interrupt all execution, accepting potential dirty state (< 5 seconds)
- `/cancel {request-id}` command: cancel a specific request
- `/pause` and `/resume` commands: pause and resume pipeline execution without full kill (Phase 2, but interface defined here)
- Global `AbortController` pattern: every pipeline executor checks the abort signal before starting a new phase or gate
- Per-request `AbortController` for scoped cancellation
- State preservation after kill: pipeline position, generated artifacts, pending escalations, event log, kill snapshot
- `HALTED` state enforcement: all incoming requests rejected with `SYSTEM_HALTED` error while halted
- Re-enable command requiring explicit human action (`emergency.restart_requires_human = true`, immutable)
- Kill switch idempotency: second kill during kill is a no-op (logged but no state change)
- Emergency configuration data model
- Kill switch drill support (TDD Section 8.3)
- Unit tests for both modes, state preservation, idempotency, re-enable flow
- Integration tests for kill during active phases

### Out of Scope

- Notification delivery of kill events (covered by PLAN-009-5; this plan emits payloads via injected interface)
- Audit trail implementation (covered by PLAN-009-5; this plan uses injected interface)
- Escalation cancellation details (PLAN-009-2 exposes `cancelPending`; this plan calls it)
- Trust level changes during kill (trust state is frozen at kill; changes resume after re-enable)
- Meta-escalation handling when the kill switch itself fails (TDD OQ-5, deferred)

## Tasks

1. **Define kill switch type system** -- Create TypeScript types and interfaces.
   - Files to create: `src/emergency/types.ts`
   - Types: `KillMode` ("graceful" | "hard"), `KillResult` (halted requests snapshot, timestamp), `SystemState` ("running" | "halted" | "paused"), `StateSnapshot` (per-request pipeline position, phase, artifacts), `CancelResult`, `PauseResumeResult`
   - Acceptance criteria: All types exported; covers all states from TDD Section 3.3
   - Estimated effort: 2 hours

2. **Implement Global AbortController Manager** -- Manage the global and per-request abort controllers.
   - Files to create: `src/emergency/abort-manager.ts`
   - Global abort controller: signals all active pipeline executors
   - Per-request abort controllers: `Map<string, AbortController>` for scoped cancellation
   - Registration API: `registerRequest(requestId): AbortSignal` (pipeline executors call this to get their signal)
   - Deregistration API: `deregisterRequest(requestId)` (called when a request completes normally)
   - Acceptance criteria: Global abort signals all registered requests; per-request abort only signals the target; registering after kill returns an already-aborted signal; deregistration cleans up
   - Estimated effort: 4 hours

3. **Implement State Snapshot Capture** -- Capture the full system state at the moment of kill.
   - Files to create: `src/emergency/state-snapshot.ts`
   - Captures per TDD Section 3.3.1: pipeline position per request (from `.autonomous-dev/state/<request-id>/pipeline.json`), list of generated artifacts, pending escalation IDs, active request count
   - Snapshot is serialized to `.autonomous-dev/state/kill-snapshot-<timestamp>.json`
   - Must execute quickly (< 1 second) since it runs before the abort signal is sent
   - Acceptance criteria: Snapshot captures all active request states; snapshot file is written atomically; snapshot includes enough state for forensic analysis
   - Estimated effort: 4 hours

4. **Implement KillSwitch class** -- Core kill switch with graceful and hard modes.
   - Files to create: `src/emergency/kill-switch.ts`
   - `kill(mode, issuedBy): Promise<KillResult>`:
     - Set `halted = true`
     - Capture state snapshot BEFORE signaling
     - Graceful: abort with `KILL_GRACEFUL` reason (executors finish current atomic operation)
     - Hard: abort with `KILL_HARD` reason (immediate interrupt)
     - Emit `kill_issued` audit event
     - Emit `immediate` urgency notification
   - `cancel(requestId, issuedBy): Promise<CancelResult>`: abort single request, log, notify
   - `isHalted(): boolean`: check system state
   - `reenable(issuedBy): void`: restore to running state, create fresh global AbortController, log `system_reenabled` event
   - Idempotency: second call to `kill()` while halted is a no-op, logged but does not change state
   - Acceptance criteria: Graceful kill signals at phase boundary; hard kill signals immediately; state snapshot captured before signal; halted state rejects new requests; re-enable restores system; double-kill is idempotent
   - Estimated effort: 8 hours

5. **Implement HALTED state gate** -- Middleware that rejects all incoming requests when system is halted.
   - Files to create: `src/emergency/halted-gate.ts`
   - Every incoming pipeline request passes through this gate first
   - When `isHalted() === true`, reject with `SYSTEM_HALTED` error code and message including who issued the kill and when
   - `emergency.restart_requires_human` is hardcoded to `true` and cannot be overridden; enforce this at the config level
   - Acceptance criteria: Requests rejected with clear error during HALTED state; error message includes kill context; config override of `restart_requires_human` is rejected
   - Estimated effort: 3 hours

6. **Implement Pause/Resume commands** -- Scoped pipeline pause and resume (Phase 2 feature, interface defined now).
   - Files to create: `src/emergency/pause-resume.ts`
   - `/pause` with optional `requestId`: pauses all pipelines or a specific request without killing
   - `/resume` with optional `requestId`: resumes paused pipelines
   - Difference from kill: paused state allows re-enable without explicit human ceremony; no state snapshot; no `HALTED` gate
   - Emits `pause_issued` and `resume_issued` audit events
   - Acceptance criteria: Pause stops execution at next phase boundary; resume continues from pause point; pause does not trigger HALTED state; audit events emitted
   - Estimated effort: 6 hours

7. **Implement State Preservation File Layout** -- Ensure the file layout from TDD Section 3.3.1 is created and maintained.
   - Files to create/modify: `src/emergency/state-persistence.ts`
   - File layout per TDD:
     - `.autonomous-dev/state/<request-id>/pipeline.json` -- pipeline position
     - `.autonomous-dev/workspaces/<request-id>/` -- generated artifacts
     - `.autonomous-dev/state/escalations/pending.json` -- pending escalations
     - `.autonomous-dev/events.jsonl` -- event log (managed by PLAN-009-5)
     - `.autonomous-dev/state/kill-snapshot-<timestamp>.json` -- kill snapshot
   - Persistence is incremental: pipeline state is written after each phase completion (not just at kill time)
   - Acceptance criteria: All state files are present after a kill; pipeline state can be deserialized to determine resume point; artifacts are intact
   - Estimated effort: 4 hours

8. **Implement Emergency Configuration loader** -- Parse the `emergency:` section of plugin config.
   - Files to create/modify: `src/emergency/emergency-config.ts`
   - Fields: `kill_default_mode` ("graceful" | "hard", default "graceful"), `restart_requires_human` (immutable, always true)
   - Acceptance criteria: Config loads correctly; `restart_requires_human` cannot be set to false; invalid mode falls back to graceful
   - Estimated effort: 2 hours

9. **Implement barrel exports and module wiring** -- Create module index.
   - Files to create: `src/emergency/index.ts`
   - Export all public APIs
   - Acceptance criteria: Clean imports; all dependencies injectable
   - Estimated effort: 1 hour

10. **Unit tests for Kill Switch** -- Cover TDD Section 8.1 Kill Switch test focus areas.
    - Files to create: `src/emergency/__tests__/abort-manager.test.ts`, `src/emergency/__tests__/kill-switch.test.ts`, `src/emergency/__tests__/state-snapshot.test.ts`, `src/emergency/__tests__/halted-gate.test.ts`, `src/emergency/__tests__/pause-resume.test.ts`
    - Test focus per TDD 8.1: Graceful vs. hard mode; state snapshot correctness; idempotent double-kill; re-enable flow; HALTED state rejection
    - Acceptance criteria: 100% branch coverage; all TDD 8.1 Kill Switch scenarios covered
    - Estimated effort: 8 hours

11. **Integration tests: Kill switch during active pipelines** -- End-to-end kill scenarios.
    - Files to create: `src/emergency/__tests__/kill-switch.integration.test.ts`
    - Scenarios from TDD Section 8.2: `/kill graceful` during active phase (halt at atomic boundary, state preserved); `/kill hard` during active phase (immediate halt, state preserved)
    - Kill switch drill scenario from TDD Section 8.3: start 3+ synthetic requests, issue kill, verify halt timing, verify state preservation, re-enable, verify system accepts new requests
    - Acceptance criteria: All scenarios pass; halt timing within TDD targets; state fully preserved; re-enable works
    - Estimated effort: 6 hours

## Dependencies & Integration Points

- **PLAN-009-1 (Trust Engine)**: The trust engine state is frozen during HALTED state. After re-enable, pending trust changes are applied at the next gate boundary.
- **PLAN-009-2 (Escalation Engine)**: The kill switch cancels all pending escalation chains. It calls `escalationEngine.cancelAllPending()` as part of the kill sequence.
- **PLAN-009-3 (Response Handler)**: Any pending human responses are invalidated by a kill. The response validator in PLAN-009-3 checks `isHalted()` before processing.
- **PLAN-009-5 (Audit & Notifications)**: The kill switch emits `kill_issued`, `cancel_issued`, `pause_issued`, `resume_issued`, `system_reenabled` audit events and `immediate` urgency notifications. Uses injected interfaces.
- **Pipeline Orchestrator**: Every pipeline executor must check the abort signal from the abort manager before starting new phases. The abort manager provides the `AbortSignal` interface.

## Testing Strategy

- **Unit tests**: Each component tested in isolation with mock dependencies. Mock the pipeline executors, abort controllers, and file system for state persistence.
- **Integration tests**: Simulate active pipeline execution with mock executors that respect abort signals. Verify halt timing, state preservation, and re-enable flow.
- **Kill switch drill**: Automated drill scenario per TDD Section 8.3 that can be run as part of the test suite (not just quarterly manual drill).
- **Stress testing**: Verify kill switch works correctly with many concurrent requests (10+).
- **Timing tests**: Verify graceful kill signals within 5 seconds and hard kill completes within 5 seconds.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Hard kill leaves dirty state (partial writes, uncommitted changes) | High (by design) | Medium | This is the documented trade-off for hard kill. State snapshot captures the pre-kill state. Dirty state is detectable by comparing snapshot with post-kill file system. |
| State snapshot capture takes too long with many active requests | Low | Medium | Snapshot reads pipeline state files that are kept up-to-date incrementally. Snapshot is a read-only operation over a bounded number of files. |
| AbortController pattern may not propagate to all async operations | Medium | High | All pipeline executors must check the signal before and after async operations. Code review must verify signal checking at every async boundary. |
| File system corruption during hard kill | Low | High | Kill snapshot is written BEFORE the abort signal. Event log uses O_APPEND for atomic appends. Artifacts may be partially written; this is acceptable for hard kill and documented. |

## Definition of Done

- [ ] All source files created and passing TypeScript compilation with strict mode
- [ ] `/kill graceful` signals all active requests to stop at atomic boundary within 5 seconds
- [ ] `/kill hard` immediately interrupts all execution within 5 seconds
- [ ] `/cancel {request-id}` cancels a specific request without affecting others
- [ ] State preservation: pipeline position, artifacts, pending escalations, kill snapshot all captured
- [ ] `HALTED` state rejects all incoming requests with `SYSTEM_HALTED` error
- [ ] Re-enable requires explicit human action; `restart_requires_human` cannot be overridden
- [ ] Double-kill is idempotent (logged, no state change)
- [ ] `/pause` and `/resume` commands work for all-pipeline and per-request scopes
- [ ] All unit tests pass with 100% branch coverage
- [ ] All integration test scenarios pass including kill switch drill
- [ ] AbortSignal is the contract between kill switch and pipeline executors
