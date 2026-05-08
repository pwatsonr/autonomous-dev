#!/usr/bin/env bats
# tests/setup-wizard/phase-13.bats
# Phase-13 module + front-matter contract per SPEC-033-2-04.

PHASE_FILE="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases/phase-13-request-types.md"

@test "P13-101a phase number" {
  grep -E '^phase:[[:space:]]+13' "$PHASE_FILE"
}

@test "P13-101b title" {
  grep -E '^title:.*"Request types' "$PHASE_FILE"
}

@test "P13-101c tdd_anchors include TDD-018 and TDD-019" {
  line="$(grep -E '^tdd_anchors:' "$PHASE_FILE")"
  echo "$line" | grep -q 'TDD-018'
  echo "$line" | grep -q 'TDD-019'
}

@test "P13-101d required_inputs.config_keys references governance.per_request_cost_cap_usd" {
  awk '/^required_inputs:/,/^optional_inputs:/' "$PHASE_FILE" \
    | grep -q 'governance.per_request_cost_cap_usd'
}

@test "P13-101e skip_predicate references phase_13_skip_predicate" {
  grep -E '^skip_predicate:' "$PHASE_FILE" | grep -q 'phase_13_skip_predicate'
}

@test "P13-101f skip_consequence verbatim text (FR-4)" {
  grep -q 'Only the default request type is active' "$PHASE_FILE"
  grep -q 'hotfix/exploration/refactor are unavailable until you run' "$PHASE_FILE"
}

@test "P13-101g idempotency_probe is phase-13-probe" {
  grep -E '^idempotency_probe:' "$PHASE_FILE" | grep -q 'phase-13-probe'
}

@test "P13-101h output_state.config_keys_written templates use placeholders" {
  awk '/config_keys_written:/,/files_created:/' "$PHASE_FILE" | grep -q '<type>'
  awk '/config_keys_written:/,/files_created:/' "$PHASE_FILE" | grep -q '<hook_point>'
  awk '/config_keys_written:/,/files_created:/' "$PHASE_FILE" | grep -q '<handler_id>'
}

@test "P13-201 module body reads catalog data-driven (no hard-coded type ids)" {
  # The body MUST iterate jq over the catalog file rather than literal
  # type-id case-statements.
  grep -q 'jq -c.*catalog' "$PHASE_FILE" || grep -q "jq.*'\.\\[\\]'" "$PHASE_FILE"
  ! grep -E '^[[:space:]]*case[[:space:]]+"\$id".*hotfix' "$PHASE_FILE"
}

@test "P13-301 cost cap defaults to governance.per_request_cost_cap_usd" {
  grep -q 'governance.per_request_cost_cap_usd' "$PHASE_FILE"
  grep -q 'cap="\${cap:-\$gov_cap}"' "$PHASE_FILE"
}

@test "P13-401 allowlist confirmation requires literal yes" {
  grep -q 'literal string "yes"' "$PHASE_FILE"
  grep -q 'confirm" != "yes"' "$PHASE_FILE"
}

@test "P13-402 displays first 200 bytes of handler before confirm" {
  grep -q 'head -c 200' "$PHASE_FILE"
}

@test "P13-501 hook idempotency: already registered same path treated as success" {
  grep -q 'already registered with same handler_path' "$PHASE_FILE"
}

@test "P13-502 hook collision update-or-skip prompt" {
  grep -q 'already registered with different handler_id' "$PHASE_FILE"
}

@test "P13-601 dry-run probe uses --dry-run --observe-first-transition" {
  grep -q -- '--dry-run --observe-first-transition' "$PHASE_FILE"
}

@test "P13-602 dry-run does fs-snapshot diff" {
  grep -q 'find "\$store"' "$PHASE_FILE"
  grep -q 'DRY-RUN VIOLATION' "$PHASE_FILE"
}

@test "P13-701 no non-default enabled → request types list verification" {
  grep -q 'autonomous-dev request types list' "$PHASE_FILE"
}

@test "P13-801 SIGHUP at phase end" {
  grep -q 'kill -HUP' "$PHASE_FILE"
}

@test "P13-802 SIGHUP suppressed in headless eval" {
  grep -q 'WIZARD_HEADLESS_EVAL' "$PHASE_FILE"
}

@test "P13-901 default_reviewers written as JSON array (not CSV)" {
  grep -q 'TYPE_REVS' "$PHASE_FILE"
  grep -q 'default_reviewers = \${TYPE_REVS' "$PHASE_FILE"
}

@test "P13-A01 phase_13_skip_predicate exists in lib" {
  LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/skip-predicates.sh"
  grep -q '^phase_13_skip_predicate()' "$LIB"
}

@test "P13-A02 phase-13-probe exists in lib" {
  LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/idempotency-checks.sh"
  grep -q '^phase-13-probe()' "$LIB"
}
