# PLAN-001-2: Main Loop Engine

## Metadata
- **Parent TDD**: TDD-001-daemon-engine
- **Estimated effort**: 3 days
- **Dependencies**: [PLAN-001-1-supervisor-core]
- **Blocked by**: [PLAN-001-1]
- **Priority**: P0

## Objective
Deliver the main loop's operational logic: gate checks, request selection, session spawning, session output capture, state updates, cost tracking, and idle backoff. After this plan, the daemon can find work across configured repositories, spawn Claude Code sessions, capture results, update request state, track costs, and back off when idle. Combined with Plan 1, this produces a functional (though not yet resilient) daemon loop.

## Scope
### In Scope
- Kill switch gate check (file existence check for `kill-switch.flag`)
- Cost cap gate check stub (reads cost-ledger.json, compares against configured daily/monthly caps; actual governance integration is out of scope for TDD-001)
- Request selection: scan repository allowlist, find `state.json` files, filter non-actionable states, sort by priority then created_at, return highest-priority actionable request
- Session spawning: checkpoint `state.json`, build `claude` CLI command with `--print --output-format json --max-turns --prompt --project-directory`, spawn as background process, `wait` for exit
- Phase-aware `--max-turns` resolution from config with built-in defaults per phase category
- Phase prompt resolution (stub: reads prompt file path from a convention, returns file contents or a fallback prompt)
- Session output capture: exit code, session cost (parsed from JSON output), turn count
- State update after session: success path (advance state) and error path (mark error, basic retry increment)
- Cost ledger: initialize, read, update with session cost, atomic writes
- Idle backoff: exponential sleep doubling from `poll_interval` up to `idle_backoff_max`, reset on work found
- `--once` mode integration with the full loop (not just the shell from Plan 1)
- Wire all components into the main loop body (replace Plan 1's stub "no work" path)

### Out of Scope
- Circuit breaker gate check -- Plan 3 (Plan 2 adds the `check_gates` call site; the circuit breaker condition is a stub returning "not tripped" until Plan 3 fills it in)
- Crash counter persistence and circuit breaker trip logic -- Plan 3
- Error backoff with `next_retry_after` timestamps -- Plan 3
- Sleep/wake recovery of in-progress sessions -- Plan 3
- State file corruption recovery (checkpoint restore) -- Plan 3
- Log rotation -- Plan 3
- Graceful shutdown child timeout escalation (SIGTERM -> SIGKILL) -- Plan 3
- OS supervisor configuration (launchd/systemd) -- Plan 4
- CLI commands (daemon start/stop/status, kill-switch, circuit-breaker reset) -- Plan 4
- Phase prompt authoring (the actual prompt content for each pipeline phase) -- separate TDD scope

## Tasks

1. **Implement kill switch gate check** -- Check for existence of `$KILL_SWITCH_FILE`. If present, log warning and return 1 (skip iteration).
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With `kill-switch.flag` present, gate check returns 1 and log contains "Kill switch is engaged". Without the file, gate check passes. Gate check does not read file contents (existence only).
   - Estimated effort: 0.5h

2. **Implement cost cap gate check** -- `check_cost_caps()` reads `cost-ledger.json`, sums today's and this month's spend, compares against `daemon.daily_cost_cap_usd` and `daemon.monthly_cost_cap_usd` from effective config. Returns 1 if either cap is exceeded.
   - Files to modify: `bin/supervisor-loop.sh`
   - Files to modify: `config/defaults.json` (add `daily_cost_cap_usd` and `monthly_cost_cap_usd` fields with sensible defaults like 50.00 and 500.00)
   - Acceptance criteria: With a ledger showing $49 today and a $50 daily cap, gate passes. With $51 today, gate fails and log contains "Cost cap reached". With no ledger file, gate passes (assumes zero spend). Ledger parse failure causes gate to fail (safe default per TDD Section 7.4).
   - Estimated effort: 2h

3. **Implement request selection** -- `select_request()` scans repositories from config's `repositories.allowlist[]`, iterates `{repo}/.autonomous-dev/requests/*/state.json` files, filters out non-actionable states (paused, failed, cancelled, monitor), filters out blocked requests (`blocked_by` array is non-empty), sorts by priority (lower = higher priority) then created_at (oldest first), returns `{request_id}|{project_path}` or empty string.
   - Files to modify: `bin/supervisor-loop.sh`
   - Files to modify: `config/defaults.json` (add `repositories` section with empty `allowlist` array)
   - Acceptance criteria: With two requests at priorities 1 and 2, selects priority 1. With two requests at equal priority, selects the one with the earlier `created_at`. Paused, failed, cancelled, and monitor requests are skipped. Requests with non-empty `blocked_by` arrays are skipped. Empty allowlist returns no work. Non-existent repo directories are skipped without error.
   - Estimated effort: 4h

4. **Implement phase-aware max-turns resolution** -- `resolve_max_turns()` takes a phase name, looks it up in `effective_config.daemon.max_turns_by_phase`, falls back to built-in defaults by phase category (intake=10, doc-gen=50, review=30, code=200, integration=100, deploy=30, default=50).
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: `resolve_max_turns "code"` returns 200 (default). With config override `code: 300`, returns 300. `resolve_max_turns "unknown_phase"` returns 50 (fallback). All phase categories from TDD Section 3.6.1 return their documented defaults.
   - Estimated effort: 1.5h

5. **Implement phase prompt resolution** -- `resolve_phase_prompt()` takes status, request_id, and project path. Looks for a prompt file at `{plugin_dir}/phase-prompts/{status}.md`. If found, reads it and performs variable substitution (request_id, project path, state file path). If not found, returns a minimal fallback prompt instructing Claude to read state.json and perform the named phase.
   - Files to modify: `bin/supervisor-loop.sh`
   - Files to create: `phase-prompts/README.md` (placeholder explaining the convention; actual prompts are out of scope)
   - Acceptance criteria: With a `phase-prompts/intake.md` file containing `{{REQUEST_ID}}` and `{{PROJECT}}` placeholders, the resolved prompt has actual values substituted. Without a prompt file for a phase, a sensible fallback prompt is returned that includes the phase name, request ID, and state file path. The fallback prompt instructs Claude to read the state file and perform the phase's work.
   - Estimated effort: 2h

6. **Implement session spawning** -- `spawn_session()` per TDD Section 3.1.1: checkpoint state.json to checkpoint.json, build claude CLI invocation, spawn as background process, capture PID in `CURRENT_CHILD_PID`, `wait` for exit, clear `CURRENT_CHILD_PID`, parse exit code and session cost from output file, return `{exit_code}|{session_cost}|{output_file}`.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: Before spawning, `checkpoint.json` is created as a copy of `state.json`. The `claude` command is invoked with `--print --output-format json --max-turns N --prompt "..." --project-directory "..."`. Exit code is correctly captured even for non-zero exits. `CURRENT_CHILD_PID` is set during execution and cleared after. Session output is written to `logs/session-{id}-{timestamp}.json`.
   - Estimated effort: 4h

7. **Implement state update after session** -- `update_request_state()` handles two paths: (a) success: log success, update state.json's `current_phase_metadata` to reflect completion, append event to `events.jsonl`; (b) error: log error, increment `retry_count` in `current_phase_metadata`, record `last_error`, append error event to `events.jsonl`. All writes use atomic tmp+mv pattern.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: After a successful session, state.json reflects updated metadata and events.jsonl has a new entry with `type: "session_complete"`. After a failed session, retry_count is incremented by 1, last_error contains the exit code, and events.jsonl has an entry with `type: "session_error"`. No partial writes (verified by reading files during a concurrent process).
   - Estimated effort: 3h

8. **Implement cost ledger** -- `initialize_cost_ledger()`, `read_cost_ledger()`, `update_cost_ledger()`. The ledger is a JSON file tracking daily and monthly costs with dated entries. `update_cost_ledger()` adds a session's cost to today's entry and the current month's total. Atomic tmp+mv writes.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: First session creates the ledger with today's date entry. Subsequent sessions accumulate cost. Reading cost for today returns the correct total. Reading cost for the month sums all daily entries in the current month. Ledger survives daemon restart (persisted to disk).
   - Estimated effort: 3h

9. **Implement idle backoff** -- `idle_backoff_sleep()` and `idle_backoff_reset()` per TDD Section 3.1.1. Exponential backoff starting at `poll_interval`, doubling each idle iteration, capping at `idle_backoff_max_seconds`. Reset to base when work is found.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: First idle sleep is `poll_interval` (30s default). Second is 60s. Third is 120s. Capped at 900s. After finding work, next idle sleep is back to 30s. Sleep duration is logged.
   - Estimated effort: 1h

10. **Wire everything into the main loop** -- Replace Plan 1's stub loop body with the real sequence: check_gates -> select_request -> (no work? idle_backoff_sleep) -> (work? idle_backoff_reset, spawn_session, update state, update cost ledger). Integrate `--once` mode break points.
    - Files to modify: `bin/supervisor-loop.sh`
    - Acceptance criteria: With a valid request in an allowlisted repo, the daemon selects it, spawns a Claude session, captures the result, and updates state. With no requests, the daemon idle-sleeps with backoff. With `--once`, exactly one iteration runs. With kill switch engaged, iterations skip work and sleep.
    - Estimated effort: 2h

11. **Write unit and integration tests** -- Unit tests for each new function. Integration tests using `mock-claude.sh` (from TDD Section 9.2) that simulates success, failure, and turns-exhausted behaviors.
    - Files to create: `tests/test_loop_engine.bats`, `tests/mock-claude.sh`
    - Files to modify: `tests/test_helpers.bash` (add shared fixtures for request state files)
    - Acceptance criteria: Unit tests cover: kill switch gate (on/off), cost cap gate (under/over/no ledger/corrupt ledger), request selection (priority sort, tie-breaking, filtering), max-turns resolution (all phase categories, config override), idle backoff (doubling, cap, reset). Integration tests cover: full iteration with mock success, full iteration with mock failure, idle backoff when no requests.
    - Estimated effort: 6h

## Dependencies & Integration Points

**Consumes from Plan 1:**
- `supervisor-loop.sh` skeleton with init phase, logging, lock, heartbeat, config, signal handling
- `config/defaults.json` with daemon configuration fields
- `SHUTDOWN_REQUESTED`, `CURRENT_CHILD_PID`, `ITERATION_COUNT` variables
- `write_heartbeat()`, `log_info/warn/error()` functions

**Exposes to Plan 3:**
- `check_gates()` function with a call site for the circuit breaker condition (currently stubbed as "not tripped")
- `update_request_state()` with retry count tracking that Plan 3 extends with `next_retry_after` backoff timestamps
- `spawn_session()` that Plan 3 extends with graceful shutdown timeout escalation
- `cost-ledger.json` contract that Plan 3's corruption recovery relies on
- `mock-claude.sh` test fixture reused by Plan 3's resilience tests

**Exposes to Plan 4:**
- `cost-ledger.json` read by `daemon status` command
- Request selection logic called by `daemon status` to report active request
- Kill switch file contract (`kill-switch.flag`) written by `kill-switch` CLI command

## Testing Strategy

- **Unit tests (bats):** Each function tested in isolation with controlled inputs. Request selection tested with fixture `state.json` files in temp directories simulating multiple repos and requests.
- **Integration tests (bats + mock-claude):** `mock-claude.sh` placed in PATH before real `claude`. Test scenarios: (1) single request, mock success, verify state updated; (2) single request, mock failure, verify retry count incremented; (3) no requests, verify idle backoff sleep logged; (4) kill switch engaged, verify iteration skipped.
- **Manual smoke test:** Create a test repo with a `.autonomous-dev/requests/REQ-test/state.json`, add repo to allowlist, run `supervisor-loop.sh --once`, verify session was spawned (or mock-spawned) and state was updated.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `claude --print --output-format json` output schema is undocumented or changes between versions | High | High -- cost parsing and turn counting break | Build a parsing wrapper (`parse_session_output()`) with fallback defaults. Log raw output on parse failure. Mark OQ-D1 from TDD as a blocker if the schema cannot be determined empirically before implementation. |
| Request selection scanning many repos with many requests may be slow in pure bash/jq | Low | Medium -- loop iteration latency increases | Profile with 50+ request fixtures. If slow, add early-exit optimization (stop scanning after finding a priority-0 request). |
| Phase prompt variable substitution using `sed` may fail on prompts containing special characters | Medium | Medium -- session receives garbled prompt | Use `envsubst` or a custom substitution function that handles regex-special characters. Test with prompts containing `$`, `/`, `&`, and newlines. |
| Concurrent file access between daemon writing state and user/other tools reading state | Low | Low -- since daemon is single-threaded and writes are atomic | Atomic tmp+mv pattern is sufficient. Document that external tools should handle read-after-partial-write gracefully (re-read on JSON parse error). |

## Definition of Done

- [ ] Kill switch gate check blocks iterations when `kill-switch.flag` exists and passes when absent
- [ ] Cost cap gate check blocks iterations when daily or monthly cap is exceeded
- [ ] Request selection correctly identifies the highest-priority actionable request across multiple repositories
- [ ] `resolve_max_turns()` returns correct values for all documented phase categories, with config override support
- [ ] Session spawning invokes `claude` with the correct flags and captures exit code, cost, and output file
- [ ] Checkpoint is created before every session spawn
- [ ] State update correctly handles success and error paths, writing to both `state.json` and `events.jsonl`
- [ ] Cost ledger tracks per-session costs and provides accurate daily/monthly totals
- [ ] Idle backoff doubles per idle iteration, caps at max, resets when work is found
- [ ] `--once` mode processes exactly one iteration (with or without work) and exits
- [ ] Integration tests with `mock-claude.sh` pass for success, failure, and no-work scenarios
- [ ] All unit tests pass (`bats tests/test_loop_engine.bats`)
- [ ] No shellcheck warnings at `--severity=warning` level
