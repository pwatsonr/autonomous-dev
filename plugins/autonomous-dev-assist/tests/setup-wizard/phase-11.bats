#!/usr/bin/env bats
# tests/setup-wizard/phase-11.bats
# Front-matter contract per SPEC-033-1-05.

PHASE_FILE="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases/phase-11-portal-install.md"
EVAL_DIR="${BATS_TEST_DIRNAME}/../../evals/test-cases/setup-wizard/phase-11-portal-install"

@test "P11-101 phase number" {
  grep -E '^phase:[[:space:]]+11' "$PHASE_FILE"
}

@test "P11-102 title" {
  grep -E '^title:.*Web portal install' "$PHASE_FILE"
}

@test "P11-103 tdd_anchors include TDD-013/014/015" {
  grep -E '^tdd_anchors:' "$PHASE_FILE" | grep -q 'TDD-013'
  grep -E '^tdd_anchors:' "$PHASE_FILE" | grep -q 'TDD-014'
  grep -E '^tdd_anchors:' "$PHASE_FILE" | grep -q 'TDD-015'
}

@test "P11-104 default-skip predicate" {
  grep -E '^skip_predicate:' "$PHASE_FILE" | grep -q 'portal_install_default_skip'
}

@test "P11-105 verbatim consequence text" {
  grep -q 'No browser pipeline view; CLI status remains' "$PHASE_FILE"
}

@test "P11-106 output_state has 6 config keys" {
  count=$(awk '/config_keys_written:/,/files_created:/' "$PHASE_FILE" | grep -cE '^[[:space:]]+- portal\.')
  [ "$count" -eq 6 ]
}

@test "P11-201 four eval cases present" {
  for c in happy-path skip-with-consequence error-recovery idempotency-resume; do
    [ -f "$EVAL_DIR/$c.md" ]
  done
}

@test "P11-202 happy-path asserts default bind 127.0.0.1" {
  grep -q '127.0.0.1' "$EVAL_DIR/happy-path.md"
}

@test "P11-203 happy-path asserts plaintext password no-leak" {
  grep -q 'WizardTest!Password-XYZ123' "$EVAL_DIR/happy-path.md"
  grep -q 'regex-no-match' "$EVAL_DIR/happy-path.md"
}

@test "P11-204 happy-path asserts bcrypt cost 12" {
  grep -E '\$2\[ab\]\$12\$|\\\$2\[ab\]\\\$12\\\$' "$EVAL_DIR/happy-path.md" || \
    grep -q '"\$2\[ab\]"' "$EVAL_DIR/happy-path.md" || \
    grep -q 'bcrypt cost 12' "$EVAL_DIR/happy-path.md"
}
