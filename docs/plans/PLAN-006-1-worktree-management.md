# PLAN-006-1: Worktree Lifecycle Management

## Metadata
- **Parent TDD**: TDD-006-parallel-execution
- **Estimated effort**: 4 days
- **Dependencies**: None (foundational layer)
- **Blocked by**: None
- **Priority**: P0

## Objective

Implement the git worktree lifecycle management layer that all other parallel execution components depend on. This includes creating, monitoring, and cleaning up git worktrees and their associated branches, enforcing naming conventions, managing disk usage thresholds, and persisting execution state to disk with atomic writes for crash recovery.

## Scope

### In Scope
- Directory layout under `.worktrees/` with request and track subdirectories (TDD 3.1.1)
- Branch naming strategy with `auto/` prefix for integration and track branches (TDD 3.1.2)
- Worktree creation with precondition checks (concurrency limit, disk limit, integration branch existence) (TDD 3.1.3)
- Worktree health monitoring: disk usage, git health, link validity (TDD 3.1.4)
- Normal cleanup (post-merge), force cleanup (crash/cancel), and full request cleanup (TDD 3.1.5)
- Naming validation regex (`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`)
- State persistence with atomic write-to-temp-then-rename (TDD 3.9.1)
- `.gitignore` management to exclude `.worktrees/` and `.autonomous-dev/state/`
- Configuration parameters: `parallel.max_worktrees`, `parallel.disk_warning_threshold_gb`, `parallel.disk_hard_limit_gb`, `parallel.worktree_cleanup_delay_seconds`, `parallel.worktree_root`, `parallel.state_dir`, `parallel.base_branch`
- Event emission stubs for `worktree.created`, `worktree.removed`, `worktree.disk_warning`, `worktree.disk_critical`

### Out of Scope
- DAG construction and cluster scheduling (PLAN-006-2)
- Agent spawning and filesystem isolation hooks (PLAN-006-3)
- Merge-back operations (PLAN-006-4)
- Integration test runner and progress tracking (PLAN-006-5)
- Shallow/sparse worktree optimization for large repos (Phase 3 feature per TDD Section 10)

## Tasks

1. **Define WorktreeManager interface and configuration types** -- Create the TypeScript interfaces for `WorktreeInfo`, `PersistedExecutionState` (partial, worktree fields), and the configuration schema for all `parallel.*` worktree-related parameters.
   - Files to create/modify:
     - `src/parallel/types.ts` (new -- shared types for the parallel execution engine)
     - `src/parallel/config.ts` (new -- configuration loading and validation)
   - Acceptance criteria:
     - All interfaces from TDD Sections 3.1, 3.9.1, 4.4 are defined
     - Configuration defaults match Appendix A values
     - Config validation rejects invalid values (negative limits, non-existent paths)
   - Estimated effort: 3 hours

2. **Implement naming validation and path utilities** -- Build utility functions for validating request IDs and track names against the naming regex, slugifying spec names, constructing branch names (`auto/{requestId}/integration`, `auto/{requestId}/{trackName}`), and resolving worktree filesystem paths.
   - Files to create/modify:
     - `src/parallel/naming.ts` (new)
   - Acceptance criteria:
     - Validates names against `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`
     - Slugify converts arbitrary spec names to valid track names
     - Branch path construction follows TDD 3.1.2 patterns
     - Rejects names that would cause filesystem issues (reserved names, excessively long)
   - Estimated effort: 2 hours

3. **Implement WorktreeManager core: create, list, remove** -- Build the core worktree management functions that wrap `git worktree add`, `git worktree list`, and `git worktree remove` with error handling.
   - Files to create/modify:
     - `src/parallel/worktree-manager.ts` (new)
   - Acceptance criteria:
     - `createIntegrationBranch(requestId, baseBranch)` creates the integration branch from the base branch
     - `createTrackWorktree(requestId, trackName)` creates the track branch from integration and adds the worktree
     - `listWorktrees(requestId?)` returns all active worktrees, optionally filtered by request
     - `removeWorktree(requestId, trackName, force?)` removes the worktree and deletes the track branch
     - `cleanupRequest(requestId)` removes all worktrees and branches for a request
     - All git commands follow the exact sequences in TDD Sections 3.1.3, 3.1.5, 5.1-5.2, 5.6-5.7
     - Precondition checks enforce `max_worktrees` and `disk_hard_limit`
     - All operations are idempotent (re-running create on an existing worktree is a no-op)
   - Estimated effort: 6 hours

4. **Implement disk usage monitoring** -- Build monitoring that periodically checks aggregate worktree disk usage and emits warning/critical events.
   - Files to create/modify:
     - `src/parallel/worktree-manager.ts` (modify -- add monitoring methods)
     - `src/parallel/events.ts` (new -- event type definitions and emission stubs)
   - Acceptance criteria:
     - `checkDiskUsage()` runs `du -sb` on worktree directories and returns aggregate usage
     - Emits `worktree.disk_warning` when usage exceeds `disk_warning_threshold_gb`
     - Emits `worktree.disk_critical` when usage exceeds `disk_hard_limit_gb`
     - `getDiskPressureLevel()` returns `"normal" | "warning" | "critical"` for scheduler consumption
     - Monitoring can run on a configurable interval (default 60 seconds)
   - Estimated effort: 3 hours

5. **Implement worktree health validation** -- Build health checks that verify worktree link validity, git status cleanliness, and branch existence.
   - Files to create/modify:
     - `src/parallel/worktree-manager.ts` (modify -- add health check methods)
   - Acceptance criteria:
     - `validateWorktreeHealth(requestId, trackName)` returns a health report
     - Checks directory existence, `git worktree list` inclusion, branch existence, `git status --porcelain` cleanliness
     - `validateAllWorktrees()` scans all active worktrees and returns aggregate health
     - Detects orphaned worktrees (directory exists but no matching state file)
     - Follows TDD Section 5.8 git command sequences
   - Estimated effort: 3 hours

6. **Implement StatePersister: atomic writes, load, crash detection** -- Build the state persistence layer that writes execution state atomically and supports crash recovery detection on startup.
   - Files to create/modify:
     - `src/parallel/state-persister.ts` (new)
   - Acceptance criteria:
     - `saveState(state)` writes to `.json.tmp` then renames atomically (TDD 3.9.1)
     - `loadState(requestId)` reads and validates the state file, including schema version check
     - `listInFlightRequests()` scans state dir for requests with `phase != "complete" && phase != "failed"`
     - `archiveState(requestId)` moves state to `.autonomous-dev/archive/`
     - Handles corrupt/truncated state files gracefully (logs error, does not crash)
     - State files include `version: 1` for future schema migration
   - Estimated effort: 4 hours

7. **Implement orphaned worktree cleanup on startup** -- Build the startup scan that detects and cleans up orphaned worktrees and stale `auto/` branches from previous crashed runs.
   - Files to create/modify:
     - `src/parallel/worktree-manager.ts` (modify -- add startup cleanup)
   - Acceptance criteria:
     - `cleanupOrphanedWorktrees()` compares `git worktree list` output against active state files
     - Removes worktrees under `.worktrees/` that have no corresponding in-flight state
     - Removes stale `auto/*` branches with no corresponding state file
     - Runs `git worktree prune` to clean dangling references
     - Logs all cleanup actions for auditing
     - Follows TDD Section 3.9.4
   - Estimated effort: 3 hours

8. **Unit and integration tests for WorktreeManager** -- Comprehensive tests covering all worktree operations, edge cases, and failure modes.
   - Files to create/modify:
     - `tests/parallel/worktree-manager.test.ts` (new)
     - `tests/parallel/state-persister.test.ts` (new)
     - `tests/parallel/naming.test.ts` (new)
   - Acceptance criteria:
     - Tests run against a real temporary git repository (not mocked git)
     - Covers: create integration branch, create track worktree, multiple worktrees for same request, cleanup normal/force/full-request, disk monitoring thresholds
     - Tests state persistence roundtrip (serialize/deserialize identity)
     - Tests atomic write (interrupt mid-write, verify old state preserved)
     - Tests orphan detection and cleanup
     - Tests naming validation with valid/invalid inputs
     - Tests precondition enforcement (max worktrees, disk limit)
   - Estimated effort: 6 hours

## Dependencies & Integration Points

- **Downstream**: PLAN-006-2 (DAG/Scheduling) depends on WorktreeManager for slot availability checks and disk pressure levels.
- **Downstream**: PLAN-006-3 (Agent Assignment) depends on WorktreeManager for worktree creation and path resolution.
- **Downstream**: PLAN-006-4 (Merge/Conflicts) depends on WorktreeManager for branch operations and cleanup after merge.
- **Downstream**: PLAN-006-5 (Integration Testing/Progress) depends on StatePersister for state read/write and WorktreeManager for health checks.
- **Event system**: The event emission stubs created here will be consumed by the Progress Tracker (PLAN-006-5).

## Testing Strategy

- **Unit tests**: Naming validation, config parsing, path construction, state serialization.
- **Integration tests**: Full worktree lifecycle in a real git repo -- create, verify, cleanup. Multiple concurrent worktrees. Disk threshold enforcement with artificial constraints.
- **Property-based tests**: State persistence roundtrip (serialize then deserialize produces identical state). Naming slugify produces valid names for arbitrary inputs.
- **Edge cases**: Create worktree when max reached, cleanup when worktree directory already deleted, load state from corrupt file, orphan cleanup when no orphans exist.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `git worktree add` is slow on large repos (TQ-4) | Medium | High -- blocks Phase 1 if > 10s | Benchmark early; if slow, prioritize sparse checkout |
| Git lock file contention when multiple worktrees created simultaneously | Low | Medium | Serialize worktree creation (no parallel `git worktree add` calls) |
| Platform-specific `du` command differences (macOS vs Linux) | Medium | Low | Use Node.js `fs.stat` recursion instead of shell `du` for portability |
| Orphan cleanup accidentally removes developer's manual worktrees | Low | High | Only clean worktrees under the configured `worktree_root` with `auto/` branch prefixes |

## Definition of Done

- [ ] All TypeScript interfaces and types defined matching TDD Sections 3.1, 3.9.1, 4.4, Appendix A
- [ ] WorktreeManager creates, lists, validates, and removes worktrees following TDD git command sequences
- [ ] Branch naming follows `auto/{requestId}/{trackName}` convention with validation
- [ ] Disk monitoring emits warning/critical events at configured thresholds
- [ ] StatePersister writes atomically, loads with version check, detects in-flight requests
- [ ] Orphaned worktree cleanup runs on startup without data loss
- [ ] All unit and integration tests pass
- [ ] No worktree operations leave the repository in a dirty state on failure (cleanup on error)
