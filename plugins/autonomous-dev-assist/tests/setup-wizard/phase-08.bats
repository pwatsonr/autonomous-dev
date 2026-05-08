#!/usr/bin/env bats
# tests/setup-wizard/phase-08.bats
# Front-matter contract + eval-set presence per SPEC-033-1-04.

PHASE_FILE="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases/phase-08-chat-channels.md"
EVAL_DIR="${BATS_TEST_DIRNAME}/../../evals/test-cases/setup-wizard/phase-08-chat-channels"

_front_matter() {
  awk '/^---$/{f++; next} f==1{print} f==2{exit}' "$PHASE_FILE"
}

@test "P8-101 phase number" {
  run bash -c "_front_matter() { awk '/^---$/{f++;next} f==1{print} f==2{exit}' \"$PHASE_FILE\"; }; _front_matter | grep -E '^phase:'"
  [ "$status" -eq 0 ]
  echo "$output" | grep -E '^phase:[[:space:]]+8'
}

@test "P8-102 title matches spec" {
  grep -E '^title:' "$PHASE_FILE" | grep -q 'Chat channels (Discord/Slack)'
}

@test "P8-103 amendment_001_phase=8" {
  grep -E '^amendment_001_phase:[[:space:]]+8' "$PHASE_FILE"
}

@test "P8-104 tdd_anchors include TDD-008 and TDD-011" {
  grep -E '^tdd_anchors:' "$PHASE_FILE" | grep -q 'TDD-008'
  grep -E '^tdd_anchors:' "$PHASE_FILE" | grep -q 'TDD-011'
}

@test "P8-105 skip_predicate references is_cli_only_mode" {
  grep -E '^skip_predicate:' "$PHASE_FILE" | grep -q 'is_cli_only_mode'
}

@test "P8-106 skip_consequence verbatim text" {
  grep -q 'You will only be able to submit requests via the CLI' "$PHASE_FILE"
}

@test "P8-107 output_state.config_keys_written has 5 keys" {
  count=$(awk '/config_keys_written:/,/files_created:/' "$PHASE_FILE" | grep -cE '^[[:space:]]+- (intake\.)')
  [ "$count" -ge 5 ]
}

@test "P8-201 four eval cases present" {
  for c in happy-path skip-with-consequence error-recovery idempotency-resume; do
    [ -f "$EVAL_DIR/$c.md" ] || { echo "missing $c"; false; }
  done
}

@test "P8-202 happy-path asserts token-leak sweep" {
  grep -q 'fake-but-valid-bot-token-XXXXXXX' "$EVAL_DIR/happy-path.md"
  grep -q 'regex-no-match' "$EVAL_DIR/happy-path.md"
}

@test "P8-203 skip-with-consequence asserts verbatim text" {
  grep -q 'You will only be able to submit requests via the CLI' "$EVAL_DIR/skip-with-consequence.md"
}
