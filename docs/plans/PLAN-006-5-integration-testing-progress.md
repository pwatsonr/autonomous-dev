# PLAN-006-5: Integration Testing, Progress Tracking, and Crash Recovery

## Metadata
- **Parent TDD**: TDD-006-parallel-execution
- **Estimated effort**: 5 days
- **Dependencies**: [PLAN-006-1-worktree-management, PLAN-006-2-dag-scheduling, PLAN-006-3-agent-assignment, PLAN-006-4-merge-conflicts]
- **Blocked by**: [PLAN-006-4-merge-conflicts] (integration tests run after merge-back), [PLAN-006-1-worktree-management] (crash recovery depends on StatePersister)
- **Priority**: P1

## Objective

Implement the integration test runner with failure attribution, the progress tracking system with stall detection and ETA calculation, the full crash recovery pipeline that resumes execution from persisted state, and the event emission system that ties all components together. This plan completes the parallel execution engine by adding the observability, resilience, and feedback loops that make the system production-ready.

## Scope

### In Scope
- Integration test runner on the integration branch after all tracks merge (TDD 3.6)
- Test failure attribution: parse output, `git log`/`git blame` to identify responsible tracks (TDD 3.6)
- Revision loop: re-execute responsible tracks in fresh worktrees branched from integration (TDD 3.6)
- Revision loop circuit breaker: max `max_revision_cycles` (default 2) before escalation (TDD 6.3)
- Track state machine: `pending -> queued -> executing -> testing -> reviewing -> merging -> complete` with `failed`/`escalated` branches (TDD 3.8.1)
- State transition recording with timestamps (TDD 3.8.1)
- Stall detection: monitor `lastActivityAt`, alert at `stall_timeout_minutes` (15 min), terminate at 2x (TDD 3.8.2)
- Activity detection: agent tool calls, git commits, file modifications (TDD 3.8.2)
- Per-track progress reporting: status, phase progress, elapsed time (TDD 3.8.3)
- Request-level progress: completed/total/failed tracks, percent complete, ETA (TDD 3.8.3)
- ETA calculation: rolling average of completed track durations adjusted for parallelism (TDD 3.8.3)
- Complexity-based initial estimates: small=5min, medium=15min, large=30min (TDD 3.8.3)
- Full crash recovery on startup: scan state files, validate worktrees, determine recovery action per track (TDD 3.9.2)
- Agent crash recovery: detect partial work, continue or re-queue (TDD 3.9.3)
- Orphaned worktree cleanup integration (delegates to PLAN-006-1 WorktreeManager) (TDD 3.9.4)
- Event system: all events from TDD Appendix B not covered by prior plans
- Integration test circuit breaker: 3 consecutive failures abort request (TDD 6.3)
- Disk pressure emergency circuit breaker: < 500 MB kills all agents, pauses engine (TDD 6.3)
- Events: `track.state_changed`, `track.stalled`, `integration.test_started`, `integration.test_passed`, `integration.test_failed`, `request.progress`, `request.completed`, `request.escalated`

### Out of Scope
- Worktree creation/cleanup mechanics (PLAN-006-1)
- DAG construction and scheduling (PLAN-006-2)
- Agent spawning and isolation (PLAN-006-3)
- Merge-back and conflict resolution (PLAN-006-4)
- Dashboard UI (Phase 3, TDD Section 10)
- Chaos testing infrastructure (Phase 3, TDD Section 8.4)
- Post-mortem report generation (Phase 3, TDD Section 10)

## Tasks

1. **Implement the event system** -- Build the centralized event emission and subscription system that all components use to communicate state changes.
   - Files to create/modify:
     - `src/parallel/events.ts` (modify -- extend the stubs from PLAN-006-1 into a full event bus)
   - Acceptance criteria:
     - `EventBus` class with `emit(event)`, `on(eventType, handler)`, `off(eventType, handler)`
     - All event types from TDD Appendix B defined as TypeScript interfaces
     - Events include: `track.state_changed`, `track.stalled`, `worktree.*`, `merge.*`, `integration.*`, `agent.*`, `request.*`, `security.*`
     - Events are logged to `.autonomous-dev/logs/req-{id}/events.log` for auditing
     - Event handlers are async-safe (emit does not block)
     - Supports multiple subscribers per event type
   - Estimated effort: 4 hours

2. **Implement the track state machine** -- Build the state machine that governs track lifecycle transitions with validation and timestamp recording.
   - Files to create/modify:
     - `src/parallel/progress-tracker.ts` (new)
   - Acceptance criteria:
     - `TrackStateMachine` enforces valid transitions per TDD 3.8.1 diagram
     - Valid transitions: `pending->queued`, `queued->executing`, `executing->testing`, `testing->reviewing`, `reviewing->merging`, `merging->complete`, and any active state -> `failed` or `escalated`
     - Invalid transitions are rejected with an error (e.g., cannot go from `pending` to `complete`)
     - Every transition recorded as `StateTransition` with `from`, `to`, `timestamp`, `reason`
     - Emits `track.state_changed` event on every transition
     - State machine state is persisted via StatePersister after each transition
   - Estimated effort: 4 hours

3. **Implement stall detection** -- Build the monitoring system that detects inactive tracks and triggers alerts or termination.
   - Files to create/modify:
     - `src/parallel/progress-tracker.ts` (modify -- add stall detection)
   - Acceptance criteria:
     - `StallDetector` monitors `lastActivityAt` for each executing track
     - Activity sources: agent tool calls (callback from AgentSpawner), git commits (polled via `git log -1 --format=%ct`), file modifications in worktree
     - First stall alert at `stall_timeout_minutes` (15 min): emits `track.stalled` warning, agent continues (TDD 3.8.2)
     - Second stall alert at 2x timeout (30 min): terminates agent, enters retry flow
     - `updateActivity(trackName)` called by agent monitoring to refresh timestamp
     - Polling interval configurable (default: check every 30 seconds)
   - Estimated effort: 4 hours

4. **Implement progress reporting and ETA calculation** -- Build the per-track and request-level progress reporting with estimated time remaining.
   - Files to create/modify:
     - `src/parallel/progress-tracker.ts` (modify -- add progress reporting)
   - Acceptance criteria:
     - `getTrackProgress(trackName)` returns `TrackProgress`: status, phase progress (e.g., "executing (turn 23/60)"), elapsed minutes (TDD 3.8.3)
     - `getRequestProgress(requestId)` returns `RequestProgress`: total/completed/failed tracks, in-progress details, percent complete, ETA, current/total clusters (TDD 3.8.3)
     - ETA uses rolling average of completed track durations divided by effective parallelism (TDD 3.8.3)
     - For first cluster (no completed tracks): uses complexity heuristic -- small=5min, medium=15min, large=30min
     - Emits periodic `request.progress` events (configurable interval, default 60 seconds)
   - Estimated effort: 4 hours

5. **Implement the integration test runner** -- Build the component that runs the full test suite on the integration branch after all tracks are merged.
   - Files to create/modify:
     - `src/parallel/integration-tester.ts` (new)
   - Acceptance criteria:
     - `runIntegrationTests(requestId)` checks out the integration branch, installs dependencies, runs the test suite (TDD 3.6)
     - Captures test output to `.autonomous-dev/logs/req-{id}/integration-test.log`
     - Returns test exit code and parsed output (failed test files, line numbers)
     - Emits `integration.test_started` at begin, `integration.test_passed` or `integration.test_failed` at end
     - Test command is configurable (not hardcoded to `npm test`): supports project-specific test runners
     - Runs in a dedicated worktree or clean checkout of the integration branch (related to TQ-7)
   - Estimated effort: 4 hours

6. **Implement test failure attribution** -- Build the analysis that maps failing tests to responsible tracks.
   - Files to create/modify:
     - `src/parallel/integration-tester.ts` (modify -- add attribution)
   - Acceptance criteria:
     - `attributeFailures(requestId, failedTests)` identifies which track(s) caused each failure (TDD 3.6)
     - For test file failures: `git log --oneline integration -- <test-file>` to find which merge commit modified the test
     - For non-test code failures: `git blame` on failing lines to identify the responsible merge commit
     - Maps merge commits back to track names
     - Returns a map of `trackName -> [failedTests]` for targeted revision
     - Handles cases where failure spans multiple tracks (attributes to all involved)
   - Estimated effort: 5 hours

7. **Implement the revision loop** -- Build the feedback loop that sends failed tracks back for re-execution with failure context.
   - Files to create/modify:
     - `src/parallel/integration-tester.ts` (modify -- add revision loop)
   - Acceptance criteria:
     - `reviseTrack(requestId, trackName, failures)` re-executes a track in a fresh worktree branched from the current integration branch (TDD 3.6)
     - Revised track has visibility into the full integrated codebase (all other tracks' changes present)
     - Agent receives: failure output, specific files and lines identified, the integration branch state
     - Revised track goes through full lifecycle: execute, test, review, merge
     - Tracks revision count per track; maximum `max_revision_cycles` (default 2) before permanent escalation (TDD 6.3)
     - Integration test circuit breaker: 3 consecutive failures after revisions aborts request (TDD 6.3)
   - Estimated effort: 5 hours

8. **Implement full crash recovery pipeline** -- Build the startup recovery that resumes in-flight requests from persisted state.
   - Files to create/modify:
     - `src/parallel/crash-recovery.ts` (new)
   - Acceptance criteria:
     - `recoverOnStartup()` implements the full algorithm from TDD 3.9.2
     - Scans `.autonomous-dev/state/*.json` for in-flight requests (phase != complete/failed)
     - For each request: validates worktree integrity (directory exists, git worktree registered, branch exists, clean vs dirty)
     - Recovery actions per track status:
       - `complete`: no action
       - `merging`: abort in-progress merge, retry merge
       - `executing/testing/reviewing`: inspect for commits beyond branch point; if yes, mark for review; if no, re-queue
       - `queued/pending`: re-queue normally
       - `failed`: check retry count; if < 1, re-queue; else leave failed
       - `escalated`: leave as escalated
     - Resumes execution from the determined recovery point
     - Delegates orphaned worktree cleanup to WorktreeManager (PLAN-006-1)
     - Recovery is idempotent: running recovery twice produces the same outcome
   - Estimated effort: 6 hours

9. **Implement emergency circuit breakers** -- Build the system-level circuit breakers for catastrophic failures.
   - Files to create/modify:
     - `src/parallel/circuit-breakers.ts` (new)
   - Acceptance criteria:
     - `DiskPressureBreaker`: if available disk < 500 MB, kills all agents and pauses engine (TDD 6.3)
     - `RevisionLoopBreaker`: if a track has been revised > `max_revision_cycles` times, permanently escalates (TDD 6.3)
     - `IntegrationTestBreaker`: 3 consecutive integration test failures aborts the request (TDD 6.3)
     - Each breaker is independently configurable (enable/disable, thresholds)
     - Breaker state is persisted so recovery respects tripped breakers
     - Emits `request.escalated` with specific breaker reason
   - Estimated effort: 3 hours

10. **Implement the engine orchestrator** -- Build the top-level orchestrator that ties all components together into the fan-out/merge-back flow.
    - Files to create/modify:
      - `src/parallel/engine.ts` (new)
    - Acceptance criteria:
      - `ParallelExecutionEngine` is the main entry point
      - `execute(requestId, specs)` runs the full pipeline: DAG construction -> cluster scheduling -> fan-out -> agent execution -> merge-back -> integration testing -> PR creation
      - Wires together: WorktreeManager, DAGConstructor, Scheduler, AgentSpawner, MergeEngine, IntegrationTester, ProgressTracker, StatePersister, CrashRecovery
      - Handles the cluster loop: for each cluster, fan-out tracks, wait for completion, merge-back, proceed to next cluster
      - After final cluster: run integration tests, handle revisions if needed
      - On success: emit `request.completed`, create PR from integration branch to main
      - On failure: emit `request.escalated`, preserve all state and logs for human review
      - Supports `resume(requestId)` for crash recovery continuation
    - Estimated effort: 6 hours

11. **Integration tests for the full pipeline** -- End-to-end tests covering the complete parallel execution lifecycle.
    - Files to create/modify:
      - `tests/parallel/integration-tester.test.ts` (new)
      - `tests/parallel/progress-tracker.test.ts` (new)
      - `tests/parallel/crash-recovery.test.ts` (new)
      - `tests/parallel/engine.test.ts` (new)
    - Acceptance criteria:
      - **3-track independent**: fan-out 3 specs, mock agents write predetermined files, merge back, verify clean integration (TDD 8.2)
      - **3-track with dependency**: A->B + C. Verify B starts only after A merges. Verify B's worktree has A's changes (TDD 8.2)
      - **Agent failure and retry**: simulate crash, verify retry, verify escalation on second failure (TDD 8.2)
      - **Stall detection**: mock inactive agent, verify alert at timeout (TDD 8.2)
      - **Crash recovery**: kill engine mid-execution, restart, verify resume without duplicate work (TDD 8.2)
      - **Full lifecycle**: 5 specs with mixed dependencies, one conflict, one failure, recovery, successful integration (TDD 8.2)
      - Tests progress reporting produces accurate percentages and ETAs
      - Tests state machine rejects invalid transitions
      - Tests failure attribution correctly identifies responsible tracks
      - Tests revision loop re-executes tracks with failure context
      - Tests circuit breakers trigger at configured thresholds
    - Estimated effort: 8 hours

## Dependencies & Integration Points

- **Upstream**: PLAN-006-1 provides StatePersister for crash recovery and WorktreeManager for worktree health validation and orphan cleanup.
- **Upstream**: PLAN-006-2 provides the Scheduler for dispatching tracks and cluster management.
- **Upstream**: PLAN-006-3 provides AgentSpawner for activity monitoring callbacks and agent lifecycle events.
- **Upstream**: PLAN-006-4 provides MergeEngine completion signals that trigger integration testing.
- **External**: The integration test runner needs to know the project's test command (configurable). The failure attribution depends on conventional test output formats (may need project-specific parsers).
- **Consumer**: The engine orchestrator is the component that the broader autonomous-dev plugin calls to execute parallel work.

## Testing Strategy

- **Unit tests**: State machine transition validation, stall timeout calculation, ETA formula, failure attribution git command parsing, circuit breaker trigger conditions.
- **Integration tests**: Full pipeline with mock agents in real git repos. Crash recovery with deliberately killed processes.
- **Scenario tests**: The 8 integration test scenarios from TDD Section 8.2.
- **Property-based tests**: State persistence roundtrip, crash recovery idempotency (recovering twice produces same state).
- **Chaos tests (stretch)**: Random agent kills during execution, corrupt state files, disk fill simulation (TDD 8.4 -- Phase 3 scope, but basic cases should be validated here).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Test output parsing is fragile across different test frameworks | High | Medium -- attribution fails for unsupported frameworks | Start with jest/vitest format; add pluggable parsers; fall back to "unknown track" when parsing fails |
| Crash recovery produces different results than original run (non-determinism) | Medium | High -- user confusion, potential data loss | Extensive idempotency testing; log all recovery decisions; human review option for recovered runs |
| Stall detection false positives during legitimate long-running operations | Medium | Medium -- unnecessary agent termination | Allow agents to emit heartbeats; extend timeout for known long operations (e.g., dependency install) |
| ETA calculation wildly inaccurate for heterogeneous track complexities | Medium | Low -- user annoyance, not correctness issue | Use per-complexity-class averages rather than global average; show confidence band |
| Race condition: engine crash during state write creates corrupt state file | Low | High -- cannot recover | Atomic write (tmp + rename) prevents partial writes; validate state on load; keep last known good backup |
| Integration test runner interferes with developer's working copy | Medium | Medium | Run in dedicated worktree (TQ-7); never operate on main checkout |

## Definition of Done

- [ ] Event bus supports all event types from TDD Appendix B with logging and async handlers
- [ ] Track state machine enforces valid transitions with timestamp recording and event emission
- [ ] Stall detection alerts at configured timeout and terminates at 2x timeout
- [ ] Progress reporting provides accurate per-track and request-level status with ETA
- [ ] Integration test runner executes test suite on integration branch and captures output
- [ ] Failure attribution maps failing tests to responsible tracks via git log/blame
- [ ] Revision loop re-executes responsible tracks with failure context, respects max revision cycles
- [ ] Crash recovery resumes in-flight requests from persisted state without duplicate work
- [ ] Recovery is idempotent and handles all track status values per TDD 3.9.2
- [ ] Circuit breakers (disk pressure, revision loop, integration test) trigger and escalate correctly
- [ ] Engine orchestrator runs the complete fan-out/merge-back pipeline end-to-end
- [ ] All 8 TDD integration test scenarios pass
- [ ] All unit, integration, and property-based tests pass
