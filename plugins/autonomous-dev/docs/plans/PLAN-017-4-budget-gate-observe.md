# PLAN-017-4: Budget Gate & Scheduled Observation

## Metadata
- **Parent TDD**: TDD-017-claude-workflows-release
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: [PLAN-017-1, PLAN-017-2, PLAN-017-3]
- **Priority**: P0

## Objective
Deliver the cost-control gating layer that protects every Claude-powered workflow shipped by Plans 1-3 from runaway spend, plus the opt-in `observe.yml.example` template that operators copy into their own forks for stateless scheduled observation. This plan produces `budget-gate.yml` as a reusable required-check workflow that aggregates HMAC-signed spend artifacts, enforces tiered thresholds (80% warn / 100% fail / 110% two-admin override), and is wired as a `needs:` dependency for `claude-assistant.yml`, the four document-review workflows, the agent-meta-review workflow, `assist-evals.yml`, and `release.yml`. The plan also delivers the observe template as a `.example` file so it does not execute on the plugin's own CI but is available to downstream operator repos.

## Scope
### In Scope
- `.github/workflows/budget-gate.yml` reusable workflow (`on: workflow_call`) per TDD §10.1
- HMAC-SHA256 verification of spend artifacts using `BUDGET_HMAC_KEY` per TDD §22.1
- Month-to-date aggregation logic that filters artifacts by ISO-8601 month prefix and excludes entries older than 32 days
- 80% warning step that posts a sticky PR comment via `actions/github-script@v7` (idempotent: updates existing comment rather than spamming)
- 100% fail step that checks for `cost:override` label and exits 1 if absent
- 110% critical step that requires `cost:override-critical` label, queries org admin list at execution time per TDD §22.4, and verifies two distinct admins with different verified emails
- Single-run validity for override labels (auto-removal step after successful run)
- Integration `needs: budget-gate` declarations added to all eight Claude-powered workflows from Plans 1-3
- `.github/workflows/observe.yml.example` template per TDD §11.1 with documentation header explaining the copy-to-enable model
- Drift-detection step in the example that validates `--scope`, `--format`, `--output` flags still exist on `autonomous-dev observe`
- Parameterization via repository variables (`OBSERVE_SCHEDULE`, `OBSERVE_SCOPE`, `OBSERVE_FORMAT`) per TDD §11.3
- `operator-fork` environment scoping for `OBSERVE_WEBHOOK_URL` per TDD §14
- `actionlint` rule exclusion in CI so the `.example` file is not treated as a live workflow
- Unit tests for the JS aggregation script and the override-verification logic
- Documentation: `docs/operators/budget-gate.md` covering threshold semantics, override workflow, and HMAC-key rotation procedure

### Out of Scope
- The Claude-invoking workflows themselves (Plans 1-3) — this plan only adds `needs:` wiring to them
- Anthropic Usage API integration (NG-04 in TDD-017; estimation-only)
- Dependabot configuration for Actions updates — Phase 5 hardening, separate plan
- Branch protection rule configuration — TDD-016 owned
- Live `observe.yml` activation on the plugin's own repo — explicitly left as `.example`
- Quarterly HMAC-key rotation automation — manual procedure documented only
- Cost ledger UI / dashboard — out of scope for v0.2

## Tasks

1. **Scaffold `budget-gate.yml` reusable workflow** — Create `.github/workflows/budget-gate.yml` with `on: workflow_call` trigger, `triggering_workflow` input, `contents: read` + `pull-requests: write` permissions, 2-minute timeout, and `concurrency: group: budget-gate-${{ github.event.number }}` per TDD §16.
   - Files to create: `.github/workflows/budget-gate.yml`
   - Acceptance criteria: `actionlint` passes. The workflow exposes `triggering_workflow` as a required input. Permissions match TDD §10.1 exactly. Workflow can be invoked via `workflow_call` from a test caller.
   - Estimated effort: 1.5h

2. **Implement HMAC artifact verification script** — `scripts/ci/verify-spend-artifact.js` reads a spend JSON artifact, recomputes `HMAC-SHA256(BUDGET_HMAC_KEY, canonical_json_without_hmac_field)`, and exits 0 only if the signature matches. Handles unsigned and malformed artifacts by exiting non-zero with a structured warning.
   - Files to create: `scripts/ci/verify-spend-artifact.js`, `scripts/ci/canonical-json.js`
   - Acceptance criteria: Given a valid signed artifact and the matching key, exits 0. Given a tampered artifact, exits 1 with `::warning::HMAC verification failed for artifact <name>`. Given an unsigned artifact, exits 1. Canonical JSON serialization produces stable byte output across Node versions.
   - Estimated effort: 3h

3. **Implement month-to-date aggregation step** — Replace inline artifact loop with a call to `scripts/ci/aggregate-spend.js` that downloads artifacts via `gh api`, runs each through the verifier from task 2, filters by ISO-8601 month and 32-day age cap per TDD §22.1, and emits `total_spend`, `budget_limit`, `percentage` to `$GITHUB_OUTPUT`.
   - Files to create: `scripts/ci/aggregate-spend.js`
   - Files to modify: `.github/workflows/budget-gate.yml`
   - Acceptance criteria: With three valid artifacts totaling $42 and `CLAUDE_MONTHLY_BUDGET_USD=500`, output is `total_spend=42`, `budget_limit=500`, `percentage=8.4`. Tampered artifacts are excluded with a warning. Artifacts dated >32 days ago are excluded. Artifacts from the previous month are excluded.
   - Estimated effort: 4h

4. **Implement 80% warning threshold step** — Use `actions/github-script@v7` to post a sticky PR comment when `80 <= percentage < 100`. The comment uses a hidden `<!-- budget-gate-comment -->` marker so subsequent runs update the existing comment rather than creating new ones.
   - Files to modify: `.github/workflows/budget-gate.yml`
   - Acceptance criteria: First run at 82% creates a comment with the percentage and dollar figures. Second run at 85% updates the existing comment in place (verified by single comment count via `gh api`). Run at 79% does not create or modify any comment.
   - Estimated effort: 2h

5. **Implement 100% fail threshold step with single-admin override** — When `100 <= percentage < 110`, check for `cost:override` label. If absent, fail with a clear error message including the override instructions. If present, log the override and proceed.
   - Files to modify: `.github/workflows/budget-gate.yml`
   - Acceptance criteria: Run at 102% without label exits 1 with `::error::Monthly budget exceeded (102%). Apply 'cost:override' label to proceed.`. Same run with label applied exits 0 and logs the actor and timestamp. Override is recorded in the workflow summary.
   - Estimated effort: 1.5h

6. **Implement 110% critical threshold with two-admin verification** — When `percentage >= 110`, require `cost:override-critical` label, query `gh api orgs/{org}/members?role=admin` at execution time per TDD §22.4, verify two distinct admin actors applied the label with different verified emails (`gh api users/{username}`), and reject same-email alt-account attacks.
   - Files to create: `scripts/ci/verify-two-admin-override.js`
   - Files to modify: `.github/workflows/budget-gate.yml`
   - Acceptance criteria: Run at 115% without `cost:override-critical` label exits 1. Run with label applied by one admin exits 1 with `Critical override requires two distinct org admin approvals`. Run with two admins sharing the same verified email exits 1 with `Same-email accounts not permitted`. Run with two distinct admins with distinct emails exits 0.
   - Estimated effort: 4h

7. **Implement single-run override validity** — After a successful run that consumed an override label, an `if: success() && labels-applied` step removes the override label so a subsequent run requires re-application per TDD §22.4 item 3.
   - Files to modify: `.github/workflows/budget-gate.yml`
   - Acceptance criteria: After a 105% run with `cost:override` consumed, the label is removed via `gh pr edit --remove-label`. A re-run at the same percentage fails because the label is absent. Removal is logged in the workflow summary.
   - Estimated effort: 1h

8. **Wire `needs: budget-gate` into all Claude-powered workflows** — Update each of the eight workflows from Plans 1-3 (`claude-assistant.yml`, `prd-review.yml`, `tdd-review.yml`, `plan-review.yml`, `spec-review.yml`, `agent-meta-review.yml`, `assist-evals.yml`, `release.yml`) to add a `budget-gate` job that calls `./.github/workflows/budget-gate.yml` and a `needs: [budget-gate]` declaration on each Claude-invoking job.
   - Files to modify: all eight workflow files from Plans 1-3
   - Acceptance criteria: Each Claude-invoking job has `needs: [budget-gate]`. Caller passes its workflow name as `triggering_workflow`. `actionlint` passes for all eight files. Manual mock test confirms a budget-gate failure blocks the downstream Claude job.
   - Estimated effort: 2h

9. **Create `observe.yml.example` template** — Author `.github/workflows/observe.yml.example` per TDD §11.1 with the schedule trigger, `workflow_dispatch`, `concurrency: observe` with `cancel-in-progress: false`, 15-minute timeout, Claude CLI install, observation invocation, optional webhook POST, and 30-day artifact retention. Top of file includes a comment block explaining the copy-to-enable model.
   - Files to create: `.github/workflows/observe.yml.example`
   - Acceptance criteria: File exists with `.example` suffix so GitHub does not auto-execute it. Header comment explains: (a) rename to `observe.yml` to enable, (b) configure `OBSERVE_SCHEDULE`, `OBSERVE_SCOPE`, `OBSERVE_FORMAT` repo variables, (c) set `OBSERVE_WEBHOOK_URL` in the `operator-fork` environment if webhook delivery is desired. `yamllint` passes.
   - Estimated effort: 2h

10. **Add drift-detection step to observe template** — Per TDD §11.2, include a step that runs `autonomous-dev observe --help` and greps for `--scope`, `--format`, `--output` so the example fails fast if the CLI surface drifts.
    - Files to modify: `.github/workflows/observe.yml.example`
    - Acceptance criteria: Step uses `grep -q` for each flag and exits 1 if any are missing. Step is documented in the header comment as the "drift detection" guard.
    - Estimated effort: 0.5h

11. **Configure `actionlint` to skip `.example` files** — Add `.actionlintrc` (or update existing CI config) so `*.example` files in `.github/workflows/` are excluded from validation but still tracked by Git.
    - Files to create or modify: `.actionlintrc.yaml` or equivalent CI step
    - Acceptance criteria: `actionlint` run on the workflows directory passes with the example present. `git ls-files .github/workflows/observe.yml.example` returns the file (not gitignored).
    - Estimated effort: 0.5h

12. **Write unit tests for aggregation, HMAC verification, and override checks** — Using `vitest` for the JS scripts. Test cases: HMAC valid/invalid/missing, canonical JSON stability, month filtering, 32-day age cap, two-admin distinct/same/same-email/non-admin, single-run label removal.
    - Files to create: `tests/ci/budget-gate.test.ts`, `tests/ci/two-admin-override.test.ts`, `tests/ci/fixtures/spend-artifacts/*.json`
    - Acceptance criteria: All tests pass. Coverage ≥90% on the three scripts from tasks 2, 3, 6. Fixtures include at least one valid signed artifact, one tampered artifact, one unsigned artifact, one previous-month artifact, and one >32-day-old artifact.
    - Estimated effort: 4h

13. **Write operator documentation** — `docs/operators/budget-gate.md` covering: threshold semantics (80/100/110), override label workflow, HMAC-key rotation procedure (manual quarterly), how to read the workflow summary, and what to do when the gate fails.
    - Files to create: `docs/operators/budget-gate.md`
    - Acceptance criteria: Document is ≤200 lines, includes a worked example for each threshold, includes the rotation procedure (rotate `BUDGET_HMAC_KEY`, retire artifacts older than rotation date, communicate cutover), and links from `docs/operators/README.md`.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `.github/workflows/budget-gate.yml` reusable workflow that any future Claude-powered workflow can declare as `needs:`.
- `BUDGET_HMAC_KEY` secret contract (PRD-010 ops will provision and rotate).
- `cost:override` and `cost:override-critical` label conventions used by all Claude-powered workflows.
- `.github/workflows/observe.yml.example` template that operator forks copy to enable scheduled observation.

**Consumes from other plans:**
- All eight Claude-powered workflows from PLAN-017-1 (claude-assistant), PLAN-017-2 (the four document review workflows + agent-meta-review), and PLAN-017-3 (assist-evals + release). This plan modifies each to add `needs: budget-gate`.
- The spend-artifact upload steps embedded in those workflows (Plans 1-3 produce signed artifacts; this plan aggregates and verifies them).
- TDD-016 baseline `actionlint` and `yamllint` CI jobs (this plan extends configuration to permit `.example` files).
- PRD-008 `autonomous-dev observe` CLI (the observe template invokes it; drift detection guards against breakage).

## Testing Strategy

- **Unit tests (vitest):** Each JS script (HMAC verify, aggregation, two-admin override) is tested in isolation with controlled fixtures. Coverage target ≥90% per task 12.
- **Workflow mock tests (`nektos/act`):** Per TDD §15.1, run `act workflow_call --input triggering_workflow=claude-assistant --secret CLAUDE_MONTHLY_BUDGET_USD=100 --secret BUDGET_HMAC_KEY=test-key` against three scenarios: under budget, 100% fail without override, 110% with valid two-admin override.
- **Integration smoke test:** Open a draft PR that triggers `claude-assistant.yml`, verify the budget-gate job runs first, the warning comment posts at simulated 82% spend, and the Claude job is blocked when the gate fails.
- **Drift-detection test:** Manually rename `observe.yml.example` to `observe.yml` in a fork, run `workflow_dispatch`, verify the drift-detection step passes against the current CLI.
- **Two-admin attack tests:** Single admin applies label twice (must fail), two admins with same verified email (must fail), revoked admin (must fail), valid two distinct admins (must pass).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| HMAC key rotation breaks aggregation if both old and new artifacts coexist during cutover | Medium | High — gate fails, blocking all Claude workflows | Operator doc (task 13) prescribes a 32-day overlap window. Aggregation script accepts a list of candidate keys via `BUDGET_HMAC_KEY` and `BUDGET_HMAC_KEY_PREVIOUS` secrets during rotation; keys are tried in order. Document removal of `_PREVIOUS` after 32 days. |
| Cost estimation drift (TDD §10.2 disclaimer: 5-10% from actual billing) causes false 100% breaches | High | Medium — engineers rely on `cost:override` workaround as routine | Plan defaults to advisory mode (status comment only) for the first 30 days post-launch; promotion to required check is a separate follow-up gated on baseline data. Captured as TODO comment in `budget-gate.yml`. |
| `actionlint` flags `.example` despite config; or operators rename the example without removing the drift-check step | Medium | Low — false-positive CI failures or operator confusion | Task 11 verifies `.actionlintrc` exclusion in CI. Header comment in `observe.yml.example` explicitly tells operators to keep the drift-check step and bump it when CLI flags change. Add a CHANGELOG entry every time `autonomous-dev observe` flag surface changes. |
| Two-admin override workflow false-fails when GitHub admin API has eventual-consistency lag | Low | Medium — legitimate critical override blocked at boundary | Override-verification script retries the admin list query 3× with 10-second backoff before failing. Failure mode is "deny by default" which is acceptable; documented in operator doc as a known minor edge case. |
| Aggregation script slows the gate to >2 min as artifact count grows over the month | Low | Low — gate timeout fires | Aggregation parallelizes artifact downloads (`Promise.all` with concurrency 8). 32-day age cap bounds artifact count. Performance test in task 12 with 500 synthetic artifacts must complete in <60s. |

## Definition of Done

- [ ] `.github/workflows/budget-gate.yml` exists, passes `actionlint`, and runs as `workflow_call` reusable workflow within 2-minute timeout
- [ ] HMAC verification rejects tampered, unsigned, and >32-day-old artifacts
- [ ] Month-to-date aggregation produces correct outputs and excludes invalid artifacts
- [ ] 80% warning step posts a sticky PR comment that updates rather than duplicates on subsequent runs
- [ ] 100% fail step blocks the workflow unless `cost:override` label is applied
- [ ] 110% critical step verifies two distinct org admins with distinct verified emails per TDD §22.4
- [ ] Override labels are removed after a successful gated run (single-run validity)
- [ ] All eight Claude-powered workflows from Plans 1-3 declare `needs: [budget-gate]` and pass `actionlint`
- [ ] `.github/workflows/observe.yml.example` exists with header comment, drift-detection step, and parameterization via repo variables
- [ ] `actionlint` is configured to skip `*.example` files; `git ls-files` confirms the example is tracked
- [ ] All unit tests pass with ≥90% coverage on the three scripts
- [ ] `nektos/act` mock tests pass for under-budget, 100%-with-override, and 110%-with-two-admin scenarios
- [ ] `docs/operators/budget-gate.md` exists, is linked from `docs/operators/README.md`, and includes the HMAC-key rotation procedure
- [ ] No `actionlint` or `yamllint` warnings on the workflows directory at default severity
