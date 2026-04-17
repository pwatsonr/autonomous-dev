# PLAN-002-4: Recovery, Cleanup & Migration

## Metadata
- **Parent TDD**: TDD-002-state-machine
- **Estimated effort**: 3 days
- **Dependencies**: [PLAN-002-1, PLAN-002-2, PLAN-002-3]
- **Blocked by**: [PLAN-002-3]
- **Priority**: P1

## Objective
Deliver the robustness and operational maturity layer for the state machine subsystem: full crash recovery procedures, state file schema migration framework, automated and manual cleanup/archival, orphaned resource detection, split-brain prevention, and integration/chaos testing. This plan takes the functional state machine from PLAN-002-1 through PLAN-002-3 and makes it production-grade -- survivable across crashes, power loss, disk pressure, and schema evolution.

## Scope
### In Scope
- Crash recovery: full startup scan implementing all recovery scenarios from TDD Section 6.1
- Corrupt state detection: JSON parse failure with checkpoint fallback (TDD Section 6.2)
- Orphaned resource detection: orphaned worktrees, lock files with dead PIDs (TDD Section 6.3)
- Stale heartbeat recovery: detect un-exited phase history entries and re-enter with retry semantics (TDD Section 6.4)
- Split-brain prevention: PID-based lock file validation and acquisition (TDD Section 6.5)
- Schema migration framework: version-aware read, sequential migration application, migration function registry (TDD Section 7)
- Migration idempotency guarantees and test fixtures for v1 (TDD Section 7.4)
- Automated cleanup: periodic scan for archivable requests in `monitor` and `cancelled` states (TDD Section 8.1)
- Archive procedure: copy state/events, compress to tarball, delete worktree/branch/directory (TDD Section 8.2)
- Manual cleanup command: `--dry-run`, `--force`, `--request {id}` flags (TDD Section 8.3)
- Disk space accounting and reporting after cleanup (TDD Section 8.4)
- Integration tests: full lifecycle happy path, review failure loops, concurrent request isolation (TDD Section 10.2)
- Chaos tests: kill-and-recover, disk-full simulation, corruption injection (TDD Section 10.4)
- Multi-repo discovery support and performance validation (TDD Section 12, Phase 2)

### Out of Scope
- State File Manager core functions (delivered in PLAN-002-1)
- Event Logger and Request Tracker core functions (delivered in PLAN-002-2)
- Lifecycle Engine transition logic (delivered in PLAN-002-3)
- Agent factory and session spawning (TDD-005)
- Document pipeline (TDD-003)
- Review gate evaluation logic (TDD-004)
- Resource governance / cost tracking (separate TDD)
- Notification system for escalations (separate concern)

## Tasks

1. **Implement startup recovery scan** -- `startup_recovery()` function that runs on supervisor startup. Implements all recovery scenarios from TDD Section 6.1: orphaned `.tmp` files, un-exited phase history entries, corrupt state files, orphaned lock files.
   - Files to create: `lib/state/recovery.sh`
   - Acceptance criteria: (a) Orphaned `.tmp` files are handled per PLAN-002-1 rules. (b) Requests with `exited_at: null` in their current phase history entry are flagged for re-entry on the next supervisor iteration. (c) Corrupt `state.json` triggers checkpoint restoration; if no checkpoint exists, request transitions to `failed`. (d) Recovery scan completes without errors on a clean system (no-op). (e) Events are logged for every recovery action taken.
   - Estimated effort: 4 hours

2. **Implement corrupt state detection with checkpoint fallback** -- Extend `state_read()` from PLAN-002-1 to attempt checkpoint restoration on JSON parse failure. If parse fails, read most recent checkpoint. If checkpoint is also invalid, transition to `failed`.
   - Files to modify: `lib/state/state_file_manager.sh`
   - Acceptance criteria: (a) Corrupt `state.json` with valid checkpoint: checkpoint is restored, warning logged. (b) Corrupt `state.json` with no checkpoints: request transitions to `failed` with `state_corruption` reason. (c) Corrupt `state.json` with corrupt checkpoint: request transitions to `failed`, both files moved to `corrupt/` directory. (d) Valid `state.json` is unaffected by this logic.
   - Estimated effort: 3 hours

3. **Implement orphaned resource detection** -- `detect_orphaned_resources()` scans for: orphaned worktree directories without corresponding active requests, lock files whose PID is not running.
   - Files to modify: `lib/state/recovery.sh`
   - Acceptance criteria: (a) Orphaned worktrees are logged as warnings (not auto-deleted per TDD Section 6.3). (b) Lock files with dead PIDs are released (deleted). (c) Lock files with live PIDs are left alone. (d) Corrupt lock files (not a valid PID) are deleted.
   - Estimated effort: 2 hours

4. **Implement stale heartbeat recovery** -- On startup, detect stale heartbeat (timestamp older than expected interval). Scan for requests with un-exited phases and prepare them for re-entry.
   - Files to modify: `lib/state/recovery.sh`
   - Acceptance criteria: (a) Stale heartbeat is detected when last beat is older than 2x the poll interval. (b) Requests with `exited_at: null` in current phase are identified. (c) Log message includes last heartbeat timestamp and list of affected requests. (d) Affected requests are not modified -- they are simply flagged for the supervisor to re-enter on the next iteration.
   - Estimated effort: 2 hours

5. **Implement split-brain prevention** -- `acquire_lock()` and `release_lock()` functions for the daemon lock file at `~/.autonomous-dev/daemon.lock`. PID-based validation per TDD Section 6.5.
   - Files to create: `lib/state/lock_manager.sh`
   - Acceptance criteria: (a) Lock file contains the current PID. (b) If lock exists with a live PID, `acquire_lock()` fails with descriptive error. (c) If lock exists with a dead PID, lock is stolen with warning. (d) `release_lock()` removes the lock file. (e) Lock is released on normal shutdown and on SIGTERM/SIGINT via trap.
   - Estimated effort: 2 hours

6. **Implement schema migration framework** -- `migrate_state()` function that detects `schema_version`, applies sequential migrations from a registry, and writes the migrated state atomically. Includes the migration function registry pattern from TDD Section 7.3.
   - Files to create: `lib/state/migration.sh`
   - Acceptance criteria: (a) State with `schema_version == CURRENT_VERSION` passes through unchanged. (b) State with `schema_version < CURRENT_VERSION` has all intermediate migrations applied sequentially. (c) State with `schema_version > CURRENT_VERSION` is rejected with error ("upgrade the plugin"). (d) Migrated state is written atomically. (e) `state_migrated` event is logged with `from_version` and `to_version`. (f) Migrations are idempotent: applying twice produces the same result.
   - Estimated effort: 3 hours

7. **Create v1 test fixtures and migration test infrastructure** -- Fixture state files representing v1 schema in various lifecycle positions. Infrastructure for testing future v1->v2 migrations when v2 is defined.
   - Files to create: `tests/fixtures/state_v1_intake.json`, `tests/fixtures/state_v1_prd_review.json`, `tests/fixtures/state_v1_failed.json`, `tests/fixtures/state_v1_complete.json`
   - Acceptance criteria: (a) Each fixture passes v1 schema validation. (b) Fixtures cover key lifecycle positions: intake, mid-pipeline (prd_review), failed, and complete (monitor). (c) Test infrastructure can load a fixture, apply a hypothetical migration function, and validate the result.
   - Estimated effort: 2 hours

8. **Implement automated cleanup** -- `automated_cleanup()` function that runs every Nth supervisor iteration. Archives requests in `monitor` past retention period and `cancelled` requests past 7 days.
   - Files to create: `lib/state/cleanup.sh`
   - Acceptance criteria: (a) Requests in `monitor` longer than `cleanup_retention_days` config are archived. (b) Requests in `cancelled` longer than 7 days are archived. (c) Active requests are never touched. (d) Cleanup frequency is configurable (default: every 100 iterations). (e) Cleanup is idempotent: running twice produces the same result.
   - Estimated effort: 3 hours

9. **Implement archive procedure** -- `archive_request()` per TDD Section 8.2: copy state/events to `~/.autonomous-dev/archive/{request_id}/`, compress to tarball, remove worktree, optionally delete remote branch, remove request directory, log to `archive.log`.
   - Files to modify: `lib/state/cleanup.sh`
   - Acceptance criteria: (a) Archive tarball is created at `~/.autonomous-dev/archive/{request_id}.tar.gz`. (b) Tarball contains `state.json` and `events.jsonl`. (c) Git worktree is removed if it exists. (d) Remote branch deletion is configurable (off by default). (e) Request directory is removed after successful archival. (f) Entry is appended to `archive.log`. (g) If any step fails, the process stops and logs the error without removing the request directory (safe partial failure).
   - Estimated effort: 3 hours

10. **Implement manual cleanup command interface** -- Functions supporting the `autonomous-dev cleanup` command: `--dry-run` (list without acting), `--force` (ignore retention), `--request {id}` (archive specific request, must be terminal).
    - Files to modify: `lib/state/cleanup.sh`
    - Acceptance criteria: (a) `--dry-run` lists requests that would be archived with their sizes. (b) `--force` archives all terminal requests regardless of age. (c) `--request {id}` archives a specific request only if it is in a terminal state (`cancelled`, `failed`, or `monitor`). (d) Attempting to archive an active request returns error. (e) Disk space accounting is reported per TDD Section 8.4 format.
    - Estimated effort: 2 hours

11. **Integration tests** -- Full lifecycle scenarios from TDD Section 10.2.
    - Files to create: `tests/integration/test_full_lifecycle.sh`
    - Acceptance criteria: Minimum 9 integration tests covering:
      - Full lifecycle happy path: `intake -> monitor` with stub sessions
      - Review failure loop: 3 regressions at `prd_review`, then escalation to `paused`
      - Concurrent request isolation: two requests in different repos advance independently
      - Stale heartbeat recovery: simulate sleep, verify re-entry
      - Schema migration: load v1 fixture with current codebase, verify it loads
      - Cleanup and archival: complete request, wait for retention, verify archive
      - Lock file with dead PID: create lock with non-existent PID, verify steal
      - Dependency blocking: request A blocks request B, B waits, A completes, B unblocks
      - Orphaned `.tmp` recovery: crash during write, verify state integrity
    - Estimated effort: 6 hours

12. **Chaos tests** -- Destructive testing from TDD Section 10.4.
    - Files to create: `tests/chaos/test_crash_recovery.sh`
    - Acceptance criteria: (a) Kill supervisor at random points in iteration loop (via `kill -9`), verify no state corruption after 100 iterations. (b) Simulate disk-full during state write (`dd` to fill tmpfs), verify `.tmp` left and `state.json` intact. (c) Corrupt `state.json` with random bytes, verify detection and `failed` transition. (d) Truncate `events.jsonl` at random byte offset, verify torn-write recovery.
    - Estimated effort: 4 hours

13. **Multi-repo discovery and performance validation** -- Verify `discover_requests()` works across multiple repos. Benchmark with 100+ request directories to validate scan time < 1 second.
    - Files to create: `tests/performance/test_discovery_benchmark.sh`
    - Acceptance criteria: (a) Discovery across 10 mock repos with 10 requests each (100 total) completes in < 1 second. (b) Discovery across 10 mock repos with 100 requests each (1000 total) completes in < 5 seconds. (c) State read with schema validation on a single request completes in < 100ms.
    - Estimated effort: 2 hours

## Dependencies & Integration Points
- **Depends on PLAN-002-1**: Uses `state_read()`, `state_write_atomic()`, `state_checkpoint()`, `state_restore_checkpoint()`. Extends `state_read()` with checkpoint fallback.
- **Depends on PLAN-002-2**: Uses `event_append()`, `event_read_all()`, `discover_requests()`, `validate_request_id()`.
- **Depends on PLAN-002-3**: Uses `state_transition()` for error-state transitions during recovery. Uses supervisor interface functions for integration tests.
- **Consumed by TDD-001 (Supervisor Loop)**: The supervisor calls `startup_recovery()` on startup, `acquire_lock()`/`release_lock()` for daemon lifecycle, `automated_cleanup()` periodically, and `migrate_state()` on state reads.
- **Consumed by CLI commands**: The `cleanup` command calls `manual_cleanup()` with the appropriate flags.

## Testing Strategy
- Integration tests use temporary directories with a full simulated environment: multiple repos, multiple requests at various lifecycle stages, pre-populated state files and event logs.
- Chaos tests run in an isolated tmpfs to enable disk-full simulation without affecting the real filesystem.
- Performance tests use `time` and bash `$SECONDS` to measure execution duration. They create large numbers of mock request directories with minimal state files.
- All recovery scenarios from TDD Section 6.1 have a dedicated test that sets up the crash condition and verifies the recovery outcome.
- Migration tests use the v1 fixtures and verify that the migration framework correctly handles version-matching, upgrade, and reject-newer-version scenarios.

## Risks
1. **Chaos test flakiness.** Kill-based tests and disk-full simulations are inherently environment-sensitive. Mitigation: run chaos tests in isolated containers (or skip in CI with a `--skip-chaos` flag). Document the expected environment.
2. **Git worktree removal edge cases.** `git worktree remove --force` can fail if the worktree has uncommitted changes or is in a detached HEAD state. Mitigation: log warnings on failure and continue archival without worktree removal. The orphaned worktree will be detected on the next startup scan.
3. **Migration framework over-engineering.** With only v1 defined, the migration framework is speculative infrastructure. Mitigation: implement the minimum viable framework (version check, sequential apply, registry pattern) without writing actual migrations. The framework proves itself when v2 is needed.
4. **Archive tarball disk usage.** If many requests are archived, the `~/.autonomous-dev/archive/` directory could grow. Mitigation: document recommended periodic cleanup of old archives. Consider adding archive age-based pruning in a future plan.
5. **Performance test reliability.** Filesystem performance varies by hardware and load. Mitigation: use relative thresholds (e.g., "< 5x the single-request time for 100 requests") rather than absolute ms values for assertions in CI. Keep absolute thresholds for local developer validation.

## Definition of Done
- [ ] `startup_recovery()` handles all crash scenarios from TDD Section 6.1
- [ ] Corrupt state detection falls back to checkpoints, or transitions to `failed` when no valid checkpoint exists
- [ ] Orphaned worktrees are detected and logged; orphaned lock files with dead PIDs are released
- [ ] Stale heartbeat recovery identifies requests with un-exited phases
- [ ] Lock manager acquires, validates, steals, and releases the daemon lock correctly
- [ ] Schema migration framework applies sequential migrations and rejects newer versions
- [ ] v1 test fixtures pass validation and migration test infrastructure is functional
- [ ] Automated cleanup archives eligible requests on schedule
- [ ] Archive procedure creates tarball, removes worktree/directory, and logs to archive.log
- [ ] Manual cleanup supports `--dry-run`, `--force`, and `--request {id}` flags
- [ ] Disk space accounting reports space recovered
- [ ] 9+ integration tests pass covering all scenarios from TDD Section 10.2
- [ ] Chaos tests validate crash recovery over 100 iterations
- [ ] Multi-repo discovery benchmarks pass (100 requests < 1s, 1000 requests < 5s)
- [ ] Code reviewed and merged
