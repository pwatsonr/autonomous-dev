# SPEC-017-4-04: Wire `needs: budget-gate` Across All Eight Workflows + `observe.yml.example` Template

## Metadata
- **Parent Plan**: PLAN-017-4
- **Tasks Covered**: Task 8 (wire `needs: budget-gate` into eight Claude-powered workflows), Task 9 (`observe.yml.example` template), Task 10 (drift-detection step), Task 11 (`actionlint` exclusion for `.example` files)
- **Estimated effort**: 5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-4-04-wire-needs-observe-template.md`

## Description
Connect the budget gate from SPEC-017-4-01/02/03 to the eight Claude-powered workflows produced by PLAN-017-1/2/3 by adding a `budget-gate` job that calls the reusable workflow and a `needs: [budget-gate]` declaration to every Claude-invoking job. Without this wiring, the gate exists but enforces nothing.

In parallel, deliver the `observe.yml.example` template per TDD §11.1: a stateless scheduled-observation workflow that operator forks copy to `observe.yml` to enable. The example ships as `.example` so the plugin's own CI does not auto-execute it; `actionlint` is configured to skip files matching `*.example`. The example includes a drift-detection step that fails fast if the `autonomous-dev observe` CLI surface changes.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/claude-assistant.yml` | Modify | Add `budget-gate` caller job + `needs: [budget-gate]` on Claude-invoking job. |
| `.github/workflows/prd-review.yml` | Modify | Same pattern. |
| `.github/workflows/tdd-review.yml` | Modify | Same pattern. |
| `.github/workflows/plan-review.yml` | Modify | Same pattern. |
| `.github/workflows/spec-review.yml` | Modify | Same pattern. |
| `.github/workflows/agent-meta-review.yml` | Modify | Same pattern. |
| `.github/workflows/assist-evals.yml` | Modify | Same pattern. |
| `.github/workflows/release.yml` | Modify | Same pattern. |
| `.github/workflows/observe.yml.example` | Create | Operator-fork template. NEVER named `observe.yml` in this repo. |
| `.actionlintrc.yaml` | Create or Modify | Exclude `*.example` paths from validation. |

## Implementation Details

### Wiring pattern (applied identically to all eight workflows)

For each of the eight workflows, add a `budget-gate` job at the top of the `jobs:` block and add `needs: [budget-gate]` to every Claude-invoking job. The pattern:

```yaml
jobs:
  budget-gate:
    uses: ./.github/workflows/budget-gate.yml
    with:
      triggering_workflow: claude-assistant   # use the workflow's own name here
    secrets:
      BUDGET_HMAC_KEY: ${{ secrets.BUDGET_HMAC_KEY }}
      BUDGET_HMAC_KEY_PREVIOUS: ${{ secrets.BUDGET_HMAC_KEY_PREVIOUS }}
      CLAUDE_MONTHLY_BUDGET_USD: ${{ secrets.CLAUDE_MONTHLY_BUDGET_USD }}

  # existing Claude-invoking job(s) — for example:
  respond:
    needs: [budget-gate]
    runs-on: ubuntu-latest
    # ... rest unchanged ...
```

The `triggering_workflow` input value MUST match the workflow's filename minus extension:

| File | `triggering_workflow` value |
|------|----------------------------|
| `claude-assistant.yml` | `claude-assistant` |
| `prd-review.yml` | `prd-review` |
| `tdd-review.yml` | `tdd-review` |
| `plan-review.yml` | `plan-review` |
| `spec-review.yml` | `spec-review` |
| `agent-meta-review.yml` | `agent-meta-review` |
| `assist-evals.yml` | `assist-evals` |
| `release.yml` | `release` |

If a workflow has multiple Claude-invoking jobs (e.g. `release.yml` may have `prepare-notes` and `publish`), each MUST list `budget-gate` in its `needs`. Non-Claude jobs (e.g. lint, build) do NOT add the dependency — those should run regardless of budget state so refactors that reduce future Claude usage are not themselves blocked by current spend.

### `.github/workflows/observe.yml.example`

```yaml
# ===================================================================
# Operator-fork template for stateless scheduled observation.
#
# COPY-TO-ENABLE MODEL
# --------------------
# This file ships as `observe.yml.example`. GitHub does NOT auto-execute
# `.example` files. To enable scheduled observation in your fork:
#
#   1. Copy this file to `.github/workflows/observe.yml`
#   2. Set repo variables:
#        - OBSERVE_SCHEDULE  (cron expression, default below)
#        - OBSERVE_SCOPE     (passed to `autonomous-dev observe --scope`)
#        - OBSERVE_FORMAT    (passed to `autonomous-dev observe --format`)
#   3. (Optional) For webhook delivery, set OBSERVE_WEBHOOK_URL as a
#      secret in the `operator-fork` GitHub Environment.
#
# DRIFT DETECTION
# ---------------
# The first step asserts that `autonomous-dev observe` still exposes the
# `--scope`, `--format`, `--output` flags this workflow depends on. If the
# CLI surface changes upstream, this workflow fails fast with a clear
# message rather than silently skipping observations. Update both this
# step and the workflow body whenever the CLI flags change; a CHANGELOG
# entry should accompany every such change.
# ===================================================================

name: observe

on:
  schedule:
    - cron: ${{ vars.OBSERVE_SCHEDULE || '0 */6 * * *' }}   # default: every 6 hours
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: observe
  cancel-in-progress: false

jobs:
  observe:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: operator-fork
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Install autonomous-dev CLI
        run: npm install -g autonomous-dev   # operators may pin a version

      - name: Drift detection — assert observe CLI surface
        run: |
          set -euo pipefail
          help=$(autonomous-dev observe --help)
          for flag in --scope --format --output; do
            echo "$help" | grep -q -- "$flag" || {
              echo "::error::observe.yml drift: '$flag' missing from 'autonomous-dev observe --help'. Update this workflow."
              exit 1
            }
          done

      - name: Run observation
        env:
          OBSERVE_SCOPE: ${{ vars.OBSERVE_SCOPE || 'all' }}
          OBSERVE_FORMAT: ${{ vars.OBSERVE_FORMAT || 'json' }}
        run: |
          mkdir -p observe-output
          autonomous-dev observe \
            --scope "$OBSERVE_SCOPE" \
            --format "$OBSERVE_FORMAT" \
            --output observe-output/observation-$(date -u +%FT%H%M%SZ).json

      - name: Optional webhook delivery
        if: env.OBSERVE_WEBHOOK_URL != ''
        env:
          OBSERVE_WEBHOOK_URL: ${{ secrets.OBSERVE_WEBHOOK_URL }}
        run: |
          for file in observe-output/*.json; do
            curl -fsS -X POST -H 'Content-Type: application/json' \
              --data-binary "@$file" "$OBSERVE_WEBHOOK_URL"
          done

      - name: Upload observation artifacts
        uses: actions/upload-artifact@v4
        with:
          name: observation-${{ github.run_id }}
          path: observe-output/
          retention-days: 30
```

### `.actionlintrc.yaml`

If the file does not yet exist, create:

```yaml
# actionlint configuration. See https://github.com/rhysd/actionlint/blob/main/docs/config.md
# Files matching these patterns are tracked by Git but not validated by actionlint.
# `.example` files are operator-fork templates that GitHub does not execute.
paths:
  ".github/workflows/*.example":
    ignore:
      - ".*"   # ignore all rules for example files
```

If `.actionlintrc.yaml` already exists, add or merge the `paths` block. CI invocations of actionlint must pass `-config-file .actionlintrc.yaml` (or rely on auto-discovery — actionlint reads the file at the repo root automatically).

If the project uses a Makefile or composite CI step instead, the equivalent is to invoke actionlint with `actionlint $(git ls-files '.github/workflows/*.yml' '.github/workflows/*.yaml')` so glob expansion never picks up `.example` files. Whichever approach is used, the result must satisfy the acceptance criteria below.

## Acceptance Criteria

### `needs: budget-gate` wiring (Task 8)
- [ ] All eight workflow files (`claude-assistant.yml`, `prd-review.yml`, `tdd-review.yml`, `plan-review.yml`, `spec-review.yml`, `agent-meta-review.yml`, `assist-evals.yml`, `release.yml`) declare a `budget-gate` job that uses `./.github/workflows/budget-gate.yml`.
- [ ] Each `budget-gate` caller passes its own workflow name (per the table above) as `triggering_workflow`.
- [ ] Each `budget-gate` caller passes the three secrets `BUDGET_HMAC_KEY`, `BUDGET_HMAC_KEY_PREVIOUS`, `CLAUDE_MONTHLY_BUDGET_USD`.
- [ ] Every Claude-invoking job in each workflow lists `budget-gate` in its `needs:` array. Non-Claude jobs (lint, build, etc.) do not.
- [ ] `actionlint` passes for all eight modified workflows with no warnings.
- [ ] Manual mock test (`nektos/act` with a budget-gate fixture that exits 1) confirms downstream Claude jobs are skipped via `needs:` short-circuit.

### `observe.yml.example` template (Task 9)
- [ ] File exists at `.github/workflows/observe.yml.example` (note the `.example` suffix).
- [ ] `git ls-files .github/workflows/observe.yml.example` returns the path (file is tracked, not gitignored).
- [ ] No file at `.github/workflows/observe.yml` exists in this repo (operator-fork-only).
- [ ] Header comment block explains the copy-to-enable model: rename to `observe.yml`, configure repo variables, optional webhook secret in `operator-fork` environment.
- [ ] Schedule trigger uses `cron: ${{ vars.OBSERVE_SCHEDULE || '0 */6 * * *' }}`.
- [ ] `workflow_dispatch` trigger is also declared.
- [ ] Concurrency group is `observe` with `cancel-in-progress: false`.
- [ ] Job `timeout-minutes: 15` and `environment: operator-fork`.
- [ ] Webhook step is gated on `env.OBSERVE_WEBHOOK_URL != ''` and reads from secrets, not vars.
- [ ] Artifact upload uses `actions/upload-artifact@v4` with `retention-days: 30`.
- [ ] `yamllint` passes against the file (the `.example` suffix does not change YAML validity requirements).

### Drift-detection step (Task 10)
- [ ] Step iterates `--scope`, `--format`, `--output` and uses `grep -q --` for each.
- [ ] Step exits 1 with a structured `::error::observe.yml drift: '<flag>' missing` if any flag is absent from `autonomous-dev observe --help`.
- [ ] Drift detection step is named in the header comment as the "drift detection" guard.

### `actionlint` exclusion (Task 11)
- [ ] `actionlint` invoked at the repo root passes with `observe.yml.example` present in the workflows directory.
- [ ] Removing the exclusion (revert the config) and re-running actionlint produces a non-zero exit (sanity check that the exclusion is what's silencing it, not coincidence).
- [ ] `git ls-files .github/workflows/observe.yml.example` returns the file (not gitignored, only actionlint-excluded).
- [ ] CI logs show that actionlint validates the eight Claude-powered workflows and `budget-gate.yml` (six total invocations of the YAML names, plus the gate) but does not list `observe.yml.example`.

## Dependencies

- Depends on SPEC-017-4-01 (`.github/workflows/budget-gate.yml` exists with the `workflow_call` interface declared).
- Depends on SPEC-017-4-02 and SPEC-017-4-03 to make the gate actually enforce thresholds (this spec only wires `needs:`).
- Consumes the eight Claude-powered workflows from PLAN-017-1 (claude-assistant), PLAN-017-2 (the four document review workflows + agent-meta-review), and PLAN-017-3 (assist-evals + release). Those workflows must exist at the paths above when this spec is implemented.
- TDD-016 baseline `actionlint` configuration must be modifiable (or replaceable) to add the `.example` exclusion.
- PRD-008 `autonomous-dev observe` CLI exposing `--scope`, `--format`, `--output` flags. Drift detection breaks at the moment any of these is removed.

## Notes

- The `triggering_workflow` input is informational (used in step summaries and PR comments). It does not affect gate logic. Mismatches between the value and the actual caller filename are not detectable inside the gate; convention-keeping relies on this spec's table and a CHANGELOG entry whenever a workflow is renamed.
- `release.yml` may have multiple Claude-invoking jobs (e.g. release-notes drafting + announcement composition). Each needs `budget-gate` in `needs:`. Build/test/publish jobs that do not invoke Claude do not.
- The `operator-fork` environment scoping for `OBSERVE_WEBHOOK_URL` per TDD §14 means operator forks must create the environment before configuring the secret. The header comment instructs operators on this; if the environment is missing, the workflow's `environment: operator-fork` declaration causes GitHub to fail the job at startup with a clear "environment not found" error — acceptable behavior, no extra defense needed in this spec.
- Drift detection greps `--help` output; this is loose (substring match), but tight enough to catch flag removal. A more rigorous approach (parsing `--help-json` if the CLI offered it) is out of scope until the CLI exposes machine-readable help.
- The `.actionlintrc.yaml` config syntax assumes actionlint v1.6+. If the repo pins an older version, the equivalent is the glob-based invocation described in the implementation notes.
- This spec deliberately does NOT activate `observe.yml` on the plugin's own repo (PLAN-017-4 explicitly leaves it as `.example`). Activating it would conflate "the plugin's own observability needs" with "the operator-fork template surface" — separate concerns deserving separate decisions.
- After this spec lands, end-to-end smoke testing in PLAN-017-4's testing strategy can verify a mocked under-budget scenario allows a draft PR to invoke `claude-assistant.yml`'s downstream job.
