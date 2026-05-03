# PRD-016: Test-Suite Stabilization & Jest Harness Migration

| Field       | Value                                                  |
|-------------|--------------------------------------------------------|
| **Title**   | Test-Suite Stabilization & Jest Harness Migration       |
| **PRD ID**  | PRD-016                                                |
| **Version** | 1.0                                                    |
| **Date**    | 2026-05-03                                             |
| **Author**  | Patrick Watson                                         |
| **Status**  | Draft                                                  |
| **Plugin**  | autonomous-dev                                         |

---

## 1. Summary

A spec/TDD coverage audit on 2026-05-03 revealed that the autonomous-dev plugin's test baseline is materially worse than prior session summaries claimed. Two systemic problems are masking a large surface of regressions and missing tests:

1. **A custom non-jest test harness** is used in 27 files under `plugins/autonomous-dev/tests/**`. The harness pattern (`async function runTests() { ... if (failed > 0) process.exit(1); } runTests();`) calls `process.exit()` from inside a jest worker, terminating the worker mid-run and aborting the entire suite before jest can produce a summary. Running `npx jest --runInBand --silent` from `plugins/autonomous-dev/` aborts on `tests/audit/log-archival.test.ts:644` and `tests/agent-factory/runtime.test.ts:616`, hiding the true pass/fail picture.
2. **A backlog of missing files and spec drift** carried over from earlier monolithic TDD landings (TDD-013/014/015/019). TDD-014 in particular shipped a security-sensitive surface (`server/auth/...`) with **zero** tests; the entire `server/auth/__tests__/*.test.ts` suite (9 files) was never written. TDD-015 is missing 3 portal pipeline production files and ~84 supporting test scaffolding files. TDD-019 is missing the plugin-reload CLI surface plus its integration test.

The visible partial output from the aborted jest run shows **24 FAIL suites and 17 PASS suites** before the worker is killed — significantly worse than the previously-claimed "3 pre-existing failing suites." Some of those FAILs are real regressions; some are the custom-harness tests crashing the worker; the project has no current way to tell them apart because the run never completes.

This PRD scopes a focused stabilization effort to (a) convert the 27 custom-harness files to idiomatic jest, (b) triage the 24 FAIL suites once the run can complete, (c) backfill TDD-014 security tests, (d) close TDD-015 portal pipeline gaps, (e) close TDD-019 plugin-reload CLI gaps, and (f) reconcile spec path-drift and Vitest/Bats references so the spec corpus matches the as-built tree. The goal is a single repeatable command — `npx jest --runInBand` — that completes cleanly, prints a real summary, and acts as the project's canonical "tests pass" gate.

---

## 2. Problem Statement

The autonomous-dev plugin has, over TDDs 002–024, accumulated a mixture of three test styles:

1. Idiomatic jest suites (`describe`/`it`/`expect`, jest config picks them up automatically).
2. A custom in-process harness inherited from pre-jest landings, which manually maintains `passed`/`failed` counters and calls `process.exit(1)` on failure.
3. Bats shell-script tests (`tests/unit/test_*.sh`) referenced in TDDs 002 and 010 but no longer exercised.

The custom harness was acceptable when the project was small enough to run individual node files via `node --loader tsx/esm tests/foo.test.ts`. As the suite grew and the project standardized on jest (see `jest.config.cjs`), the harness silently became hostile to jest's worker model. The damage compounds:

- **Hidden regressions:** When a worker calls `process.exit(1)`, jest aborts the whole run. Any suite scheduled after the offending file is reported as not-run. The visible 24 FAIL / 17 PASS partial summary is therefore an underestimate; the real number of broken suites could be higher.
- **No "green" baseline:** There is no command an operator or CI job can run today that prints a complete summary. The project's "tests pass" gate is currently aspirational.
- **Security tests missing:** TDD-014 introduced auth, CIDR utilities, Tailscale integration, OAuth+PKCE, session security, and CSRF protection — nine modules, no tests. The audit found 51 missing files for TDD-014, of which 9 are the test files for the security surface itself.
- **Spec drift erodes confidence:** ~355 files referenced by SPECs exist at relocated paths (specs say `src/portal/...`; production code lives at `plugins/autonomous-dev-portal/server/...`). Reviewers reading the SPEC corpus see references that do not match the tree, which makes the SPEC corpus look stale and untrustworthy.

The previously-claimed "3 pre-existing failing suites" baseline (full-collection-run, governance-lifecycle, scrub-integration) is still the recurring assumption in session summaries and PR descriptions. That assumption is wrong. New failing suites visible in the partial output include `parallel/*`, `agent-factory/improvement/*`, `notifications/*`, `escalation/response-handler.integration`, `safety/security-audit`, `intake/__tests__/core/reconciliation_repair`, `intake/notifications/notification_engine`, and `tests/core/test_handoff_manager`.

Until the harness is fixed, the regression count cannot be measured, the security tests cannot be backfilled with confidence, and no further TDD can claim to "leave tests green."

---

## 3. Goals

| ID   | Goal                                                                                                       |
|------|------------------------------------------------------------------------------------------------------------|
| G-01 | Convert all 27 custom-harness test files in `plugins/autonomous-dev/tests/**` to idiomatic jest (`describe`/`it`/`expect`); remove every `process.exit()` call from test code. |
| G-02 | Restore a clean, repeatable "tests pass" gate: `npx jest --runInBand` from `plugins/autonomous-dev/` completes without aborting the worker and prints a full pass/fail summary. |
| G-03 | Produce a triage matrix for the 24 newly-visible FAIL suites with per-suite disposition (FIX / SKIP-WITH-NOTE / DELETE) and an owner per row. |
| G-04 | Backfill the 9 missing TDD-014 security test files so that `server/auth/...` ships with full unit-test coverage of its public surface. |
| G-05 | Close TDD-015's portal pipeline gap by shipping the 3 missing production files (`cost-pipeline.ts`, `heartbeat-pipeline.ts`, `log-pipeline.ts`) and the supporting test scaffolding. |
| G-06 | Close TDD-019's plugin-reload CLI gap by shipping `bin/reload-plugins.js`, `src/cli/commands/plugin.ts`, `src/cli/dispatcher.ts` wiring, and the integration test. |
| G-07 | Reconcile spec path-drift: amend ~30+ SPEC files so cited paths match the as-built tree (e.g., `plugins/autonomous-dev-portal/server/...` instead of `src/portal/...`). |
| G-08 | Reconcile harness references in SPECs: ~10 specs that name Vitest must be corrected to Jest (TDD-022 chains-cli, TDD-024 cred-proxy); ~10 SPECs in TDDs 002/010 that reference Bats `tests/unit/test_*.sh` must be reconciled with the Jest-only as-built layout. |
| G-09 | Achieve a baseline regression count of zero: every suite either passes, is explicitly marked `.skip` with an inline comment citing the disposition, or has been deleted with rationale recorded in the triage matrix. |

## 4. Non-Goals

| ID    | Non-Goal                                                                                                  |
|-------|-----------------------------------------------------------------------------------------------------------|
| NG-01 | **Not a production refactor.** This PRD does not authorize behavioral changes to production code paths beyond the closeout files explicitly listed for TDD-014/015/019. If a real regression is found during triage, fixing it lands as a separate small PR referencing this PRD; we do not bundle production refactors into the harness migration. |
| NG-02 | **Not a coverage-widening initiative.** The scope is to make the existing tests run, not to add new test cases beyond what is required to close TDD-014/015/019. Branch-coverage targets, mutation testing, and integration test expansion are out of scope and tracked elsewhere. |
| NG-03 | **Not a jest-replacement evaluation.** We are standardizing on Jest because that is what `jest.config.cjs` is configured for and what the majority of suites already use. Vitest/Mocha/Tap migrations are explicitly excluded. |
| NG-04 | **Not a CI infrastructure overhaul.** The CI gate hardening (FR-1660/1661) is limited to a lint rule banning `process.exit` in test files plus removal of the legacy "3 known failures allowed" carve-out. Pipeline parallelization, caching strategy changes, and runner image updates are out of scope. |
| NG-05 | **Not a rewrite of the SPEC corpus.** The SPEC reconciliation is a path/text amendment only — no SPEC content is re-derived. If a SPEC is fundamentally wrong about behavior, it is logged as an Open Question rather than rewritten in this PR. |
| NG-06 | **Not a deletion authority.** Deleting tests requires the triage matrix to record (a) why the test was legacy, (b) whether the production code it covered is still live, and (c) named approval. Bulk deletes without that evidence are out of scope. |

---

## 5. Background

### 5.1 Why the custom harness existed

TDDs 002–009 landed during a phase when the plugin used monolithic SPEC-less drops: a single TDD shipped many files in one PR without the SPEC-NNN-X discipline that took hold from TDD-010 onward. The fastest way to produce a runnable test artifact during that period was to write a self-contained `runTests()` function that could be invoked directly with `node --loader tsx/esm` — no jest config, no mocks, no resolver tuning.

When jest was adopted as the canonical runner (see `jest.config.cjs` `testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)']`), the harness files were pulled into the jest invocation by their `.test.ts` extension. Each file's top-level `runTests()` IIFE then runs inside a jest worker. On any failure the file calls `process.exit(1)`, which jest interprets as a worker crash; the run aborts, suites scheduled later are reported as missing, and the user sees a partial transcript.

### 5.2 Why this masked regressions

Jest's default behavior on worker crash is to surface the worker error and stop. Because the harness files are scheduled early in the alphabetical/glob ordering (e.g., `tests/agent-factory/...`, `tests/audit/...`), any failure in a harness file aborts the run before higher-numbered suites are executed. The aborted run is then either:
- Misread as "the harness file failed" (true) without noticing that the run never reached the rest of the tree.
- Cited verbatim ("3 failing suites") from whatever the last-completed summary was, even though that summary predates regressions.

Both interpretations produce a recurring pattern in session notes: each TDD claims to leave tests green based on a partial run that did not exercise the full tree.

### 5.3 Why this is urgent now

TDD-014 shipped `server/auth/...` to production with no tests. The audit lists 51 missing files for TDD-014; nine of them are the security test suite (`localhost-auth`, `network-binding`, `cidr-utils`, `tailscale-auth`, `tailscale-client`, `oauth-flow`, `pkce-utils`, `session-security`, `csrf-protection`). Until the harness is fixed and jest can complete, we cannot even run those tests once they are written — which means we cannot backfill TDD-014 safely without first closing the harness gap.

---

## 6. User Stories

| ID    | Story                                                                                                                                                                                                       | Priority |
|-------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-01 | As a maintainer, I want `npx jest --runInBand` to run to completion and print a full summary so that I can trust the "tests pass" claim in PR descriptions.                                                  | P0       |
| US-02 | As a maintainer, I want a triage matrix for the 24 FAIL suites so that I can route each failure to the right owner with a clear disposition.                                                                 | P0       |
| US-03 | As a security reviewer, I want every module under `server/auth/...` to have unit-test coverage so that I can audit the auth surface against TDD-014's threat model.                                          | P0       |
| US-04 | As a portal contributor, I want the cost/heartbeat/log pipeline production files to exist so that I can wire them into the live-data settings UI per TDD-015.                                                 | P1       |
| US-05 | As an operator, I want `bin/reload-plugins.js` to exist and be wired through `src/cli/dispatcher.ts` so that I can hot-reload plugins per TDD-019.                                                            | P1       |
| US-06 | As a SPEC reviewer, I want SPEC paths to match the actual tree (no `src/portal/...` references when production code is at `plugins/autonomous-dev-portal/server/...`) so that the SPEC corpus is trustworthy. | P1       |
| US-07 | As a CI engineer, I want a lint rule that fails any test file containing `process.exit(` so that the harness anti-pattern cannot regress.                                                                     | P1       |
| US-08 | As a contributor onboarding, I want all SPEC text describing the test runner to say Jest (not Vitest, not Bats) so that I can find and run the right tests on day one.                                       | P2       |

---

## 7. Functional Requirements

### 7.1 Custom-harness migration (27 files)

| ID      | Priority | Requirement                                                                                                                                                                                                                                  |
|---------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1601 | P0       | The system SHALL convert all 27 identified custom-harness files to idiomatic jest, replacing the top-level `async function runTests()` IIFE with `describe`/`it` blocks and replacing manual `passed`/`failed` counters with `expect()` assertions. |
| FR-1602 | P0       | Every `process.exit()` call in `plugins/autonomous-dev/tests/**` SHALL be removed; assertion failures SHALL be expressed exclusively through `expect()` so that jest controls process lifecycle.                                              |
| FR-1603 | P0       | Each conversion SHALL preserve the original assertion set. Reviewers SHALL be able to compare the pre-conversion `runTests` body to the post-conversion `describe`/`it` body and verify a 1:1 mapping of checks.                              |
| FR-1604 | P0       | The 27 files in scope SHALL include, at minimum: `tests/audit/log-archival.test.ts`, `tests/agent-factory/runtime.test.ts`, `tests/pipeline/frontmatter/{validator,parser,id-generator}.test.ts`, `tests/triage/notification.test.ts`, `tests/agent-factory/{audit,discovery,parser,config,runtime,cli,agents,validator}.test.ts`, `tests/agent-factory/improvement/{observation-trigger,rate-limiter,meta-reviewer,version-classifier,proposer,weakness-report-store}.test.ts`, `tests/governance/cooldown.test.ts`. The remaining ~7 files SHALL be enumerated in the triage matrix at FR-1610. |
| FR-1605 | P0       | After migration, each previously-harness file SHALL be runnable in isolation via `npx jest <path>` and SHALL produce a jest pass/fail summary, not a custom one.                                                                              |
| FR-1606 | P1       | Where the original harness used implicit module-side-effect imports (e.g., importing a module so its `register()` runs), the migrated test SHALL replace that with explicit `beforeAll`/`beforeEach` setup so the test reads as intentional rather than incidental. |

### 7.2 Test failure triage (24 FAIL suites)

| ID      | Priority | Requirement                                                                                                                                                                                                                                                |
|---------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1610 | P0       | The system SHALL produce a triage matrix at `docs/triage/PRD-016-test-failures.md` listing every FAIL suite from a clean post-migration `npx jest --runInBand` run, with columns: suite path, failure category (regression / fixture / flake / harness-residue), disposition (FIX / SKIP-WITH-NOTE / DELETE), owner, linked SPEC or follow-up issue. |
| FR-1611 | P0       | Each FIX disposition SHALL include a one-line description of the suspected root cause and an ETA bucket (this-PR / next-PR / next-sprint).                                                                                                                  |
| FR-1612 | P0       | Each SKIP-WITH-NOTE disposition SHALL be implemented as `describe.skip(...)` or `it.skip(...)` with an inline comment of the form `// SKIP per PRD-016 triage row N: <reason>` so the rationale travels with the code.                                       |
| FR-1613 | P0       | Each DELETE disposition SHALL include (a) why the test is legacy, (b) whether the production code it covered is still live, and (c) a named approver in the matrix. Bulk deletions without all three fields SHALL be rejected at review.                    |
| FR-1614 | P0       | The triage matrix SHALL cover at minimum the failing suites already visible in the partial run: `parallel/*`, `agent-factory/improvement/*`, `notifications/*`, `escalation/response-handler.integration`, `safety/security-audit`, `intake/__tests__/core/reconciliation_repair`, `intake/notifications/notification_engine`, `tests/core/test_handoff_manager`, plus the previously-cited `full-collection-run`, `governance-lifecycle`, and `scrub-integration`. |
| FR-1615 | P1       | Suites identified as flakes SHALL be re-run a minimum of 5 times in CI before being labeled flake; consistent failures across re-runs SHALL be re-categorized as regression.                                                                                |

### 7.3 TDD-014 security test backfill (9 files)

| ID      | Priority | Requirement                                                                                                                                                                                                                       |
|---------|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1620 | P0       | The system SHALL ship 9 missing security test files under `plugins/autonomous-dev-portal/server/auth/__tests__/`: `localhost-auth.test.ts`, `network-binding.test.ts`, `cidr-utils.test.ts`, `tailscale-auth.test.ts`, `tailscale-client.test.ts`, `oauth-flow.test.ts`, `pkce-utils.test.ts`, `session-security.test.ts`, `csrf-protection.test.ts`. |
| FR-1621 | P0       | Each new security test SHALL cover the public surface of its corresponding production module: every exported function, every middleware entry point, every error path that produces a 4xx/5xx response.                              |
| FR-1622 | P0       | `localhost-auth.test.ts` SHALL verify that requests originating from non-localhost peers are rejected when localhost-only mode is enabled, and that the IPv4/IPv6 loopback aliases are handled correctly.                              |
| FR-1623 | P0       | `network-binding.test.ts` SHALL verify that the server binds only to interfaces matching the configured CIDR allowlist, and that misconfiguration produces a startup error rather than a permissive fallback.                          |
| FR-1624 | P0       | `cidr-utils.test.ts` SHALL cover IPv4 and IPv6 CIDR parsing, range membership, and edge cases (`/32`, `/128`, malformed input, empty allowlist).                                                                                       |
| FR-1625 | P0       | `tailscale-auth.test.ts` and `tailscale-client.test.ts` SHALL exercise the Tailscale identity exchange happy path and at least three failure modes (no Tailscale daemon, malformed identity, expired token).                            |
| FR-1626 | P0       | `oauth-flow.test.ts` and `pkce-utils.test.ts` SHALL verify the authorization-code-with-PKCE flow end-to-end, including PKCE challenge/verifier generation, S256 transformation, replay rejection, and state parameter validation.       |
| FR-1627 | P0       | `session-security.test.ts` SHALL verify session-cookie attributes (`HttpOnly`, `Secure`, `SameSite`), session-fixation prevention, and idle/absolute timeout enforcement.                                                              |
| FR-1628 | P0       | `csrf-protection.test.ts` SHALL verify token issuance, double-submit-cookie validation, rejection of cross-origin POST without a valid token, and correct exemption of safe (GET/HEAD/OPTIONS) methods.                                |

### 7.4 TDD-015 portal pipeline closeout (3 production files + scaffolding)

| ID      | Priority | Requirement                                                                                                                                                                                                                                                  |
|---------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1630 | P0       | The system SHALL ship the three missing portal pipeline production files: `plugins/autonomous-dev-portal/server/live-data/cost-pipeline.ts`, `.../heartbeat-pipeline.ts`, `.../log-pipeline.ts`, each implementing the contract described in TDD-015.            |
| FR-1631 | P0       | Each pipeline file SHALL have a corresponding unit test under `plugins/autonomous-dev-portal/server/live-data/__tests__/` exercising the public emit/subscribe surface and at least one error/recovery path.                                                  |
| FR-1632 | P1       | The system SHALL ship the test scaffolding (fixtures, helpers, mock providers) referenced by TDD-015's test files. The exact file list SHALL be derived from the audit's "87 missing files" set and recorded in the triage matrix.                              |
| FR-1633 | P1       | Where TDD-015's audit list contains files that are scaffolding for test code that no longer makes sense post-migration, those entries SHALL be removed from the SPEC rather than created as empty files. Removals SHALL be recorded in the SPEC reconciliation log. |

### 7.5 TDD-019 plugin-reload CLI closeout

| ID      | Priority | Requirement                                                                                                                                                                                       |
|---------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1640 | P0       | The system SHALL ship `plugins/autonomous-dev/bin/reload-plugins.js` as the executable entry point, with a `#!/usr/bin/env node` shebang and `chmod +x`.                                            |
| FR-1641 | P0       | The system SHALL ship `plugins/autonomous-dev/src/cli/commands/plugin.ts` implementing the `plugin reload` subcommand, returning structured exit codes (0 = success, 1 = transient, 2 = config error). |
| FR-1642 | P0       | The system SHALL wire the new command into `plugins/autonomous-dev/src/cli/dispatcher.ts` so that `autonomous-dev plugin reload` resolves to the new handler.                                       |
| FR-1643 | P0       | The system SHALL ship a plugin-reload integration test that boots the daemon, modifies an installed plugin, invokes `plugin reload`, and asserts the new plugin version is observed without a daemon restart. |

### 7.6 SPEC reconciliation (path-drift, Vitest, Bats)

| ID      | Priority | Requirement                                                                                                                                                                                                                                                |
|---------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1650 | P1       | The system SHALL amend SPEC files for TDDs 013/014/015 so that file paths cited in the SPECs match the as-built layout (`plugins/autonomous-dev-portal/server/...` rather than `src/portal/...`). Approximately 30+ SPEC files are in scope; the exact list SHALL be derived from the audit. |
| FR-1651 | P1       | The system SHALL amend approximately 10 SPEC files in TDD-022 (chains-cli) and TDD-024 (cred-proxy) where the SPEC text mentions Vitest, replacing those references with Jest to match the as-built test runner.                                              |
| FR-1652 | P1       | The system SHALL reconcile approximately 10 SPEC files in TDDs 002 and 010 that reference Bats `tests/unit/test_*.sh` files. Each SPEC SHALL either (a) be amended to point at the equivalent Jest suite, or (b) record explicitly that the Bats coverage was retired and link to the Jest replacement. |
| FR-1653 | P1       | All SPEC reconciliation SHALL ship as a single doc-only PR with a per-SPEC diff summary at the top of the PR description. No production code SHALL change in that PR.                                                                                          |
| FR-1654 | P2       | The system SHALL add a CI check that grep-fails on `src/portal/`, `vitest`, and `bats` token strings inside SPEC files, after the reconciliation PR merges, to prevent re-drift.                                                                                |

### 7.7 CI gate hardening

| ID      | Priority | Requirement                                                                                                                                                                                            |
|---------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1660 | P1       | The system SHALL add an ESLint rule (or jest-specific lint plugin) that flags `process.exit(` inside any `*.test.ts` or `*.spec.ts` file under `plugins/**/tests/**`, with severity `error`.            |
| FR-1661 | P1       | The CI workflow SHALL run `npx jest --runInBand --ci` from `plugins/autonomous-dev/` and fail on any non-skipped test failure. The previous "3 known failures allowed" carve-out SHALL be removed.       |
| FR-1662 | P2       | The CI workflow SHALL publish a JUnit XML report so that the GitHub Actions UI surfaces per-suite results without operators needing to scroll the raw log.                                              |

---

## 8. Success Metrics

| Metric                                                                                                                                            | Baseline (2026-05-03)                            | Target                                |
|---------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------|---------------------------------------|
| `npx jest --runInBand` from `plugins/autonomous-dev/` completes without aborting the worker.                                                       | Aborts at `tests/audit/log-archival.test.ts:644` | Completes; prints full summary.        |
| Number of suites in jest summary.                                                                                                                  | Unknown (run aborts before total is computed)    | All suites accounted for (pass/skip).  |
| Suite pass rate.                                                                                                                                   | Visible partial: 17 PASS / 41 visible (~41%)     | ≥95% pass.                             |
| `process.exit(` occurrences under `plugins/autonomous-dev/tests/**`.                                                                                | ≥27                                              | 0.                                    |
| Files under `plugins/autonomous-dev-portal/server/auth/__tests__/`.                                                                                 | 0                                                | 9.                                    |
| Coverage of `plugins/autonomous-dev-portal/server/auth/*.ts` (lines).                                                                               | 0%                                               | ≥90%.                                  |
| Triage matrix completeness: rows per FAIL suite with disposition + owner.                                                                          | 0                                                | 100% of FAIL suites.                  |
| SPEC files referencing `src/portal/`, `vitest`, or `bats` tokens.                                                                                  | ≥50                                              | 0.                                    |
| Baseline regression count (suites that fail without an explicit triage disposition).                                                               | Unmeasurable                                     | 0.                                    |

---

## 9. Acceptance Criteria

- **FR-1601:** All 27 enumerated files contain `describe`/`it`/`expect`; none contain a top-level `runTests()` IIFE; `git grep -n "runTests()" plugins/autonomous-dev/tests` returns no results.
- **FR-1602:** `git grep -n "process.exit" plugins/autonomous-dev/tests` returns no results.
- **FR-1603:** Each migration commit includes a "preserved-assertions" note in the body listing the original assertion count and the post-migration assertion count; the two numbers match.
- **FR-1604/1605:** Each enumerated file passes individually under `npx jest <path>` and prints a jest summary.
- **FR-1610:** `docs/triage/PRD-016-test-failures.md` exists; every FAIL suite from the post-migration run has a row with disposition + owner + linked SPEC/issue.
- **FR-1612:** Every `describe.skip` or `it.skip` introduced by this PRD is annotated with `// SKIP per PRD-016 triage row N: <reason>`.
- **FR-1620:** All 9 files exist under `server/auth/__tests__/`; each is non-empty and runs under jest.
- **FR-1621:** `npx jest --coverage` reports ≥90% line coverage for files under `plugins/autonomous-dev-portal/server/auth/`.
- **FR-1622–FR-1628:** Each named scenario is covered by at least one `it(...)` block whose name maps to the FR description.
- **FR-1630:** All three pipeline files exist with non-trivial implementations; each has at least one passing unit test.
- **FR-1640–FR-1643:** `bin/reload-plugins.js` is executable; `autonomous-dev plugin reload` resolves; the integration test passes end-to-end.
- **FR-1650–FR-1653:** SPEC reconciliation PR merges with no production code diff; post-merge `git grep` against `src/portal/`, `vitest`, `bats` in SPEC files returns 0 results.
- **FR-1660:** ESLint reports an error when a test file contains `process.exit(`.
- **FR-1661:** The CI job runs `npx jest --runInBand --ci` and fails on any non-skipped failure.
- **G-09:** `npx jest --runInBand` reports zero failed suites (all are pass or explicitly `.skip` with PRD-016 annotation).

---

## 10. Risks & Mitigations

| ID    | Risk                                                                                                                  | Probability | Impact | Mitigation                                                                                                                                                    |
|-------|-----------------------------------------------------------------------------------------------------------------------|-------------|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-01  | Fixing real regressions surfaced by the triage uncovers production bugs that require behavioral fixes, expanding scope. | High        | Medium | Each production fix lands as its own PR referencing PRD-016; this PRD tracks the triage but does not bundle behavioral fixes.                                  |
| R-02  | Custom-harness migration silently drops assertions (e.g., conditional checks inside the original `runTests()` are missed). | Medium      | High   | FR-1603 mandates a 1:1 assertion-count check in each migration commit body; reviewers verify pre/post counts match.                                            |
| R-03  | TDD-014 security tests reveal real auth vulnerabilities that block merge.                                              | Medium      | High   | Security findings escalate to a separate hotfix PR; PRD-016 documents the finding and its hotfix link rather than blocking the harness migration on it.        |
| R-04  | Triage labels too many suites as flakes, hiding regressions.                                                          | Medium      | Medium | FR-1615 requires 5 re-runs before flake classification; consistent failures auto-promote to regression.                                                        |
| R-05  | SPEC reconciliation churn produces large diffs that are hard to review.                                                | Medium      | Low    | FR-1653 requires per-SPEC diff summary in the PR description; reviewer can spot-check rather than read every diff.                                              |
| R-06  | Plugin-reload integration test (FR-1643) is inherently flaky due to file-watcher timing.                              | Medium      | Medium | Use deterministic invalidation (explicit cache bust) rather than file-watcher; document the chosen approach in TDD-019 SPEC amendment.                          |
| R-07  | Deleting "legacy" tests removes coverage for production code that is still live.                                       | Low         | High   | FR-1613 requires named approver + production-code-still-live check before any DELETE disposition is honored.                                                   |
| R-08  | The 24 visible FAIL suites are an under-count; post-migration run reveals >24 real failures.                          | Medium      | Medium | Triage matrix is open-ended; FR-1610 requires a row for every FAIL surfaced post-migration, not a fixed count.                                                  |

---

## 11. Dependencies

- **None on production code paths** beyond TDD-014/015/019 closeout, which is already in scope here.
- Depends on `jest.config.cjs` remaining the canonical jest configuration (no Vitest/Mocha pivot mid-PRD).
- Depends on the audit document (2026-05-03) being treated as the authoritative file-list source for scope sizing; if a new audit pass produces a different count, the triage matrix is updated rather than this PRD.
- Depends on CI runner being able to execute `npx jest --runInBand --ci` within current job timeouts; if the full run exceeds the timeout, sharding is in scope as a fast-follow but not required for first merge.

---

## 12. Open Questions

| ID    | Question                                                                                                                                       | Recommendation                                                                                                                          |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| OQ-01 | Should we delete tests that are clearly legacy (e.g., shell-based bats files retired in favor of Jest, or harness files whose target code is gone)? | Yes, but only via the FR-1613 process: documented evidence of legacy status, proof the production code is gone, and a named approver.    |
| OQ-02 | Should we add a hard CI gate that fails on `process.exit(` in test files, or rely on the lint rule alone?                                       | Both. Lint catches it locally; CI runs lint-with-error so the regression cannot reach main. (FR-1660 + FR-1661.)                          |
| OQ-03 | Should the SPEC reconciliation PR merge before or after the harness migration PR?                                                                | After. Harness migration is the higher-value change; SPEC reconciliation is doc-only and can land independently without blocking tests.   |
| OQ-04 | For TDD-015 scaffolding files where the SPEC lists test fixtures that may not be needed post-migration, do we create empty stubs or amend the SPEC? | Amend the SPEC (per FR-1633). Empty stub files exist solely to satisfy a SPEC and should not exist if the SPEC is wrong.                  |
| OQ-05 | Should TDD-014 security tests use a real Tailscale daemon in CI, or mock the Tailscale client interface?                                        | Mock at the client interface boundary. Real-daemon tests are out of scope for unit coverage; integration coverage is a separate decision. |
| OQ-06 | Do we need a baseline coverage number for the whole plugin, or only for the auth surface?                                                       | Auth surface only (≥90%). A whole-plugin coverage target is a non-goal per NG-02.                                                          |
| OQ-07 | If post-migration the suite count or pass rate is materially worse than the audit predicted, do we re-scope this PRD or split it?              | Split. Harness migration (FRs in §7.1) is the foundation; everything else can ship as a follow-on PRD-016A if scope blows up.            |

---

## 13. Out-of-Scope Carve-outs (Explicit)

For clarity to downstream TDD/Plan/Spec authors:

- The harness migration is **not** an opportunity to refactor the production modules under test. If a test reveals that the production code is awkward to test, file an issue; do not refactor in the migration PR.
- The TDD-014 security backfill is **not** an opportunity to redesign the auth surface. The tests cover what shipped. If a test reveals a vulnerability, escalate per R-03.
- The SPEC reconciliation is **not** an opportunity to re-examine SPEC content. Path/text amendments only.

---

## 14. Glossary

- **Custom harness**: The pre-jest pattern of `async function runTests() { let passed=0, failed=0; ... if (failed > 0) process.exit(1); } runTests();` at the top level of a `.test.ts` file.
- **Harness-residue failure**: A FAIL suite caused by harness behavior (e.g., `process.exit` being intercepted, or counters reading inconsistently) rather than by the production code under test.
- **Triage matrix**: The document at `docs/triage/PRD-016-test-failures.md` enumerating every FAIL suite with disposition, owner, and linked follow-up.
- **Path drift**: SPEC text citing `src/portal/...` when the as-built code lives at `plugins/autonomous-dev-portal/server/...`.
- **Jest "tests pass" gate**: The single command `npx jest --runInBand` from `plugins/autonomous-dev/` completing with zero non-skipped failures.
