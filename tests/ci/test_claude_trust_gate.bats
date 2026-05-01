#!/usr/bin/env bats

# tests/ci/test_claude_trust_gate.bats
# SPEC-017-1-01: Verifies the claude-trust-gate composite action's trust
# evaluation logic across the full GitHub author_association enum plus
# empty/null inputs. Sources the shared harness which mirrors action.yml.

setup() {
  HARNESS_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/helpers" && pwd)"
  # shellcheck disable=SC1091
  source "$HARNESS_DIR/trust_gate_harness.sh"
}

@test "OWNER -> is-trusted=true" {
  result="$(evaluate_trust OWNER)"
  [ "$result" = "true" ]
}

@test "MEMBER -> is-trusted=true" {
  result="$(evaluate_trust MEMBER)"
  [ "$result" = "true" ]
}

@test "COLLABORATOR -> is-trusted=true" {
  result="$(evaluate_trust COLLABORATOR)"
  [ "$result" = "true" ]
}

@test "CONTRIBUTOR -> is-trusted=false" {
  result="$(evaluate_trust CONTRIBUTOR)"
  [ "$result" = "false" ]
}

@test "FIRST_TIMER -> is-trusted=false" {
  result="$(evaluate_trust FIRST_TIMER)"
  [ "$result" = "false" ]
}

@test "NONE -> is-trusted=false" {
  result="$(evaluate_trust NONE)"
  [ "$result" = "false" ]
}

@test "empty string -> is-trusted=false" {
  result="$(evaluate_trust '')"
  [ "$result" = "false" ]
}

@test "null literal -> is-trusted=false" {
  result="$(evaluate_trust 'null')"
  [ "$result" = "false" ]
}
