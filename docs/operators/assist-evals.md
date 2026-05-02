# Assist Evals: Threshold, Regression Rule, Baseline Lifecycle

The `assist-evals.yml` workflow scores the autonomous-dev-assist plugin
against a fixed set of seed scenarios in `tests/evals/assist/` and
blocks PRs (and tagged releases via `release.yml::verify-evals`) when
the pass-rate degrades.

## What it does

- Runs on every PR that touches assist code or eval scaffolding.
- Runs nightly at 06:00 UTC against `main`.
- Each scenario is invoked through `autodev assist <skill> --prompt
  <input>` and scored by `scripts/ci/score-eval-response.js` (keyword /
  forbidden-phrase / length checks).
- Failure to meet the configured threshold blocks merge (PR runs) or
  release (tag-push runs against the latest baseline).

## Threshold

The threshold is a repo-level **variable** (not a secret) so its value
is visible in repo settings and audit logs:

| Variable | Default | Where to set |
|----------|---------|--------------|
| `ASSIST_EVAL_THRESHOLD` | `0.85` | Repo settings → Variables → Actions |

Lowering or raising the threshold requires NO code change -- edit the
variable in repo settings.

## Regression Rule

A PR's `pass_rate` must be within `0.05` (5 percentage points) of the
most recent baseline. The baseline is the latest successful nightly
cron run on `main`. Examples:

| Baseline | PR pass_rate | Result |
|----------|--------------|--------|
| 0.92 | 0.90 | PASS (regression 0.02 ≤ 0.05) |
| 0.92 | 0.86 | FAIL (regression 0.06 > 0.05) |
| —    | 0.84 | FAIL (below 0.85 threshold; threshold check runs first) |
| —    | 0.90 | PASS (no baseline yet; only threshold check enforced) |

The 0.05 tolerance reflects PLAN-017-3 §Risks: scenario phrasing drifts
naturally, and a hard-cliff comparison would produce false-failures
every time the assist plugin's wording shifts. The baseline updates
nightly so drift is gradual and operator-visible.

## Baseline Lifecycle

- Stored on the orphan branch `_eval-baseline` as a single file:
  `baseline.json` (copy of the most recent successful
  `eval-results.json`).
- Updated automatically by the cron job after every successful nightly
  run on `main`. PRs always compare against the most recent baseline.
- The `verify-evals` job in `release.yml` reads this same file -- a
  release is allowed only when the latest baseline is at or above
  threshold.
- Direct push by `github-actions[bot]` is the default mechanism. If
  branch protection on `_eval-baseline` is enabled, switch to
  `peter-evans/create-or-update-pull-request@v6` and merge the bot's
  baseline-update PRs as part of the cron run (PLAN-017-3 task 8).

## How to lower the threshold safely

1. **Investigate first.** A regression usually means either (a) the
   assist plugin behavior changed intentionally and scenarios need
   updating, or (b) a real bug landed. Rule out (b) before changing
   the bar.
2. **If intentional behavior change**: lower the variable AND update
   the affected scenarios' `expected_keywords` so they pass against the
   new behavior. Commit the scenario edits in the same PR that explains
   the threshold change.
3. **If a bug**: fix the bug rather than lowering the threshold.
   Re-run the workflow to confirm pass-rate recovers.
4. **Never** lower the threshold to unblock an unrelated PR. The
   threshold is shared infrastructure and protects every contributor.

## Recovery from a corrupted or missing baseline

See `docs/operators/release-recovery.md`.

## Future enhancement

A `workflow_dispatch` trigger on `assist-evals.yml` would let operators
force a baseline refresh without waiting for the cron. Out of scope
for SPEC-017-3-04; add when needed.
