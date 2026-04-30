# SPEC-018-2-04: Bats Unit Tests and Bug-Typed End-to-End Integration Test

## Metadata
- **Parent Plan**: PLAN-018-2
- **Tasks Covered**: Task 7 (bats unit tests for selection logic), Task 8 (integration test: bug-typed end-to-end skips PRD)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-2-04-bats-tests-and-bug-integration.md`

## Description
Lock in the contracts established by SPEC-018-2-01 through -03 with a comprehensive test suite. Bats unit tests cover all five request types (`feature`, `bug`, `infra`, `refactor`, `hotfix`) across phase advancement, skipped-phase behavior, timeout overrides, additional-gate awaiting, and retry-limit escalation. Five state fixtures (one per type) are stored under `tests/fixtures/state/typed/` and serve as the authoritative reference for what a v1.1 state file looks like for each type. A separate integration test exercises the daemon end-to-end with a bug-typed request, asserting that the supervisor advances directly from `intake` to `tdd` (proving PRD/PRD-review are skipped) and that no PRD-author session was spawned.

This is the final spec in PLAN-018-2; together with the implementation specs it satisfies the plan's Definition of Done.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/bats/test_select_request_typed.bats` | Create | Five-scenario bats suite, one per type |
| `plugins/autonomous-dev/tests/bats/test_typed_limits.bats` | Create | Targeted tests for `resolve_phase_timeout` and `resolve_max_retries` |
| `plugins/autonomous-dev/tests/bats/test_spawn_session_flags.bats` | Create | Snapshot tests for `--bug-context-path`, `ENHANCED_GATES`, `--expedited` |
| `plugins/autonomous-dev/tests/integration/test-bug-request-skips-prd.bats` | Create | End-to-end: one supervisor iteration over a bug state, assert phase transition |
| `plugins/autonomous-dev/tests/fixtures/state/typed/feature.json` | Create | Full v1.1 state, type=feature, 14-phase override |
| `plugins/autonomous-dev/tests/fixtures/state/typed/bug.json` | Create | type=bug, skips prd/prd_review, maxRetries=5, expedited_reviews=true |
| `plugins/autonomous-dev/tests/fixtures/state/typed/infra.json` | Create | type=infra, additionalGates set, enhancedPhases set, maxRetries=2 |
| `plugins/autonomous-dev/tests/fixtures/state/typed/refactor.json` | Create | type=refactor, skips prd, retains tdd/plan/code/test |
| `plugins/autonomous-dev/tests/fixtures/state/typed/hotfix.json` | Create | type=hotfix, phaseTimeouts.code=1800, expedited_reviews=true |
| `plugins/autonomous-dev/tests/fixtures/snapshots/spawn-bug-tdd.txt` | Create | Canonical command-line for bug+tdd spawn |
| `plugins/autonomous-dev/tests/fixtures/snapshots/spawn-infra-tdd.txt` | Create | Canonical command-line for infra+tdd spawn |
| `plugins/autonomous-dev/tests/fixtures/snapshots/spawn-bug-tdd-review.txt` | Create | Canonical command-line for bug+tdd_review (with `--expedited`) |

## Implementation Details

### Fixture Schema

Each fixture under `tests/fixtures/state/typed/` is a complete v1.1 state file. The `bug.json` reference (others vary the relevant fields):

```json
{
  "id": "test-bug-001",
  "type": "bug",
  "expedited_reviews": true,
  "current_phase": "intake",
  "phase_started_at": 1714435200,
  "retry_count": 0,
  "phase_overrides": [
    "intake", "tdd", "tdd_review",
    "plan", "plan_review",
    "code", "code_review",
    "test", "test_review",
    "validate"
  ],
  "type_config": {
    "maxRetries": 5,
    "phaseTimeouts": {},
    "enhancedPhases": [],
    "additionalGates": {}
  },
  "phase_history": [],
  "status_reason": ""
}
```

Variations:
- `feature.json`: `phase_overrides` is the full 14-phase legacy sequence; `type_config` is empty objects/defaults.
- `infra.json`: `enhancedPhases: ["tdd_review", "plan_review"]`, `additionalGates: {"tdd_review": "security_review", "plan_review": "cost_analysis"}`, `maxRetries: 2`.
- `refactor.json`: skips `prd` and `prd_review`; otherwise full sequence; `maxRetries: 3`.
- `hotfix.json`: skips `prd`/`prd_review`; `phaseTimeouts: {"code": 1800}`; `expedited_reviews: true`.

### `test_select_request_typed.bats` Scenario Map

```
@test "feature-typed state advances intake -> prd"
@test "bug-typed state advances intake -> tdd (PRD skipped)"
@test "infra-typed state in tdd_review awaits security_review gate"
@test "infra-typed state in tdd_review advances after gate artifact present"
@test "refactor-typed state advances intake -> tdd"
@test "hotfix-typed state in code phase respects 1800s timeout"
@test "select_request returns empty string at terminal phase"
@test "v1.0 state without phase_overrides falls back to legacy sequence with warning"
```

Each test sources `bin/supervisor-loop.sh` (or extracts the helper functions for direct invocation), copies the relevant fixture into a `BATS_TEST_TMPDIR` so mutations are isolated, manipulates the state as needed, and asserts via `bats-assert`.

### `test_typed_limits.bats` Scenario Map

```
@test "resolve_phase_timeout returns hotfix override (1800)"
@test "resolve_phase_timeout falls back to global default for feature"
@test "resolve_phase_timeout falls back to hardcoded 14400 when global config absent"
@test "resolve_max_retries returns 5 for bug"
@test "resolve_max_retries returns 2 for infra"
@test "resolve_max_retries returns 3 (default) for feature"
@test "resolve_max_retries returns 3 when type_config absent"
@test "timeout escalation message matches contract regex"
@test "retry escalation message matches contract regex"
```

The contract regex from SPEC-018-2-02:

```
Phase '[a-z_]+' (exceeded timeout|exhausted retries) \(.*type=(feature|bug|infra|refactor|hotfix)\)
```

### `test_spawn_session_flags.bats` Snapshot Tests

Each test invokes `spawn_session` with a fixture and a captured-process wrapper that writes the assembled command line to a temp file instead of executing `claude`. The captured output is compared verbatim with `tests/fixtures/snapshots/spawn-*.txt`. Snapshot regeneration is gated behind `BATS_UPDATE_SNAPSHOTS=1`; CI fails on drift.

Snapshot file format (one logical command per line, env vars sorted, paths normalized to `${STATE_DIR}` placeholder):

```
claude --agent tdd-author --bug-context-path ${STATE_DIR}/state.json --state ${STATE_DIR}/state.json
```

For infra:

```
env ENHANCED_GATES=security_review,cost_analysis,rollback_plan claude --agent tdd-author --state ${STATE_DIR}/state.json
```

For bug+tdd_review:

```
claude --agent tdd-reviewer --expedited --state ${STATE_DIR}/state.json
```

### `test-bug-request-skips-prd.bats` Integration Test

```
@test "bug-typed request skips PRD in one supervisor iteration" {
  setup_temp_state_dir              # creates BATS_TEST_TMPDIR/req-001/
  copy_fixture bug.json state.json
  run_supervisor_one_iteration      # invokes supervisor-loop.sh with --once
  assert_state_phase tdd            # current_phase moved from intake to tdd
  assert_phase_history_length 1     # exactly one transition recorded
  assert_phase_history_contains "intake -> tdd"
  refute_log_contains "spawning agent: prd-author"
}
```

`run_supervisor_one_iteration` is a thin wrapper around `bin/supervisor-loop.sh --once <state-dir>` that captures stdout/stderr to a tempfile for the `assert_log` / `refute_log` helpers. The supervisor must support `--once` mode (single iteration then exit); if it does not yet, this test is responsible for adding the flag plumbing as a minimal change scoped to the test harness needs.

## Acceptance Criteria

- [ ] All five fixture state files exist, parse with `jq -e .`, and contain the required v1.1 fields (`type`, `expedited_reviews`, `current_phase`, `phase_started_at`, `retry_count`, `phase_overrides`, `type_config`, `phase_history`, `status_reason`).
- [ ] `test_select_request_typed.bats` contains exactly the eight test cases listed above and all pass against the implementation from SPEC-018-2-01 and -03.
- [ ] `test_typed_limits.bats` contains the nine test cases listed above and all pass against SPEC-018-2-02.
- [ ] `test_spawn_session_flags.bats` contains at least three snapshot tests covering bug+tdd, infra+tdd, and bug+tdd_review combinations; all pass byte-for-byte against the committed snapshots.
- [ ] Snapshot files use `${STATE_DIR}` as a placeholder for absolute paths; the harness substitutes the real path before comparison.
- [ ] `BATS_UPDATE_SNAPSHOTS=1 bats tests/bats/test_spawn_session_flags.bats` regenerates the snapshot files in place and exits 0.
- [ ] `test-bug-request-skips-prd.bats` runs in under 10 seconds and asserts: phase transitioned to `tdd`, `phase_history` has exactly one entry naming `intake -> tdd`, and the captured supervisor log does NOT contain the substring `prd-author`.
- [ ] All bats files in `tests/bats/` complete in under 30 seconds total when run with `bats tests/bats/`.
- [ ] Running the existing pre-PLAN-018-2 bats suite still passes (no regressions on feature-typed scenarios).
- [ ] Each bats test isolates its state mutations into `BATS_TEST_TMPDIR`; running the suite twice in succession produces identical results (no shared mutable state).
- [ ] `shellcheck` passes on the integration test harness if it includes any sourced helper bash beyond the `.bats` file itself.

## Dependencies

- **Blocked by SPEC-018-2-01, -02, and -03**: tests exercise the implementations from all three.
- **Blocked by PLAN-018-1**: fixtures rely on the v1.1 state schema.
- Bats-core, bats-assert, bats-support: already established by PLAN-016-2's CI baseline. No new test-runner dependencies.
- The `--once` mode for `bin/supervisor-loop.sh` may need a small flag-handling addition if not already present from earlier work; bundle that change with `test-bug-request-skips-prd.bats` if required.

## Notes

- Fixtures double as documentation: an engineer wanting to know what an `infra`-typed v1.1 state looks like reads `tests/fixtures/state/typed/infra.json`. Treat them as canonical examples and keep them in sync if the schema evolves.
- Snapshot tests are deliberately strict (byte-for-byte). The cost is occasional churn when the spawn helper changes; the benefit is that any unintended change to the agent contract surfaces immediately in CI.
- `${STATE_DIR}` placeholder substitution avoids embedding `BATS_TEST_TMPDIR` paths in committed snapshots, which would change per-run.
- The integration test is intentionally narrow: one supervisor iteration, one state, one assertion. Broader end-to-end coverage (CLI submission, multi-phase progression, escalation routing) belongs to PLAN-018-3 and the integration testing phase in PLAN-018-4 (if any).
- If `bin/supervisor-loop.sh` does not yet accept `--once`, add the flag with the minimal possible change: parse it at the top of the loop, run one iteration, exit 0. Document the change in the test file's header comment so the inclusion is discoverable.
- `phase_history` semantics: the lifecycle engine appends to this array on every successful transition. The integration test asserts the array length after exactly one iteration; a length other than 1 indicates either no advancement (test failure) or unintended multi-phase progression (also a test failure worth investigating).
