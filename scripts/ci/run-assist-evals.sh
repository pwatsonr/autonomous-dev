#!/usr/bin/env bash
# scripts/ci/run-assist-evals.sh
#
# Iterates every scenario in tests/evals/assist/, invokes the
# autonomous-dev-assist plugin via the `autodev` CLI, scores the
# response with `score-eval-response.js`, and writes a single
# `eval-results.json` summarizing total / passed / pass_rate /
# failed scenarios.
#
# Determinism: the scorer is deterministic (no network, no random).
# The only non-deterministic input is the assist plugin's own
# response, which the script invokes exactly once per scenario per
# run. SPEC-017-3-03 §Acceptance requires byte-identical output
# across re-runs given byte-identical responses.

set -euo pipefail

SCENARIO_DIR="tests/evals/assist"
RESULTS_FILE="eval-results.json"
TOTAL=0
PASSED=0
FAILED_SCENARIOS=()

if [ ! -d "$SCENARIO_DIR" ]; then
  echo "::error::Scenario directory $SCENARIO_DIR does not exist"
  exit 1
fi

shopt -s nullglob
# Iterate scenarios in a stable, sorted order so re-runs produce
# byte-identical eval-results.json given identical responses.
mapfile -t scenario_files < <(printf '%s\n' "$SCENARIO_DIR"/*.json | sort)

for scenario_file in "${scenario_files[@]}"; do
  TOTAL=$((TOTAL + 1))
  scenario_id="$(basename "$scenario_file" .json)"

  # Validate scenario shape.
  if ! jq -e '.input and .expected_keywords and (.skill // "help")' "$scenario_file" > /dev/null; then
    echo "::error::Scenario $scenario_id is malformed (missing required fields)"
    FAILED_SCENARIOS+=("$scenario_id")
    continue
  fi

  skill="$(jq -r '.skill // "help"' "$scenario_file")"
  input="$(jq -r '.input' "$scenario_file")"

  # Invoke the assist plugin's skill via the autonomous-dev CLI.
  # Contract: `autodev assist <skill> --prompt <text>` writes the
  # response to stdout and exits 0 on success. On failure (CLI absent,
  # skill error, etc.) we capture an empty response and let the scorer
  # mark the scenario failed -- the workflow surfaces the failure via
  # the failed-scenarios list rather than aborting the entire run.
  response="$(autodev assist "$skill" --prompt "$input" 2>/dev/null || true)"

  # Score deterministically. The process-substitution writes the
  # response to a fifo so the scorer can read it as a file path,
  # which avoids shell-quoting issues with multi-line responses.
  if node scripts/ci/score-eval-response.js \
       --scenario "$scenario_file" \
       --response <(printf '%s' "$response"); then
    PASSED=$((PASSED + 1))
  else
    FAILED_SCENARIOS+=("$scenario_id")
  fi
done

PASS_RATE="0"
if [ "$TOTAL" -gt 0 ]; then
  PASS_RATE="$(awk "BEGIN { printf \"%.4f\", $PASSED / $TOTAL }")"
fi

# Build the JSON output. We jq-encode the failed-scenarios list via
# stdin to avoid eval / interpolation hazards.
failed_json="$(printf '%s\n' "${FAILED_SCENARIOS[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')"

jq -n \
  --argjson total "$TOTAL" \
  --argjson passed "$PASSED" \
  --argjson rate "$PASS_RATE" \
  --argjson failed "$failed_json" \
  '{ total: $total, passed: $passed, pass_rate: $rate, failed_scenarios: $failed }' \
  > "$RESULTS_FILE"

echo "Wrote $RESULTS_FILE"
cat "$RESULTS_FILE"
