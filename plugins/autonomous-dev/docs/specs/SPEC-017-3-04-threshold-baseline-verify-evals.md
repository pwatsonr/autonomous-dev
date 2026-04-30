# SPEC-017-3-04: Threshold Check, Baseline-Update Step, and verify-evals Job

## Metadata
- **Parent Plan**: PLAN-017-3
- **Tasks Covered**: Task 7 (threshold check on PR + cron paths), Task 8 (baseline-update step on cron only), Task 9 (verify-evals job in release.yml)
- **Estimated effort**: 5.5 hours
- **Spec path (after promotion)**: `plugins/autonomous-dev/docs/specs/SPEC-017-3-04-threshold-baseline-verify-evals.md`

## Description
Add the regression-detection logic to `assist-evals.yml`: compare the current run's `pass_rate` (from SPEC-017-3-03) against (a) the configurable `ASSIST_EVAL_THRESHOLD` floor and (b) the most recent baseline stored in the `_eval-baseline` branch, failing if either check trips. Add a cron-only step that publishes the latest passing run as the new baseline. Then add a `verify-evals` job to `release.yml` (built in SPEC-017-3-01/02) that downloads the baseline and blocks the release if it is below threshold or absent.

This spec closes the regression-gate loop: PRs touching assist code can no longer merge if they regress the eval pass-rate, and tagged releases cannot publish if the most recent main-branch eval run is below the threshold.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/assist-evals.yml` | Modify | Add threshold-check step (PR + cron) and baseline-update step (cron only) |
| `.github/workflows/release.yml` | Modify | Add `verify-evals` job that downloads baseline and asserts threshold |
| `scripts/ci/fetch-eval-baseline.sh` | Create | Fetches `baseline.json` from `_eval-baseline` branch via `git` or `gh api` |
| `scripts/ci/check-eval-threshold.sh` | Create | Compares pass_rate against threshold + baseline; emits clear errors |
| `docs/operators/release-recovery.md` | Create | Documents the recovery procedure when `_eval-baseline` is missing or corrupted |
| `docs/operators/assist-evals.md` | Create | Documents the threshold variable, regression rule, and how to lower the threshold |

## Implementation Details

### Configuration Surface

| Variable | Type | Default | Configured in |
|----------|------|---------|---------------|
| `ASSIST_EVAL_THRESHOLD` | repo variable (not secret) | `0.85` | GitHub repo settings → Variables |
| `_eval-baseline` branch | git ref | created by first cron run | Auto |

The threshold is a repo *variable* (not a secret) so its value can be inspected and audited; the operator can change it without a code change.

### `assist-evals.yml` — Add Threshold Check Step

Append after `Summarize results`:

```yaml
- name: Fetch baseline
  id: baseline
  if: always() && steps.summary.outputs.pass-rate != ''
  run: bash scripts/ci/fetch-eval-baseline.sh

- name: Check threshold + regression
  if: always() && steps.summary.outputs.pass-rate != ''
  env:
    THRESHOLD: ${{ vars.ASSIST_EVAL_THRESHOLD || '0.85' }}
    PASS_RATE: ${{ steps.summary.outputs.pass-rate }}
    BASELINE_RATE: ${{ steps.baseline.outputs.baseline-rate }}
  run: bash scripts/ci/check-eval-threshold.sh
```

### `assist-evals.yml` — Add Baseline-Update Step (cron-only)

```yaml
- name: Update baseline (cron only)
  if: success() && github.event_name == 'schedule' && github.ref == 'refs/heads/main'
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    set -euo pipefail
    git config user.name  "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

    # Create or update _eval-baseline branch
    git fetch origin _eval-baseline 2>/dev/null || true
    if git show-ref --verify --quiet refs/remotes/origin/_eval-baseline; then
      git checkout -B _eval-baseline origin/_eval-baseline
    else
      git checkout --orphan _eval-baseline
      git rm -rf . 2>/dev/null || true
    fi

    cp eval-results.json baseline.json
    git add baseline.json
    git commit -m "chore(evals): update baseline pass_rate from run ${GITHUB_RUN_ID}"
    git push origin _eval-baseline
```

### `scripts/ci/fetch-eval-baseline.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# Fetches baseline.json from the _eval-baseline branch.
# On success: writes baseline.json to PWD and emits baseline-rate to $GITHUB_OUTPUT.
# On absence: emits baseline-rate="" and a warning to stderr (does NOT fail).

if ! git fetch origin _eval-baseline 2>/dev/null; then
  echo "::warning::_eval-baseline branch does not exist (no prior baseline)"
  echo "baseline-rate=" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

if ! git show "origin/_eval-baseline:baseline.json" > baseline.json 2>/dev/null; then
  echo "::warning::baseline.json missing on _eval-baseline branch"
  echo "baseline-rate=" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

BASELINE_RATE="$(jq -r '.pass_rate' baseline.json)"
echo "Baseline pass_rate: $BASELINE_RATE"
echo "baseline-rate=${BASELINE_RATE}" >> "${GITHUB_OUTPUT:-/dev/null}"
```

### `scripts/ci/check-eval-threshold.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

THRESHOLD="${THRESHOLD:-0.85}"
PASS_RATE="${PASS_RATE:?PASS_RATE env var required}"
BASELINE_RATE="${BASELINE_RATE:-}"

# Compare pass_rate against threshold floor
if awk "BEGIN { exit !($PASS_RATE < $THRESHOLD) }"; then
  echo "::error::Pass rate $PASS_RATE is below threshold $THRESHOLD"
  {
    echo "## Threshold Check: FAIL"
    echo ""
    echo "- Pass rate: $PASS_RATE"
    echo "- Threshold: $THRESHOLD"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi

# Compare against baseline (>5 point regression)
if [ -n "$BASELINE_RATE" ]; then
  if awk "BEGIN { exit !( ($BASELINE_RATE - $PASS_RATE) > 0.05 ) }"; then
    REGRESSION="$(awk "BEGIN { printf \"%.4f\", $BASELINE_RATE - $PASS_RATE }")"
    echo "::error::Pass rate $PASS_RATE regresses $REGRESSION points from baseline $BASELINE_RATE (>0.05 threshold)"
    {
      echo "## Threshold Check: FAIL (regression)"
      echo ""
      echo "- Pass rate:  $PASS_RATE"
      echo "- Baseline:   $BASELINE_RATE"
      echo "- Regression: $REGRESSION (threshold: 0.05)"
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    exit 1
  fi
fi

echo "Threshold check PASS: pass_rate=$PASS_RATE threshold=$THRESHOLD baseline=${BASELINE_RATE:-<none>}"
{
  echo "## Threshold Check: PASS"
  echo ""
  echo "- Pass rate: $PASS_RATE"
  echo "- Threshold: $THRESHOLD"
  echo "- Baseline:  ${BASELINE_RATE:-<none>}"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
```

### `release.yml` — Add `verify-evals` Job

Add to `release.yml` (the workflow built in SPEC-017-3-01/02):

```yaml
verify-evals:
  name: Verify assist eval baseline
  runs-on: ubuntu-latest
  timeout-minutes: 5
  outputs:
    baseline-rate: ${{ steps.baseline.outputs.baseline-rate }}
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - name: Fetch eval baseline
      id: baseline
      run: bash scripts/ci/fetch-eval-baseline.sh

    - name: Assert baseline meets threshold
      env:
        THRESHOLD: ${{ vars.ASSIST_EVAL_THRESHOLD || '0.85' }}
        BASELINE_RATE: ${{ steps.baseline.outputs.baseline-rate }}
      run: |
        set -euo pipefail
        if [ -z "${BASELINE_RATE:-}" ]; then
          echo "::error::No assist eval baseline found on _eval-baseline branch; release blocked. See docs/operators/release-recovery.md"
          exit 1
        fi
        if awk "BEGIN { exit !($BASELINE_RATE < $THRESHOLD) }"; then
          echo "::error::Assist eval baseline is below $THRESHOLD; release blocked"
          exit 1
        fi
        echo "Baseline $BASELINE_RATE meets threshold $THRESHOLD"
```

The `generate-changelog` job from SPEC-017-3-02 already declares `needs: [verify-version, verify-evals]`. With this spec landed, the `verify-evals` reference resolves to a real job and the release pipeline gates on it.

### `docs/operators/release-recovery.md`

Document the recovery procedure (target ≤ 80 lines):

1. **Symptom**: `verify-evals` fails with "No assist eval baseline found on _eval-baseline branch".
2. **Cause**: Branch was deleted, never created (first-time setup), or `baseline.json` was corrupted.
3. **Recovery procedure**:
   a. Manually trigger `assist-evals.yml` via `gh workflow run assist-evals.yml --ref main` and wait for completion.
   b. Verify the run passed and `eval-results.json` shows pass_rate ≥ threshold.
   c. The cron-update step runs only on `schedule` events; for manual recovery, locally check out a `_eval-baseline` branch, copy `eval-results.json` to `baseline.json`, commit, and push.
   d. Re-trigger the failed release by deleting the tag (`gh release delete <tag>` and `git push origin :refs/tags/<tag>`) and re-pushing it.
4. **Prevention**: Do not delete `_eval-baseline` branch under any circumstance. Add it to repo branch-protection rules with `restrict deletion` enabled.

### `docs/operators/assist-evals.md`

Document the threshold variable and regression rule (target ≤ 100 lines):

1. **What it does**: PR runs and nightly cron evaluate the assist plugin against the seed scenarios in `tests/evals/assist/`. Failure to meet the threshold blocks merge (PR) or release (tag push).
2. **Threshold**: Repo variable `ASSIST_EVAL_THRESHOLD` (default 0.85). Lower it (e.g., to 0.80) by editing the variable in repo settings — no code change required.
3. **Regression rule**: A PR's pass_rate must be within 0.05 of the baseline (the most recent successful main-branch nightly run). A pass_rate of 0.86 against baseline 0.92 fails (regresses 0.06).
4. **Baseline lifecycle**: Updated by the cron job after every successful nightly run on `main`. PRs always compare against the latest baseline.
5. **How to lower the threshold safely**: (a) Investigate the cause of the regression; (b) if the new behavior is intentional, lower the threshold AND update the affected scenarios' `expected_keywords` so they pass against the new behavior; (c) if the regression is a bug, fix the bug rather than lowering the threshold.

## Acceptance Criteria

### `assist-evals.yml` modifications

- [ ] `actionlint` exits 0 on the modified workflow.
- [ ] Threshold-check step runs on every PR and cron event.
- [ ] Baseline-update step runs ONLY when `github.event_name == 'schedule'` AND `github.ref == 'refs/heads/main'` AND the prior step succeeded.
- [ ] Pass rate 0.90 with baseline 0.92 PASSES (regression of 0.02 ≤ 0.05).
- [ ] Pass rate 0.86 with baseline 0.92 FAILS with stderr containing the exact line `::error::Pass rate 0.86 regresses 0.06 points from baseline 0.92 (>0.05 threshold)` (numeric formatting may vary; the substring `regresses` and the values must appear).
- [ ] Pass rate 0.84 with no baseline FAILS with stderr containing `::error::Pass rate 0.84 is below threshold 0.85`.
- [ ] Pass rate 0.84 with baseline 0.92 FAILS with the threshold error (threshold check runs first).
- [ ] When `_eval-baseline` branch does not exist, `fetch-eval-baseline.sh` emits a `::warning::` and sets `baseline-rate=""` — does NOT fail the workflow on the PR path.
- [ ] After a successful nightly cron run on `main`, `_eval-baseline` branch is created (first time) or updated (subsequent runs) with `baseline.json` matching the run's `eval-results.json`.
- [ ] The branch is created as an orphan branch (no main-history files), containing only `baseline.json`.
- [ ] Workflow summary clearly displays a `## Threshold Check: PASS` or `FAIL` block with the relevant numbers.

### `release.yml` modifications

- [ ] `verify-evals` job exists with `timeout-minutes: 5`.
- [ ] `verify-evals` runs in parallel with `verify-version` (no `needs:` between them).
- [ ] `generate-changelog` job declares `needs: [verify-version, verify-evals]` (matches the contract SPEC-017-3-02 anticipated).
- [ ] With baseline pass_rate 0.90, `verify-evals` passes.
- [ ] With baseline pass_rate 0.80 (and threshold 0.85), `verify-evals` fails with stderr containing the exact line `::error::Assist eval baseline is below 0.85; release blocked`.
- [ ] Without a `_eval-baseline` branch, `verify-evals` fails with stderr containing `::error::No assist eval baseline found on _eval-baseline branch; release blocked. See docs/operators/release-recovery.md`.
- [ ] When `verify-evals` fails, `generate-changelog` and `create-release` show "skipped" status, not "failed" — the release does NOT publish.

### Documentation

- [ ] `docs/operators/release-recovery.md` exists, ≤ 80 lines, documents symptom/cause/recovery/prevention.
- [ ] `docs/operators/assist-evals.md` exists, ≤ 100 lines, documents threshold variable, regression rule, baseline lifecycle, and safe-lower procedure.
- [ ] Both docs are linked from the workflow header comments in `assist-evals.yml` and `release.yml` respectively.

## Dependencies

- **Blocking**: SPEC-017-3-01 (release.yml scaffold + spend emitter).
- **Blocking**: SPEC-017-3-03 (assist-evals.yml scaffold + eval-results.json contract + `pass-rate` job output).
- **Soft**: SPEC-017-3-02 (changelog/release jobs). This spec wires `verify-evals` such that SPEC-017-3-02's `generate-changelog` `needs:` reference resolves. Order of merge: 01 → 03 → 04 → 02 is the cleanest; 01 → 02 (with TODO) → 03 → 04 also works.
- **Permission precondition**: `secrets.GITHUB_TOKEN` provides write access to push the `_eval-baseline` branch. Default token permissions in repo settings must allow `contents: write` for `GITHUB_TOKEN`. If branch protection rules cover `_eval-baseline`, configure an exception for the `github-actions[bot]` actor or switch to `peter-evans/create-or-update-pull-request@v6`.
- **Variable precondition**: Operator may set `ASSIST_EVAL_THRESHOLD` in repo Variables; absence falls back to default `0.85`.

## Notes

- The threshold-check failure messages use specific numeric formatting (`%.4f` from `awk`). Test assertions should match on substring (`regresses`, `below threshold`) rather than exact decimal-place formatting to avoid brittleness.
- The 5-point (0.05) regression tolerance is a deliberate choice from PLAN-017-3 §Risks: scenarios drift, and a hard-cliff comparison would produce false-failures every time the assist plugin's phrasing shifts. The baseline updates nightly so drift is gradual.
- The orphan-branch approach for `_eval-baseline` keeps the branch small (single file, no main history) and avoids merge conflicts. Operators should never `git merge main` into `_eval-baseline`.
- The cron-only gate on the baseline-update step prevents PR runs from updating the baseline (a regression PR could otherwise lower the bar for itself).
- `peter-evans/create-or-update-pull-request@v6` is mentioned in PLAN-017-3 task 8 as a fallback if branch protection blocks direct push. This spec defaults to direct push for simplicity; adopt the PR-based fallback only if branch protection is enabled on `_eval-baseline`. Document the choice in `docs/operators/assist-evals.md`.
- The `verify-evals` job in `release.yml` does NOT re-run the eval suite — it trusts the most recent main-branch baseline. This makes releases fast (≤ 5 min for verify-evals) at the cost of relying on cron freshness. If a regression lands on main but the cron has not yet run, the next release uses the still-passing prior baseline. Acceptable per PLAN-017-3 §Risks.
- Future enhancement: a `workflow_dispatch` trigger on `assist-evals.yml` lets operators force a baseline refresh without waiting for the cron. Out of scope for this spec; add when needed.
