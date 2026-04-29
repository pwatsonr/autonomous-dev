# PLAN-020-2: Reviewer Chain Config + Scheduler + Score Aggregator

## Metadata
- **Parent TDD**: TDD-020-quality-reviewer-suite
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-020-1]
- **Priority**: P0

## Objective
Wire the four specialist reviewer agents from PLAN-020-1 into the existing review-gate flow via three components: (1) a `reviewer-chains.json` config file (with per-request-type defaults) that describes which reviewers run at which gates with what thresholds and blocking semantics; (2) a scheduler that runs reviewers concurrently when independent (UX + a11y on frontend changes share the detection cache) and sequentially when ordering matters (rule-set-enforcement after the others, since it consumes their output); (3) a score aggregator that enforces the built-in-minimum rule from TDD-019 §11.2 (a gate cannot pass with ONLY specialist verdicts — at least one built-in reviewer must complete successfully). This plan completes the TDD-020 user story end-to-end.

## Scope
### In Scope
- `<repo>/.autonomous-dev/reviewer-chains.json` per TDD §6 with per-request-type entries (`feature`, `bug`, `infra`, `refactor`, `hotfix`) and per-gate reviewer arrays. Each reviewer entry: `name`, `type` (built-in|specialist), `blocking` (bool), `threshold` (0-100), optional `trigger` (e.g., `frontend` to gate UX/a11y on frontend detection)
- Default chain config shipped at `plugins/autonomous-dev/config_defaults/reviewer-chains.json` per TDD §6 with the canonical chain structure; consumers copy/customize per repo
- `ReviewerScheduler` class at `src/reviewers/scheduler.ts` that takes a gate name + request type + change-set and returns the ordered list of reviewer invocations (with concurrency groups marked)
- Concurrent execution group: UX/UI + accessibility share the frontend-detection cache (PLAN-020-1's `detectFrontendChanges()`) and run via `Promise.all`. The scheduler computes the cache once and passes the result to both reviewers
- Sequential execution: built-in reviewers run first (their output is part of context for specialists). Then specialist reviewers run in declared order. `rule-set-enforcement-reviewer` runs last so it can reference all prior findings
- `ScoreAggregator` class at `src/reviewers/aggregator.ts` per TDD-019 §11.2: collects all reviewer verdicts, enforces the built-in-minimum rule (at least one built-in reviewer must produce a non-error verdict), applies per-reviewer thresholds, and computes the final gate verdict
- Threshold semantics: a `blocking: true` reviewer below threshold fails the gate. `blocking: false` (advisory) reviewers below threshold log a warning but don't fail.
- Trigger semantics: `trigger: "frontend"` reviewers are skipped if `detectFrontendChanges()` returns `isFrontendChange: false`
- Per-request-type defaults loaded from `config_defaults/reviewer-chains.json` when no repo-level file exists
- CLI `autonomous-dev chains show [--type <type>] [--gate <gate>]` that prints the resolved chain for a given context (helps operators debug)
- CLI `autonomous-dev chains validate <path>` that schema-checks a chain config file before deployment
- Telemetry: every reviewer invocation logs `{reviewer, request_id, gate, score, verdict, duration_ms}` to the existing metrics pipeline (TDD-007)
- Unit tests for: chain resolver (per-type defaults vs repo override), scheduler (concurrent grouping, frontend-trigger gating, sequential ordering), aggregator (built-in-min rule, threshold enforcement)
- Integration test: register all four specialists, configure a chain with mixed blocking/advisory and a frontend trigger, run a fixture review gate, assert the final verdict and that all advisories were logged

### Out of Scope
- The four reviewer agent definitions and the frontend-detection helper -- delivered by PLAN-020-1
- The 90 eval cases -- delivered by PLAN-020-1
- Standards artifact loading (`standards.yaml`) -- TDD-021 / PLAN-021-1
- Custom evaluator sandbox invoked by the rule-set reviewer -- PLAN-021-2
- A/B testing harness for advisory→blocking promotion (TDD §11 Phase 2) -- separate plan
- Auto-rollback monitoring (false-positive rate > 25% over 30 days) -- ops/observability concern
- Plugin chaining for fix-recipe consumption -- TDD-022

## Tasks

1. **Author `reviewer-chains.json` schema** -- Create JSON Schema at `plugins/autonomous-dev/schemas/reviewer-chains-v1.json` covering the per-request-type / per-gate / per-reviewer structure from TDD §6. Includes enums for `type`, `trigger`, and threshold range constraints.
   - Files to create: `plugins/autonomous-dev/schemas/reviewer-chains-v1.json`
   - Acceptance criteria: Schema validates the TDD §6 example clean. Missing `name` on a reviewer entry fails. Invalid `type` (`'plugin'`) fails. Threshold > 100 fails. Schema includes worked example.
   - Estimated effort: 2h

2. **Ship default chain config** -- Create `plugins/autonomous-dev/config_defaults/reviewer-chains.json` with the canonical chain structure for all five request types. The structure matches TDD §6: feature has all 6 reviewers (2 built-in + 4 specialists); bug prioritizes qa-edge-case; infra emphasizes security; refactor emphasizes quality metrics; hotfix has the minimal chain.
   - Files to create: `plugins/autonomous-dev/config_defaults/reviewer-chains.json`
   - Acceptance criteria: All five request types have entries. Each has at least one `code_review` gate. The schema validation passes. The chain for `feature.code_review` includes both `code-reviewer` (built-in, blocking, 80) and at least 2 specialists. `infra` has `security-reviewer` with `threshold: 95`. `hotfix` has only built-in reviewers (no specialists).
   - Estimated effort: 2h

3. **Implement chain resolver** -- Add `resolveChain(repoPath, requestType, gate)` at `src/reviewers/chain-resolver.ts`. Logic: load `<repo>/.autonomous-dev/reviewer-chains.json` if present, else fall back to `config_defaults/reviewer-chains.json`. Return the resolved reviewer array for `<requestType>.<gate>`.
   - Files to create: `plugins/autonomous-dev/src/reviewers/chain-resolver.ts`
   - Acceptance criteria: With a repo-level config present, repo entries take precedence. With no repo file, defaults are used. Missing request type fallback to `feature`. Missing gate within a request type returns empty (no reviewers run). Tests cover all four cases.
   - Estimated effort: 2h

4. **Implement `ReviewerScheduler`** -- Create `src/reviewers/scheduler.ts` with `schedule(chain, context)` method that returns `{groups: ReviewerInvocation[][]}`. Logic: group concurrent reviewers (UX + a11y) into the same array; sequential reviewers (rule-set-enforcement, built-ins) each get their own group. Frontend-triggered reviewers are filtered out when not a frontend change.
   - Files to create: `plugins/autonomous-dev/src/reviewers/scheduler.ts`
   - Acceptance criteria: For a feature chain on a frontend change, scheduler returns groups: `[[code-reviewer], [security-reviewer], [qa-edge-case], [ux-ui, accessibility], [rule-set-enforcement]]` (concurrent UX+a11y in group 4). For a non-frontend change, group 4 is empty (or omitted). For a chain with only built-ins, all are sequential (one per group). Tests cover all permutations.
   - Estimated effort: 4h

5. **Implement reviewer invocation runner** -- Create `src/reviewers/runner.ts` that takes scheduler output and runs each group: `Promise.all(group.map(r => invokeReviewer(r, context)))`. The function captures verdicts, durations, and errors. Errors don't crash the runner — they're recorded as `{verdict: 'ERROR', error_message: ...}` for the aggregator.
   - Files to create: `plugins/autonomous-dev/src/reviewers/runner.ts`
   - Acceptance criteria: A group with 2 concurrent reviewers runs both in parallel (verified by timing test: total wall time ~max of the two, not sum). Errors in one reviewer don't affect others. The runner returns a complete array of results in the original chain order (post-flatten). Tests cover happy path, single error, all errors.
   - Estimated effort: 3h

6. **Implement `ScoreAggregator`** -- Create `src/reviewers/aggregator.ts` with `aggregate(results, chain)` method per TDD-019 §11.2. Logic: 
   - At least one built-in reviewer must have produced a non-error verdict (otherwise gate fails with reason "no built-in reviewer completed")
   - For each `blocking: true` reviewer, score must meet threshold
   - For each `blocking: false` reviewer below threshold, log a warning
   - Final verdict: `APPROVE` if all blocking reviewers pass, `REQUEST_CHANGES` otherwise
   - Output includes per-reviewer breakdown and overall verdict
   - Files to create: `plugins/autonomous-dev/src/reviewers/aggregator.ts`
   - Acceptance criteria: With all built-ins erroring, gate fails with "no built-in reviewer completed". With all built-ins passing and one blocking specialist below threshold, gate fails with that reviewer's reason. With all blocking reviewers passing and an advisory below threshold, gate passes but a warning is logged. Tests cover the truth table.
   - Estimated effort: 3h

7. **Wire scheduler + runner + aggregator into the review-gate evaluator** -- Modify the existing `bin/score-evaluator.sh` (or its TypeScript equivalent if it exists) so that it calls the chain-resolver + scheduler + runner + aggregator in sequence and writes the final verdict to `<state-dir>/gates/<gate-name>.json`.
   - Files to modify: `plugins/autonomous-dev/bin/score-evaluator.sh`, `plugins/autonomous-dev/src/reviewers/index.ts`
   - Acceptance criteria: A review gate triggered from the supervisor invokes the new pipeline. The gate-output file matches the existing format expected by PLAN-018-2's gate-presence check. No regressions in existing tests for built-in-only chains.
   - Estimated effort: 3h

8. **Implement `chains show` and `chains validate` CLI subcommands** -- `autonomous-dev chains show [--type <type>] [--gate <gate>]` prints the resolved chain in a tabular format. `autonomous-dev chains validate <path>` schema-checks a config file. Both have `--json` output mode.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/chains.ts`
   - Acceptance criteria: `chains show --type feature --gate code_review` prints the 6-reviewer chain. `chains show --type bug` prints all gates for bug. `chains validate /tmp/test-chains.json` exits 0 on a valid file, 1 on invalid with error pointing at the field. JSON output mode emits structured data.
   - Estimated effort: 2h

9. **Telemetry integration** -- Add a logger call in the runner that emits `{reviewer, request_id, gate, score, verdict, duration_ms}` per invocation. Routes through the existing TDD-007 metrics pipeline.
   - Files to modify: `plugins/autonomous-dev/src/reviewers/runner.ts`
   - Acceptance criteria: Each reviewer invocation produces exactly one log entry. The entry shape matches the documented schema. Tests verify entries are produced for both successful and error invocations.
   - Estimated effort: 1.5h

10. **Unit tests** -- `tests/reviewers/test-chain-resolver.test.ts`, `test-scheduler.test.ts`, `test-runner.test.ts`, `test-aggregator.test.ts` covering all paths from tasks 3-6. Use mocked reviewer invocations.
    - Files to create: four test files under `plugins/autonomous-dev/tests/reviewers/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `chain-resolver.ts`, `scheduler.ts`, `runner.ts`, `aggregator.ts`. Tests are deterministic (mocked invocations return fixed results).
    - Estimated effort: 4h

11. **Integration test: full review-gate flow** -- `tests/integration/test-reviewer-chain-flow.test.ts` that registers all four specialists (mocked agent responses), configures a feature chain with mixed blocking/advisory and a frontend trigger, runs the gate against a fixture frontend diff, asserts: built-in reviewers ran, frontend specialists ran (concurrent group), rule-set-enforcement ran last, advisory reviewer below threshold logged a warning but didn't fail, blocking reviewer above threshold passed.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-reviewer-chain-flow.test.ts`
    - Acceptance criteria: Test passes deterministically. Assertions cover: invocation order (built-ins → qa → ux+a11y concurrent → rule-set), final verdict, advisory warning logged, blocking pass.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `reviewer-chains.json` config format consumed by any future reviewer-suite extension (e.g., a custom security reviewer plugin).
- `ReviewerScheduler`, `ScoreAggregator` interfaces consumed by future plans that need to integrate custom reviewers (e.g., the cloud-deploy plan from TDD-024 may add a deploy-time reviewer).
- `chains show` / `chains validate` CLI patterns reusable by future config-driven systems.
- Telemetry data shape consumed by observability dashboards.

**Consumes from other plans:**
- **PLAN-020-1** (blocking): the four specialist agent files, `detectFrontendChanges()` helper, `reviewer-finding-v1.json` schema. Without these, the scheduler has nothing to invoke.
- TDD-002 / PLAN-002-3: existing review-gate evaluator that this plan extends.
- TDD-007 / PLAN-007-X: existing metrics pipeline for telemetry emission.
- TDD-018 / PLAN-018-2: per-request-type chain resolution depends on `request_type` being present in state.json.
- PRD-004 / TDD-004: existing built-in reviewers (code-reviewer, security-reviewer) that the chain references.

## Testing Strategy

- **Unit tests (task 10):** Chain resolver, scheduler, runner, aggregator. ≥95% coverage.
- **Integration test (task 11):** Full review-gate flow with all four specialists + built-ins.
- **Schema validation:** `chains validate` runs in CI as a lint step on `config_defaults/reviewer-chains.json` and on any `<repo>/.autonomous-dev/reviewer-chains.json` in test fixtures.
- **Concurrency test:** Scheduler test with mock reviewers having artificial 200ms delays asserts UX + a11y complete in ~200ms (concurrent), not 400ms (sequential).
- **Manual smoke:** Run a real review gate with the new pipeline; verify the per-reviewer breakdown appears in the gate-output file.
- **Backward compatibility:** Existing tests for built-in-only chains pass without modification.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Concurrent reviewer execution overwhelms the daemon (4+ Claude API calls in parallel) | Medium | Medium -- rate-limiting failures | Concurrency groups are bounded: at most UX + a11y run in parallel (2 calls). Built-ins and other specialists run sequentially. Per-reviewer cost caps from PLAN-020-1 prevent runaway. Documented limit: max 2 concurrent reviewer invocations per gate. |
| Built-in-min rule blocks gates when an operator wants to disable built-ins (e.g., trusted private fork) | Low | Low -- operator workaround exists | The rule is enforced at aggregation time. Operators can disable specific built-ins by setting `enabled: false` in the chain entry (default true). Future: add a config flag `enforce_built_in_min: true|false` for advanced operators. Documented in operator guide. |
| Chain config drift across repos (each team customizes differently) breaks centralized testing | High | Medium -- per-repo chain divergence | The defaults shipped in this plan are the source of truth. Per-repo customization is opt-in. CI smoke test in PLAN-016-2 lints all `<repo>/.autonomous-dev/reviewer-chains.json` files in repos under autonomous-dev management. |
| Scheduler picks wrong concurrency group due to typo in chain config | Low | Low -- reviewer runs sequentially when it could be concurrent | The scheduler defaults to sequential execution. Concurrent grouping is opt-in via the `trigger` field. A typo causes sequential fallback, which is slower but correct. Monitoring captures wall-clock time per reviewer; ops alerts if frontend-trigger fails to fire. |
| Aggregator's "no built-in completed" failure mode is hit during a Claude API outage | Medium | High -- gates fail across the board | The runner records errors as `verdict: 'ERROR'`. The aggregator's "non-error" check requires at least one verdict to be non-error. During a sustained outage, all reviewers error and gates fail. Mitigation: TDD-009 escalation routes the failure to the operator; daemon's circuit breaker pauses new requests after N consecutive failures. |
| Telemetry pipeline introduces back-pressure when a reviewer takes a long time | Low | Low -- log lag, no functional impact | Logging is async (fire-and-forget). The TDD-007 pipeline batches log entries with bounded queue. Reviewer invocation does not block on log emission. |

## Definition of Done

- [ ] `reviewer-chains-v1.json` schema validates the TDD §6 example
- [ ] Default chain config covers all five request types (feature/bug/infra/refactor/hotfix)
- [ ] Chain resolver respects repo-level overrides and falls back to defaults
- [ ] Scheduler groups concurrent reviewers (UX + a11y) and runs others sequentially
- [ ] Frontend-trigger reviewers are filtered when not a frontend change
- [ ] Runner executes groups via `Promise.all`; errors don't crash the runner
- [ ] Aggregator enforces built-in-min rule and per-reviewer thresholds
- [ ] Advisory reviewers below threshold log a warning; don't fail the gate
- [ ] Pipeline integration: review-gate evaluator invokes the new flow end-to-end
- [ ] `chains show` and `chains validate` CLI subcommands work with JSON output
- [ ] Telemetry emits one log entry per reviewer invocation with the documented shape
- [ ] All unit tests pass with ≥95% coverage on new files
- [ ] Integration test demonstrates full flow with all four specialists + built-ins
- [ ] Concurrency test verifies UX + a11y run in parallel (not sequential)
- [ ] No regressions in existing built-in-only chain tests
