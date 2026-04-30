# SPEC-020-2-05: Unit + Integration Tests for Reviewer Chain Pipeline

## Metadata
- **Parent Plan**: PLAN-020-2
- **Tasks Covered**: Task 10 (unit tests for chain-resolver, scheduler, runner, aggregator), Task 11 (integration test for full review-gate flow)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-2-05-unit-and-integration-tests.md`

## Description
Land the test suite that locks in the behavior implemented by SPEC-020-2-01 through -04: four unit-test files (one per pure-logic module) achieving ≥95% coverage on `chain-resolver.ts`, `scheduler.ts`, `runner.ts`, `aggregator.ts`, and one integration test that exercises the full pipeline end-to-end with all four specialist agents (mocked) plus both built-ins, asserting invocation order, concurrency, advisory warnings, and final verdict.

All tests are deterministic: invocation mocks return fixed scores/verdicts/durations on demand. The concurrency test uses artificial 200ms delays in mocks and asserts wall time is `~max(t1, t2)` (with tolerance) to prove `Promise.all` is actually parallel.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/reviewers/test-chain-resolver.test.ts` | Create | Resolver tests: repo override, defaults fallback, missing type, missing gate, malformed JSON, disabled filter |
| `plugins/autonomous-dev/tests/reviewers/test-scheduler.test.ts` | Create | Scheduler tests: feature/frontend grouping, non-frontend filtering, hotfix all-sequential, rule-set-last invariant, purity |
| `plugins/autonomous-dev/tests/reviewers/test-runner.test.ts` | Create | Runner tests: concurrency timing, error capture, ordering, telemetry-hook firing |
| `plugins/autonomous-dev/tests/reviewers/test-aggregator.test.ts` | Create | Aggregator tests: built-in-min, blocking thresholds, advisory warnings, error verdicts, empty inputs |
| `plugins/autonomous-dev/tests/integration/test-reviewer-chain-flow.test.ts` | Create | End-to-end pipeline: resolve → schedule → run → aggregate, all 6 reviewers, frontend trigger active |
| `plugins/autonomous-dev/tests/fixtures/reviewer-chains/repo-override.json` | Create | Sample repo-level chain for resolver tests |
| `plugins/autonomous-dev/tests/fixtures/reviewer-chains/malformed.json` | Create | Intentionally broken JSON for resolver error path |
| `plugins/autonomous-dev/tests/fixtures/reviewer-chains/frontend-diff/changed-files.txt` | Create | List of changed files including `.tsx` for `detectFrontendChanges` to flag |

## Implementation Details

### Test Framework

All tests use the project's existing test runner (Vitest, per project convention). Each file imports the implementation modules directly — no mocking framework needed for the resolver/scheduler/aggregator (pure logic). The runner and integration tests use plain JS object mocks for `InvokeReviewerFn` and `emitReviewerInvocation`.

### Chain Resolver Tests (`test-chain-resolver.test.ts`)

Required test cases (one `describe` block per concern):

1. **Repo override precedence**: write `<tmpdir>/.autonomous-dev/reviewer-chains.json` with a custom chain; assert resolver returns the custom entries (not defaults).
2. **Defaults fallback**: pass a `repoPath` with NO `.autonomous-dev/reviewer-chains.json`; assert resolver returns the bundled default chain.
3. **Missing request type**: pass `requestType: "chore"` (not in default config); assert resolver falls back to the `feature` chain.
4. **Missing gate**: pass `gate: "post_deploy"` (not configured for any type); assert resolver returns `[]`.
5. **Malformed JSON**: place the malformed fixture at `<tmpdir>/.autonomous-dev/reviewer-chains.json`; assert resolver throws `ChainConfigError` referencing the file path. Confirm it does NOT silently fall back to defaults.
6. **Disabled filter**: build a chain with one entry having `enabled: false`; assert that entry is excluded from the returned array, while entries with `enabled: true` (or absent) are kept.

Coverage target: ≥95% on `chain-resolver.ts`. Both happy and error branches of `loadChainConfig` are exercised.

### Scheduler Tests (`test-scheduler.test.ts`)

Required test cases:

1. **Feature chain on frontend change**: build the feature chain (6 reviewers), set `isFrontendChange: true`, call `schedule`. Assert `groups.length === 5` and groups in this exact order: `[code-reviewer]`, `[security-reviewer]`, `[qa-edge-case-reviewer]`, `[ux-ui-reviewer, accessibility-reviewer]`, `[rule-set-enforcement-reviewer]`.
2. **Feature chain on non-frontend change**: same chain, `isFrontendChange: false`. Assert `groups.length === 4` (the `[ux-ui, a11y]` group is omitted entirely, not present as `[]`).
3. **Hotfix chain (built-ins only)**: chain with 2 built-ins. Assert `groups === [[code-reviewer], [security-reviewer]]`.
4. **Rule-set-last invariant**: build a chain where `rule-set-enforcement-reviewer` appears in position 0 (first). Assert it ends up in the LAST group regardless.
5. **UX + a11y co-location**: build a chain where `ux-ui-reviewer` and `accessibility-reviewer` are NOT adjacent in the declared order. Assert they still end up in the SAME group.
6. **Empty chain**: pass `[]`. Assert `groups === []`.
7. **Purity**: call `schedule` twice with structurally equal inputs; assert both outputs are deeply equal AND the input chain array reference is unchanged after the call.

Coverage target: ≥95% on `scheduler.ts`.

### Runner Tests (`test-runner.test.ts`)

Required test cases:

1. **Concurrency timing**: build a single group with 2 invocations; mock `invokeReviewer` to sleep 200ms before resolving. Run via `ReviewerRunner.run`. Assert `Date.now()` delta is `< 350ms` (proving parallelism). If sequential, the time would be ~400ms.
2. **Sequential across groups**: build 3 groups of 1 invocation each, each sleeping 100ms. Assert total time is `>= 270ms` (proving group-N+1 waits for group-N).
3. **Error capture**: mock one invocation to throw `new Error("boom")`. Assert the corresponding `ReviewerResult` has `verdict: 'ERROR'`, `score: null`, `error_message: "boom"`. Assert the runner does NOT throw.
4. **Error isolation in a group**: 2 concurrent invocations, one throws, one succeeds. Assert both produce `ReviewerResult` entries; the successful one has `verdict !== 'ERROR'`.
5. **All-error path**: all invocations throw. Assert the runner returns an array of N error results in original order; does NOT throw.
6. **Result ordering**: build a chain spanning multiple groups with distinct reviewer names; assert the returned `ReviewerResult[]` order matches the FLATTENED chain order (group 0 first, etc.).
7. **Telemetry hook firing**: inject a mock `emitReviewerInvocation`; assert it is called exactly once per invocation with the correct payload shape (matching `ReviewerInvocationLog`). Verify it is called for both successful and errored invocations.

Coverage target: ≥95% on `runner.ts`.

### Aggregator Tests (`test-aggregator.test.ts`)

Required test cases (truth-table coverage):

1. **All built-ins error → fail**: chain has 2 built-ins; both results have `verdict: 'ERROR'`. Assert `outcome === 'REQUEST_CHANGES'` and `reason` contains `"no built-in reviewer completed"`.
2. **One built-in passes → built-in-min satisfied**: 2 built-ins, one passes one errors. Assert built-in-min is satisfied (subsequent rules apply normally).
3. **Chain has zero built-ins**: chain made of only specialists, all pass. Assert `outcome === 'APPROVE'` (built-in-min rule is skipped).
4. **Blocking specialist below threshold → fail**: built-ins pass; blocking specialist returns `score: 70` against `threshold: 80`. Assert `outcome === 'REQUEST_CHANGES'` and reason references the specialist name, score, and threshold.
5. **Blocking reviewer errored → fail**: built-ins pass; one blocking entry returns `verdict: 'ERROR'`. Assert `outcome === 'REQUEST_CHANGES'` and reason contains `"errored"` and the error message.
6. **Advisory below threshold → warn, pass**: all blocking pass; one advisory has `score: 60, threshold: 75`. Assert `outcome === 'APPROVE'`, `warnings.length === 1`, warning string references reviewer/score/threshold.
7. **Advisory errored → warn, pass**: all blocking pass; one advisory has `verdict: 'ERROR'`. Assert `outcome === 'APPROVE'`, `warnings.length >= 1` referencing the errored advisory.
8. **All pass cleanly → approve**: all reviewers (built-in + specialist, blocking + advisory) score above threshold. Assert `outcome === 'APPROVE'`, `warnings === []`, `built_in_count_completed === <num built-ins>`, `reason` is the success string.
9. **Empty results array**: pass `[]` results with a non-empty chain. Assert aggregator does NOT throw and returns a `GateVerdict` with a meaningful `reason`.
10. **`per_reviewer` pass-through**: assert the output's `per_reviewer` array equals the input `results` array (same length, same entries, in the same order).

Coverage target: ≥95% on `aggregator.ts`.

### Integration Test (`test-reviewer-chain-flow.test.ts`)

Single end-to-end test that exercises the full `runReviewGate` pipeline:

1. **Setup**: create a tmp repo dir with NO chain override (use defaults). Build a `ChangeSetContext` with `requestType: "feature"`, `gate: "code_review"`, `isFrontendChange: true`, and a fake `requestId`.
2. **Mock `invokeReviewer`** with deterministic outcomes:
   - `code-reviewer` → score 90, APPROVE
   - `security-reviewer` → score 88, APPROVE
   - `qa-edge-case-reviewer` → score 85, APPROVE
   - `ux-ui-reviewer` → score 70, REQUEST_CHANGES (advisory, below threshold)
   - `accessibility-reviewer` → score 80, APPROVE
   - `rule-set-enforcement-reviewer` → score 95, APPROVE
   Each mock records the timestamp at which it was invoked into a shared array (used to assert order/concurrency).
3. **Mock `emitReviewerInvocation`** to record all calls into an array.
4. **Run** `runReviewGate(...)`.
5. **Assertions**:
   - Final `outcome === 'APPROVE'` (advisory below threshold doesn't fail).
   - `warnings.length === 1` and the warning references `ux-ui-reviewer` with `score: 70` and `threshold: 75`.
   - Invocation order from the recorded timestamps:
     - Built-ins finished before any specialist started (timestamp of any built-in's resolution < timestamp of any specialist's start).
     - `ux-ui-reviewer` and `accessibility-reviewer` started within 50ms of each other (concurrent group; tighter than sequential).
     - `rule-set-enforcement-reviewer` started AFTER all other reviewers had finished.
   - `built_in_count_completed === 2`.
   - The verdict file was written to `<stateDir>/gates/code_review.json` and contains the full `GateVerdict` JSON.
   - `emitReviewerInvocation` was called exactly 6 times (once per reviewer); each payload matches `ReviewerInvocationLog`.

Test must complete deterministically in `< 5 seconds` on CI hardware.

## Acceptance Criteria

- [ ] All four unit test files exist under `plugins/autonomous-dev/tests/reviewers/`.
- [ ] All cases listed for each test file are present and pass.
- [ ] Coverage on `chain-resolver.ts` is ≥95% (lines AND branches).
- [ ] Coverage on `scheduler.ts` is ≥95% (lines AND branches).
- [ ] Coverage on `runner.ts` is ≥95% (lines AND branches).
- [ ] Coverage on `aggregator.ts` is ≥95% (lines AND branches).
- [ ] All tests are deterministic (no flakes when run 10× in a row locally).
- [ ] Concurrency timing test reliably distinguishes parallel from sequential execution (uses ≥150ms delta to avoid CI scheduler jitter).
- [ ] `test-reviewer-chain-flow.test.ts` exists and passes deterministically.
- [ ] Integration test asserts invocation order: built-ins → qa → ux+a11y (concurrent) → rule-set.
- [ ] Integration test asserts the advisory `ux-ui-reviewer` below threshold logged a warning but did NOT fail the gate.
- [ ] Integration test asserts the verdict file is written to `<stateDir>/gates/code_review.json` with valid JSON content.
- [ ] Integration test asserts `emitReviewerInvocation` was called 6 times with correct payload shapes.
- [ ] Integration test completes in `< 5s` on CI hardware.
- [ ] Existing built-in-only chain tests still pass (no regressions introduced by the new wiring).

## Dependencies

- **Consumes** SPEC-020-2-01 through -04: tests import the implementations from those specs. The test suite cannot be implemented before those specs land.
- **Consumes from PLAN-020-1** (mocked at the function boundary): no real reviewer agents are invoked. Tests stub the `InvokeReviewerFn` directly so this spec has no runtime dependency on PLAN-020-1's deliverables.
- **Test runner**: Vitest (existing project convention). No new test infrastructure introduced.

## Notes

- The 50ms tolerance on the concurrency assertion in the integration test (UX + a11y "started within 50ms of each other") is a CI-friendly threshold. Local development typically sees `< 5ms` but CI runners can be jittery.
- The `< 350ms` assertion in the runner concurrency test accommodates: 200ms mock delay + scheduling overhead + Vitest's own per-test setup. If CI proves flakier, tighten to `< 400ms` (still well below the 400ms sequential lower bound).
- For the `chain-resolver` malformed-JSON test, generate the fixture programmatically (e.g., write `{invalid` to disk) rather than committing literal broken JSON — committed broken JSON sometimes triggers IDE / pre-commit linting noise.
- The integration test deliberately uses the DEFAULT chain config (no repo override) because that is the production path for most users. A separate test in `test-chain-resolver.test.ts` covers the override path; redundant integration coverage of overrides is unnecessary.
- Mock recording arrays should be reset in `beforeEach` to avoid cross-test contamination; the integration test in particular shares state across assertion blocks within a single `it`.
- Coverage thresholds (≥95%) should be enforced by Vitest's `coverage.thresholds` config so future regressions break CI.
- The `ChainConfigError` exception class (from SPEC-020-2-02) is asserted by `instanceof` in the resolver test — relying on string matching of the error message would be fragile.
