#!/usr/bin/env bash
# ci-eval.sh -- Static content evaluation for autonomous-dev-assist skills
#
# Validates that skill SKILL.md files contain all required terms from
# eval test cases. No LLM calls needed — pure grep-based verification.
# Designed to run in GitHub Actions CI.
#
# Usage:
#   bash evals/ci-eval.sh              # Run all suites
#   bash evals/ci-eval.sh help         # Run one suite
#   bash evals/ci-eval.sh --threshold 90  # Custom pass threshold
#
# Exit codes:
#   0 — All suites pass threshold
#   1 — One or more suites below threshold
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Defaults
THRESHOLD=80
SUITE_FILTER=""
VERBOSE=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) SUITE_FILTER="$1"; shift ;;
  esac
done

# Colors (disabled if not a TTY)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; BOLD=''; NC=''
fi

# Counters
TOTAL_CASES=0
TOTAL_PASS=0
TOTAL_PARTIAL=0
TOTAL_FAIL=0
SUITE_RESULTS=""
FAILURES=""
EXIT_CODE=0

# Map suite to skill file
skill_file_for_suite() {
  case "$1" in
    help)           echo "${PLUGIN_DIR}/skills/help/SKILL.md" ;;
    troubleshoot)   echo "${PLUGIN_DIR}/skills/troubleshoot/SKILL.md" ;;
    config)         echo "${PLUGIN_DIR}/skills/config-guide/SKILL.md" ;;
    setup-wizard)   echo "${PLUGIN_DIR}/skills/setup-wizard/SKILL.md" ;;
    *) echo "" ;;
  esac
}

# Extract YAML values without yq (portable)
# Reads a simple YAML list and returns items
extract_yaml_list() {
  local file="$1"
  local field="$2"
  local case_id="$3"

  # Find the case block, extract the field's list items
  awk -v id="$case_id" -v field="$field" '
    $0 ~ "id: " id { found=1; next }
    found && /^  - id:/ { found=0 }
    found && $0 ~ "    " field ":" { in_list=1; next }
    found && in_list && /^      - / { gsub(/^      - /, ""); gsub(/"/, ""); print; next }
    found && in_list && /^    [a-z]/ { in_list=0 }
    found && in_list && /^  - id:/ { in_list=0 }
  ' "$file"
}

# Score one test case against a skill file
score_case() {
  local case_id="$1"
  local test_file="$2"
  local skill_file="$3"
  local skill_content
  skill_content="$(cat "$skill_file" | tr '[:upper:]' '[:lower:]')"

  local mention_total=0
  local mention_found=0
  local mention_missing=""
  local violation_found=""

  # Check must_mention items
  while IFS= read -r term; do
    [[ -z "$term" ]] && continue
    mention_total=$((mention_total + 1))
    local lower_term
    lower_term="$(echo "$term" | tr '[:upper:]' '[:lower:]')"
    if echo "$skill_content" | grep -qF -- "$lower_term"; then
      mention_found=$((mention_found + 1))
    else
      mention_missing="${mention_missing}${term}, "
    fi
  done < <(extract_yaml_list "$test_file" "must_mention" "$case_id")

  # Check must_not_mention items
  while IFS= read -r term; do
    [[ -z "$term" ]] && continue
    local lower_term
    lower_term="$(echo "$term" | tr '[:upper:]' '[:lower:]')"
    if echo "$skill_content" | grep -qF -- "$lower_term"; then
      violation_found="${violation_found}${term}, "
    fi
  done < <(extract_yaml_list "$test_file" "must_not_mention" "$case_id")

  # Score
  local score=100
  if [[ $mention_total -gt 0 ]]; then
    score=$(( mention_found * 100 / mention_total ))
  fi

  # Violations are automatic failures
  if [[ -n "$violation_found" ]]; then
    score=0
  fi

  # Verdict
  local verdict="PASS"
  if [[ $score -lt 60 ]]; then
    verdict="FAIL"
  elif [[ $score -lt 100 ]]; then
    verdict="PARTIAL"
  fi

  # Output
  TOTAL_CASES=$((TOTAL_CASES + 1))
  case "$verdict" in
    PASS)    TOTAL_PASS=$((TOTAL_PASS + 1)); printf "  ${GREEN}PASS${NC}  %s\n" "$case_id" ;;
    PARTIAL) TOTAL_PARTIAL=$((TOTAL_PARTIAL + 1)); printf "  ${YELLOW}PART${NC}  %s (%d%% — missing: %s)\n" "$case_id" "$score" "${mention_missing%, }" ;;
    FAIL)    TOTAL_FAIL=$((TOTAL_FAIL + 1)); printf "  ${RED}FAIL${NC}  %s (%d%%)\n" "$case_id" "$score" ;;
  esac

  if [[ "$verdict" != "PASS" ]]; then
    FAILURES="${FAILURES}\n  ${case_id}: score=${score}%"
    [[ -n "$mention_missing" ]] && FAILURES="${FAILURES} missing=[${mention_missing%, }]"
    [[ -n "$violation_found" ]] && FAILURES="${FAILURES} violations=[${violation_found%, }]"
  fi
}

# Run one suite
run_suite() {
  local suite_name="$1"
  local test_file="${SCRIPT_DIR}/test-cases/${suite_name}-questions.yaml"

  # Handle troubleshoot file naming
  if [[ "$suite_name" == "troubleshoot" ]]; then
    test_file="${SCRIPT_DIR}/test-cases/troubleshoot-scenarios.yaml"
  fi

  if [[ ! -f "$test_file" ]]; then
    echo "  SKIP: No test file for suite '$suite_name'"
    return
  fi

  local skill_file
  skill_file="$(skill_file_for_suite "$suite_name")"
  if [[ -z "$skill_file" || ! -f "$skill_file" ]]; then
    echo "  SKIP: No skill file for suite '$suite_name'"
    return
  fi

  printf "\n${BOLD}Suite: %s${NC}\n" "$suite_name"
  printf "  Skill: %s\n" "$(basename "$(dirname "$skill_file")")/SKILL.md"
  echo ""

  local suite_cases=0
  local suite_pass=0
  local suite_start_pass=$TOTAL_PASS

  # Extract all case IDs from the test file
  local case_ids
  case_ids="$(grep '  - id:' "$test_file" | sed 's/.*id: //' | tr -d ' ')"

  while IFS= read -r case_id; do
    [[ -z "$case_id" ]] && continue
    suite_cases=$((suite_cases + 1))
    score_case "$case_id" "$test_file" "$skill_file"
  done <<< "$case_ids"

  suite_pass=$((TOTAL_PASS - suite_start_pass))
  local suite_score=0
  [[ $suite_cases -gt 0 ]] && suite_score=$((suite_pass * 100 / suite_cases))

  local suite_status="PASS"
  [[ $suite_score -lt $THRESHOLD ]] && suite_status="FAIL"

  printf "\n  %s: %d/%d pass (%d%%)" "$suite_name" "$suite_pass" "$suite_cases" "$suite_score"
  if [[ "$suite_status" == "PASS" ]]; then
    printf " ${GREEN}✓${NC}\n"
  else
    printf " ${RED}✗ (threshold: %d%%)${NC}\n" "$THRESHOLD"
    EXIT_CODE=1
  fi

  SUITE_RESULTS="${SUITE_RESULTS}\n  ${suite_name}: ${suite_pass}/${suite_cases} (${suite_score}%) ${suite_status}"
}

# Main
echo ""
printf "${BOLD}autonomous-dev-assist Eval Runner (static content check)${NC}\n"
printf "Threshold: %d%%\n" "$THRESHOLD"

# Determine suites to run
if [[ -n "$SUITE_FILTER" ]]; then
  SUITES="$SUITE_FILTER"
else
  SUITES="help troubleshoot config setup-wizard"
fi

for suite in $SUITES; do
  run_suite "$suite"
done

# Summary
echo ""
printf "${BOLD}═══════════════════════════════════════════${NC}\n"
printf "${BOLD}Summary${NC}\n"
printf "  Total: %d cases | Pass: %d | Partial: %d | Fail: %d\n" \
  "$TOTAL_CASES" "$TOTAL_PASS" "$TOTAL_PARTIAL" "$TOTAL_FAIL"

if [[ $TOTAL_CASES -gt 0 ]]; then
  OVERALL=$((TOTAL_PASS * 100 / TOTAL_CASES))
  printf "  Overall: %d%%\n" "$OVERALL"
fi

if [[ -n "$FAILURES" ]]; then
  echo ""
  printf "${RED}Failures:${NC}"
  printf "$FAILURES\n"
fi

echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
  printf "${GREEN}${BOLD}RESULT: ALL SUITES PASS${NC}\n"
else
  printf "${RED}${BOLD}RESULT: BELOW THRESHOLD — merge blocked${NC}\n"
fi

exit $EXIT_CODE
