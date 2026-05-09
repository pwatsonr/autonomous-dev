# SPEC-034-2-04: CI Integration — Merge-Blocking Lint Jobs

## Metadata
- **Parent Plan**: PLAN-034-2 (CI Lint Gates and Voice/Copy Sweep)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) — §8 Phase 4, §10.4 enforcement summary
- **Parent PRD**: PRD-018 (Portal Visual Redesign)
- **Estimated effort**: 3 hours
- **Dependencies**: SPEC-034-2-01, SPEC-034-2-02, SPEC-034-2-03 (all three lint scripts must exist), SPEC-034-2-05 (voice sweep must land before emoji lint becomes merge-blocking; otherwise CI fails on merge of this spec)
- **Priority**: P1
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-034-2-04-ci-integration-merge-blocking.md`

## Objective

Wire all three lint scripts (`lint-css-tokens.sh`, `lint-no-emoji.sh`, `lint-box-shadow.sh`) plus the existing `scripts/check-phase-contrast.ts` into `.github/workflows/` as a merge-blocking `portal-lint` job. The job is path-filtered to run only on PRs touching portal CSS, styles, or templates; it runs all four checks in sequence and any failure blocks merge per TDD-034 §10.4 (no advisory-only checks).

## Acceptance Criteria

- AC-01: A workflow file at `.github/workflows/portal-lint.yml` (new) or a `portal-lint` job inside an existing portal workflow exists with `runs-on: ubuntu-latest`.
- AC-02: The job is gated on a `paths` filter matching `plugins/autonomous-dev-portal/server/static/**/*.css`, `plugins/autonomous-dev-portal/src/styles/**`, and `plugins/autonomous-dev-portal/server/templates/**`.
- AC-03: Job steps run in this order, each as a separate step so failures are individually attributable in the GitHub UI: (1) `lint-css-tokens.sh`, (2) `lint-box-shadow.sh`, (3) `lint-no-emoji.sh`, (4) `check-phase-contrast.ts` (Part A), (5) `check-phase-contrast.ts` (Part B).
- AC-04: Job is configured as required for merge to `main` via branch protection (documented in the PR description; the actual GitHub UI change is performed by the repo admin).
- AC-05: A deliberately broken PR — hex literal injected into `plugins/autonomous-dev-portal/src/styles/components.css` — fails the `portal-lint` job at the `lint-css-tokens.sh` step.
- AC-06: PRs that touch only non-portal files (e.g., `plugins/autonomous-dev/...`) do NOT trigger `portal-lint` (path filter works).
- AC-07: Each lint step prints the full script stdout to the CI log (no `> /dev/null` redirection) so violations are diagnosable without re-running locally.

## Implementation

Files:
- `.github/workflows/portal-lint.yml` — new workflow.
- `plugins/autonomous-dev-portal/scripts/README.md` — short reference: how to run each lint locally and the allowlist rationale (per PLAN-034-2 task 7).

Steps:
1. Author `portal-lint.yml`: trigger on `pull_request` with `paths:` filter per AC-02; one job `portal-lint` with five sequential steps per AC-03.
2. Each step uses `run: bash plugins/autonomous-dev-portal/scripts/<name>.sh` (or `bun run plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` for the TS one).
3. Add a checkout step (`actions/checkout@v4`) and, for the contrast script, a bun setup step (`oven-sh/setup-bun@v1`) before the relevant step.
4. Author `scripts/README.md`: one paragraph per script — purpose, local invocation command, allowlist rationale (1px borders, `0px` resets, structural dimensions for token lint; `design-tokens.css` exclusion for box-shadow lint; comment-line skip for emoji lint).
5. Note in the PR description that branch protection requires a separate admin change in repo settings to mark `portal-lint` as required for merge to `main`.

## Tests

- Author a draft PR that intentionally injects `color: #ff0000;` into `src/styles/components.css` and confirm `portal-lint` fails on the CSS-tokens step. Close the draft after verification.
- Author a second draft PR touching only `plugins/autonomous-dev/src/...` (non-portal) and confirm `portal-lint` does not run.

## Verification

```bash
# Local dry-run of the four checks (mirrors the CI job):
bash plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh
bash plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh
bash plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh
bun run plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts

# CI-side: confirm the workflow exists and parses.
gh workflow view portal-lint
```
