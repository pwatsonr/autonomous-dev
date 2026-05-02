#!/usr/bin/env bash
# scripts/ci/fetch-eval-baseline.sh
#
# Fetches `baseline.json` from the `_eval-baseline` branch and writes
# its `pass_rate` to $GITHUB_OUTPUT as `baseline-rate`. Used by both
# `assist-evals.yml` (regression check, SPEC-017-3-04) and
# `release.yml` (verify-evals job, SPEC-017-3-04).
#
# The script intentionally does NOT fail when the branch or file is
# absent -- it emits a warning and an empty `baseline-rate`. Callers
# decide what "no baseline" means in context: PR runs treat it as
# soft-pass; the release verify-evals job treats it as hard-fail.

set -euo pipefail

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
