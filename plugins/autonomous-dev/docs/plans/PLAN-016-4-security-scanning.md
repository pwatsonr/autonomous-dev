# PLAN-016-4: Security Scanning (Secrets and Dependencies)

## Metadata
- **Parent TDD**: TDD-016-baseline-ci-plugin-validation
- **Estimated effort**: 2 days
- **Dependencies**: [PLAN-016-1]
- **Blocked by**: [PLAN-016-1]
- **Priority**: P0

## Objective
Deliver the secret-scanning and dependency-scanning portion of the baseline CI: a `security` job (and supporting reusable workflow) that runs `gitleaks` v8 on every PR with a tuned allowlist, runs `trufflehog` v3 in verified-only mode on a weekly schedule, uploads SARIF reports to GitHub Code Scanning, and exposes a `security` required-status check on `main`. This plan does NOT cover Claude-powered security review (deferred to TDD-017 / PLAN-017-*); that workflow consumes the SARIF artifacts produced here but is implemented separately.

## Scope
### In Scope
- `.github/workflows/security-review.yml` with `gitleaks` and `trufflehog` jobs plus `aggregate-security-results` gating step (TDD Section 11)
- `.github/security/gitleaks.toml` allowlist with rules for Anthropic, Slack, Discord, GitHub, and AWS credential patterns and path/regex allowlists for documentation and test fixtures
- `gitleaks/gitleaks-action@v2` invocation pinned to gitleaks v8.x with `fail-on-error: true` and full git history (`fetch-depth: 0`)
- `trufflehog/trufflehog-actions-scan@v3` invocation with `--only-verified` flag, scheduled-only execution (`schedule` and `workflow_dispatch` events) to avoid PR noise from unverified findings
- SARIF upload via `github/codeql-action/upload-sarif@v3` for both scanners with distinct `category` labels (`gitleaks`, `trufflehog`) and `if: always()` so partial failures still publish results
- `security-events: write` permission scoping in the workflow header
- Concurrency group `security-${{ github.ref }}` with `cancel-in-progress: true` for PR runs
- Branch-protection update making `security-baseline` (the aggregate job) a required status check on `main`
- README/SECURITY note describing the allowlist contract and how to add commit-SHA exemptions
- Smoke test fixtures committed under `tests/fixtures/security/` with a planted dummy AWS key to verify gitleaks blocks the PR

### Out of Scope
- Claude-powered security review (`claude-code-security-review` action) -- TDD-017 and PLAN-017-*
- ESLint `plugin:security/recommended` rule wiring -- PLAN-016-1 (lint job)
- `npm audit` dependency vulnerability gate -- deferred to a future plan
- `SECURITY.md` content authoring -- repository governance task, tracked separately
- Fork-PR secret-safe fallbacks for security scanning -- deferred
- Paths-filter job -- delivered by PLAN-016-1

## Tasks

1. **Create gitleaks allowlist config** -- Author `.github/security/gitleaks.toml` with `[allowlist]` paths (test fixtures, mocks, `*.md`), regex allowlists for documentation placeholders, and the five custom `[[rules]]` blocks (Slack, Discord, Anthropic, GitHub, AWS) per TDD Section 11. Include empty `[allowlist.commits]` block for future SHA exemptions.
   - Files to create: `.github/security/gitleaks.toml`
   - Acceptance criteria: File parses with `gitleaks detect --config .github/security/gitleaks.toml --no-git` against an empty repo without errors. All five custom rules present. Path allowlist covers `plugins/autonomous-dev/tests/fixtures/.*` and `*.md`.
   - Estimated effort: 1.5h

2. **Scaffold security-review workflow** -- Create `.github/workflows/security-review.yml` with `name`, triggers (`pull_request` to main, weekly cron `0 6 * * 1`, `workflow_dispatch`), top-level `permissions` (`contents: read`, `security-events: write`, `pull-requests: write`), and concurrency group.
   - Files to create: `.github/workflows/security-review.yml`
   - Acceptance criteria: Workflow YAML lints via `actionlint` without warnings. `permissions` block matches TDD Section 11. Concurrency group is `security-${{ github.ref }}` with `cancel-in-progress: true`.
   - Estimated effort: 1h

3. **Implement gitleaks job** -- Add the `gitleaks` job per TDD Section 11: checkout with `fetch-depth: 0`, run `gitleaks/gitleaks-action@v2` with `config-path: .github/security/gitleaks.toml`, `sarif-output: gitleaks.sarif`, `fail-on-error: true`. Pass `GITHUB_TOKEN` for PR comment posting.
   - Files to modify: `.github/workflows/security-review.yml`
   - Acceptance criteria: Job runs on `pull_request` events. Uses `gitleaks-action@v2` (which pins to gitleaks 8.x). On a PR containing a planted AWS key matching the custom rule, the job exits non-zero and posts a PR comment.
   - Estimated effort: 1.5h

4. **Implement trufflehog job** -- Add the `trufflehog` job gated on `if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'`. Use `trufflehog/trufflehog-actions-scan@v3` with `extra_args: --debug --only-verified` and `base: main`, `head: ${{ github.ref }}`.
   - Files to modify: `.github/workflows/security-review.yml`
   - Acceptance criteria: Job is skipped on PR events (verified via dry-run). Job executes on the weekly cron trigger. Verified-only mode is set so unverified findings do not block.
   - Estimated effort: 1h

5. **Wire SARIF uploads** -- Add `github/codeql-action/upload-sarif@v3` steps for both jobs with `if: always()`, distinct `category` values (`gitleaks` and `trufflehog`), and the correct `sarif_file` paths (`gitleaks.sarif`, `results.sarif`).
   - Files to modify: `.github/workflows/security-review.yml`
   - Acceptance criteria: After a successful run, the GitHub Security tab shows two distinct categories. After a run where gitleaks fails, the SARIF still uploads (verified via `if: always()`). `security-events: write` permission is sufficient for upload.
   - Estimated effort: 1.5h

6. **Implement aggregate-security-results gate** -- Add the `aggregate-security-results` job with `needs: [gitleaks]`, `if: always()`, that reads `needs.gitleaks.result` and exits 1 when it is `failure`. Echo a clear message referencing PRD-007 FR-14.
   - Files to modify: `.github/workflows/security-review.yml`
   - Acceptance criteria: Aggregate job runs even when gitleaks fails (via `if: always()`). Exit code is non-zero on any gitleaks failure. Log message references "PRD-007 FR-14" so the block reason is auditable.
   - Estimated effort: 1h

7. **Add security smoke-test fixture** -- Commit `tests/fixtures/security/leaked-aws-key.txt` containing a dummy AWS key matching the `aws-access-key` rule, plus `tests/fixtures/security/README.md` explaining its purpose. Add the fixture path to gitleaks `[allowlist].paths` so the fixture itself does not trip the scanner, then add a separate test that scans WITHOUT the allowlist to prove the rule fires.
   - Files to create: `tests/fixtures/security/leaked-aws-key.txt`, `tests/fixtures/security/README.md`
   - Files to modify: `.github/security/gitleaks.toml`
   - Acceptance criteria: Repository CI run is green (fixture is allowlisted). A local `gitleaks detect --no-git --no-allowlist` (or equivalent) reports the planted key, proving the rule works.
   - Estimated effort: 1h

8. **Update branch protection for required check** -- Document and apply the branch-protection rule that makes `security-baseline` a required status check on `main`. Update `docs/operations/branch-protection.md` (or create it if absent) with the gh-cli command. Coordinate with PLAN-016-1 which owns the broader required-checks list.
   - Files to create or modify: `docs/operations/branch-protection.md`
   - Acceptance criteria: Documentation lists `security-baseline` among required contexts. The `gh api` command in the doc, when run by an admin, adds the check.
   - Estimated effort: 1h

9. **Author allowlist contributor guide** -- Add a short section to `SECURITY.md` (or create a stub if missing) describing how to add a commit-SHA exemption to `[allowlist.commits]`, how to add a path exemption, and the review requirement (security review approval) before merging an allowlist change.
   - Files to modify: `SECURITY.md` (create stub if absent)
   - Acceptance criteria: Section "Managing the Gitleaks Allowlist" exists in `SECURITY.md` with three subsections: commit exemptions, path exemptions, review process.
   - Estimated effort: 0.5h

10. **Write CI smoke tests for the workflow** -- Add `tests/ci/test_security_workflow.bats` (bats) that validates: gitleaks config parses, workflow file passes `actionlint`, all referenced action versions are pinned (no `@latest`), SARIF upload categories are unique, and the smoke fixture is in the allowlist.
    - Files to create: `tests/ci/test_security_workflow.bats`
    - Acceptance criteria: All bats tests pass locally and in CI. Coverage includes: gitleaks config schema, actionlint pass, action pinning check, SARIF category uniqueness, fixture allowlist verification.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `gitleaks.sarif` and `results.sarif` artifacts consumed by PLAN-017 (Claude-powered security review may aggregate findings).
- `security-baseline` aggregate job name used by PLAN-016-1's required-status-check configuration.
- `.github/security/gitleaks.toml` allowlist contract used by any future security tooling that wants to share patterns.
- Smoke-test fixture (`tests/fixtures/security/leaked-aws-key.txt`) reused by future fork-PR fallback testing.

**Consumes from other plans:**
- PLAN-016-1: `.github/workflows/ci.yml` skeleton, branch-protection script, and the broader required-status-check registry. This plan adds `security-baseline` to that registry; it does not own the registry itself.

## Testing Strategy

- **Static checks (CI):** `actionlint` on the workflow YAML; `gitleaks detect --config .github/security/gitleaks.toml --no-git` against the repo to verify the config parses and matches expected files.
- **Smoke test (local):** Run `gitleaks detect --no-allowlist --source tests/fixtures/security` and verify the planted AWS key is reported. Re-run with default config and verify it is silenced by the allowlist.
- **Workflow dry-run:** Use `act -j gitleaks` (or push to a draft PR) to verify the gitleaks job runs end-to-end and SARIF uploads succeed.
- **Schedule trigger test:** Manually invoke the workflow via `workflow_dispatch` to confirm trufflehog runs and uploads its SARIF.
- **Required-check verification:** After branch-protection update, open a draft PR with a planted secret; verify the PR cannot be merged until the secret is removed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `gitleaks-action@v2` major version drift breaks the workflow | Low | Medium -- CI red until pinned | Pin to a specific minor version (`gitleaks-action@v2.3.x`) and add a Dependabot rule for security-tagged action updates. Track gitleaks v8 → v9 migration as a follow-up. |
| TruffleHog `--only-verified` misses unverified-but-real secrets | Medium | High -- false negatives on credential leaks | Document the trade-off in `SECURITY.md`. Plan a future PLAN to enable `--all-verified` once we measure noise rate. Mitigation today: gitleaks runs on every PR with full pattern coverage, so unverified-but-leaked tokens still get caught by gitleaks. |
| Allowlist creep silently disables the scanner | Medium | High -- secrets slip past gitleaks | Add a pre-merge check (Task 10's bats test) that fails when `[allowlist.commits]` exceeds N entries without a corresponding entry in `SECURITY.md`'s exemption log. |
| SARIF upload fails for fork PRs because `security-events: write` is not granted | High | Low -- fork PRs cannot publish to Security tab | Out of scope here; fork-PR fallback path runs gitleaks but skips SARIF upload. This plan documents the limitation. |
| Planted-secret fixture is itself committed to history and triggers downstream tooling (other repos cloning ours) | Low | Medium -- false alarms in consumers | Use a key prefix (e.g., `AKIAEXAMPLE`) that matches the regex but is clearly synthetic. Document in `tests/fixtures/security/README.md` that the value is a fixture. |

## Definition of Done

- [ ] `.github/workflows/security-review.yml` exists with gitleaks, trufflehog, and aggregate-security-results jobs
- [ ] `.github/security/gitleaks.toml` exists with all five custom rules and the documented allowlist
- [ ] gitleaks job runs on every PR; trufflehog job runs only on schedule and workflow_dispatch
- [ ] SARIF artifacts upload successfully to GitHub Code Scanning under categories `gitleaks` and `trufflehog`
- [ ] Aggregate job exits non-zero when gitleaks finds a leak; exits zero when scans pass
- [ ] `security-baseline` is a required status check on `main` (verified via `gh api`)
- [ ] Smoke-test fixture proves the AWS-key rule fires when allowlist is bypassed
- [ ] `SECURITY.md` documents the allowlist contribution process
- [ ] All bats tests in `tests/ci/test_security_workflow.bats` pass
- [ ] No `actionlint` warnings on the workflow file
- [ ] All third-party actions pinned to a specific version (no `@latest` or `@main`)
