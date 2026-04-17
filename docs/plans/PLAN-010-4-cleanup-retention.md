# PLAN-010-4: Cleanup Engine & Retention Policies

## Metadata
- **Parent TDD**: TDD-010-config-governance
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-010-1-layered-config-system, PLAN-010-2-cost-tracking-budget, PLAN-010-3-resource-monitoring-rate-limiting]
- **Blocked by**: [PLAN-010-1-layered-config-system] (reads retention and cleanup config), [PLAN-010-2-cost-tracking-budget] (cost ledger rotation depends on cost ledger format)
- **Priority**: P1

## Objective

Implement the `CleanupEngine` component described in TDD-010 Section 3.7. This plan delivers the per-artifact-type retention policy system, the cleanup algorithm that archives and removes aged artifacts, cost ledger monthly rotation, worktree and remote branch cleanup for completed requests, the automatic cleanup trigger in the supervisor loop, and the `autonomous-dev cleanup` CLI command with `--dry-run` support. The goal is to prevent unbounded growth of state files, logs, worktrees, and branches while preserving audit trails via compressed archives.

## Scope

### In Scope
- Per-artifact-type retention calculation for all 10 artifact types from Section 3.7.1 (request state dirs, event logs, cost ledgers, daemon logs, observation reports, observation archives, worktrees, remote branches, archived requests, config validation logs)
- Cleanup algorithm: iterate allowlisted repos, identify aged artifacts, archive or delete per retention policy (Section 3.7.3)
- Archive creation: gzipped tarballs of `state.json` + `events.jsonl` for completed requests (Section 3.7.4)
- Archive storage at `~/.autonomous-dev/archive/` with the naming convention `REQ-{id}.tar.gz`
- Worktree removal for completed/cancelled/failed requests via `git worktree remove`
- Remote branch deletion for completed requests via `git push --delete origin autonomous/REQ-{id}` (when `cleanup.delete_remote_branches` is true)
- Cost ledger monthly rotation: copy previous month's entries to `cost-ledger-YYYY-MM.jsonl`, start new active ledger (Section 3.3.5)
- Archived cost ledger retention: delete monthly archives older than `retention.cost_ledger_months`
- Daemon log rotation: delete daemon logs older than `retention.daemon_log_days`
- Config validation log rotation: delete logs older than `retention.config_validation_log_days`
- Observation report lifecycle: move to `archive/` after `retention.observation_report_days`, delete from archive after `retention.observation_archive_days`
- Archived request tarball deletion after `retention.archive_days`
- Automatic cleanup trigger: run every Nth supervisor-loop iteration (`cleanup.auto_cleanup_interval_iterations`, default 100)
- `autonomous-dev cleanup` CLI command with `--dry-run` flag
- Error handling for cleanup failures: archive creation failure, branch deletion failure, worktree removal failure (Section 5.4)
- Unit and integration tests for retention calculation, archival, and cleanup logic

### Out of Scope
- Worktree creation and lifecycle management during active execution (TDD-006)
- Cost tracking and budget enforcement logic (PLAN-010-2)
- Resource monitoring and rate limiting (PLAN-010-3)
- Hash-chain integrity for event logs (Phase 3 / future)
- Policy for retroactive retention changes (TDD-010 OQ-9; current implementation applies new retention settings to all artifacts regardless of when they were created)
- Compression format alternatives (gzip is the only supported format)

## Tasks

1. **Implement retention age calculation** -- For each artifact type, compute whether the artifact has exceeded its configured retention period. Calculate age in days (or months for cost ledger) from the artifact's `updated_at` (for requests), `created_at` (for observations), or file modification time (for logs).
   - Files to create: `lib/cleanup_engine.sh`
   - Acceptance criteria: Correctly computes age in days/months for all 10 artifact types. Uses `updated_at` from `state.json` for requests (not filesystem mtime). Uses file mtime for log files. Handles timezone correctly (UTC). Returns boolean per artifact: eligible for cleanup or not.
   - Estimated effort: 3 hours

2. **Implement request archival** -- For completed/cancelled/failed requests past retention, create a gzipped tarball containing `state.json` and `events.jsonl`. Store at `~/.autonomous-dev/archive/REQ-{id}.tar.gz`. Do not include working artifacts (generated docs, code snapshots) per PRD-001 FR-701.
   - Files to modify: `lib/cleanup_engine.sh`
   - Acceptance criteria: Archive contains exactly `state.json` and `events.jsonl` (and nothing else). Archive is a valid `.tar.gz` file. Archive naming matches `REQ-{id}.tar.gz`. If archive already exists, skip (idempotent). Archive directory is created if it does not exist. Handles missing `events.jsonl` gracefully (archive contains only `state.json`).
   - Estimated effort: 3 hours

3. **Implement request state directory cleanup** -- After successful archival, delete the request's state directory (`{repo}/.autonomous-dev/requests/{id}/`). Verify archive exists before deleting source.
   - Files to modify: `lib/cleanup_engine.sh`
   - Acceptance criteria: State directory is removed only after archive is confirmed to exist. If archival failed, the state directory is NOT deleted (fail-safe). Handles already-deleted directories gracefully (idempotent).
   - Estimated effort: 2 hours

4. **Implement worktree cleanup for completed requests** -- Remove git worktrees associated with completed/cancelled/failed requests using `git worktree remove`. Respect the `parallel.worktree_cleanup_delay_seconds` delay (do not remove worktrees until the delay has elapsed since completion).
   - Files to modify: `lib/cleanup_engine.sh`
   - Acceptance criteria: Identifies worktrees associated with completed requests. Respects the cleanup delay (worktree is not removed if completion was less than `worktree_cleanup_delay_seconds` ago). Uses `git worktree remove`. Falls back to `git worktree remove --force` if the initial remove fails. Logs error if force removal also fails, flagging for manual intervention. Handles requests that have no worktree.
   - Estimated effort: 3 hours

5. **Implement remote branch cleanup** -- Delete remote branches (`autonomous/REQ-{id}`) for archived requests when `cleanup.delete_remote_branches` is true. Use `git push --delete origin autonomous/REQ-{id}`.
   - Files to modify: `lib/cleanup_engine.sh`
   - Acceptance criteria: Only runs when `cleanup.delete_remote_branches` is `true`. Correctly identifies the branch name from the request ID. Handles branch-not-found (already deleted) gracefully. Logs warning on failure but continues with other cleanup (branch deletion failure is non-critical per Section 5.4).
   - Estimated effort: 2 hours

6. **Implement cost ledger monthly rotation** -- At the start of each month, identify entries from the previous month in the active ledger. Copy them to `~/.autonomous-dev/cost-ledger-YYYY-MM.jsonl`. Start a fresh active ledger with only current-month entries. This runs as part of the cleanup cycle.
   - Files to create: `lib/ledger_rotation.sh`
   - Acceptance criteria: Previous month's entries are copied to the monthly archive file. Active ledger retains only current-month entries. Monthly archive file is named `cost-ledger-YYYY-MM.jsonl` (e.g., `cost-ledger-2026-03.jsonl`). Rotation is idempotent (running twice in the same month does not duplicate entries). Active ledger's last line still has correct `daily_total_usd` and `monthly_total_usd` after rotation.
   - Estimated effort: 4 hours

7. **Implement archived cost ledger pruning** -- Delete monthly cost ledger archives older than `retention.cost_ledger_months`.
   - Files to modify: `lib/ledger_rotation.sh`
   - Acceptance criteria: Archives older than the configured retention are deleted. Archives within retention are preserved. Correctly parses `YYYY-MM` from filenames to determine age. Handles missing archive directory gracefully.
   - Estimated effort: 1 hour

8. **Implement log rotation** -- Rotate daemon logs older than `retention.daemon_log_days` and config validation logs older than `retention.config_validation_log_days`. Rotation means deletion (these are operational logs, not audit trails).
   - Files to modify: `lib/cleanup_engine.sh`
   - Acceptance criteria: Log files older than configured retention are deleted. Current log files are not touched. Handles missing log directories gracefully. Uses file modification time for age calculation.
   - Estimated effort: 2 hours

9. **Implement observation report lifecycle** -- Move observation reports older than `retention.observation_report_days` from the active directory to `archive/`. Delete archived observations older than `retention.observation_archive_days`.
   - Files to modify: `lib/cleanup_engine.sh`
   - Acceptance criteria: Active observations past retention are moved (not copied) to `archive/`. Archived observations past archive retention are deleted. Archive directory is created if it does not exist. Handles concurrent access gracefully (file moved between check and action).
   - Estimated effort: 2 hours

10. **Implement archived request tarball pruning** -- Delete archived request tarballs (`~/.autonomous-dev/archive/REQ-*.tar.gz`) older than `retention.archive_days`.
    - Files to modify: `lib/cleanup_engine.sh`
    - Acceptance criteria: Tarballs older than `retention.archive_days` are deleted. Recent tarballs are preserved. Uses file modification time (set at archival time) for age calculation.
    - Estimated effort: 1 hour

11. **Implement the main cleanup orchestrator** -- Build the top-level `cleanup_run()` function that iterates all allowlisted repos and runs each cleanup sub-task in the order specified by Section 3.7.3: requests, observations, logs, cost ledgers, archives.
    - Files to modify: `lib/cleanup_engine.sh`
    - Acceptance criteria: Iterates all repos in the allowlist. Runs all cleanup sub-tasks for each repo. Collects and reports results (items cleaned, errors encountered). Does not stop on individual item failure (continues to next item). Returns summary statistics.
    - Estimated effort: 3 hours

12. **Implement automatic cleanup trigger** -- Integrate cleanup into the supervisor loop: track iteration count and run cleanup every `cleanup.auto_cleanup_interval_iterations` iterations.
    - Files to create: `lib/cleanup_trigger.sh`
    - Acceptance criteria: Cleanup runs every Nth iteration (default N=100). Counter persists across iterations (not across daemon restarts -- restart resets counter). Cleanup runs at the END of the iteration, after all work is done (per TDD-010 Section 2.2). Does not block the next iteration if cleanup takes longer than the poll interval.
    - Estimated effort: 2 hours

13. **Implement `autonomous-dev cleanup` CLI command** -- Manual cleanup trigger with `--dry-run` flag. Dry-run lists what would be cleaned without taking action. Normal mode runs cleanup immediately and reports results.
    - Files to create: `commands/cleanup.sh`
    - Acceptance criteria: `--dry-run` lists all artifacts eligible for cleanup with their type, path, age, and action (archive/delete/move). Normal mode executes cleanup and prints a summary. Exit code 0 on success, 1 if any cleanup item failed. Human-readable tabular output.
    - Estimated effort: 3 hours

14. **Implement cleanup error handling** -- Handle all error scenarios from TDD-010 Section 5.4: `tar` failure (skip, retry next cycle), `git push --delete` failure (log warning, continue), `git worktree remove` failure (attempt force, flag for manual intervention).
    - Files to modify: `lib/cleanup_engine.sh`
    - Acceptance criteria: Each error type is handled as specified. Error count is tracked and reported in the cleanup summary. No error causes the entire cleanup run to abort. Persistent errors (worktree cannot be removed even with force) are flagged in a well-known location for operator review.
    - Estimated effort: 2 hours

15. **Unit tests for retention and cleanup logic** -- Test retention age calculation for each artifact type. Test archive creation and verification. Test dry-run mode output. Test error handling paths.
    - Files to create: `test/unit/test_cleanup_engine.sh`, `test/unit/test_ledger_rotation.sh`
    - Acceptance criteria: Tests cover: age calculation for each artifact type, archive creation with correct contents, dry-run produces output without side effects, worktree cleanup with delay, remote branch deletion when enabled/disabled, log rotation at boundary, cost ledger rotation at month boundary, archived tarball pruning.
    - Estimated effort: 5 hours

16. **Integration test: end-to-end cleanup of aged artifacts** -- Create a set of test artifacts at various ages, run cleanup, verify correct artifacts are archived/deleted and others are preserved.
    - Files to create: `test/integration/test_cleanup_integration.sh`
    - Acceptance criteria: Test creates request state dirs, event logs, observation reports, and log files with backdated timestamps. Runs cleanup. Verifies: aged requests are archived (tarball exists), state dirs are removed, non-aged items are untouched, dry-run mode does not modify anything. Cleans up all test artifacts.
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **PLAN-010-1 (Config System)**: Reads all `cleanup.*` and `retention.*` config fields, plus `repositories.allowlist` for iterating repos.
- **PLAN-010-2 (Cost Tracking)**: Cost ledger rotation depends on the ledger format defined in PLAN-010-2. The rotation must preserve the JSONL format and the denormalized aggregate fields.
- **PLAN-010-3 (Resource Monitoring)**: Worktree cleanup affects the worktree count that PLAN-010-3 monitors. After cleanup, the worktree count should decrease, potentially unblocking queued work.
- **Supervisor loop (TDD-001)**: The cleanup trigger integrates into the supervisor loop's iteration counter. The loop calls `cleanup_run_if_due()` at the end of each iteration.
- **State machine (TDD-002)**: Cleanup reads `state.json` to determine request status. Only terminal-status requests are eligible for cleanup.
- **Git operations**: Worktree removal and branch deletion are git operations that could fail if the repository is in a locked or corrupted state. Cleanup must handle these failures gracefully.

## Testing Strategy

- **Unit tests**: Pure-function tests for age calculation, archive content verification (inspect tarball contents), retention boundary checks (exactly at boundary, one day before, one day after). Use controlled timestamps and mock filesystems.
- **Integration tests**: Real filesystem tests with temp directories. Create artifacts with backdated timestamps (using `touch -t` or equivalent), run cleanup, verify correct artifacts are affected. Test the full cleanup cycle including cost ledger rotation.
- **Dry-run verification**: Every integration test should first run with `--dry-run` and verify no side effects, then run without `--dry-run` and verify correct side effects.
- **Idempotency tests**: Run cleanup twice on the same state. The second run should be a no-op (no errors, no duplicate archives).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Retroactive retention changes clean up more than expected (TDD-010 OQ-9) | Medium | Medium | Document that new retention settings apply to all existing artifacts. Consider adding a `--since` flag to limit retroactive cleanup in a future iteration. |
| Cost ledger rotation loses entries if it runs mid-write | Low | High | Rotation uses atomic operations: read all lines, filter by month, write to archive, then write current-month lines to new active ledger. The supervisor loop is single-threaded, so concurrent writes should not occur. |
| `git worktree remove` fails on dirty worktrees | Medium | Low | Use `--force` flag on retry. If that also fails, log the error and flag for manual cleanup. Do not block other cleanup operations. |
| Large number of archived tarballs in `~/.autonomous-dev/archive/` degrades `ls`/glob performance | Low | Low | Filesystem limits are typically well above expected request volumes. If needed, add date-based subdirectories in a future iteration. |
| Remote branch deletion fails because the remote is unreachable | Medium | Low | Branch deletion failure is non-critical (logged as warning per Section 5.4). Orphaned remote branches can be cleaned up manually or on the next successful cleanup cycle. |
| `touch -t` for backdating test files behaves differently on macOS vs Linux | Medium | Low | Use `date` to compute correct format strings per platform. Test on both platforms in CI. |

## Definition of Done

- [ ] Retention age is correctly calculated for all 10 artifact types
- [ ] Completed/cancelled/failed requests past retention are archived as `.tar.gz` containing `state.json` + `events.jsonl`
- [ ] Request state directories are deleted only after successful archival
- [ ] Worktree cleanup respects the `worktree_cleanup_delay_seconds` delay
- [ ] Remote branch deletion runs only when `cleanup.delete_remote_branches` is true
- [ ] Cost ledger monthly rotation correctly splits entries by month
- [ ] Archived cost ledgers older than `retention.cost_ledger_months` are deleted
- [ ] Daemon logs and config validation logs are rotated per configured retention
- [ ] Observation reports follow the active -> archive -> delete lifecycle
- [ ] Archived request tarballs are pruned per `retention.archive_days`
- [ ] Cleanup orchestrator iterates all repos and runs all sub-tasks
- [ ] Automatic cleanup triggers every N supervisor-loop iterations
- [ ] `autonomous-dev cleanup` works with and without `--dry-run`
- [ ] All error handling from Section 5.4 is implemented
- [ ] Cleanup is idempotent (running twice produces no errors or duplicate archives)
- [ ] Unit and integration tests pass for all cleanup and retention logic
- [ ] Dry-run mode produces accurate output without side effects
