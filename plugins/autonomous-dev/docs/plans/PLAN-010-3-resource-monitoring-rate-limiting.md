# PLAN-010-3: Resource Monitoring & Rate Limiting

## Metadata
- **Parent TDD**: TDD-010-config-governance
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-010-1-layered-config-system]
- **Blocked by**: [PLAN-010-1-layered-config-system] (reads resource thresholds and governance fields from effective config)
- **Priority**: P1

## Objective

Implement the `ResourceMonitor` component described in TDD-010 Sections 3.5 and 3.6. This plan delivers disk usage monitoring with warning and hard-limit thresholds, worktree count tracking, active session counting, the API rate-limit detection and exponential backoff state machine, and repository allowlist validation. Together these subsystems ensure the daemon never exceeds resource constraints, backs off gracefully from API rate limits, and operates only on explicitly permitted repositories.

## Scope

### In Scope
- Disk usage monitoring: system-wide (`governance.disk_usage_limit_gb` on `~/.autonomous-dev/`) and worktree-specific (`parallel.disk_warning_threshold_gb`, `parallel.disk_hard_limit_gb`) (Section 3.6.1)
- Cross-platform disk measurement (`du -sb` on Linux, `du -sk` on macOS with conversion) (Section 3.6.1)
- Worktree count monitoring via `git worktree list --porcelain` across all allowlisted repos (Section 3.6.2)
- Active session count by scanning request state files for non-terminal status with live PID verification via `kill -0` (Section 3.6.3)
- API rate-limit detection from Claude Code error output (HTTP 429 / rate-limit text) (Section 3.6.4)
- Exponential backoff state machine: base, 2x, 4x, 8x, 16x, then pause and escalate (Section 3.6.4)
- Rate-limit state file at `~/.autonomous-dev/rate-limit-state.json` (Section 4.3)
- Global rate-limit scope: all requests pause when any request hits a rate limit (Section 8.5)
- Rate-limit state clearing after a successful session completes without rate limit
- Repository allowlist validation: exact-match, symlink resolution, `.git` directory check (Section 3.5)
- Per-repository config overrides: merge repo-specific overrides into the config precedence chain (Section 3.5.3)
- `ResourceMonitor.check_resources()` composite function: disk + worktree + session + rate-limit checks
- Error handling for all resource monitor failures (Section 5.3)
- Unit and integration tests for all monitoring and rate-limit logic

### Out of Scope
- Cost budget checks (PLAN-010-2 -- the `CostGovernor` is a separate component)
- Worktree creation and management (TDD-006 Parallel Execution)
- Worktree cleanup after request completion (PLAN-010-4)
- Plugin hook wiring (functions are built here; hook integration is separate)
- Request queuing logic when resource limits are hit (owned by the supervisor loop / TDD-001)

## Tasks

1. **Implement disk usage monitoring** -- Measure disk usage of `~/.autonomous-dev/` (system-wide) and worktree directories (per-repo). Use `du -sb` on Linux and `du -sk` on macOS. Compare against three thresholds: worktree warning, worktree hard limit, and system-wide hard limit.
   - Files to create: `lib/resource_monitor.sh`
   - Acceptance criteria: Returns structured status with `disk_ok`, `disk_warning`, or `disk_exceeded` per threshold. Handles macOS and Linux `du` differences. Handles `du` failure gracefully (log warning, skip check, do not block work per Section 5.3). Byte-to-GB conversion is accurate.
   - Estimated effort: 4 hours

2. **Implement worktree count monitoring** -- Count active git worktrees across all allowlisted repositories using `git worktree list --porcelain`. Compare against `parallel.max_worktrees`.
   - Files to modify: `lib/resource_monitor.sh`
   - Acceptance criteria: Counts worktrees across all repos in the allowlist. Returns pass/fail against `max_worktrees`. Handles `git worktree list` failure conservatively (assume at max per Section 5.3). Handles repos with no worktrees (count = 0, the main working tree).
   - Estimated effort: 3 hours

3. **Implement active session counting** -- Count active Claude Code sessions by scanning request state files. A request is "active" if its status is not in a terminal set (`completed`, `cancelled`, `failed`) AND its `current_session_pid` is alive (verified via `kill -0`). Compare against `governance.max_concurrent_requests`.
   - Files to modify: `lib/resource_monitor.sh`
   - Acceptance criteria: Correctly identifies active sessions by PID liveness check. Dead PIDs are not counted (stale state detection). Returns pass/fail against `max_concurrent_requests`. Handles missing or malformed state files gracefully.
   - Estimated effort: 3 hours

4. **Implement rate-limit detection** -- Parse Claude Code session output for rate-limit indicators: HTTP 429 status codes, "rate limit" text patterns, and Anthropic API rate-limit error messages. Export a function that takes session output and returns whether a rate limit was detected.
   - Files to create: `lib/rate_limit_handler.sh`
   - Acceptance criteria: Detects HTTP 429 responses in output. Detects "rate limit" / "rate_limit" / "Rate limit exceeded" text variations. Returns boolean (detected / not detected). Does not false-positive on normal output mentioning "rate" in other contexts.
   - Estimated effort: 2 hours

5. **Implement rate-limit backoff state machine** -- On rate-limit detection, compute the next backoff duration using exponential backoff (base * 2^(consecutive-1)), write the rate-limit state file, and return the `retry_at` timestamp. When backoff exceeds `rate_limit_backoff_max_seconds`, activate the kill switch and emit an escalation.
   - Files to modify: `lib/rate_limit_handler.sh`
   - Acceptance criteria: Backoff sequence matches TDD specification: base, base*2, base*4, base*8, base*16, then pause. State file is written atomically (`tmp` + `mv`). State file matches Section 4.3 schema. When max is exceeded, kill switch is set and escalation is emitted. `retry_at` timestamp is accurate.
   - Estimated effort: 4 hours

6. **Implement rate-limit state checking and clearing** -- At the start of each iteration, check the rate-limit state file. If `active` is true and current time is before `retry_at`, skip this iteration (backoff in effect). After a successful session without rate limiting, reset the state to `active: false`, `consecutive_rate_limits: 0`.
   - Files to modify: `lib/rate_limit_handler.sh`
   - Acceptance criteria: Pre-iteration check correctly respects the `retry_at` timestamp. Expired backoffs allow work to proceed. Successful session clears the state. State file is created on first rate-limit event if it does not exist. Corrupted state file is deleted and recreated (per Section 5.3).
   - Estimated effort: 3 hours

7. **Implement repository allowlist validation** -- Validate a repository path against the allowlist: resolve symlinks with `realpath`, check for `.git` directory, compare resolved paths against resolved allowlist entries. Reject non-allowlisted repos.
   - Files to create: `lib/repo_allowlist.sh`
   - Acceptance criteria: Exact match after `realpath` resolution. Symlinks are resolved on both sides. Path must exist on disk. Path must contain `.git/` directory. Non-allowlisted paths are rejected with a clear error message. Empty allowlist rejects everything.
   - Estimated effort: 3 hours

8. **Implement per-repository config overrides** -- When loading config for a specific request, check `repositories.overrides` for a matching repo path. If found, merge the override between project-level config and CLI flags in the precedence chain: CLI > repo override > project > global > defaults.
   - Files to modify: `lib/repo_allowlist.sh`, `lib/config_loader.sh` (from PLAN-010-1)
   - Acceptance criteria: Repo overrides are applied only when the request targets a matching repo. Override values take precedence over project-level but not CLI. Non-matching repos get no override. Overrides are deep-merged (not shallow).
   - Estimated effort: 3 hours

9. **Implement composite `check_resources()` function** -- Orchestrate all resource checks in sequence: disk usage, worktree count, active sessions, rate-limit state. Return a structured `ResourceStatus` with pass/fail and reason for each check. If any check fails, the composite returns non-zero.
   - Files to modify: `lib/resource_monitor.sh`
   - Acceptance criteria: All four checks run in sequence. Each check's result is reported individually. Any single failure causes the composite to fail. The function returns a JSON status object with per-check details. The supervisor loop can use this to decide whether to queue or block.
   - Estimated effort: 2 hours

10. **Implement resource monitor error handling** -- Handle all error cases from TDD-010 Section 5.3: `du` failure (skip check, do not block), rate-limit state file missing (treat as no active limit), rate-limit state corrupted (delete and recreate), `git worktree list` failure (assume max).
    - Files to modify: `lib/resource_monitor.sh`, `lib/rate_limit_handler.sh`
    - Acceptance criteria: Each error scenario is handled as specified. Errors are logged with context. No error case causes the system to crash or hang. Conservative assumptions are used when data is unavailable.
    - Estimated effort: 2 hours

11. **Unit tests for resource monitoring** -- Test disk usage calculation with known values. Test worktree counting with mock `git worktree list` output. Test session counting with mock state files and PID checks. Test rate-limit state machine transitions.
    - Files to create: `test/unit/test_resource_monitor.sh`, `test/unit/test_rate_limit_handler.sh`, `test/unit/test_repo_allowlist.sh`
    - Acceptance criteria: Tests cover: disk under/at/over each threshold, cross-platform `du` handling, worktree count at/over max, session count with live and dead PIDs, rate-limit backoff sequence (all steps including escalation), rate-limit clearing on success, allowlist match and rejection, symlink resolution.
    - Estimated effort: 5 hours

12. **Integration tests for resource monitoring** -- End-to-end tests using temp directories and real filesystem operations. Test disk-limit enforcement with actual file creation. Test rate-limit backoff sequence with simulated state.
    - Files to create: `test/integration/test_resource_monitoring.sh`
    - Acceptance criteria: Test creates files to approach disk limit, verifies warning and hard-limit triggers. Test simulates consecutive rate limits, verifies backoff durations and eventual escalation. Test creates a non-allowlisted repo path, verifies rejection. Clean up all temp artifacts.
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **PLAN-010-1 (Config System)**: Reads `parallel.disk_warning_threshold_gb`, `parallel.disk_hard_limit_gb`, `governance.disk_usage_limit_gb`, `parallel.max_worktrees`, `governance.max_concurrent_requests`, `governance.rate_limit_backoff_base_seconds`, `governance.rate_limit_backoff_max_seconds`, `repositories.allowlist`, `repositories.overrides` from the effective config.
- **Supervisor loop (TDD-001)**: The supervisor loop calls `check_resources()` after `check_budgets()` at the start of each iteration. If resources are exceeded, the loop queues work rather than spawning sessions.
- **Parallel execution (TDD-006)**: Worktree count monitoring informs whether new worktrees can be created. The parallel execution engine should check `check_resources()` before creating worktrees.
- **Escalation system (TDD-009)**: Rate-limit escalation payloads are emitted via `emit_escalation()`. This plan constructs the payload; delivery is owned by TDD-009.
- **Plugin hooks**: The `SessionStart` hook calls `check_resources()`. The `Stop` hook updates session counts and clears rate-limit state on success. Functions are built here; hook wiring is separate.
- **PLAN-010-1 (Config Loader)**: The per-repository override merging (Task 8) requires a minor extension to the config loader from PLAN-010-1.

## Testing Strategy

- **Unit tests**: Pure-function tests for disk measurement parsing, worktree count parsing, PID liveness checking (using controlled test PIDs), rate-limit detection regex, backoff computation, allowlist matching. Use mock data and controlled environments.
- **Integration tests**: Real filesystem tests for disk usage monitoring (create/delete temp files to trigger thresholds). State machine walkthrough for rate-limit backoff (simulate consecutive failures, verify state file contents at each step).
- **Property-based tests**: Rate-limit backoff is monotonically increasing until it exceeds max. Allowlist validation is deterministic (same input always produces same output). Disk check never blocks when `du` fails.
- **Edge case tests**: Empty allowlist, single-entry allowlist, allowlist with symlinks, rate-limit state file with future `retry_at`, worktree list with zero worktrees, active session with a PID that dies between check and spawn.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `du` is slow on very large worktree directories, causing iteration delays | Medium | Medium | Run `du` with a timeout. If it exceeds 5 seconds, skip the check for this iteration and log a warning. Consider caching the result for a configurable number of iterations. |
| PID reuse: `kill -0` succeeds for a PID that belongs to a different process after the original Claude Code session died | Low | Low | PID reuse is unlikely in the short term. The workaround is that the next state check will find the session in a stale state and clean it up. Not a safety issue -- just a brief over-count. |
| Rate-limit detection regex may not cover all Anthropic API error formats | Medium | Medium | Start with known patterns and log unrecognized error output for analysis. Make the regex configurable or at least easy to extend. |
| macOS and Linux `du` output format differences cause parsing bugs | Medium | Medium | Test on both platforms in CI. Use explicit format parsing with `awk` rather than relying on column positions. |
| Global rate-limit scope is overly conservative (one request's rate limit pauses all) | Low | Low | This is a deliberate design choice (TDD-010 Section 8.5). Monitor in practice; if it causes excessive pausing, a per-request scope can be added later. |

## Definition of Done

- [ ] Disk usage monitoring works on both macOS and Linux with correct thresholds
- [ ] Worktree count is tracked across all allowlisted repositories
- [ ] Active session counting uses PID liveness verification
- [ ] Rate-limit detection parses known error patterns from Claude Code output
- [ ] Exponential backoff state machine follows the specified sequence (base through max, then escalate)
- [ ] Rate-limit state file matches Section 4.3 schema and is written atomically
- [ ] Rate-limit state clears after a successful session
- [ ] Repository allowlist validates exact paths with symlink resolution and `.git` check
- [ ] Per-repository config overrides are merged at the correct precedence level
- [ ] Composite `check_resources()` returns structured status with per-check details
- [ ] All error handling from Section 5.3 is implemented (graceful degradation, conservative assumptions)
- [ ] Unit tests pass for all monitoring, rate-limit, and allowlist logic
- [ ] Integration tests demonstrate disk-limit enforcement and rate-limit backoff sequence
- [ ] Allowlist validation is checked at both intake and session spawn (defense in depth)
