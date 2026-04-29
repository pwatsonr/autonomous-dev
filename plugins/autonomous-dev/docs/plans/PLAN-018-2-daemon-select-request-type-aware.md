# PLAN-018-2: Daemon select_request() Type-Aware Phase Progression

## Metadata
- **Parent TDD**: TDD-018-request-types-pipeline-variants
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: [PLAN-018-1]
- **Priority**: P0

## Objective
Update the daemon's request-selection and session-spawning logic so that the supervisor loop honors per-type phase overrides when computing the next actionable state. This plan modifies `bin/supervisor-loop.sh` to consult the v1.1 `phase_overrides` array (instead of hardcoded phase progression), enforces enhanced-phase gates, applies type-specific timeouts, and respects expedited-review flags. It also wires per-type session spawning so that bug-typed requests pass `bug_context` to the TDD-author session and infra-typed requests trigger the additional security/cost gates.

## Scope
### In Scope
- `select_request()` enhancement in `bin/supervisor-loop.sh` per TDD §8.1: read `phase_overrides[]` and `type_config` from state.json, advance to the next non-skipped phase, honor `phaseTimeouts` overrides, apply `maxRetries` from the type config
- Type-aware session spawning per TDD §8.2: when type === 'bug', invoke the TDD-author with `--bug-context-path <state-file>` so the agent reads structured bug context; when type === 'infra', set environment variable `ENHANCED_GATES=security_review,cost_analysis,rollback_plan` consumed by the gate evaluator
- `expedited_reviews` flag propagation: when true, reviewer agents receive `--expedited` flag that lowers iteration count and uses faster scoring rubric (rubric details deferred to PRD-004 reviewer config; this plan only passes the flag)
- Additional-gate enforcement: when `type_config.additionalGates` includes a gate name, the daemon refuses to advance past the relevant phase until that gate has produced an artifact in `<state-dir>/gates/<gate-name>.json`
- Phase-timeout enforcement: when `type_config.phaseTimeouts[phase]` is set, the supervisor uses that value instead of the global default; on timeout, the request is paused and an escalation is raised
- Backward compatibility: a v1.0 state without `phase_overrides` falls back to the legacy phase sequence (the migration in PLAN-018-1 should already have populated it, but the daemon defends against partial migration)
- Bash unit tests via `bats` covering: phase advancement for each of the five types, skipped-phase behavior, timeout override, additional-gate enforcement
- Integration test that submits a bug-typed request and verifies the daemon skips PRD/PRD-review entirely

### Out of Scope
- The `RequestType` enum and matrix definitions -- delivered by PLAN-018-1
- Bug intake schema validation and CLI surface -- PLAN-018-3
- TDD-author agent prompt that processes `bug_context` -- PLAN-018-3
- Reviewer agent rubric changes for expedited mode -- separate PRD-004 reviewer-config update
- Gate evaluator implementation (security_review, cost_analysis, rollback_plan) -- the daemon enforces presence of gate artifacts; the gates themselves live in agent code
- Hook system that might also customize phase progression -- TDD-019 / PLAN-019-*

## Tasks

1. **Update `select_request()` to read `phase_overrides[]`** -- Modify `bin/supervisor-loop.sh` so the function reads the `phase_overrides` array from state.json via `jq`, finds the current phase index, and returns the next phase. If `phase_overrides` is absent (defensive), fall back to the legacy 14-phase sequence and log a warning.
   - Files to modify: `plugins/autonomous-dev/bin/supervisor-loop.sh`
   - Acceptance criteria: For a state with `phase_overrides: [...]` excluding `prd`, the function advances from `intake` to `tdd` directly. For a v1.0-style state, the function advances `intake` → `prd` (legacy). Shellcheck passes. Logs a warning when the fallback path is taken (so operators notice unmigrated files).
   - Estimated effort: 3h

2. **Implement enhanced-phase recognition** -- Add a helper `is_enhanced_phase()` that consults `type_config.enhancedPhases` from state.json and returns 0/1. Use this in the existing review/score evaluators to apply stricter thresholds (the score-evaluator already supports a "strict" mode; this plan wires the flag).
   - Files to modify: `plugins/autonomous-dev/bin/supervisor-loop.sh`, `plugins/autonomous-dev/bin/score-evaluator.sh` (or wherever review-gate scoring lives)
   - Acceptance criteria: For an `infra`-typed request entering the `tdd_review` phase, scoring is invoked with `--strict-mode`. For a `feature`-typed request, no flag is added. Snapshot test of the spawned process command-line confirms the flag is present/absent per type.
   - Estimated effort: 2h

3. **Implement timeout overrides** -- Modify the phase-timeout lookup to first consult `type_config.phaseTimeouts[phase]`, then fall back to the global default from `~/.claude/autonomous-dev.json`. On timeout, raise an escalation with a message that names the type and configured timeout.
   - Files to modify: `plugins/autonomous-dev/bin/supervisor-loop.sh`
   - Acceptance criteria: For a `hotfix`-typed request in the `code` phase, the timeout is 30 minutes (per the matrix); for a `feature`-typed request, the timeout is the global default. A bats test simulates a phase that exceeds the timeout and verifies the escalation message includes both the type and the timeout value.
   - Estimated effort: 2h

4. **Implement additional-gate enforcement** -- Before advancing past a phase that has an additional gate listed in `type_config.additionalGates`, check for the gate artifact at `<state-dir>/gates/<gate-name>.json`. If absent, the request stays in the current phase with a status reason like "awaiting gate: security_review". The gate artifacts are produced by external agents/processes; this plan only enforces presence.
   - Files to modify: `plugins/autonomous-dev/bin/supervisor-loop.sh`
   - Acceptance criteria: For an `infra`-typed request in `tdd_review`, the daemon does not advance to `plan` until `gates/security_review.json` exists. The `status_reason` field in state.json is updated to reflect what gate is being awaited. Manually creating the gate artifact unblocks advancement.
   - Estimated effort: 3h

5. **Implement type-aware session spawning** -- Update the session-spawning helper (likely `bin/spawn-session.sh` or inline in supervisor-loop) so that `type === 'bug'` adds `--bug-context-path <state-file>` to the agent invocation. For `type === 'infra'`, export `ENHANCED_GATES` env var. For `expedited_reviews === true`, pass `--expedited` to reviewer agents.
   - Files to modify: `plugins/autonomous-dev/bin/spawn-session.sh` (locate via grep), `plugins/autonomous-dev/bin/supervisor-loop.sh`
   - Acceptance criteria: A bug-typed request in `tdd` phase spawns the tdd-author with the `--bug-context-path` flag. An infra-typed request in `tdd` phase spawns with `ENHANCED_GATES` exported in the environment. A bug-typed request entering `tdd_review` spawns the reviewer with `--expedited`. Snapshot tests of the spawned commands lock in the contract.
   - Estimated effort: 3h

6. **Implement maxRetries enforcement** -- The supervisor's existing retry logic uses a global default (typically 3). Update it to read `type_config.maxRetries` per request. After exhausting retries, raise an escalation noting the type and configured limit.
   - Files to modify: `plugins/autonomous-dev/bin/supervisor-loop.sh`
   - Acceptance criteria: For a `bug`-typed request, retries up to 5 times before escalating. For `infra`, only 2 retries. For `feature`, the global default of 3. Bats test simulates a phase that fails repeatedly and verifies the escalation fires after the type-specific count.
   - Estimated effort: 2h

7. **Bats unit tests for selection logic** -- Create `tests/bats/test_select_request_typed.bats` with one scenario per request type covering: phase advancement, skipped-phase behavior, timeout override, additional-gate awaiting, retry limit. Use a fixture state file per type under `tests/fixtures/state/typed/`.
   - Files to create: `plugins/autonomous-dev/tests/bats/test_select_request_typed.bats`, `plugins/autonomous-dev/tests/fixtures/state/typed/{feature,bug,infra,refactor,hotfix}.json`
   - Acceptance criteria: All five scenarios pass. Each fixture is a complete v1.1 state with the right `phase_overrides` and `type_config` for its type. Tests run in <30s total.
   - Estimated effort: 3h

8. **Integration test: bug-typed end-to-end** -- Create `tests/integration/test-bug-request-skips-prd.bats` that submits a bug-typed request via the CLI (assumes PLAN-018-3 wires the `--type bug` flag; this test mocks the CLI submission by writing a v1.1 state directly), runs one supervisor iteration, and verifies the daemon advanced from `intake` to `tdd` (not `prd`).
   - Files to create: `plugins/autonomous-dev/tests/integration/test-bug-request-skips-prd.bats`
   - Acceptance criteria: After one supervisor iteration on a bug-typed `intake` state, the state is in `tdd` (or `tdd_review` if the iteration was fast). Manually inspect logs to confirm no PRD-author session was spawned. The `phase_history` array contains exactly one transition: `intake → tdd`.
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- The `phase_overrides[]` and `type_config` reading pattern reused by any future plan that adds a new pipeline variant.
- The `--bug-context-path` agent flag consumed by PLAN-018-3's TDD-author extension.
- The `ENHANCED_GATES` environment variable consumed by future gate-evaluator implementations.
- The gate-artifact convention (`<state-dir>/gates/<name>.json`) for future plugin/hook authors who add new gates.

**Consumes from other plans:**
- **PLAN-018-1** (blocking): `RequestType` enum, `PHASE_OVERRIDE_MATRIX`, `phase_overrides` field in state.json. Without v1.1 state files, this plan has nothing to read.
- TDD-001 / PLAN-001-2: existing `select_request()` in `supervisor-loop.sh` and the loop engine that calls it.
- TDD-002 / PLAN-002-3: existing lifecycle engine that handles phase transitions.
- TDD-009: escalation routing for raising timeouts and retry-exhaustion alerts.

## Testing Strategy

- **Bats unit tests (task 7):** Five-scenario coverage of selection logic per type. Fixtures under `tests/fixtures/state/typed/`.
- **Integration test (task 8):** Bug-typed request end-to-end through one supervisor iteration.
- **Shellcheck on all modified scripts:** The CI baseline from PLAN-016-2 catches regressions.
- **Snapshot tests for spawned commands:** Capture the actual `claude` CLI invocation (or whatever process the spawn helper invokes) per type and lock in the contract. Updating the snapshot requires explicit reviewer approval.
- **Manual smoke:** Submit a bug-typed request via CLI (after PLAN-018-3 lands) and watch the daemon log to confirm PRD is skipped.
- **No mocking of state I/O:** Tests use real state files in temp dirs.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Existing v1.0 state files in production daemons aren't migrated before this plan ships, breaking selection | High | High -- daemon refuses to advance | The defensive fallback in task 1 handles this. The migration script from PLAN-018-1 should be run as part of the upgrade procedure. Document this in the deploy README. |
| The gate-artifact convention (`gates/<name>.json`) isn't established yet, so infra requests block forever waiting for `security_review.json` | Medium | High -- infra requests stuck in tdd_review | Initial release ships with stub gate-evaluator scripts at `bin/gates/security_review.sh` etc. that emit a "passed" artifact when run. Operators replace with real implementations later. Stubs are documented as such in the plan acceptance criteria. |
| Type-aware spawning passes flags that downstream agents don't understand (e.g., `--bug-context-path` to a tdd-author that hasn't been updated yet) | Medium | High -- agent crashes on unknown flag | PLAN-018-3 ships the agent prompt update in the same release as this plan. Coordination is enforced by both plans listing each other in dependencies. |
| Timeout overrides interact badly with the supervisor's existing heartbeat/circuit-breaker logic | Low | Medium -- false circuit breaker trips | Phase timeouts are evaluated separately from the supervisor heartbeat. Bats test simulates a 5-minute timeout and verifies the heartbeat continues firing during the wait. |
| `expedited_reviews` flag isn't honored by the reviewer agents (which haven't been updated to read it) | High | Low -- expedited flag is a no-op for the first release | The flag is documented as "advisory" in this plan; reviewer agents will be updated in a follow-up coordinated with PRD-004. The behavior degrades gracefully (full review runs instead of expedited) — never breaks. |
| Snapshot tests for spawned commands fail intermittently due to non-deterministic env-var ordering | Low | Low -- noisy CI | Sort env vars before snapshotting. The test serializer canonicalizes the command line. |

## Definition of Done

- [ ] `select_request()` reads `phase_overrides[]` from v1.1 state files and advances correctly per type
- [ ] Defensive fallback handles v1.0 / partially migrated state files with a clear warning
- [ ] Phase timeouts honor `type_config.phaseTimeouts[phase]` overrides
- [ ] `maxRetries` enforcement is per-type and emits escalation messages naming the type
- [ ] Additional gates block advancement until the corresponding `gates/<name>.json` artifact exists
- [ ] `--bug-context-path`, `ENHANCED_GATES`, and `--expedited` are propagated to spawned sessions per the matrix
- [ ] Stub gate-evaluator scripts exist for `security_review`, `cost_analysis`, `rollback_plan`
- [ ] Bats tests cover all five request types
- [ ] Integration test demonstrates a bug-typed request skipping PRD/PRD-review end-to-end
- [ ] Shellcheck passes on all modified bash scripts
- [ ] No regressions in feature-typed request handling (existing tests still pass)
