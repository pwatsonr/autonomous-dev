#!/usr/bin/env bash
# scorer.sh -- Scoring helper for the autonomous-dev-assist eval harness
#
# Provides functions to compare a model response against expected criteria.
# Sourced by runner.sh; not intended to be executed directly.
#
# Functions:
#   check_topics  RESPONSE  TOPICS_ARRAY   -> score 0-100
#   check_mentions RESPONSE MENTION_ARRAY  -> per-item pass/fail, overall score
#   check_absent  RESPONSE  ABSENT_ARRAY   -> per-item pass/fail, overall score
#   compute_composite TOPIC_SCORE MENTION_SCORE ABSENT_SCORE -> 0-100
#
# All functions read from arguments or stdin and write results to stdout.

set -euo pipefail

# ---------------------------------------------------------------------------
# normalize_text TEXT
#   Lowercase, strip punctuation, collapse whitespace.
#   Writes normalized text to stdout.
# ---------------------------------------------------------------------------
normalize_text() {
  local text="$1"
  echo "$text" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9_ /-]/ /g' \
    | tr -s ' '
}

# ---------------------------------------------------------------------------
# check_topics RESPONSE TOPICS_JSON
#   Checks how many expected topics appear in the response.
#
#   Arguments:
#     $1 -- response text (the model's answer)
#     $2 -- JSON array of topic strings, e.g. '["daemon","pipeline","phases"]'
#
#   Stdout:
#     JSON object: {"score": <0-100>, "total": N, "found": N, "missing": [...]}
# ---------------------------------------------------------------------------
check_topics() {
  local response="$1"
  local topics_json="$2"

  local normalized
  normalized=$(normalize_text "$response")

  local total found missing_items
  total=$(echo "$topics_json" | jq -r 'length')
  found=0
  missing_items="[]"

  if [[ "$total" -eq 0 ]]; then
    echo '{"score": 100, "total": 0, "found": 0, "missing": []}'
    return 0
  fi

  local i topic norm_topic
  for i in $(seq 0 $((total - 1))); do
    topic=$(echo "$topics_json" | jq -r ".[$i]")
    norm_topic=$(normalize_text "$topic")

    if echo "$normalized" | grep -qiF "$norm_topic"; then
      found=$((found + 1))
    else
      missing_items=$(echo "$missing_items" | jq --arg t "$topic" '. + [$t]')
    fi
  done

  local score
  score=$(( (found * 100) / total ))

  jq -n \
    --argjson score "$score" \
    --argjson total "$total" \
    --argjson found "$found" \
    --argjson missing "$missing_items" \
    '{score: $score, total: $total, found: $found, missing: $missing}'
}

# ---------------------------------------------------------------------------
# check_mentions RESPONSE MENTIONS_JSON
#   Checks that specific terms/commands appear in the response.
#
#   Arguments:
#     $1 -- response text
#     $2 -- JSON array of must-mention strings
#
#   Stdout:
#     JSON object: {"score": <0-100>, "total": N, "found": N, "results": [...]}
#     Each result: {"term": "...", "pass": true/false}
# ---------------------------------------------------------------------------
check_mentions() {
  local response="$1"
  local mentions_json="$2"

  local normalized
  normalized=$(normalize_text "$response")

  local total found results
  total=$(echo "$mentions_json" | jq -r 'length')
  found=0
  results="[]"

  if [[ "$total" -eq 0 ]]; then
    echo '{"score": 100, "total": 0, "found": 0, "results": []}'
    return 0
  fi

  local i term norm_term pass
  for i in $(seq 0 $((total - 1))); do
    term=$(echo "$mentions_json" | jq -r ".[$i]")
    norm_term=$(normalize_text "$term")

    if echo "$normalized" | grep -qiF "$norm_term"; then
      pass="true"
      found=$((found + 1))
    else
      pass="false"
    fi

    results=$(echo "$results" | jq --arg t "$term" --argjson p "$pass" '. + [{"term": $t, "pass": $p}]')
  done

  local score
  score=$(( (found * 100) / total ))

  jq -n \
    --argjson score "$score" \
    --argjson total "$total" \
    --argjson found "$found" \
    --argjson results "$results" \
    '{score: $score, total: $total, found: $found, results: $results}'
}

# ---------------------------------------------------------------------------
# check_absent RESPONSE ABSENT_JSON
#   Checks that forbidden terms do NOT appear in the response.
#
#   Arguments:
#     $1 -- response text
#     $2 -- JSON array of must-not-mention strings
#
#   Stdout:
#     JSON object: {"score": <0-100>, "total": N, "clean": N, "violations": [...]}
# ---------------------------------------------------------------------------
check_absent() {
  local response="$1"
  local absent_json="$2"

  local normalized
  normalized=$(normalize_text "$response")

  local total clean violations
  total=$(echo "$absent_json" | jq -r 'length')
  clean=0
  violations="[]"

  if [[ "$total" -eq 0 ]]; then
    echo '{"score": 100, "total": 0, "clean": 0, "violations": []}'
    return 0
  fi

  local i term norm_term
  for i in $(seq 0 $((total - 1))); do
    term=$(echo "$absent_json" | jq -r ".[$i]")
    norm_term=$(normalize_text "$term")

    if echo "$normalized" | grep -qiF "$norm_term"; then
      violations=$(echo "$violations" | jq --arg t "$term" '. + [$t]')
    else
      clean=$((clean + 1))
    fi
  done

  local score
  score=$(( (clean * 100) / total ))

  jq -n \
    --argjson score "$score" \
    --argjson total "$total" \
    --argjson clean "$clean" \
    --argjson violations "$violations" \
    '{score: $score, total: $total, clean: $clean, violations: $violations}'
}

# ---------------------------------------------------------------------------
# check_actionability RESPONSE
#   Checks whether the response contains actionable content (code blocks,
#   command invocations, or step-by-step instructions).
#
#   Arguments:
#     $1 -- response text
#
#   Stdout:
#     JSON object: {"score": <0-100>, "indicators_found": [...]}
# ---------------------------------------------------------------------------
check_actionability() {
  local response="$1"

  local indicators_found="[]"
  local found=0
  local total=4

  # Check for code blocks
  if echo "$response" | grep -qF '```'; then
    indicators_found=$(echo "$indicators_found" | jq '. + ["code_block"]')
    found=$((found + 1))
  fi

  # Check for autonomous-dev commands
  if echo "$response" | grep -qiF 'autonomous-dev '; then
    indicators_found=$(echo "$indicators_found" | jq '. + ["autonomous_dev_command"]')
    found=$((found + 1))
  fi

  # Check for claude commands
  if echo "$response" | grep -qiF 'claude '; then
    indicators_found=$(echo "$indicators_found" | jq '. + ["claude_command"]')
    found=$((found + 1))
  fi

  # Check for shell prompt indicators
  if echo "$response" | grep -qF '$ '; then
    indicators_found=$(echo "$indicators_found" | jq '. + ["shell_prompt"]')
    found=$((found + 1))
  fi

  # Score: at least 1 indicator = 50, 2+ = 100
  local score=0
  if [[ "$found" -ge 2 ]]; then
    score=100
  elif [[ "$found" -ge 1 ]]; then
    score=50
  fi

  jq -n \
    --argjson score "$score" \
    --argjson found "$indicators_found" \
    '{score: $score, indicators_found: $found}'
}

# ---------------------------------------------------------------------------
# compute_composite TOPIC_SCORE MENTION_SCORE ABSENT_SCORE ACTION_SCORE
#   Computes a weighted composite score.
#
#   Weights (from eval-config.yaml):
#     accuracy   = 50%  (average of mention_score and absent_score)
#     completeness = 30% (topic_score)
#     actionability = 20% (action_score)
#
#   Arguments:
#     $1 -- topic coverage score (0-100)
#     $2 -- must-mention score (0-100)
#     $3 -- must-not-mention score (0-100)
#     $4 -- actionability score (0-100)
#
#   Stdout:
#     JSON: {"composite": <0-100>, "accuracy": N, "completeness": N, "actionability": N}
# ---------------------------------------------------------------------------
compute_composite() {
  local topic_score="${1:-0}"
  local mention_score="${2:-0}"
  local absent_score="${3:-0}"
  local action_score="${4:-0}"

  # accuracy = average of mention + absent scores
  local accuracy=$(( (mention_score + absent_score) / 2 ))
  local completeness="$topic_score"
  local actionability="$action_score"

  # weighted composite: accuracy*50% + completeness*30% + actionability*20%
  local composite=$(( (accuracy * 50 + completeness * 30 + actionability * 20) / 100 ))

  jq -n \
    --argjson composite "$composite" \
    --argjson accuracy "$accuracy" \
    --argjson completeness "$completeness" \
    --argjson actionability "$actionability" \
    '{composite: $composite, accuracy: $accuracy, completeness: $completeness, actionability: $actionability}'
}

# ---------------------------------------------------------------------------
# score_response RESPONSE EXPECTED_TOPICS MUST_MENTION MUST_NOT_MENTION
#   Full scoring pipeline for a single response.
#
#   Arguments:
#     $1 -- response text
#     $2 -- JSON array of expected topics
#     $3 -- JSON array of must-mention terms
#     $4 -- JSON array of must-not-mention terms
#
#   Stdout:
#     Full JSON scoring report for this case.
# ---------------------------------------------------------------------------
score_response() {
  local response="$1"
  local expected_topics="${2:-[]}"
  local must_mention="${3:-[]}"
  local must_not_mention="${4:-[]}"

  local topics_result mentions_result absent_result action_result

  topics_result=$(check_topics "$response" "$expected_topics")
  mentions_result=$(check_mentions "$response" "$must_mention")
  absent_result=$(check_absent "$response" "$must_not_mention")
  action_result=$(check_actionability "$response")

  local topic_score mention_score absent_score action_score
  topic_score=$(echo "$topics_result" | jq -r '.score')
  mention_score=$(echo "$mentions_result" | jq -r '.score')
  absent_score=$(echo "$absent_result" | jq -r '.score')
  action_score=$(echo "$action_result" | jq -r '.score')

  local composite_result
  composite_result=$(compute_composite "$topic_score" "$mention_score" "$absent_score" "$action_score")

  jq -n \
    --argjson composite "$composite_result" \
    --argjson topics "$topics_result" \
    --argjson mentions "$mentions_result" \
    --argjson absent "$absent_result" \
    --argjson actionability "$action_result" \
    '{
      composite: $composite.composite,
      breakdown: {
        accuracy: $composite.accuracy,
        completeness: $composite.completeness,
        actionability: $composite.actionability
      },
      details: {
        topics: $topics,
        mentions: $mentions,
        absent: $absent,
        actionability: $actionability
      }
    }'
}
