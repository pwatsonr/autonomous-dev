#!/usr/bin/env bats

# tests/ci/test_document_review_action.bats
# SPEC-017-2-01: fork-PR detection logic.
# SPEC-017-2-02: verdict-parser unit tests against lib/parse-verdict.sh.

setup() {
  PARSER="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../.github/actions/document-review/lib" && pwd)/parse-verdict.sh"
  TMP_RESPONSE="$(mktemp -t doc-review-resp.XXXXXX)"
  TMP_OUTPUT="$(mktemp -t doc-review-out.XXXXXX)"
  export GITHUB_OUTPUT="$TMP_OUTPUT"
}

teardown() {
  rm -f "$TMP_RESPONSE" "$TMP_OUTPUT"
}

# --- SPEC-017-2-01: fork detection -------------------------------------------

@test "fork detection: head.repo == base.repo => is-fork=false" {
  HEAD_REPO="acme/proj"
  BASE_REPO="acme/proj"
  if [[ "$HEAD_REPO" != "$BASE_REPO" ]]; then result=true; else result=false; fi
  [ "$result" = "false" ]
}

@test "fork detection: head.repo != base.repo => is-fork=true" {
  HEAD_REPO="contributor/proj"
  BASE_REPO="acme/proj"
  if [[ "$HEAD_REPO" != "$BASE_REPO" ]]; then result=true; else result=false; fi
  [ "$result" = "true" ]
}

# --- SPEC-017-2-02: verdict parser -------------------------------------------

@test "parser: VERDICT: APPROVE, no severity tags => verdict=APPROVE, has-critical=false" {
  echo "VERDICT: APPROVE" > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=APPROVE" "$TMP_OUTPUT"
  grep -q "has-critical=false" "$TMP_OUTPUT"
}

@test "parser: VERDICT: REQUEST_CHANGES with **[CRITICAL]** => has-critical=true" {
  printf 'VERDICT: REQUEST_CHANGES\n\nFinding **[CRITICAL]**: bad thing\n' > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=REQUEST_CHANGES" "$TMP_OUTPUT"
  grep -q "has-critical=true" "$TMP_OUTPUT"
}

@test "parser: case-insensitive verdict line accepted" {
  echo "verdict: concerns" > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=CONCERNS" "$TMP_OUTPUT"
}

@test "parser: SCORE: 92 captured" {
  printf 'VERDICT: APPROVE\nSCORE: 92\n' > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -eq 0 ]
  grep -q "score=92" "$TMP_OUTPUT"
}

@test "parser: missing VERDICT line fails with ::error::" {
  echo "no verdict here" > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -ne 0 ]
  [[ "$output" == *"::error::"* ]]
}

@test "parser: severity tag with HIGH but no CRITICAL => has-critical=false" {
  printf 'VERDICT: CONCERNS\n**[HIGH]** finding\n' > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -eq 0 ]
  grep -q "has-critical=false" "$TMP_OUTPUT"
}

@test "parser: multiple verdict lines, first wins" {
  printf 'VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES\n' > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -eq 0 ]
  grep -q "verdict=APPROVE" "$TMP_OUTPUT"
}

@test "parser: empty response file fails" {
  : > "$TMP_RESPONSE"
  run bash "$PARSER" "$TMP_RESPONSE" numeric
  [ "$status" -ne 0 ]
}
