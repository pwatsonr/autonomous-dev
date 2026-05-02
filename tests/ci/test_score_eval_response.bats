#!/usr/bin/env bats

# tests/ci/test_score_eval_response.bats
# SPEC-017-3-03: Verifies scripts/ci/score-eval-response.js exit codes
# and stderr messages for the five documented paths.
#
# Note on framework: SPEC-017-3-03 §`tests/ci/test_score_eval_response.test.ts`
# specifies vitest or the project's TS runner. The existing tests/ci/
# directory uses bats exclusively (see test_claude_trust_gate.bats,
# test_document_review_action.bats). Bats is closer to the CLI-script
# nature of the scorer (exit code + stderr) and consistent with
# co-located tests, so we adopt bats for parity. The acceptance criterion
# (cover all 5 paths, all pass) is satisfied identically.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCORER="$REPO_ROOT/scripts/ci/score-eval-response.js"
  TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TMP"
}

write_scenario() {
  cat > "$TMP/scenario.json"
}

write_response() {
  cat > "$TMP/response.txt"
}

@test "happy path: keywords present, no forbidden, length in range -> exit 0" {
  write_scenario <<'JSON'
{
  "description": "happy",
  "skill": "help",
  "input": "x",
  "expected_keywords": ["install", "plugin"],
  "forbidden_phrases": [],
  "min_response_length": 10,
  "max_response_length": 200
}
JSON
  write_response <<'TXT'
To install the plugin, run the autonomous-dev installer command.
TXT
  run node "$SCORER" --scenario "$TMP/scenario.json" --response "$TMP/response.txt"
  [ "$status" -eq 0 ]
}

@test "missing required keyword -> exit 1, stderr SCORE FAIL: Missing expected keyword" {
  write_scenario <<'JSON'
{
  "description": "missing kw",
  "skill": "help",
  "input": "x",
  "expected_keywords": ["installer", "manifest"],
  "forbidden_phrases": [],
  "min_response_length": 0,
  "max_response_length": 9999
}
JSON
  write_response <<'TXT'
To install the plugin, run the autonomous-dev command.
TXT
  run node "$SCORER" --scenario "$TMP/scenario.json" --response "$TMP/response.txt"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"SCORE FAIL: Missing expected keyword"* ]] || \
    [[ "$output" == *"SCORE FAIL: Missing expected keyword"* ]]
}

@test "forbidden phrase present -> exit 1, stderr SCORE FAIL: Contains forbidden phrase" {
  write_scenario <<'JSON'
{
  "description": "forbidden",
  "skill": "help",
  "input": "x",
  "expected_keywords": ["plugin"],
  "forbidden_phrases": ["i don't know"],
  "min_response_length": 0,
  "max_response_length": 9999
}
JSON
  write_response <<'TXT'
About this plugin, I don't know much, sorry.
TXT
  run node "$SCORER" --scenario "$TMP/scenario.json" --response "$TMP/response.txt"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"SCORE FAIL: Contains forbidden phrase"* ]] || \
    [[ "$output" == *"SCORE FAIL: Contains forbidden phrase"* ]]
}

@test "response too short -> exit 1, stderr SCORE FAIL: Response too short" {
  write_scenario <<'JSON'
{
  "description": "short",
  "skill": "help",
  "input": "x",
  "expected_keywords": ["x"],
  "forbidden_phrases": [],
  "min_response_length": 100,
  "max_response_length": 9999
}
JSON
  write_response <<'TXT'
x is short
TXT
  run node "$SCORER" --scenario "$TMP/scenario.json" --response "$TMP/response.txt"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"SCORE FAIL: Response too short"* ]] || \
    [[ "$output" == *"SCORE FAIL: Response too short"* ]]
}

@test "response too long -> exit 1, stderr SCORE FAIL: Response too long" {
  write_scenario <<'JSON'
{
  "description": "long",
  "skill": "help",
  "input": "x",
  "expected_keywords": ["x"],
  "forbidden_phrases": [],
  "min_response_length": 0,
  "max_response_length": 5
}
JSON
  write_response <<'TXT'
x is way too long for this scenario
TXT
  run node "$SCORER" --scenario "$TMP/scenario.json" --response "$TMP/response.txt"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"SCORE FAIL: Response too long"* ]] || \
    [[ "$output" == *"SCORE FAIL: Response too long"* ]]
}

@test "malformed scenario JSON -> exit 1, stderr SCORE FAIL: Cannot parse scenario JSON" {
  echo "{ this is not json" > "$TMP/scenario.json"
  echo "anything" > "$TMP/response.txt"
  run node "$SCORER" --scenario "$TMP/scenario.json" --response "$TMP/response.txt"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"SCORE FAIL: Cannot parse scenario JSON"* ]] || \
    [[ "$output" == *"SCORE FAIL: Cannot parse scenario JSON"* ]]
}
