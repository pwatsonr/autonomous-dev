# SPEC-035-4-04: CI Docker-Pinned Visual Regression Runner

## Metadata
- **Parent Plan**: PLAN-035-4
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§10.4)
- **Parent PRD**: PRD-018-portal-visual-redesign (M-03)
- **Tasks Covered**: PLAN-035-4 Task 11 + the `GOLDEN_MISSING` failure mode + git-lfs threshold guard.
- **Depends on**: SPEC-035-4-03 (Playwright suite + goldens)
- **Estimated effort**: 0.4 day
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Stand up the GitHub Actions CI job that runs the visual regression suite from SPEC-035-4-03 inside the version-pinned Playwright Docker image `mcr.microsoft.com/playwright:v1.40.0-jammy`. The job (a) eliminates cross-OS render diffs by binding rendering to a single Docker image, (b) explicitly fails with `GOLDEN_MISSING: ...` when a golden is absent (no auto-generation in CI), and (c) enforces the 500KB git-lfs threshold for the goldens directory.

## Acceptance Criteria

- AC-1 Workflow file lives at `.github/workflows/visual-regression.yml`.
- AC-2 Triggers: `on: [pull_request, push]` with `branches: [main]` for push and default for PR. Workflow concurrency-group is `visual-regression-${{ github.ref }}` with `cancel-in-progress: true`.
- AC-3 The single job `visual-regression` runs `runs-on: ubuntu-latest` with `container: image: mcr.microsoft.com/playwright:v1.40.0-jammy`. The image tag is literally pinned in the workflow file (no floating tags such as `latest` or `v1`).
- AC-4 Job env block sets `PORT=19281`, `NODE_ENV=test`, `PORTAL_WORDMARK_BRACKETS=1`, `CI=true`.
- AC-5 Steps in order:
  1. `actions/checkout@v4` with `lfs: true` (so LFS-tracked goldens download).
  2. `actions/setup-node@v4` (or rely on the Playwright image's bundled Node).
  3. `bun install --frozen-lockfile` (or `npm ci` fallback per the portal's actual build chain).
  4. **Pre-flight golden presence check** — script `scripts/ci/check-goldens-present.sh`: for each expected snapshot name (`design-system-full.png` + `design-system-card-{01..20}.png`), assert the file exists at `tests/visual-regression/goldens/`. On any miss, exit 1 with `echo "GOLDEN_MISSING: No golden image found at tests/visual-regression/goldens/<name>.png. Run \"npm run gen:visual-goldens\" locally and commit the generated files."`.
  5. **Goldens size guard** — script `scripts/ci/check-goldens-size.sh`: if total bytes of `tests/visual-regression/goldens/` exceeds 512000 (500KB) AND `.gitattributes` does not contain `tests/visual-regression/goldens/*.png filter=lfs`, exit 1 with `GOLDEN_SIZE_EXCEEDED: tests/visual-regression/goldens/ exceeds 500KB without git-lfs tracking. Run "git lfs track \"tests/visual-regression/goldens/*.png\"" and re-stage.`
  6. Start portal in background: `bun run server/index.ts &` then `scripts/ci/wait-for-port.sh 19281 30`.
  7. Run `npx playwright test tests/visual-regression/design-system.spec.ts`.
  8. On failure, `actions/upload-artifact@v4` uploading `playwright-report/`, `test-results/`, and any `*-diff.png` files for reviewer inspection.
- AC-6 The pre-flight check (step 4) runs **before** Playwright is invoked, so missing goldens fail fast with the human-readable message rather than an opaque Playwright stack trace.
- AC-7 The job does NOT pass `--project=golden-gen` and does NOT set `UPDATE_GOLDEN=1` under any circumstance — auto-generation in CI is forbidden.
- AC-8 Job timeout is 15 minutes.
- AC-9 The workflow is added to the repo's branch-protection required-checks list (out-of-band, but documented in the PR description) so visual diffs block merges.

## Implementation

**`.github/workflows/visual-regression.yml`** (skeleton):

```yaml
name: visual-regression
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: visual-regression-${{ github.ref }}
  cancel-in-progress: true
jobs:
  visual-regression:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    container:
      image: mcr.microsoft.com/playwright:v1.40.0-jammy
    env:
      PORT: 19281
      NODE_ENV: test
      PORTAL_WORDMARK_BRACKETS: '1'
      CI: 'true'
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true }
      - uses: oven-sh/setup-bun@v1
      - run: bun install --frozen-lockfile
      - run: bash scripts/ci/check-goldens-present.sh
      - run: bash scripts/ci/check-goldens-size.sh
      - run: bun run server/index.ts &
      - run: bash scripts/ci/wait-for-port.sh 19281 30
      - run: npx playwright test tests/visual-regression/design-system.spec.ts
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-diffs
          path: |
            playwright-report/
            test-results/
            tests/visual-regression/goldens/**/*-diff.png
```

**`scripts/ci/check-goldens-present.sh`**:

```bash
#!/usr/bin/env bash
set -euo pipefail
GOLD_DIR="tests/visual-regression/goldens"
EXPECTED=("design-system-full.png")
for n in $(seq -f "%02g" 1 20); do EXPECTED+=("design-system-card-${n}.png"); done
missing=0
for name in "${EXPECTED[@]}"; do
  if [[ ! -s "${GOLD_DIR}/${name}" ]]; then
    echo "GOLDEN_MISSING: No golden image found at ${GOLD_DIR}/${name}. Run \"npm run gen:visual-goldens\" locally and commit the generated files."
    missing=1
  fi
done
exit $missing
```

**`scripts/ci/check-goldens-size.sh`**: computes `du -sb tests/visual-regression/goldens/` and grep `.gitattributes` for the LFS filter; emits `GOLDEN_SIZE_EXCEEDED: ...` and exits 1 when the threshold is breached without LFS tracking.

**`scripts/ci/wait-for-port.sh`**: polls `nc -z 127.0.0.1 $PORT` with a deadline; exits 0 when reachable, 1 on timeout.

## Tests

- **Workflow lint**: `actionlint .github/workflows/visual-regression.yml` returns clean.
- **Pre-flight script**: `bats tests/ci/check-goldens-present.bats` covers all-present pass + single-missing fail with the exact expected error string.
- **Size-guard script**: `bats tests/ci/check-goldens-size.bats` covers under-threshold pass, over-threshold without LFS fail, over-threshold with LFS pass.
- **End-to-end CI run**: open a draft PR that deletes one golden file; assert the CI run fails on step 4 with the `GOLDEN_MISSING` message visible in the GitHub Actions log.
- **Image pin**: `grep -F "mcr.microsoft.com/playwright:v1.40.0-jammy" .github/workflows/visual-regression.yml` returns exactly one match; floating tags such as `:latest`, `:v1`, `:jammy` are absent.

## Verification

- `actionlint` passes on the new workflow.
- The reference run on a clean PR turns green within the 15-minute budget.
- A deliberately-deleted golden produces a CI failure whose first error line is the documented `GOLDEN_MISSING: ...` message.
- A deliberately-oversized goldens directory (e.g., temporary 600KB padding) without LFS tracking fails on step 5 with `GOLDEN_SIZE_EXCEEDED: ...`.
- The `visual-regression` check is added to the repo's required-checks set; merging a PR with a failing diff is blocked.
- The Docker image tag in the workflow is exactly `mcr.microsoft.com/playwright:v1.40.0-jammy` — no auto-update, no floating reference.
