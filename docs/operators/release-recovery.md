# Release Recovery: Missing or Corrupted Eval Baseline

This runbook covers the failure mode where `release.yml`'s `verify-evals`
job blocks a tagged release because the `_eval-baseline` branch is
missing, empty, or corrupted.

## Symptom

A tag push fails the `verify-evals` job with one of:

- `::error::No assist eval baseline found on _eval-baseline branch; release blocked. See docs/operators/release-recovery.md`
- `::error::Assist eval baseline is below 0.85; release blocked`

The downstream `generate-changelog` and `create-release` jobs show
`skipped` status and the GitHub Release is NOT published.

## Cause

One of:

1. The `_eval-baseline` branch was deleted (manual cleanup or
   accidental `git push --delete origin _eval-baseline`).
2. First-time setup -- the nightly cron has never produced a baseline.
3. `baseline.json` on `_eval-baseline` was corrupted (manual edit,
   JSON-invalid commit, or partial push).

## Recovery Procedure

1. Trigger the assist-evals workflow against `main` and wait for completion:

   ```bash
   gh workflow run assist-evals.yml --ref main
   gh run watch
   ```

2. Verify the run passed and `eval-results.json` shows a `pass_rate` at
   or above the configured threshold (default `0.85`):

   ```bash
   gh run view --log | grep "Pass rate"
   ```

3. The cron-update step in `assist-evals.yml` runs only on `schedule`
   events. For manual recovery, locally publish the baseline:

   ```bash
   gh run download <run-id> -n eval-results-<run-id>
   git fetch origin _eval-baseline 2>/dev/null || true

   if git show-ref --verify --quiet refs/remotes/origin/_eval-baseline; then
     git checkout -B _eval-baseline origin/_eval-baseline
   else
     git checkout --orphan _eval-baseline
     git rm -rf . 2>/dev/null || true
   fi

   cp eval-results.json baseline.json
   git add baseline.json
   git commit -m "chore(evals): manual baseline recovery from run <run-id>"
   git push origin _eval-baseline
   git checkout main
   ```

4. Re-trigger the failed release by deleting the tag and re-pushing:

   ```bash
   gh release delete <tag> --yes 2>/dev/null || true
   git push origin :refs/tags/<tag>
   git tag -d <tag>
   git tag <tag> && git push origin <tag>
   ```

## Prevention

- Do NOT delete the `_eval-baseline` branch under any circumstance.
- Add `_eval-baseline` to repo branch-protection rules with
  `restrict deletion` enabled.
- Restrict force-push to `_eval-baseline` to the `github-actions[bot]`
  actor only.
- If a future workflow rewrites `baseline.json`, ensure it is
  JSON-valid by piping through `jq empty` before committing.
