#!/usr/bin/env bash
# runner.sh -- Eval runner for the autonomous-dev-assist plugin
#
# Reads test cases from YAML files, invokes the skill under test via
# `claude -p`, scores each response, and produces a summary report.
# Exits non-zero if any suite drops below the configured threshold.
#
# Usage:
#   bash evals/runner.sh                 # run all enabled suites
#   bash evals/runner.sh help            # run only the help suite
#   bash evals/runner.sh troubleshoot    # run only the troubleshoot suite
#   bash evals/runner.sh config          # run only the config suite
#   bash evals/runner.sh --dry-run help  # parse & validate without invoking claude
#
# Requirements: bash 4+, jq 1.6+, yq (https://github.com/mikefarah/yq) v4+

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EVAL_DIR="${SCRIPT_DIR}"
CONFIG_FILE="${EVAL_DIR}/eval-config.yaml"
SCORER="${EVAL_DIR}/scorer.sh"
REPORT_DIR="${EVAL_DIR}/reports"

# Source the scorer
if [[ ! -f "${SCORER}" ]]; then
  echo "ERROR: scorer.sh not found at ${SCORER}" >&2
  exit 1
fi
# shellcheck source=scorer.sh
source "${SCORER}"

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
DRY_RUN=false
SUITE_FILTER=""
TOTAL_CASES=0
TOTAL_PASSED=0
TOTAL_FAILED=0
SUITE_RESULTS="[]"  # JSON array of per-suite summaries
EXIT_CODE=0

# ---------------------------------------------------------------------------
# Color helpers (disabled when not a terminal)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

# ---------------------------------------------------------------------------
# log helpers
# ---------------------------------------------------------------------------
info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
pass()  { echo -e "${GREEN}[PASS]${RESET}  $*"; }
fail()  { echo -e "${RED}[FAIL]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

# ---------------------------------------------------------------------------
# check_dependencies
# ---------------------------------------------------------------------------
check_dependencies() {
  local missing=0
  for cmd in jq yq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "ERROR: Required command '$cmd' is not installed." >&2
      missing=$((missing + 1))
    fi
  done
  if [[ "$missing" -gt 0 ]]; then
    echo "Install missing dependencies and try again." >&2
    exit 1
  fi

  if [[ "$DRY_RUN" == "false" ]] && ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI is not installed or not in PATH." >&2
    echo "Install from: https://docs.anthropic.com/en/docs/claude-code" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# load_config
#   Reads thresholds and runner settings from eval-config.yaml.
# ---------------------------------------------------------------------------
THRESHOLD_PER_CASE=60
THRESHOLD_PER_SUITE=80
THRESHOLD_GLOBAL=80
MAX_FAIL_PCT=20
INVOKE_TIMEOUT=120

load_config() {
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    warn "Config file not found at ${CONFIG_FILE}; using built-in defaults."
    return 0
  fi

  THRESHOLD_PER_CASE=$(yq -r '.thresholds.per_case // 60' "${CONFIG_FILE}")
  THRESHOLD_PER_SUITE=$(yq -r '.thresholds.per_suite // 80' "${CONFIG_FILE}")
  THRESHOLD_GLOBAL=$(yq -r '.thresholds.global_minimum // 80' "${CONFIG_FILE}")
  MAX_FAIL_PCT=$(yq -r '.thresholds.max_case_failure_pct // 20' "${CONFIG_FILE}")
  INVOKE_TIMEOUT=$(yq -r '.runner.timeout_seconds // 120' "${CONFIG_FILE}")
}

# ---------------------------------------------------------------------------
# invoke_skill SKILL_NAME QUESTION
#   Sends the question to the skill via `claude -p` and captures the response.
#
#   Stdout: the model's response text.
#   Returns 0 on success, 1 on timeout/error.
# ---------------------------------------------------------------------------
invoke_skill() {
  local skill="$1"
  local question="$2"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY RUN] Would invoke skill '${skill}' with question: ${question}"
    return 0
  fi

  local response
  if response=$(timeout "${INVOKE_TIMEOUT}" claude -p "Using the ${skill} skill, answer this question: ${question}" 2>/dev/null); then
    echo "$response"
    return 0
  else
    local rc=$?
    if [[ "$rc" -eq 124 ]]; then
      echo "[TIMEOUT] Skill invocation timed out after ${INVOKE_TIMEOUT}s"
    else
      echo "[ERROR] Skill invocation failed with exit code ${rc}"
    fi
    return 1
  fi
}

# ---------------------------------------------------------------------------
# run_help_suite
#   Processes test cases from help-questions.yaml.
# ---------------------------------------------------------------------------
run_help_suite() {
  local test_file="${EVAL_DIR}/test-cases/help-questions.yaml"
  if [[ ! -f "$test_file" ]]; then
    warn "Test file not found: ${test_file}"
    return 1
  fi

  local case_count
  case_count=$(yq -r '.cases | length' "$test_file")
  info "Found ${case_count} test cases in help suite"

  local suite_passed=0
  local suite_failed=0
  local suite_total_score=0
  local case_results="[]"

  local i
  for i in $(seq 0 $((case_count - 1))); do
    local case_id question difficulty
    case_id=$(yq -r ".cases[$i].id" "$test_file")
    question=$(yq -r ".cases[$i].question" "$test_file")
    difficulty=$(yq -r ".cases[$i].difficulty" "$test_file")

    local expected_topics must_mention must_not_mention
    expected_topics=$(yq -r -o=json ".cases[$i].expected_topics" "$test_file")
    must_mention=$(yq -r -o=json ".cases[$i].must_mention" "$test_file")
    must_not_mention=$(yq -r -o=json ".cases[$i].must_not_mention" "$test_file")

    echo -n "  [${case_id}] (${difficulty}) ... "

    local response
    if ! response=$(invoke_skill "help" "$question"); then
      fail "${case_id}: invocation failed"
      suite_failed=$((suite_failed + 1))
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      case_results=$(echo "$case_results" | jq --arg id "$case_id" --argjson s 0 \
        '. + [{"id": $id, "score": $s, "status": "error"}]')
      continue
    fi

    local score_report composite
    score_report=$(score_response "$response" "$expected_topics" "$must_mention" "$must_not_mention")
    composite=$(echo "$score_report" | jq -r '.composite')

    suite_total_score=$((suite_total_score + composite))
    TOTAL_CASES=$((TOTAL_CASES + 1))

    if [[ "$composite" -ge "$THRESHOLD_PER_CASE" ]]; then
      pass "${case_id}: score ${composite}/100"
      suite_passed=$((suite_passed + 1))
      TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
      fail "${case_id}: score ${composite}/100 (threshold: ${THRESHOLD_PER_CASE})"
      # Show details on failure
      local missing_topics missing_mentions violations
      missing_topics=$(echo "$score_report" | jq -r '.details.topics.missing | join(", ")')
      missing_mentions=$(echo "$score_report" | jq -r '[.details.mentions.results[] | select(.pass == false) | .term] | join(", ")')
      violations=$(echo "$score_report" | jq -r '.details.absent.violations | join(", ")')
      [[ -n "$missing_topics" ]] && echo "       Missing topics: ${missing_topics}"
      [[ -n "$missing_mentions" ]] && echo "       Missing mentions: ${missing_mentions}"
      [[ -n "$violations" ]] && echo "       Violations: ${violations}"
      suite_failed=$((suite_failed + 1))
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi

    case_results=$(echo "$case_results" | jq \
      --arg id "$case_id" \
      --argjson s "$composite" \
      --argjson report "$score_report" \
      '. + [{"id": $id, "score": $s, "details": $report}]')
  done

  local suite_avg=0
  if [[ "$case_count" -gt 0 ]]; then
    suite_avg=$((suite_total_score / case_count))
  fi

  local suite_status="PASS"
  if [[ "$suite_avg" -lt "$THRESHOLD_PER_SUITE" ]]; then
    suite_status="FAIL"
    EXIT_CODE=1
  fi

  SUITE_RESULTS=$(echo "$SUITE_RESULTS" | jq \
    --arg name "help" \
    --argjson avg "$suite_avg" \
    --argjson passed "$suite_passed" \
    --argjson failed "$suite_failed" \
    --arg status "$suite_status" \
    --argjson cases "$case_results" \
    '. + [{
      "suite": $name,
      "average_score": $avg,
      "passed": $passed,
      "failed": $failed,
      "status": $status,
      "cases": $cases
    }]')

  echo ""
  if [[ "$suite_status" == "PASS" ]]; then
    pass "help suite: avg ${suite_avg}/100 (${suite_passed}/${case_count} passed)"
  else
    fail "help suite: avg ${suite_avg}/100 (${suite_passed}/${case_count} passed) -- BELOW THRESHOLD ${THRESHOLD_PER_SUITE}"
  fi
}

# ---------------------------------------------------------------------------
# run_troubleshoot_suite
#   Processes test cases from troubleshoot-scenarios.yaml.
# ---------------------------------------------------------------------------
run_troubleshoot_suite() {
  local test_file="${EVAL_DIR}/test-cases/troubleshoot-scenarios.yaml"
  if [[ ! -f "$test_file" ]]; then
    warn "Test file not found: ${test_file}"
    return 1
  fi

  local case_count
  case_count=$(yq -r '.cases | length' "$test_file")
  info "Found ${case_count} test cases in troubleshoot suite"

  local suite_passed=0
  local suite_failed=0
  local suite_total_score=0
  local case_results="[]"

  local i
  for i in $(seq 0 $((case_count - 1))); do
    local case_id scenario severity
    case_id=$(yq -r ".cases[$i].id" "$test_file")
    scenario=$(yq -r ".cases[$i].scenario" "$test_file")
    severity=$(yq -r ".cases[$i].severity" "$test_file")

    # Build the question from scenario + symptoms
    local symptoms_text
    symptoms_text=$(yq -r ".cases[$i].symptoms | join(\". \")" "$test_file")
    local full_question="I'm experiencing this problem: ${scenario}. Symptoms: ${symptoms_text}"

    # Expected criteria -- for troubleshoot we use expected_commands as must_mention
    # and expected_diagnosis keywords as expected_topics
    local expected_commands expected_fix
    expected_commands=$(yq -r -o=json ".cases[$i].expected_commands" "$test_file")
    expected_fix=$(yq -r -o=json ".cases[$i].expected_fix" "$test_file")

    # Extract key terms from the diagnosis as topics
    local expected_diagnosis
    expected_diagnosis=$(yq -r ".cases[$i].expected_diagnosis" "$test_file")

    # Use the expected_commands as must_mention items
    # Use a simplified set of topics derived from scenario keywords
    local topics_json='[]'
    local must_not_mention='[]'

    echo -n "  [${case_id}] (${severity}) ... "

    local response
    if ! response=$(invoke_skill "troubleshoot" "$full_question"); then
      fail "${case_id}: invocation failed"
      suite_failed=$((suite_failed + 1))
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      case_results=$(echo "$case_results" | jq --arg id "$case_id" --argjson s 0 \
        '. + [{"id": $id, "score": $s, "status": "error"}]')
      continue
    fi

    local score_report composite
    score_report=$(score_response "$response" "$topics_json" "$expected_commands" "$must_not_mention")
    composite=$(echo "$score_report" | jq -r '.composite')

    suite_total_score=$((suite_total_score + composite))
    TOTAL_CASES=$((TOTAL_CASES + 1))

    if [[ "$composite" -ge "$THRESHOLD_PER_CASE" ]]; then
      pass "${case_id}: score ${composite}/100"
      suite_passed=$((suite_passed + 1))
      TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
      fail "${case_id}: score ${composite}/100 (threshold: ${THRESHOLD_PER_CASE})"
      local missing_commands
      missing_commands=$(echo "$score_report" | jq -r '[.details.mentions.results[] | select(.pass == false) | .term] | join(", ")')
      [[ -n "$missing_commands" ]] && echo "       Missing commands: ${missing_commands}"
      suite_failed=$((suite_failed + 1))
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi

    case_results=$(echo "$case_results" | jq \
      --arg id "$case_id" \
      --argjson s "$composite" \
      --argjson report "$score_report" \
      '. + [{"id": $id, "score": $s, "details": $report}]')
  done

  local suite_avg=0
  if [[ "$case_count" -gt 0 ]]; then
    suite_avg=$((suite_total_score / case_count))
  fi

  local suite_status="PASS"
  if [[ "$suite_avg" -lt "$THRESHOLD_PER_SUITE" ]]; then
    suite_status="FAIL"
    EXIT_CODE=1
  fi

  SUITE_RESULTS=$(echo "$SUITE_RESULTS" | jq \
    --arg name "troubleshoot" \
    --argjson avg "$suite_avg" \
    --argjson passed "$suite_passed" \
    --argjson failed "$suite_failed" \
    --arg status "$suite_status" \
    --argjson cases "$case_results" \
    '. + [{
      "suite": $name,
      "average_score": $avg,
      "passed": $passed,
      "failed": $failed,
      "status": $status,
      "cases": $cases
    }]')

  echo ""
  if [[ "$suite_status" == "PASS" ]]; then
    pass "troubleshoot suite: avg ${suite_avg}/100 (${suite_passed}/${case_count} passed)"
  else
    fail "troubleshoot suite: avg ${suite_avg}/100 (${suite_passed}/${case_count} passed) -- BELOW THRESHOLD ${THRESHOLD_PER_SUITE}"
  fi
}

# ---------------------------------------------------------------------------
# run_config_suite
#   Processes test cases from config-questions.yaml.
# ---------------------------------------------------------------------------
run_config_suite() {
  local test_file="${EVAL_DIR}/test-cases/config-questions.yaml"
  if [[ ! -f "$test_file" ]]; then
    warn "Test file not found: ${test_file}"
    return 1
  fi

  local case_count
  case_count=$(yq -r '.cases | length' "$test_file")
  info "Found ${case_count} test cases in config suite"

  local suite_passed=0
  local suite_failed=0
  local suite_total_score=0
  local case_results="[]"

  local i
  for i in $(seq 0 $((case_count - 1))); do
    local case_id question difficulty
    case_id=$(yq -r ".cases[$i].id" "$test_file")
    question=$(yq -r ".cases[$i].question" "$test_file")
    difficulty=$(yq -r ".cases[$i].difficulty // \"medium\"" "$test_file")

    # For config cases, expected_parameters serve as must_mention items
    local expected_parameters expected_section
    expected_parameters=$(yq -r -o=json ".cases[$i].expected_parameters" "$test_file")
    expected_section=$(yq -r ".cases[$i].expected_section" "$test_file")

    # Build expected_topics from section + defaults
    local expected_defaults_keys
    expected_defaults_keys=$(yq -r -o=json ".cases[$i].expected_defaults | keys" "$test_file" 2>/dev/null || echo '[]')

    # Merge parameters and default keys as must_mention
    local must_mention="$expected_parameters"
    local expected_topics='[]'
    if [[ "$expected_section" != "null" ]] && [[ -n "$expected_section" ]]; then
      expected_topics=$(echo '[]' | jq --arg s "$expected_section" '. + [$s]')
    fi
    local must_not_mention='[]'

    echo -n "  [${case_id}] (${difficulty}) ... "

    local response
    if ! response=$(invoke_skill "config-guide" "$question"); then
      fail "${case_id}: invocation failed"
      suite_failed=$((suite_failed + 1))
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      case_results=$(echo "$case_results" | jq --arg id "$case_id" --argjson s 0 \
        '. + [{"id": $id, "score": $s, "status": "error"}]')
      continue
    fi

    # Additionally check that default values are mentioned correctly
    local defaults_json
    defaults_json=$(yq -r -o=json ".cases[$i].expected_defaults" "$test_file" 2>/dev/null || echo '{}')
    local defaults_correct=0
    local defaults_total=0
    if [[ "$defaults_json" != "{}" ]] && [[ "$defaults_json" != "null" ]]; then
      defaults_total=$(echo "$defaults_json" | jq 'length')
      local key val
      for key in $(echo "$defaults_json" | jq -r 'keys[]'); do
        val=$(echo "$defaults_json" | jq -r --arg k "$key" '.[$k]')
        if echo "$response" | grep -qF "$val"; then
          defaults_correct=$((defaults_correct + 1))
        fi
      done
    fi

    local score_report composite
    score_report=$(score_response "$response" "$expected_topics" "$must_mention" "$must_not_mention")
    composite=$(echo "$score_report" | jq -r '.composite')

    # Boost/penalize based on default value accuracy
    if [[ "$defaults_total" -gt 0 ]]; then
      local defaults_pct=$(( (defaults_correct * 100) / defaults_total ))
      # Blend: 70% base composite + 30% defaults accuracy
      composite=$(( (composite * 70 + defaults_pct * 30) / 100 ))
    fi

    suite_total_score=$((suite_total_score + composite))
    TOTAL_CASES=$((TOTAL_CASES + 1))

    if [[ "$composite" -ge "$THRESHOLD_PER_CASE" ]]; then
      pass "${case_id}: score ${composite}/100"
      suite_passed=$((suite_passed + 1))
      TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
      fail "${case_id}: score ${composite}/100 (threshold: ${THRESHOLD_PER_CASE})"
      local missing_params
      missing_params=$(echo "$score_report" | jq -r '[.details.mentions.results[] | select(.pass == false) | .term] | join(", ")')
      [[ -n "$missing_params" ]] && echo "       Missing params: ${missing_params}"
      if [[ "$defaults_total" -gt 0 ]]; then
        echo "       Defaults correct: ${defaults_correct}/${defaults_total}"
      fi
      suite_failed=$((suite_failed + 1))
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi

    case_results=$(echo "$case_results" | jq \
      --arg id "$case_id" \
      --argjson s "$composite" \
      --argjson report "$score_report" \
      '. + [{"id": $id, "score": $s, "details": $report}]')
  done

  local suite_avg=0
  if [[ "$case_count" -gt 0 ]]; then
    suite_avg=$((suite_total_score / case_count))
  fi

  local suite_status="PASS"
  if [[ "$suite_avg" -lt "$THRESHOLD_PER_SUITE" ]]; then
    suite_status="FAIL"
    EXIT_CODE=1
  fi

  SUITE_RESULTS=$(echo "$SUITE_RESULTS" | jq \
    --arg name "config" \
    --argjson avg "$suite_avg" \
    --argjson passed "$suite_passed" \
    --argjson failed "$suite_failed" \
    --arg status "$suite_status" \
    --argjson cases "$case_results" \
    '. + [{
      "suite": $name,
      "average_score": $avg,
      "passed": $passed,
      "failed": $failed,
      "status": $status,
      "cases": $cases
    }]')

  echo ""
  if [[ "$suite_status" == "PASS" ]]; then
    pass "config suite: avg ${suite_avg}/100 (${suite_passed}/${case_count} passed)"
  else
    fail "config suite: avg ${suite_avg}/100 (${suite_passed}/${case_count} passed) -- BELOW THRESHOLD ${THRESHOLD_PER_SUITE}"
  fi
}

# ---------------------------------------------------------------------------
# print_summary
#   Prints the final summary and writes the report file.
# ---------------------------------------------------------------------------
print_summary() {
  header "========================================"
  header "        EVAL SUMMARY REPORT"
  header "========================================"
  echo ""

  local suite_count
  suite_count=$(echo "$SUITE_RESULTS" | jq 'length')

  local s
  for s in $(seq 0 $((suite_count - 1))); do
    local name avg passed failed status
    name=$(echo "$SUITE_RESULTS" | jq -r ".[$s].suite")
    avg=$(echo "$SUITE_RESULTS" | jq -r ".[$s].average_score")
    passed=$(echo "$SUITE_RESULTS" | jq -r ".[$s].passed")
    failed=$(echo "$SUITE_RESULTS" | jq -r ".[$s].failed")
    status=$(echo "$SUITE_RESULTS" | jq -r ".[$s].status")

    local total=$((passed + failed))
    if [[ "$status" == "PASS" ]]; then
      pass "  ${name}: ${avg}/100 avg  (${passed}/${total} cases passed)"
    else
      fail "  ${name}: ${avg}/100 avg  (${passed}/${total} cases passed)  ** BELOW THRESHOLD **"
    fi
  done

  echo ""
  local overall_total=$((TOTAL_PASSED + TOTAL_FAILED))
  info "Total: ${TOTAL_PASSED}/${overall_total} cases passed, ${TOTAL_FAILED} failed"

  if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo ""
    pass "ALL SUITES PASSED"
  else
    echo ""
    fail "ONE OR MORE SUITES BELOW THRESHOLD (${THRESHOLD_PER_SUITE}%)"
  fi

  # Write JSON report
  mkdir -p "${REPORT_DIR}"
  local report_file="${REPORT_DIR}/eval-report-$(date -u +%Y%m%d-%H%M%S).json"

  jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson threshold "$THRESHOLD_PER_SUITE" \
    --argjson total_passed "$TOTAL_PASSED" \
    --argjson total_failed "$TOTAL_FAILED" \
    --argjson exit_code "$EXIT_CODE" \
    --argjson suites "$SUITE_RESULTS" \
    '{
      timestamp: $ts,
      threshold: $threshold,
      total_passed: $total_passed,
      total_failed: $total_failed,
      exit_code: $exit_code,
      suites: $suites
    }' > "$report_file"

  info "Report written to: ${report_file}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --help|-h)
        echo "Usage: bash evals/runner.sh [--dry-run] [suite-name]"
        echo ""
        echo "Suites: help, troubleshoot, config"
        echo ""
        echo "Options:"
        echo "  --dry-run   Parse test cases without invoking claude"
        echo "  --help      Show this help"
        exit 0
        ;;
      *)
        SUITE_FILTER="$1"
        shift
        ;;
    esac
  done

  header "autonomous-dev-assist eval runner"
  echo "  Config:    ${CONFIG_FILE}"
  echo "  Dry run:   ${DRY_RUN}"
  echo "  Suite:     ${SUITE_FILTER:-all}"
  echo ""

  check_dependencies
  load_config

  info "Thresholds: per-case=${THRESHOLD_PER_CASE}, per-suite=${THRESHOLD_PER_SUITE}, global=${THRESHOLD_GLOBAL}"
  echo ""

  # Run requested suites
  if [[ -z "$SUITE_FILTER" ]] || [[ "$SUITE_FILTER" == "help" ]]; then
    header "--- Suite: help ---"
    run_help_suite
  fi

  if [[ -z "$SUITE_FILTER" ]] || [[ "$SUITE_FILTER" == "troubleshoot" ]]; then
    header "--- Suite: troubleshoot ---"
    run_troubleshoot_suite
  fi

  if [[ -z "$SUITE_FILTER" ]] || [[ "$SUITE_FILTER" == "config" ]]; then
    header "--- Suite: config ---"
    run_config_suite
  fi

  # Print summary and write report
  print_summary

  exit "${EXIT_CODE}"
}

main "$@"
