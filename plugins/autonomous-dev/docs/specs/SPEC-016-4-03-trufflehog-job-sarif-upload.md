# SPEC-016-4-03: TruffleHog Verified-Only Job + SARIF Upload to Code Scanning

## Metadata
- **Parent Plan**: PLAN-016-4
- **Tasks Covered**: TASK-004 (implement trufflehog job), TASK-005 (wire SARIF uploads for both scanners)
- **Estimated effort**: 2.5 hours

## Description
Append the `trufflehog` job and the SARIF upload steps to `.github/workflows/security-review.yml` (created in SPEC-016-4-02). The trufflehog job runs ONLY on the weekly `schedule` event and on `workflow_dispatch` -- never on PR events -- because `trufflehog/trufflehog-actions-scan@v3`'s default mode produces high-noise unverified findings that would block legitimate PRs. We pass `--only-verified` so trufflehog actively probes each suspected credential against its issuer before reporting. Both scanners (gitleaks from SPEC-016-4-02 and trufflehog from this spec) upload SARIF reports to GitHub Code Scanning under distinct categories (`gitleaks`, `trufflehog`) so the Security tab disambiguates findings by source.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/security-review.yml` | Modify | Append `trufflehog` job + add SARIF upload steps to both jobs |

## Implementation Details

### TruffleHog Job

```yaml
  trufflehog:
    name: trufflehog (verified-only, weekly)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    steps:
      - name: Checkout (full history)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run trufflehog (verified-only)
        id: trufflehog
        uses: trufflesecurity/trufflehog@v3.63.2
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
          head: HEAD
          extra_args: --debug --only-verified --json --sarif-output=results.sarif
        continue-on-error: true   # SARIF upload (next step) handles result publishing; gate logic lives in aggregate job

      - name: Upload trufflehog SARIF to Code Scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3.27.0
        with:
          sarif_file: results.sarif
          category: trufflehog
```

Behavior notes:
- The `if:` guard is the **non-negotiable** boundary that keeps trufflehog out of PR feedback loops. PR runs MUST skip this job entirely (no GitHub UI artifact, no minute consumption).
- `--only-verified` causes trufflehog to make an outbound credential-validation request to each issuer (AWS STS, Slack, etc.) for every candidate match. Findings only fire when the credential is **live**. This eliminates the "regex looks like a token but is actually a hash" false-positive class.
- `--sarif-output=results.sarif` writes the scan output to a file path the next step uploads. We do not need to parse trufflehog's stdout.
- `continue-on-error: true` lets the SARIF upload step run even when trufflehog finds verified leaks. The aggregate-security-results gate (SPEC-016-4-04) reads `needs.trufflehog.result` and fails the build accordingly. Without `continue-on-error`, the SARIF would never publish, defeating the "always upload" guarantee.
- `timeout-minutes: 30` is intentionally larger than gitleaks' 10. TruffleHog's verification step is network-bound; on a large repo with many candidates, scanning + verification can take 15-20 minutes.

### SARIF Upload Step for Gitleaks (Append to gitleaks job from SPEC-016-4-02)

```yaml
      - name: Upload gitleaks SARIF to Code Scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3.27.0
        with:
          sarif_file: gitleaks.sarif
          category: gitleaks
```

This step is appended to the `gitleaks` job's steps array. After this spec, the gitleaks job has these steps in order:
1. `actions/checkout@v4` (from SPEC-016-4-02)
2. `gitleaks/gitleaks-action@v2.3.7` (from SPEC-016-4-02)
3. `github/codeql-action/upload-sarif@v3.27.0` with `category: gitleaks` (this spec)

### Distinct Categories Rationale

GitHub Code Scanning groups findings by `category` and de-duplicates within a category but NOT across them. Using `gitleaks` and `trufflehog` as distinct categories means:
- Both scanners can find the same leak; the Security tab shows two entries (one per source) so operators can correlate.
- Resolving a finding in one tool does not silence the other -- defense in depth.
- The "Tool" column in Code Scanning displays the category, making provenance obvious.

If both jobs uploaded under the same category, gitleaks' incremental re-uploads on subsequent PRs would silently overwrite trufflehog's weekly findings. Distinct categories prevent this.

### `if: always()` Rationale

`if: always()` on each upload step ensures the SARIF publishes EVEN WHEN the preceding scanner step exits non-zero. This is critical for the GitHub Code Scanning workflow:
- An operator pushes a commit with a real leak.
- gitleaks fires, gitleaks-action exits non-zero, the gitleaks JOB is marked failed.
- Without `if: always()`, the SARIF upload would skip, and the Code Scanning UI would show stale data from the previous successful run.
- With `if: always()`, the upload happens, the Security tab reflects the new finding, and operators can dismiss/acknowledge through the UI even though the PR is blocked.

## Acceptance Criteria

- [ ] The `trufflehog` job exists in `.github/workflows/security-review.yml` with `name: trufflehog (verified-only, weekly)`.
- [ ] The `trufflehog` job's `if:` condition is exactly `github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'`.
- [ ] On a `pull_request` event, the `trufflehog` job is skipped (verified via `act` dry-run or by inspecting a PR's checks list -- no trufflehog check appears).
- [ ] On a `schedule` or `workflow_dispatch` event, the `trufflehog` job runs to completion.
- [ ] The trufflehog step uses `trufflesecurity/trufflehog@v3.63.2` (pinned minor; not `@v3`, not `@latest`).
- [ ] The trufflehog step passes `extra_args: --debug --only-verified --json --sarif-output=results.sarif`.
- [ ] The trufflehog step has `continue-on-error: true` so the SARIF upload always runs.
- [ ] The trufflehog SARIF upload step uses `github/codeql-action/upload-sarif@v3.27.0`, `if: always()`, `sarif_file: results.sarif`, `category: trufflehog`.
- [ ] The gitleaks SARIF upload step uses `github/codeql-action/upload-sarif@v3.27.0`, `if: always()`, `sarif_file: gitleaks.sarif`, `category: gitleaks`.
- [ ] After a successful run on `main`, the GitHub Security tab shows two distinct categories (`gitleaks`, `trufflehog`) under Code Scanning.
- [ ] After a run where gitleaks fails on a planted AWS key, the gitleaks SARIF still uploads (verified by inspecting the run's "Upload gitleaks SARIF" step status -- "Success" even though the gitleaks step is "Failure").
- [ ] No third-party actions are referenced via `@latest`, `@main`, or branch names.
- [ ] `actionlint -shellcheck=` passes with zero warnings on the updated file.

## Dependencies

- SPEC-016-4-02: workflow header, `gitleaks` job (this spec appends to both).
- TDD-016 §11: SARIF category contract, scheduled-only trufflehog rationale.
- PRD-007 FR-14: required-status-check governance (informs the aggregate gate in SPEC-016-4-04).
- `trufflesecurity/trufflehog@v3.63.2` (pinned external action).
- `github/codeql-action/upload-sarif@v3.27.0` (pinned external action).

## Notes

- We deliberately use `trufflesecurity/trufflehog@v3` (the official action) rather than `trufflehog/trufflehog-actions-scan@v3` (a community wrapper). The official action receives faster pattern updates and has more reliable `--only-verified` semantics.
- `--only-verified` is the linchpin of the noise-reduction strategy. If trufflehog ever ships a regression where verification is stubbed, our scan will start producing false positives. Mitigation: the bats test in SPEC-016-4-04 asserts the `extra_args` string contains `--only-verified` so an accidental removal in a future PR is caught at PR time.
- `--json` is included alongside `--sarif-output` because trufflehog's SARIF generator depends on the JSON pipeline being active. Removing `--json` silently produces an empty SARIF; this is a known footgun.
- The 30-minute timeout is generous; verified-only scans of repos under 100K commits typically finish in <10 minutes. We can reduce later once we have telemetry.
- The `if: always()` SARIF upload pattern is GitHub's officially recommended idiom for security workflows -- see `actions/codeql-action` docs.
- Future enhancement: add a third upload category (`semgrep`) when SAST is introduced. The category contract scales without re-architecting.
