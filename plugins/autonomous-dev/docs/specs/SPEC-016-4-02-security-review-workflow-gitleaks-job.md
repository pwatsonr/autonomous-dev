# SPEC-016-4-02: security-review.yml Workflow Skeleton + Gitleaks PR Job

## Metadata
- **Parent Plan**: PLAN-016-4
- **Tasks Covered**: TASK-002 (scaffold security-review workflow), TASK-003 (implement gitleaks job)
- **Estimated effort**: 2.5 hours

## Description
Create `.github/workflows/security-review.yml` -- the GitHub Actions workflow that runs the secret-scanning stage of the baseline CI. This spec covers (a) the workflow header (name, triggers, concurrency, top-level permissions) and (b) the `gitleaks` job which runs on every pull request against `main`. The job checks out full git history, executes `gitleaks/gitleaks-action@v2` with the SPEC-016-4-01 config, and posts PR comments on findings. SARIF upload, the trufflehog job, and the aggregate gate are owned by SPEC-016-4-03 and SPEC-016-4-04 respectively.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/security-review.yml` | Create | Workflow header (triggers, concurrency, permissions) plus the `gitleaks` job |

## Implementation Details

### Workflow Header

```yaml
name: security-review

on:
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Mondays 06:00 UTC -- weekly trufflehog scan (SPEC-016-4-03)
  workflow_dispatch:

permissions:
  contents: read
  security-events: write   # required for SARIF upload (SPEC-016-4-03)
  pull-requests: write     # required for gitleaks PR comments

concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true
```

Rationale:
- `permissions` is declared at workflow level (not per-job) so all jobs inherit the minimum needed scope. `security-events: write` is required by `github/codeql-action/upload-sarif@v3` even though that action runs in SPEC-016-4-03.
- `concurrency` cancels prior in-flight runs on the same ref (a PR with rapid pushes). `cancel-in-progress: true` prevents multiple gitleaks jobs racing the same PR.
- `pull_request: branches: [main]` scopes PR scanning to merge candidates; PRs targeting feature branches do not run security review (saves CI minutes; final scan happens when promoted to main).
- The `schedule` and `workflow_dispatch` triggers exist now so SPEC-016-4-03 can attach trufflehog without modifying the header.

### Gitleaks Job

```yaml
jobs:
  gitleaks:
    name: gitleaks (secret scanning)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout (full history)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0   # required for gitleaks --redact and historical scanning

      - name: Run gitleaks
        id: gitleaks
        uses: gitleaks/gitleaks-action@v2.3.7
        with:
          config-path: .github/security/gitleaks.toml
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_ENABLE_COMMENTS: "true"
          GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "true"
          GITLEAKS_ENABLE_SUMMARY: "true"

      # SARIF upload step is added in SPEC-016-4-03; this job exits with the
      # gitleaks step's status so the aggregate gate (SPEC-016-4-04) can read it.
```

Pin and behavior notes:
- `gitleaks/gitleaks-action@v2.3.7` pins to a specific minor (TDD §11). The action internally fetches gitleaks 8.x, so we get rule updates without action drift.
- The action defaults to `--redact` and writes SARIF to `gitleaks.sarif` in the workspace -- SPEC-016-4-03's upload step picks it up by path.
- `GITLEAKS_ENABLE_COMMENTS=true` posts a sticky comment on the PR summarizing findings (the `pull-requests: write` permission powers this).
- `GITLEAKS_ENABLE_UPLOAD_ARTIFACT=true` also uploads `gitleaks-report.json` as a workflow artifact (90-day retention by default), giving operators a manual review surface.
- We do NOT pass `fail-on-error` -- gitleaks-action@v2 already exits non-zero on findings by default, and the aggregate gate (SPEC-016-4-04) reads `needs.gitleaks.result`.
- `timeout-minutes: 10` bounds the scan; gitleaks on a 50K-commit repo typically completes in <2 minutes. The bound prevents stuck runners.

### Forks (Documented Limitation)

Fork PRs cannot upload SARIF (`security-events: write` is not granted to fork actors). The gitleaks job still runs, but the SARIF step (SPEC-016-4-03) silently no-ops. This is documented in `SECURITY.md` and tracked as a follow-up. No action required in this spec.

## Acceptance Criteria

- [ ] `.github/workflows/security-review.yml` exists and lints clean under `actionlint -shellcheck=` with zero warnings.
- [ ] Workflow `name` is exactly `security-review`.
- [ ] Triggers are `pull_request: branches: [main]`, `schedule: cron: '0 6 * * 1'`, and `workflow_dispatch` -- and only these three.
- [ ] Top-level `permissions` block is exactly `contents: read`, `security-events: write`, `pull-requests: write` (no extras, no missing entries).
- [ ] `concurrency.group` is `security-${{ github.ref }}` and `concurrency.cancel-in-progress` is `true`.
- [ ] The `gitleaks` job uses `runs-on: ubuntu-latest`, `timeout-minutes: 10`, and runs on every workflow trigger (no `if:` condition restricting it).
- [ ] The checkout step uses `actions/checkout@v4` with `fetch-depth: 0`.
- [ ] The gitleaks step uses `gitleaks/gitleaks-action@v2.3.7` (pinned minor; not `@v2`, not `@latest`, not `@main`).
- [ ] The gitleaks step passes `config-path: .github/security/gitleaks.toml`.
- [ ] `GITHUB_TOKEN` is passed via `env`, sourced from `secrets.GITHUB_TOKEN`.
- [ ] `GITLEAKS_ENABLE_COMMENTS=true`, `GITLEAKS_ENABLE_UPLOAD_ARTIFACT=true`, and `GITLEAKS_ENABLE_SUMMARY=true` are set.
- [ ] On a draft PR containing the planted AWS key from SPEC-016-4-01 (with the fixture path NOT in the allowlist for the test branch), the job exits non-zero AND a sticky comment is posted listing the finding.
- [ ] On a clean PR, the job exits zero, no PR comment is posted, and the run completes in <3 minutes on `ubuntu-latest`.
- [ ] No third-party actions are referenced via `@latest`, `@main`, or branch names anywhere in the file.

## Dependencies

- SPEC-016-4-01: provides `.github/security/gitleaks.toml`.
- TDD-016 §11: workflow architecture and job topology.
- PRD-007 FR-14: required-status-check governance.
- `gitleaks/gitleaks-action@v2.3.7` (pinned external action).
- `actions/checkout@v4` (pinned external action).

## Notes

- This spec deliberately stops at the gitleaks job. SPEC-016-4-03 appends the trufflehog job and SARIF upload steps; SPEC-016-4-04 appends the aggregate gate. Splitting keeps each PR small and reviewable.
- We use `gitleaks-action@v2` (which wraps gitleaks 8) rather than installing gitleaks directly because the action handles PR comment formatting, artifact upload, and SARIF generation in one step.
- The PR-comment behavior is sticky (gitleaks-action edits its prior comment on re-runs rather than appending). This avoids comment spam on rapid push cycles.
- `GITLEAKS_ENABLE_SUMMARY=true` writes a job summary to GitHub's Actions UI -- operators can see findings without leaving the run page.
- The 10-minute timeout is conservative; if scan duration approaches it, we should add `--max-target-megabytes` or shard by path. Tracked as future optimization, not a blocker.
- `actionlint` is invoked via SPEC-016-4-04's bats test; this spec just requires the file to be lint-clean.
