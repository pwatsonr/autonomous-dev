# Release Workflow Smoke Tests

This runbook documents the three operator-driven smoke-test procedures
that validate the `release.yml` workflow end-to-end (SPEC-017-3-02 task 12).

Run procedure 1 once after the initial merge of PLAN-017-3, then re-run
procedures 2 and 3 any time the workflow's job graph or trust model
changes. Procedures should be executed against the live repository on a
disposable tag (`v0.0.1-rc.*`); cleanup steps below remove the test
artifact.

## Procedure 1 — Success Case

**Goal**: Verify the full pipeline (`verify-version` → `verify-evals` →
`generate-changelog` → `create-release`) publishes a GitHub Release with a
Claude-generated changelog body.

**Preconditions**

- `_eval-baseline` branch exists with a `baseline.json` whose
  `pass_rate` is at or above `vars.ASSIST_EVAL_THRESHOLD` (default 0.85).
- `secrets.ANTHROPIC_API_KEY` and `secrets.BUDGET_HMAC_KEY` are set.

**Commands**

```bash
# Bump the manifest to a release-candidate version.
jq '.version = "0.0.1-rc.1"' \
  plugins/autonomous-dev/.claude-plugin/plugin.json > /tmp/p.json && \
  mv /tmp/p.json plugins/autonomous-dev/.claude-plugin/plugin.json
git commit -am "chore: bump to 0.0.1-rc.1 for smoke test"
git push origin main
git tag v0.0.1-rc.1 && git push origin v0.0.1-rc.1
```

**Expected**

- All four jobs succeed in `gh run list --workflow=release.yml`.
- `gh release view v0.0.1-rc.1` displays a body that begins with
  `## v0.0.1-rc.1 — YYYY-MM-DD` and contains at least one entry with a
  parenthesized commit SHA, e.g. `(a1b2c3d)`.
- A `spend-estimate-<run_id>` and `spend-estimate-<run_id>-changelog`
  artifact are present on the run.

**Cleanup**

```bash
gh release delete v0.0.1-rc.1 --yes
git push origin :refs/tags/v0.0.1-rc.1
git tag -d v0.0.1-rc.1
# Revert manifest bump
git revert HEAD --no-edit && git push origin main
```

## Procedure 2 — Version-Mismatch Failure

**Goal**: Verify `verify-version` blocks a release when the pushed tag
does not match the plugin manifest, and downstream jobs are skipped (not
failed).

**Preconditions**: same as Procedure 1.

**Commands**

```bash
# Manifest at 0.0.2-rc.1 -- intentionally mismatched against the tag.
jq '.version = "0.0.2-rc.1"' \
  plugins/autonomous-dev/.claude-plugin/plugin.json > /tmp/p.json && \
  mv /tmp/p.json plugins/autonomous-dev/.claude-plugin/plugin.json
git commit -am "chore: bump to 0.0.2-rc.1 for mismatch smoke test"
git push origin main
git tag v0.0.3-rc.1 && git push origin v0.0.3-rc.1
```

**Expected**

- `verify-version` job fails with stderr containing the exact line
  `::error::Tag v0.0.3-rc.1 does not match plugin manifest version 0.0.2-rc.1`.
- `generate-changelog` and `create-release` show `skipped` status (not
  `failed`).
- No GitHub Release is created (`gh release view v0.0.3-rc.1` returns
  "release not found").

**Cleanup**

```bash
git push origin :refs/tags/v0.0.3-rc.1
git tag -d v0.0.3-rc.1
git revert HEAD --no-edit && git push origin main
```

## Procedure 3 — Eval-Regression Failure

**Goal** (deferred until SPEC-017-3-04 is merged): Verify `verify-evals`
blocks a release when the most recent baseline `pass_rate` is below
`vars.ASSIST_EVAL_THRESHOLD`.

**Preconditions**

- SPEC-017-3-04 has been merged and `verify-evals` exists in `release.yml`.
- A test branch exists allowing temporary modification of
  `_eval-baseline`.

**Commands**

```bash
# Force the baseline to a low pass-rate.
git fetch origin _eval-baseline
git checkout _eval-baseline
jq '.pass_rate = 0.50' baseline.json > /tmp/b.json && mv /tmp/b.json baseline.json
git commit -am "chore(test): force low baseline for smoke test"
git push origin _eval-baseline
git checkout main
git tag v0.0.1-rc.2 && git push origin v0.0.1-rc.2
```

**Expected**

- `verify-evals` fails with stderr containing
  `::error::Assist eval baseline is below 0.85; release blocked`.
- `generate-changelog` and `create-release` show `skipped`.

**Cleanup**

```bash
# Restore prior baseline (revert the test commit on _eval-baseline).
git checkout _eval-baseline
git revert HEAD --no-edit
git push origin _eval-baseline
git checkout main
git push origin :refs/tags/v0.0.1-rc.2
git tag -d v0.0.1-rc.2
```

After Procedure 1, manually spot-check the Claude-generated changelog
body for the first three real releases (per PLAN-017-3 §Risks). Reject
and re-author the release if the body contains entries that are not
traceable to the parenthesized SHAs.
