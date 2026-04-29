# PLAN-017-3: Release Automation & Assist Eval Regression Gate

## Metadata
- **Parent TDD**: TDD-017-claude-workflows-release
- **Estimated effort**: 3 days
- **Dependencies**: [PLAN-017-1]
- **Blocked by**: [PLAN-017-1]
- **Priority**: P1

## Objective
Deliver two related Claude-powered workflows: (1) `release.yml` triggered by tag push `v*` that uses Claude to generate a changelog from the commit log, validates the tag against the plugin manifest's `version` field, and creates a GitHub Release with the changelog attached; (2) `assist-evals.yml` that runs the assist-plugin evaluation suite on PR + nightly cron, blocking releases when the help/troubleshoot pass-rate regresses below the configured threshold. The release workflow uses the `claude-trust-gate` composite from PLAN-017-1 for the changelog generation step (changelog content is passed via `--attach`, never interpolated). The eval workflow runs as a `needs:` dependency for `release.yml` so a regression in eval scenarios blocks the release entirely.

## Scope
### In Scope
- `.github/workflows/release.yml` triggered by `push: tags: ['v*']`
- Tag-vs-manifest version verification step that compares the pushed tag (e.g., `v0.2.0`) against `plugins/autonomous-dev/.claude-plugin/plugin.json`'s `version` field; fails if they disagree
- Changelog generation step that runs `git log <previous-tag>..HEAD --pretty=format:"%h %s"` and passes the output via `--attach` to a Claude invocation that produces a structured CHANGELOG.md entry
- Claude invocation uses the `claude-trust-gate` composite (re-used from PLAN-017-1) and the `--attach`/`--max-turns 5` pattern
- GitHub Release creation via `softprops/action-gh-release@v2` with the generated changelog as the release body and any built artifacts (plugin tarball, if produced upstream) attached
- `.github/workflows/assist-evals.yml` triggered by `pull_request` (paths: changes to `plugins/autonomous-dev-assist/skills/**` or `plugins/autonomous-dev-assist/agents/**`) AND nightly cron `0 6 * * *`
- Eval harness invocation: a script `scripts/ci/run-assist-evals.sh` that runs the assist plugin's eval suite (a deterministic set of help/troubleshoot scenarios stored in `tests/evals/assist/`) and outputs a pass-rate JSON to `eval-results.json`
- Pass-rate threshold check: configurable via `ASSIST_EVAL_THRESHOLD` repo variable, defaults to 0.85; fails the workflow if the run pass-rate is below the threshold OR if it regresses by more than 5 points from the most recent passing run on `main`
- Baseline tracking: nightly cron run on `main` writes the latest pass-rate to a `_eval-baseline` branch as a JSON file; PR runs compare against this baseline
- `release.yml` declares `needs: [verify-evals]` where `verify-evals` is a job that downloads the latest baseline and asserts the most recent main run passed
- Spend artifact emission for both workflows (HMAC-signed, consumed by PLAN-017-4)
- 10-minute timeout on `release.yml` and 15-minute timeout on `assist-evals.yml`

### Out of Scope
- The assist plugin's eval scenarios themselves -- these live in `tests/evals/assist/` and are owned by the assist-plugin team; this plan only invokes them
- Document review workflows (PRD/TDD/plan/spec/agent-meta) -- PLAN-017-2
- Budget gate enforcement -- PLAN-017-4 (this plan emits spend artifacts; the gate consumes them)
- Plugin marketplace publishing automation -- separate concern, not in TDD-017 scope
- Release branch protection rules -- ops concern, configured separately
- Multi-plugin release coordination (releasing autonomous-dev and autonomous-dev-assist together) -- handled by repo-level versioning convention; this plan validates per-plugin

## Tasks

1. **Scaffold `release.yml`** -- Create `.github/workflows/release.yml` with `on: push: tags: ['v*']`, top-level `permissions: contents: write, pull-requests: read` (write needed for releases), `concurrency: release-${{ github.ref }}` with `cancel-in-progress: false` (release runs are precious), 10-minute timeout.
   - Files to create: `.github/workflows/release.yml`
   - Acceptance criteria: `actionlint` passes. Workflow triggers only on tag push matching `v*`. Concurrency is non-cancellable. Permissions match the spec.
   - Estimated effort: 1.5h

2. **Implement tag-vs-manifest version check** -- Add a job `verify-version` that extracts the tag (`${{ github.ref_name }}` minus the leading `v`) and the manifest version from `plugins/autonomous-dev/.claude-plugin/plugin.json` via `jq`, then asserts equality. Fails with a clear message if they disagree.
   - Files to modify: `.github/workflows/release.yml`
   - Acceptance criteria: Tag `v0.2.0` with manifest version `0.2.0` passes. Tag `v0.2.0` with manifest version `0.1.9` fails with `::error::Tag v0.2.0 does not match plugin manifest version 0.1.9`. Tag `v0.2.0-rc.1` with manifest `0.2.0-rc.1` passes (semver pre-release tags supported).
   - Estimated effort: 2h

3. **Implement changelog generation via Claude** -- Add a job `generate-changelog` (depends on `verify-version` and `verify-evals`) that runs `git log <previous-tag>..HEAD --pretty=format:"%h %s"` and writes to `/tmp/commits.txt`. Then invoke `anthropics/claude-code-action@v1` via the `claude-trust-gate` composite with `claude_args: "--attach /tmp/commits.txt --max-turns 5"` and a prompt that requests a structured CHANGELOG entry (sections: Added, Changed, Deprecated, Removed, Fixed, Security). Output the generated changelog to `/tmp/changelog.md`.
   - Files to modify: `.github/workflows/release.yml`
   - Acceptance criteria: Job runs only when tasks 2 and `verify-evals` (task 7) succeed. The commit log is passed via `--attach`, never interpolated into the prompt. The generated changelog file exists and is non-empty after the step.
   - Estimated effort: 3h

4. **Implement GitHub Release creation** -- Add a job `create-release` that runs `softprops/action-gh-release@v2` with `body_path: /tmp/changelog.md`, `tag_name: ${{ github.ref_name }}`, and `generate_release_notes: false` (we use Claude's output, not GitHub's auto-generated notes). Attach any plugin artifacts present in `dist/` if the build pipeline produced them.
   - Files to modify: `.github/workflows/release.yml`
   - Acceptance criteria: A pushed tag produces a published GitHub Release with the Claude-generated changelog as the body. The release is associated with the tag (`gh release view v0.2.0` shows the changelog). Attached artifacts (if any) are downloadable from the release page.
   - Estimated effort: 2h

5. **Scaffold `assist-evals.yml`** -- Create `.github/workflows/assist-evals.yml` with `on: pull_request: paths: ['plugins/autonomous-dev-assist/skills/**', 'plugins/autonomous-dev-assist/agents/**']` AND `schedule: cron: '0 6 * * *'`, top-level `permissions: contents: read, pull-requests: write`, 15-minute timeout, `concurrency: assist-evals-${{ github.ref }}` with `cancel-in-progress: true`.
   - Files to create: `.github/workflows/assist-evals.yml`
   - Acceptance criteria: `actionlint` passes. Workflow triggers correctly on the documented paths and cron. Permissions and concurrency match the spec.
   - Estimated effort: 1.5h

6. **Implement the eval-runner script** -- Create `scripts/ci/run-assist-evals.sh` that iterates `tests/evals/assist/*.json` (each scenario describes a user prompt and an expected behavior), invokes the assist plugin's `help` or `troubleshoot` skill via the autonomous-dev CLI, scores the response using a deterministic rubric (presence of expected keywords, absence of forbidden phrases, response length bounds), and writes `eval-results.json` with `total`, `passed`, `pass_rate`, `failed_scenarios[]`.
   - Files to create: `scripts/ci/run-assist-evals.sh`, `scripts/ci/score-eval-response.js`
   - Acceptance criteria: Running the script against the existing eval scenarios produces a deterministic `eval-results.json`. The pass-rate is reproducible across runs (no flakes from non-determinism). At least 10 sample scenarios exist in `tests/evals/assist/` so the pass-rate is meaningful.
   - Estimated effort: 4h

7. **Implement the threshold check (PR + cron paths)** -- In `assist-evals.yml`, add a step that reads `eval-results.json`, compares `pass_rate` against `ASSIST_EVAL_THRESHOLD` (default 0.85), and additionally compares against the baseline from the `_eval-baseline` branch. Fails if pass_rate is below threshold OR regresses >5 points from baseline.
   - Files to modify: `.github/workflows/assist-evals.yml`
   - Acceptance criteria: Pass rate 0.90 with baseline 0.92 passes (within 5 points). Pass rate 0.86 with baseline 0.92 fails (regresses 6 points). Pass rate 0.84 with no baseline fails (below threshold). Workflow summary clearly displays the comparison.
   - Estimated effort: 2h

8. **Implement baseline-update step (cron only)** -- In `assist-evals.yml`, add a step gated on `if: github.event_name == 'schedule'` that, on a successful nightly run, commits the latest `eval-results.json` to the `_eval-baseline` branch as `baseline.json`. Use `peter-evans/create-or-update-pull-request@v6` if branch protection requires PRs; otherwise direct push.
   - Files to modify: `.github/workflows/assist-evals.yml`
   - Acceptance criteria: After a successful nightly run, `_eval-baseline` branch is updated. PR runs use the latest baseline.json. The branch is created on first run if it doesn't exist.
   - Estimated effort: 2h

9. **Wire `verify-evals` job into `release.yml`** -- Add a `verify-evals` job to `release.yml` that downloads the most recent `baseline.json` from `_eval-baseline`, asserts `pass_rate >= 0.85`, and fails the release if not. This job runs in parallel with `verify-version` and is a `needs:` for `generate-changelog`.
   - Files to modify: `.github/workflows/release.yml`
   - Acceptance criteria: With baseline pass_rate 0.90, `verify-evals` passes. With baseline pass_rate 0.80, `verify-evals` fails the release with `::error::Assist eval baseline is below 0.85; release blocked`. Without a baseline branch, the job fails (releases require a passing baseline).
   - Estimated effort: 1.5h

10. **Implement spend artifact emission** -- Both workflows produce spend artifacts in the same shape as PLAN-017-1 task 6 (HMAC-signed, fields: `workflow`, `run_id`, `actor`, `month`, `estimated_cost_usd`, `timestamp`, `hmac`). For the eval workflow the cost is the cost of running the eval scenarios (sum of per-scenario Claude invocations); for the release workflow it's the cost of the changelog generation step.
    - Files to modify: `.github/workflows/release.yml`, `.github/workflows/assist-evals.yml`
    - Acceptance criteria: Both workflows upload an artifact named `spend-estimate-<run_id>` after every run. JSON shape matches the contract from PLAN-017-1. HMAC field is non-empty and validates against the canonical-JSON computation.
    - Estimated effort: 1.5h

11. **Author 10+ baseline eval scenarios** -- Create `tests/evals/assist/setup-help-01.json` ... `troubleshoot-05.json` (10 scenarios total covering setup-wizard help, troubleshooter diagnostic flows, error-recovery prompts, ambiguous-input handling). Each scenario has `input`, `expected_keywords`, `forbidden_phrases`, `min_response_length`, `max_response_length`.
    - Files to create: `tests/evals/assist/*.json` (10 files)
    - Acceptance criteria: All 10 scenarios pass when run against the current assist plugin. Each scenario's expectations are documented in a `description` field. Scenarios cover both `help` skill and `troubleshoot` skill.
    - Estimated effort: 4h

12. **Smoke-test the full flow** -- Tag a release candidate (`v0.0.1-rc.1` against a test manifest), verify `release.yml` runs end-to-end: version check passes, eval baseline is fetched, changelog is generated, GitHub Release is created. Then deliberately push a tag where the manifest version doesn't match, verify the workflow fails. Then deliberately make an eval scenario fail and verify the threshold check blocks the release.
    - Files to modify: None (test-only)
    - Acceptance criteria: Three test runs (success, version-mismatch failure, eval-regression failure) produce the expected outcomes. The release page shows the Claude-generated changelog for the success case. The two failure cases produce clear error messages identifying which step failed and why.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `_eval-baseline` branch convention: nightly-updated baseline JSON consumed by any future workflow that wants to compare against the latest known-good eval pass-rate.
- `scripts/ci/run-assist-evals.sh` and `scripts/ci/score-eval-response.js` reusable for any plugin that adopts the same eval-scenario JSON contract.
- Spend artifact emission shared with PLAN-017-1 and PLAN-017-2.
- Release-workflow pattern (tag-version verification + Claude changelog + GitHub Release) reusable for the assist plugin's own release workflow when it gets one.

**Consumes from other plans:**
- **PLAN-017-1** (blocking): `claude-trust-gate` composite for the changelog generation step; spend artifact contract.
- **PLAN-017-4** (consumer): the budget gate is wired into both workflows via `needs: [budget-gate]` in PLAN-017-4 task 8.

## Testing Strategy

- **Eval-runner unit tests:** `tests/ci/test_score_eval_response.test.ts` covering: keyword matching (case-insensitive), forbidden phrase detection, response-length bounds, malformed scenario JSON.
- **Tag-version check unit test:** `tests/ci/test_verify_version.bats` covering: matching versions pass; mismatched fail; pre-release tags (`v0.2.0-rc.1`) handled correctly.
- **Workflow smoke tests (task 12):** Three real tag pushes covering success and two failure modes.
- **Eval-scenario validation:** All 10 scenarios from task 11 must pass against the current assist plugin (this is the baseline that future regressions are measured against).
- **Cron-trigger test:** Manually invoke `assist-evals.yml` via `workflow_dispatch` to verify the schedule path works (cron triggers can't be tested in PRs).
- **Baseline-update smoke:** After a nightly run, verify the `_eval-baseline` branch is updated and the JSON shape is correct.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Eval scenarios become non-deterministic over time as the assist plugin's responses drift | High | High -- false-failure releases blocked | Scoring uses keyword/phrase matching with permissive thresholds, not exact-string comparison. The 5-point regression threshold tolerates minor drift. Baseline updates nightly so drift is gradual, not cliff-edge. |
| Claude-generated changelog hallucinates features that aren't in the commits | Medium | High -- inaccurate release notes | Prompt explicitly instructs Claude to cite commit SHAs for every claim and to use only the attached commit log. Manual review of the first three releases verifies fidelity. After 3 successful releases, this becomes routine; before then, every release goes through a spot-check. |
| Tag-version check misses semver pre-release prefixes (e.g., tag `v0.2.0-rc.1` against manifest `0.2.0-rc.1`) | Medium | Medium -- valid releases blocked | Both extraction steps use the same `jq -r '.version'` and tag-strip logic. Test case in task 12 specifically covers pre-release tags. |
| `_eval-baseline` branch gets corrupted or deleted, blocking all releases | Low | High -- no releases possible until rebuilt | `verify-evals` gracefully detects missing baseline and emits a clear error pointing to the recovery procedure (manually run the eval workflow, push the baseline). Document the recovery in `docs/operators/release-recovery.md`. |
| `softprops/action-gh-release@v2` major version drift breaks release publishing | Low | High -- silent or noisy release failures | Pin to `@v2`. Track upstream changelog. CI smoke test in task 12 exercises the full path at least once per quarter. |
| Eval threshold (0.85) is too strict for the current assist plugin's actual quality, causing routine false-failures | Medium | Low -- threshold can be lowered without code change | Threshold is a repo variable (`ASSIST_EVAL_THRESHOLD`), not hardcoded. Operator can lower to 0.80 or 0.75 without a code change. Document the trade-off in `docs/operators/assist-evals.md`. |

## Definition of Done

- [ ] `.github/workflows/release.yml` exists, passes `actionlint`, and triggers only on `v*` tag push
- [ ] Tag-vs-manifest version check fails when versions disagree (verified)
- [ ] Claude-generated changelog uses `--attach` for commit log; no codepath interpolates commits into the prompt
- [ ] `softprops/action-gh-release@v2` creates a published release with the changelog as body
- [ ] `.github/workflows/assist-evals.yml` exists, passes `actionlint`, and triggers on PR paths + nightly cron
- [ ] `scripts/ci/run-assist-evals.sh` runs deterministically and produces `eval-results.json`
- [ ] At least 10 baseline eval scenarios exist in `tests/evals/assist/` and all pass against the current plugin
- [ ] Threshold check fails when pass-rate is below 0.85 OR regresses >5 points from baseline
- [ ] Baseline-update step runs only on cron and updates `_eval-baseline` branch on success
- [ ] `verify-evals` job in `release.yml` blocks the release when baseline is below threshold
- [ ] Both workflows emit HMAC-signed spend artifacts matching the PLAN-017-1 contract
- [ ] Smoke-test PR/tag combinations from task 12 produce the documented outcomes (success + two failure modes)
- [ ] All third-party actions pinned to a major version
