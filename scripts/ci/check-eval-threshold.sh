#!/usr/bin/env bash
# scripts/ci/check-eval-threshold.sh
#
# Compares the current run's pass_rate against
#   (a) the configurable ASSIST_EVAL_THRESHOLD floor (default 0.85)
#   (b) the most recent baseline pass_rate (>0.05-point regression).
#
# Exit 0 if both checks pass; exit 1 with `::error::` on stderr otherwise.
# Threshold check runs first; if it fails, the regression check is skipped.
#
# Required env vars:
#   PASS_RATE       Current run's pass_rate (from eval-results.json).
#   THRESHOLD       Floor (default 0.85).
#   BASELINE_RATE   Prior baseline pass_rate; empty string = no baseline.

set -euo pipefail

THRESHOLD="${THRESHOLD:-0.85}"
PASS_RATE="${PASS_RATE:?PASS_RATE env var required}"
BASELINE_RATE="${BASELINE_RATE:-}"

# Threshold floor check.
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

# Baseline regression check (only when a baseline exists).
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
