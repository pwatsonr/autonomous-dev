# PRD-017: Cleanup, Hygiene, and Operational Closeout for TDDs 010-024

| Field       | Value                                            |
|-------------|--------------------------------------------------|
| **Title**   | Cleanup, Hygiene, and Operational Closeout       |
| **PRD ID**  | PRD-017                                          |
| **Version** | 1.0                                              |
| **Date**    | 2026-05-03                                       |
| **Author**  | Patrick Watson                                   |
| **Status**  | Draft                                            |
| **Plugin**  | autonomous-dev                                   |

---

## 1. Summary

The spec→code phase closing TDDs 010-024 landed several thousand lines of production code across CI workflows, request types, standards plugins, deployment backends, credential proxy, egress firewall, and cost governance. A coverage audit on 2026-05-03 surfaced a small but real set of follow-up items that do not fit cleanly under PRD-015 (assist extension) or PRD-016 (test stabilization): dual-path source files where a successor superseded a predecessor without removing it, placeholder pinned-SHA comments awaiting upstream resolution, a missing opt-in workflow template, ~30+ specs whose "Files to Create/Modify" tables drifted from the as-built layout, and a recurring "stale stub assertion" pattern that PRD-016 will fix in tests but that has no documented prevention.

PRD-017 is a closeout PRD. It closes the production-code (non-test) hygiene loops opened during TDDs 010-024 so the autonomous-dev plugin can ship to operators with no embedded TBD markers, no orphaned dead code, and no spec/source path mismatches that would confuse first-time contributors. Scope is intentionally narrow: items in this PRD are short, mechanical, or doc-only. They do not invent new product behavior.

---

## 2. Goals

| ID    | Goal                                                                                                                                                                                                            |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| G-01  | Resolve the cost-cap dual-path: choose between migrating the orchestrator to `intake/deploy/cost-cap-enforcer.ts` (the HMAC-chained ledger-backed enforcer) or documenting both paths as intentional, then delete or annotate accordingly. |
| G-02  | Replace every `TBD-replace-with-pinned-SHA` comment in `plugins/autonomous-dev-deploy-{aws,gcp,azure,k8s}/**` and `.github/workflows/release.yml` with verified, pinned upstream SHAs before any branch-protected merge depends on them. |
| G-03  | Ship the missing `.github/workflows/observe.yml.example` template called for in PRD-010 §5.9, completing the observe-runbook surface that already includes `commands/observe.md`.                                |
| G-04  | Author a doc-only sweep PR that amends ~30+ spec "Files to Create/Modify" tables whose paths reference `src/portal/...` or `plugins/autonomous-dev/...` locations that landed under `server/...` or different plugin roots. |
| G-05  | Document the "stale stub assertion" pattern (where SPEC-N's stub is replaced by SPEC-N+1's real impl, leaving `console.warn('stub')` assertions in tests) as a lessons-learned appendix and propose a self-documenting test-tagging convention. |

## 3. Non-Goals

| ID     | Non-Goal                                                                                                                                                                                            |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| NG-01  | Not authoring new product features. PRD-017 only closes hygiene loops on already-shipped TDDs 010-024; any new behavior belongs in a separate PRD.                                                  |
| NG-02  | Not widening cleanup scope into refactors. Items here are mechanical (rename, delete, pin, doc-only). No restructuring of cost-governance, deployment, or standards subsystems.                     |
| NG-03  | Not fixing test-side path drift or stale stub assertions in test files. Those belong to PRD-016 (test stabilization). PRD-017 owns the production-code path drift and the lessons-learned appendix only. |
| NG-04  | Not introducing a new linter, CI gate, or precommit hook. The test-tagging convention proposed in G-05 is a documented convention; enforcement (if any) is deferred to a follow-up PRD.             |
| NG-05  | Not regenerating or rewriting the affected specs in full. The doc-only sweep amends "Files to Create/Modify" tables and adjacent prose — it does not re-author requirements or acceptance criteria. |
| NG-06  | Not pinning third-party action SHAs that ship outside this repo's vendored backends. Operators who fork `release.yml` are responsible for re-pinning downstream.                                     |

---

## 4. Background

### 4.1 Why these accumulate

The autonomous-dev pipeline is built spec-by-spec under a strict TDD-driven contract. Each spec lands as a passing PR, then the next spec begins. This produces high test density per landing but creates four predictable accumulation patterns:

1. **Successor-without-deletion.** When SPEC-N+1 supersedes SPEC-N's implementation, the real impl lands as a NEW file (e.g., `cost-cap-enforcer.ts`) rather than as edits to the predecessor (`cost-cap.ts`). The TDD spec→code session focuses on making SPEC-N+1's tests pass, not on tracing every caller of SPEC-N to migrate them. Result: dead code coexists with live code.

2. **Pinned-SHA placeholders.** Vendored third-party actions in deployment workflows were stubbed with `TBD-replace-with-pinned-SHA` comments per the SPEC-024-1 deviation, with the intent that the operator (or a closing PR) would resolve pins before any branch-protected workflow ran. The closing PR was never authored.

3. **Spec/source drift.** During spec authoring, paths in "Files to Create/Modify" tables reflect the architect's mental model at planning time. During spec→code, the plan-author and code-executor may relocate files (e.g., `src/portal/foo.ts` → `server/portal/foo.ts`) when integration reveals a better home. Tests get updated; specs do not.

4. **Stub-then-real-impl test debt.** SPEC-N tests typically assert `console.warn('stub')` to certify that the stub is wired. SPEC-N+1 replaces the stub with the real impl but the SPEC-N test, scoped to SPEC-N's contract, still passes "vacuously" because the stub-warning assertion gets satisfied by an unrelated log line OR is silently dropped. This is a class of test rot that no existing convention catches.

### 4.2 The tradeoff

Closing every loop synchronously inside the spec→code session would have ~doubled cycle time per spec and destabilized the mainline. The chosen tradeoff was: ship the spec, log the loop, close in a closeout PRD. PRD-017 is that closeout PRD. The follow-on cost is real but bounded — five small workstreams, all mechanical or doc-only.

### 4.3 Why now

TDDs 010-024 are complete. Operators are about to onboard via the setup wizard (extended in AMENDMENT-002). Shipping with `TBD-replace-with-pinned-SHA` strings in workflow files creates a supply-chain risk and embarrasses the project at first-impression review. Shipping with `cost-cap.ts` AND `cost-cap-enforcer.ts` coexisting forces the next contributor to read both before changing either. Shipping with stale spec paths breaks the documented "follow the spec" experience.

---

## 5. Functional Requirements

### 5.1 Cost-cap dual-path resolution

| ID       | Priority | Requirement                                                                                                                                                                                                |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1701  | P0       | The system SHALL produce a written decision record (delivered as part of this PRD's spec) selecting either Path-A (migrate orchestrator to `cost-cap-enforcer.ts`, delete `cost-cap.ts`) or Path-B (keep both with documented distinct responsibilities).                                          |
| FR-1702  | P0       | If Path-A is selected, every caller of `checkCostCap` and `recordCost` from `intake/deploy/cost-cap.ts` SHALL be migrated to the equivalent ledger-backed APIs in `intake/deploy/cost-cap-enforcer.ts`, and `intake/deploy/cost-cap.ts` SHALL be deleted in the same PR. |
| FR-1703  | P0       | If Path-A is selected, all tests previously exercising `cost-cap.ts` SHALL be ported to exercise `cost-cap-enforcer.ts`, with no net regression in test coverage of the cost-cap surface.                  |
| FR-1704  | P0       | If Path-B is selected, the distinct responsibilities SHALL be documented in JSDoc headers on both files AND in `plugins/autonomous-dev/docs/architecture/cost-governance.md` (creating that doc if absent), with explicit rules for when an operator should use each. |
| FR-1705  | P1       | Regardless of path, a unit test SHALL assert that the orchestrator's cost-check codepath produces a ledger entry (HMAC-chained) for every deploy attempt; if Path-B is chosen, the test verifies the per-env per-request enforcer also persists to the ledger via the enforcer. |

### 5.2 Cloud SHA placeholder resolution

| ID       | Priority | Requirement                                                                                                                                                                                                |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1706  | P0       | Every occurrence of the literal string `TBD-replace-with-pinned-SHA` in `plugins/autonomous-dev-deploy-aws/**`, `plugins/autonomous-dev-deploy-gcp/**`, `plugins/autonomous-dev-deploy-azure/**`, and `plugins/autonomous-dev-deploy-k8s/**` SHALL be replaced with the verified upstream SHA at the time of the closeout PR. |
| FR-1707  | P0       | Every occurrence of `TBD-replace-with-pinned-SHA` in `.github/workflows/release.yml` SHALL likewise be resolved.                                                                                             |
| FR-1708  | P0       | Each replaced SHA SHALL include a comment line in the form `# {action-name}@v{semver} ({date-pinned})` adjacent to the SHA, so future audits can verify the pin without leaving the file.                  |
| FR-1709  | P0       | A repository-level CI check (run as part of existing lint or a new `lint:no-tbd-shas` script in the closeout PR) SHALL fail the build if any `TBD-replace-with-pinned-SHA` literal reappears in the affected paths. |
| FR-1710  | P1       | The closeout PR SHALL include a one-paragraph "How to refresh pins" runbook in `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` so future bumps are reproducible.                              |

### 5.3 Missing observe.yml.example

| ID       | Priority | Requirement                                                                                                                                                                                                |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1711  | P0       | The repository SHALL ship a file at `plugins/autonomous-dev/.github/workflows/observe.yml.example` that matches the surface called for in PRD-010 §5.9 (opt-in observability workflow template).            |
| FR-1712  | P0       | The example workflow SHALL be syntactically valid GitHub Actions YAML (parseable by `actionlint`) and SHALL include header comments explaining (a) it is opt-in, (b) how to copy it to `.github/workflows/observe.yml`, and (c) which inputs and secrets it requires. |
| FR-1713  | P0       | The example workflow SHALL cross-reference `commands/observe.md` so the operator-facing runbook and the workflow template are mutually discoverable.                                                        |
| FR-1714  | P1       | A doc-only test (e.g., a markdown linter or a custom check in the existing `test:docs` suite) SHALL fail the build if `observe.yml.example` is missing, preventing regression.                              |

### 5.4 Spec path-drift sweep (production-code side)

| ID       | Priority | Requirement                                                                                                                                                                                                |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1715  | P0       | A doc-only sweep SHALL identify every spec under `plugins/autonomous-dev/docs/specs/**` whose "Files to Create/Modify" table references a path that does not exist as-built (e.g., `src/portal/...` when as-built is `server/portal/...`). |
| FR-1716  | P0       | For each affected spec, the "Files to Create/Modify" table SHALL be amended to match the as-built path, with the original path noted in a `<!-- moved-from: ... -->` HTML comment immediately above the row. |
| FR-1717  | P0       | The sweep SHALL NOT modify spec acceptance criteria, requirements, or test expectations — only path references in tables and adjacent prose.                                                                |
| FR-1718  | P1       | The sweep SHALL produce a summary table at `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md` listing every amended spec, the original path, and the as-built path, sorted by spec ID.           |
| FR-1719  | P0       | The closeout PR SHALL keep this sweep in a separate commit (or separate PR) from any code changes, so the doc-only review is independently auditable.                                                       |
| FR-1720  | P0       | This requirement applies only to the production-code side. Test-file path drift is owned by PRD-016. Specs whose only drift is in test paths SHALL be flagged in the summary table but NOT amended in this PRD. |

### 5.5 Stub-assertion staleness — lessons learned and convention

| ID       | Priority | Requirement                                                                                                                                                                                                |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1721  | P0       | A new appendix at `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md` SHALL document the pattern: SPEC-N stubs assert `console.warn('stub')`, SPEC-N+1 replaces the stub with real impl, the SPEC-N assertion silently rots. |
| FR-1722  | P0       | The appendix SHALL include at least three real examples from the spec→code session, citing the affected SPEC IDs, the stub assertion, and how it became stale.                                              |
| FR-1723  | P0       | The appendix SHALL propose a test-tagging convention (e.g., a `// @stub-of: SPEC-N` JSDoc tag on the test, or a structured `describe.skip.if(stubSuperseded)` helper) that makes stub assertions self-document. |
| FR-1724  | P1       | The proposed convention SHALL include a worked example showing how SPEC-N+1's PR can flip the tag (or unskip the test) in a single line, so the supersession is visible in the diff.                       |
| FR-1725  | P1       | The appendix SHALL note that adoption of the convention is deferred to a follow-up PRD (since enforcement requires either a custom matcher or a CI check), and SHALL list the open questions that follow-up PRD must answer. |

### 5.6 Closeout meta-requirements

| ID       | Priority | Requirement                                                                                                                                                                                                |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1726  | P0       | All five workstreams (5.1-5.5) SHALL be tracked as separate commits within the closeout effort, even when delivered in a single PR, so reviewers can review and revert independently.                       |
| FR-1727  | P0       | The closeout PR description SHALL link to this PRD and enumerate which FR-IDs each commit closes, in the form `closes FR-1701,FR-1702,FR-1703`.                                                              |
| FR-1728  | P1       | The closeout PR SHALL be the last PR merged before AMENDMENT-002 begins onboarding wizard work, so operators encountering the new wizard land on a clean tree.                                              |

---

## 6. Success Metrics

| ID    | Metric                                                                                                                                  | Baseline                                                                  | Target                                                                                              | Verification                                                       |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| SM-01 | Count of `TBD-replace-with-pinned-SHA` literals in `main` after closeout                                                                | 7+ occurrences (audit 2026-05-03)                                         | 0                                                                                                   | `git grep 'TBD-replace-with-pinned-SHA'` returns no matches.        |
| SM-02 | Orchestrator call sites for `cost-cap.ts` (Path-A) OR documented dual-path responsibilities (Path-B)                                    | Orchestrator imports `cost-cap.ts`; `cost-cap-enforcer.ts` is dead code   | Path-A: zero imports of `cost-cap.ts` and file deleted; Path-B: both files have JSDoc + arch doc   | grep imports; review of `docs/architecture/cost-governance.md`.    |
| SM-03 | Presence of `observe.yml.example`                                                                                                       | Missing                                                                   | File exists, parses with `actionlint`, references `commands/observe.md`                            | File-exists check + actionlint run in CI.                          |
| SM-04 | Spec path-drift PR merged                                                                                                               | ~30+ specs reference non-existent paths                                   | All affected specs amended, summary table at `_path-drift-amendments.md` covers every change       | Summary table row count matches grep of `<!-- moved-from: -->`.    |
| SM-05 | Lessons-learned appendix published                                                                                                      | No documentation of stub-assertion staleness pattern                      | Appendix exists with ≥3 examples and a proposed convention                                          | File-exists check + manual review.                                 |
| SM-06 | First-time-contributor onboarding success ("clone main, follow a spec, paths match")                                                    | Multiple specs would lead the contributor to a non-existent path          | Zero specs in the affected set lead to a non-existent path                                          | Manual walk-through of three randomly sampled affected specs.       |

---

## 7. Acceptance Criteria

| ID    | Criterion                                                                                                                                 |
|-------|-------------------------------------------------------------------------------------------------------------------------------------------|
| AC-01 | A closeout PR (or PR series) lands all five workstreams; each commit message references the FR-IDs it closes.                             |
| AC-02 | `git grep 'TBD-replace-with-pinned-SHA' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` returns no matches on `main`. |
| AC-03 | Either `intake/deploy/cost-cap.ts` is deleted (Path-A) OR `docs/architecture/cost-governance.md` documents the dual-path with explicit usage rules (Path-B). |
| AC-04 | `plugins/autonomous-dev/.github/workflows/observe.yml.example` exists, passes `actionlint`, and is referenced from `commands/observe.md`. |
| AC-05 | `_path-drift-amendments.md` summary table lists every amended spec; spot-check of three random rows confirms `<!-- moved-from: -->` comments are present in the corresponding spec files. |
| AC-06 | `lessons-learned/stub-assertion-staleness.md` exists, contains ≥3 cited examples, proposes a test-tagging convention, and notes follow-up PRD. |
| AC-07 | A new lint script (`lint:no-tbd-shas`) is wired into the existing CI pipeline and fails on any reintroduced `TBD-replace-with-pinned-SHA` literal in the affected paths. |
| AC-08 | No production behavior changes ship in this PRD other than the cost-cap migration if Path-A is selected; reviewer confirms via diff scan. |

---

## 8. Risks & Mitigations

| ID  | Risk                                                                                                              | Likelihood | Impact   | Mitigation                                                                                                                                       |
|-----|-------------------------------------------------------------------------------------------------------------------|------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| R1  | Path-A migration breaks an undiscovered orchestrator caller of `cost-cap.ts`.                                     | Medium     | Medium   | Run the full integration test matrix and a manual smoke against the deploy phase before merging. If Path-A is risky, default to Path-B.            |
| R2  | Pinned SHAs go stale within weeks because upstream releases new versions.                                          | High       | Low      | The "How to refresh pins" runbook (FR-1710) makes refresh reproducible; staleness is acceptable as long as pins remain valid releases.            |
| R3  | Path-drift sweep accidentally touches acceptance criteria text and changes spec semantics.                         | Low        | High     | Reviewer must inspect every diff line; FR-1717 forbids non-path edits; the doc-only commit is isolated for independent review.                    |
| R4  | The proposed test-tagging convention (FR-1723) is rejected by future maintainers, leaving the appendix as decor.   | Medium     | Low      | FR-1725 explicitly defers adoption to a follow-up PRD; the appendix's value as documentation stands even if the convention is replaced.           |
| R5  | `observe.yml.example` ships but operators copy it without reading the header comments and run an unconfigured workflow. | Medium     | Medium   | The header comments enumerate required inputs/secrets; the workflow uses `if: false` defaults until inputs are populated.                        |
| R6  | The closeout PR grows beyond a reviewable size and stalls in review.                                               | Medium     | Medium   | Workstreams are split into separate commits (FR-1726); reviewer can approve commit-by-commit or split into multiple PRs if needed.                |
| R7  | Spec path-drift sweep collides with PRD-016's test-side sweep, producing merge conflicts.                          | Medium     | Low      | NG-03 and FR-1720 carve a clean boundary; coordinate merge order via the dependency declaration in §9.                                            |

---

## 9. Dependencies

| ID  | Document / System                                                                                                          | Relationship           | Notes                                                                                                                              |
|-----|----------------------------------------------------------------------------------------------------------------------------|------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| D1  | **PRD-016: Test Stabilization** (forthcoming)                                                                              | Sibling, partial overlap| PRD-016 owns test-file path drift and stub-assertion fixes in test files. PRD-017 owns production-code path drift and the lessons-learned appendix. Some spec amendments may touch files PRD-016 also touches; merge PRD-017's doc-only sweep first to minimize churn. |
| D2  | **PRD-010: GitHub Actions CI/CD Pipeline**                                                                                 | Upstream               | Defines `observe.yml.example` requirement (PRD-010 §5.9) that FR-1711..FR-1714 satisfy.                                            |
| D3  | **PRD-014: Deployment Backends Framework**                                                                                 | Upstream               | Owns the `plugins/autonomous-dev-deploy-{aws,gcp,azure,k8s}/**` plugins where SHA placeholders live.                                |
| D4  | **TDDs 010-024** (closed)                                                                                                  | Upstream               | The TDDs whose closeout this PRD completes; no further work on those TDDs is implied.                                              |
| D5  | **AMENDMENT-002: Setup-Wizard Phase Coverage Extension**                                                                   | Downstream consumer    | AMENDMENT-002's phase-by-phase wizard onboards operators across the surfaces this PRD cleans up; merging PRD-017 first ensures the wizard demos a clean tree. |

---

## 10. Open Questions

| ID    | Question                                                                                                                                                              | Recommended Answer                                                                                                          | Owner            | Status |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|------------------|--------|
| OQ-01 | Path-A or Path-B for cost-cap dual-path?                                                                                                                              | **Path-A.** The HMAC-chained ledger is the security-stronger artifact; per-request enforcement can be a method on the same module rather than a separate file. | Cost-governance owner | Open   |
| OQ-02 | Should the SHA-pin lint script live in `package.json` `scripts` or as a dedicated GitHub Actions check?                                                                | **Both.** A npm script for local dev; a workflow step for branch protection.                                                | Platform team    | Open   |
| OQ-03 | Should the path-drift sweep cover specs that landed under PRD-008/009 even though they're outside the TDD-010-024 audit window?                                       | **Yes if the as-built path differs from the spec, no otherwise.** Audit broadly; fix narrowly.                              | Doc owner        | Open   |
| OQ-04 | Does the lessons-learned appendix belong under `docs/lessons-learned/` (new dir) or under `docs/architecture/`?                                                       | **`docs/lessons-learned/`.** Lessons-learned is a recognized doc category that doesn't muddle architecture.                | Doc owner        | Open   |
| OQ-05 | Should AMENDMENT-002 wait on PRD-017 or proceed in parallel?                                                                                                          | **Proceed in parallel; merge PRD-017 first.** AMENDMENT-002 doesn't structurally depend on PRD-017 cleanups but benefits from a clean tree at first-run wizard. | Release coordinator | Open   |
| OQ-06 | Is `actionlint` already a project dependency, or does FR-1712 introduce a new tool?                                                                                   | **Verify in the closeout PR.** If absent, add as devDependency; if present, reuse.                                          | CI owner         | Open   |
| OQ-07 | Should the test-tagging convention from FR-1723 be a comment tag (`// @stub-of: SPEC-N`), a JSDoc field, or a structured helper function?                              | **Structured helper.** Comment tags are ungreppable across linter changes; a helper produces a real call-graph edge.        | Test infra owner | Open   |

---

## 11. References

| Document                                                                                                                              | Relationship                | Key Integration Points                                                            |
|---------------------------------------------------------------------------------------------------------------------------------------|-----------------------------|-----------------------------------------------------------------------------------|
| **PRD-010: GitHub Actions CI/CD Pipeline** (`plugins/autonomous-dev/docs/prd/PRD-010-github-actions-pipeline.md`)                     | Upstream                    | §5.9 specifies the `observe.yml.example` template that FR-1711-1714 deliver.       |
| **PRD-014: Deployment Backends Framework** (`plugins/autonomous-dev/docs/prd/PRD-014-deployment-backends-framework.md`)               | Upstream                    | Defines the cloud-deploy plugins where SHA pins live.                              |
| **PRD-016: Test Stabilization** (forthcoming)                                                                                          | Sibling                     | Owns the test-file analog of the path-drift and stub-assertion fixes.              |
| **AMENDMENT-002: Setup-Wizard Phase Coverage Extension** (this branch)                                                                 | Downstream                  | Onboards operators across surfaces this PRD cleans up.                             |
| **TDD-024 spec→code session notes**                                                                                                    | Source of audit             | The 2026-05-03 audit that surfaced these items.                                    |
| **`commands/observe.md`** (`plugins/autonomous-dev/commands/observe.md`)                                                               | Companion artifact          | Operator-facing runbook that `observe.yml.example` cross-references.               |

---

*End of PRD-017: Cleanup, Hygiene, and Operational Closeout for TDDs 010-024*
