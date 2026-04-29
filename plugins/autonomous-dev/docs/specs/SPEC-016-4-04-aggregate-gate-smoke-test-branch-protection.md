# SPEC-016-4-04: Aggregate Security Gate, Smoke-Test Suite, and Branch-Protection Wiring

## Metadata
- **Parent Plan**: PLAN-016-4
- **Tasks Covered**: TASK-006 (aggregate-security-results gate), TASK-008 (branch protection update), TASK-010 (CI smoke tests)
- **Estimated effort**: 4 hours

## Description
Close out PLAN-016-4 by adding the `aggregate-security-results` gate job to `.github/workflows/security-review.yml`, wiring the resulting `security-baseline` status into branch protection on `main`, and authoring the bats smoke-test suite that validates the security workflow itself. The aggregate job depends on the `gitleaks` job from SPEC-016-4-02 (and reads its result), exits non-zero when gitleaks reports findings, and emits a log message referencing PRD-007 FR-14 so the block reason is auditable. The bats suite runs in CI to prevent silent drift in the security configuration -- it asserts gitleaks parses, the workflow lints, all actions are pinned, SARIF categories are unique, and the smoke-test fixture is allowlisted.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/security-review.yml` | Modify | Append the `aggregate-security-results` job |
| `docs/operations/branch-protection.md` | Create or modify | Add the `gh api` snippet wiring `security-baseline` as a required check on `main` |
| `tests/ci/test_security_workflow.bats` | Create | Bats suite asserting workflow integrity, action pinning, fixture allowlisting |

## Implementation Details

### Aggregate Gate Job

```yaml
  aggregate-security-results:
    name: security-baseline
    runs-on: ubuntu-latest
    needs: [gitleaks]
    if: always()
    steps:
      - name: Evaluate security scanner outcomes
        env:
          GITLEAKS_RESULT: ${{ needs.gitleaks.result }}
        run: |
          set -euo pipefail
          echo "::notice::PRD-007 FR-14 :: Security baseline gate"
          echo "gitleaks result: ${GITLEAKS_RESULT}"

          if [[ "${GITLEAKS_RESULT}" == "failure" ]]; then
            echo "::error::Security baseline FAILED: gitleaks reported a leak. See PR comment + Security tab. (PRD-007 FR-14)"
            exit 1
          fi

          if [[ "${GITLEAKS_RESULT}" == "cancelled" || "${GITLEAKS_RESULT}" == "skipped" ]]; then
            echo "::error::Security baseline INDETERMINATE: gitleaks did not run to completion (${GITLEAKS_RESULT}). (PRD-007 FR-14)"
            exit 1
          fi

          echo "Security baseline PASSED."
```

Design notes:
- `needs: [gitleaks]` -- NOT `[gitleaks, trufflehog]`. Trufflehog runs on schedule/workflow_dispatch only, not on PRs, so a PR-time aggregate that needs trufflehog would always fail-skip. The aggregate job gates ONLY the per-PR signal (gitleaks); trufflehog findings flow through the Security tab and are reviewed asynchronously by a code owner.
- `if: always()` ensures the aggregate runs even when gitleaks fails. Without it, the aggregate would also be skipped, and `security-baseline` would never report a status to branch protection -- making the required check effectively unreachable.
- The job's `name` (`security-baseline`) is what GitHub branch protection matches on. This is the contract with PRD-007 FR-14.
- Cancelled and skipped results are treated as failures because branch protection should not pass on indeterminate runs (operator could re-run with sabotaged inputs).
- The `::notice::` and `::error::` annotations surface in GitHub's Actions UI as inline annotations on the run, making the gate's reasoning self-documenting.

### Branch Protection Update (`docs/operations/branch-protection.md`)

Document MUST contain a runnable `gh api` snippet plus a checklist of required contexts. Append `security-baseline` to the existing context list (PLAN-016-1 owns the registry). Sample content:

```markdown
## Required Status Checks on `main`

The following checks are required on every PR before merge:

| Check Name | Owning Plan | Source Workflow |
|------------|-------------|-----------------|
| `lint` | PLAN-016-1 | `.github/workflows/ci.yml` |
| `unit-tests` | PLAN-016-1 | `.github/workflows/ci.yml` |
| `security-baseline` | PLAN-016-4 | `.github/workflows/security-review.yml` |

### Applying Branch Protection

```bash
gh api -X PUT \
  "repos/${OWNER}/${REPO}/branches/main/protection" \
  -F required_status_checks.strict=true \
  -F 'required_status_checks.contexts[]=lint' \
  -F 'required_status_checks.contexts[]=unit-tests' \
  -F 'required_status_checks.contexts[]=security-baseline' \
  -F enforce_admins=true \
  -F required_pull_request_reviews.required_approving_review_count=1
```

Run as a repo admin. Verify with `gh api repos/${OWNER}/${REPO}/branches/main/protection | jq '.required_status_checks.contexts'`.
```

### Bats Smoke Test (`tests/ci/test_security_workflow.bats`)

```bash
#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  WORKFLOW="${REPO_ROOT}/.github/workflows/security-review.yml"
  CONFIG="${REPO_ROOT}/.github/security/gitleaks.toml"
  FIXTURE="${REPO_ROOT}/tests/fixtures/security/leaked-aws-key.txt"
}

@test "gitleaks config parses cleanly" {
  run gitleaks detect --config "${CONFIG}" --no-git --source "$(mktemp -d)"
  [ "${status}" -eq 0 ]
}

@test "gitleaks config contains all five custom rules" {
  for rule in "anthropic-api-key" "slack-bot-token" "discord-bot-token" "github-pat" "aws-access-key"; do
    run grep -F "id = \"${rule}\"" "${CONFIG}"
    [ "${status}" -eq 0 ] || { echo "Missing rule: ${rule}" >&2; return 1; }
  done
}

@test "workflow file passes actionlint" {
  run actionlint "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "all actions in workflow are pinned to a specific version" {
  # No @latest, no @main, no bare branch refs
  run grep -E '^\s*uses:\s+[^@]+@(latest|main|master)\b' "${WORKFLOW}"
  [ "${status}" -ne 0 ]   # grep finds NOTHING -> status nonzero -> test passes
}

@test "all actions in workflow use pinned semver" {
  # Every `uses:` line MUST end in @vN.N.N or @vN
  while IFS= read -r line; do
    if ! [[ "${line}" =~ uses:[[:space:]]+[^@]+@v[0-9]+(\.[0-9]+){0,2} ]]; then
      echo "Unpinned action: ${line}" >&2
      return 1
    fi
  done < <(grep -E '^\s*uses:\s+' "${WORKFLOW}")
}

@test "SARIF upload categories are unique" {
  run grep -E '^\s+category:\s+' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  unique_count=$(grep -E '^\s+category:\s+' "${WORKFLOW}" | sort -u | wc -l | tr -d ' ')
  total_count=$(grep -cE '^\s+category:\s+' "${WORKFLOW}")
  [ "${unique_count}" -eq "${total_count}" ]
}

@test "trufflehog job is gated to schedule + workflow_dispatch only" {
  run grep -F "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "trufflehog uses --only-verified" {
  run grep -F -- "--only-verified" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "smoke fixture exists" {
  [ -f "${FIXTURE}" ]
}

@test "smoke fixture is silenced by gitleaks allowlist" {
  run gitleaks detect --config "${CONFIG}" --no-git --source "$(dirname "${FIXTURE}")"
  [ "${status}" -eq 0 ]   # allowlist quiets the finding
}

@test "smoke fixture is detected when allowlist is bypassed" {
  run gitleaks detect --config "${CONFIG}" --no-git --no-allowlist --source "$(dirname "${FIXTURE}")"
  [ "${status}" -ne 0 ]   # finding fires
  echo "${output}" | grep -F "aws-access-key"
}

@test "aggregate job is named security-baseline" {
  run grep -F "name: security-baseline" "${WORKFLOW}"
  [ "${status}" -eq 0 ]
}

@test "aggregate job needs gitleaks and uses if: always()" {
  run grep -A 4 "name: security-baseline" "${WORKFLOW}"
  echo "${output}" | grep -F "needs: [gitleaks]"
  echo "${output}" | grep -F "if: always()"
}

@test "allowlist commit exemptions stay below soft cap" {
  # Soft cap: <=5 entries before SECURITY.md exemption-log review tightens
  count=$(grep -cE '^\s+"[a-f0-9]{7,40}"' "${CONFIG}" || true)
  [ "${count}" -le 5 ] || { echo "Commit exemption count ${count} exceeds soft cap of 5" >&2; return 1; }
}
```

The bats suite runs in the existing `lint` workflow (PLAN-016-1) so it gates every PR.

## Acceptance Criteria

- [ ] The `aggregate-security-results` job exists in `security-review.yml` with `name: security-baseline`, `needs: [gitleaks]`, `if: always()`.
- [ ] When `needs.gitleaks.result == 'success'`, the aggregate job exits 0 and prints `Security baseline PASSED.`.
- [ ] When `needs.gitleaks.result == 'failure'`, the aggregate job exits 1 and emits a `::error::` annotation containing the literal text `PRD-007 FR-14`.
- [ ] When `needs.gitleaks.result == 'cancelled'` or `'skipped'`, the aggregate job exits 1.
- [ ] `docs/operations/branch-protection.md` contains a `## Required Status Checks on main` section listing `security-baseline` in the table.
- [ ] `docs/operations/branch-protection.md` contains a runnable `gh api -X PUT .../branches/main/protection` command with `security-baseline` in the `contexts[]` list.
- [ ] After running the documented `gh api` command on a test repo, `gh api repos/.../main/protection | jq '.required_status_checks.contexts'` includes `"security-baseline"`.
- [ ] `tests/ci/test_security_workflow.bats` has at least 13 tests covering: gitleaks parses, all 5 rules present, actionlint passes, all actions pinned (no @latest/@main), SARIF categories unique, trufflehog gated, `--only-verified` present, smoke fixture exists, fixture silenced by allowlist, fixture detected without allowlist, aggregate job named `security-baseline`, aggregate uses `needs: [gitleaks]` + `if: always()`, commit-exemption soft cap (≤5).
- [ ] All bats tests pass locally (`bats tests/ci/test_security_workflow.bats`) and in the CI lint workflow.
- [ ] On a draft PR with the planted AWS key NOT allowlisted, `security-baseline` reports a failure status visible to branch protection -- the PR cannot be merged.
- [ ] On a clean PR, `security-baseline` reports success and the PR becomes mergeable (assuming other required checks pass).
- [ ] Running `act -j aggregate-security-results -e <event-with-failed-gitleaks>` exits 1 with the PRD-007 FR-14 annotation present in the log.

## Dependencies

- SPEC-016-4-01: `.github/security/gitleaks.toml` and `tests/fixtures/security/leaked-aws-key.txt` (bats tests assert against both).
- SPEC-016-4-02: `gitleaks` job (the aggregate `needs:` it) and the workflow file scaffold.
- SPEC-016-4-03: trufflehog job + SARIF upload steps (the bats suite validates their shape).
- PLAN-016-1: lint workflow that runs the bats suite; required-status-check registry.
- PRD-007 FR-14: governance contract referenced in the aggregate's annotation.
- bats-core test runner (already vendored per repo CI).
- `actionlint`, `gitleaks` v8 binaries available in CI runner image.

## Notes

- The aggregate gate is intentionally minimal: today it only reads gitleaks. When future security tooling (e.g., `semgrep`, `npm audit`) is introduced, this job grows a new `needs:` entry and result check. The shape (`if: always()`, structured exit codes, PRD-007 annotation) is preserved.
- `security-baseline` is the GitHub-facing contract -- the JOB name displayed in checks, NOT the file name. Branch protection matches on this exact string. Renaming requires a synchronized update to `docs/operations/branch-protection.md` AND the `gh api` command on every protected repo.
- The `enforce_admins=true` setting in branch protection is non-negotiable for security gates: even repo admins must comply, otherwise an attacker who compromises an admin account can bypass scanning.
- The bats suite's "all actions pinned" test is a defensive layer against supply-chain attacks: an unpinned action could be hijacked at the registry level. Combined with Dependabot for action updates (configured separately), we get auditable, reviewable upgrades instead of silent drift.
- The "commit exemption soft cap" test (≤5 entries) is intentionally lenient. The intent is to nudge reviewers toward asking "should we rotate this credential instead?" before adding an exemption -- not to block legitimate exemptions. Entries above 5 require lifting the cap in this test, which itself requires PR review.
- The `act` invocation in the acceptance criteria is the local-developer reproduction path; CI runs the workflow natively via push events.
- Future plan: extract the aggregate-gate pattern into a reusable `actions/aggregate-results` composite action when a third scanner is added.
