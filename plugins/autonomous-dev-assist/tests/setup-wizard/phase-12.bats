#!/usr/bin/env bats
# tests/setup-wizard/phase-12.bats
# Phase-12 module + front-matter contract per SPEC-033-2-02.

PHASE_FILE="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases/phase-12-ci-setup.md"
TPL_DIR="${BATS_TEST_DIRNAME}/../../../autonomous-dev/templates/workflows"

@test "P12-101a phase number" {
  grep -E '^phase:[[:space:]]+12' "$PHASE_FILE"
}

@test "P12-101b title" {
  grep -E '^title:.*CI workflows' "$PHASE_FILE"
}

@test "P12-101c tdd_anchors include TDD-016 and TDD-017" {
  line="$(grep -E '^tdd_anchors:' "$PHASE_FILE")"
  echo "$line" | grep -q 'TDD-016'
  echo "$line" | grep -q 'TDD-017'
}

@test "P12-101d prd_links contains PRD-015" {
  grep -E '^prd_links:' "$PHASE_FILE" | grep -q 'PRD-015'
}

@test "P12-101e skip_predicate references phase_12_skip_predicate" {
  grep -E '^skip_predicate:' "$PHASE_FILE" | grep -q 'phase_12_skip_predicate'
}

@test "P12-101f skip_consequence verbatim text" {
  grep -q 'GitHub-only support; daemon will run but workflow validation must be done manually' "$PHASE_FILE"
}

@test "P12-101g idempotency_probe is phase-12-probe" {
  grep -E '^idempotency_probe:' "$PHASE_FILE" | grep -q 'phase-12-probe'
}

@test "P12-101h output_state.config_keys_written has 4 ci.* entries" {
  count=$(awk '/config_keys_written:/,/files_created:/' "$PHASE_FILE" | grep -cE '^[[:space:]]+- ci\.')
  [ "$count" -eq 4 ]
}

@test "P12-101i output_state.files_created has 3 workflow paths" {
  count=$(awk '/files_created:/,/external_resources_created:/' "$PHASE_FILE" \
    | grep -cE '^[[:space:]]+- "\.github/workflows/')
  [ "$count" -eq 3 ]
}

@test "P12-101j external_resources_created lists secret + protection" {
  awk '/external_resources_created:/,/verification:/' "$PHASE_FILE" | grep -q 'AUTONOMOUS_DEV_TOKEN'
  awk '/external_resources_created:/,/verification:/' "$PHASE_FILE" | grep -q 'branch_protection'
}

@test "P12-201 PRD-015 banner is present" {
  grep -q 'PRD-015' "$PHASE_FILE"
  grep -q 'docs/prds/PRD-015-' "$PHASE_FILE"
}

@test "P12-301 PAT-scope diagnostic text present" {
  grep -q 'your token needs' "$PHASE_FILE"
  grep -q 'admin permissions on this repo' "$PHASE_FILE"
}

@test "P12-401 GHES diagnostic text present" {
  grep -q 'GHES' "$PHASE_FILE"
  grep -q 'github.com only at this time' "$PHASE_FILE"
}

@test "P12-501 trap install before pr create" {
  # Trap definition appears BEFORE 'gh pr create' line in module.
  trap_line=$(grep -n "trap '_phase12_cleanup" "$PHASE_FILE" | head -1 | cut -d: -f1)
  pr_line=$(grep -n 'gh pr create' "$PHASE_FILE" | head -1 | cut -d: -f1)
  [ -n "$trap_line" ] && [ -n "$pr_line" ] && [ "$trap_line" -lt "$pr_line" ]
}

@test "P12-502 trap covers EXIT INT TERM" {
  grep -q "trap '_phase12_cleanup.*' EXIT INT TERM" "$PHASE_FILE"
}

@test "P12-601 contexts derived from filenames not hard-coded" {
  # Contexts are built from a loop over scaffolded basenames.
  grep -q 'basename "$f" .yml' "$PHASE_FILE"
}

@test "P12-701 5-minute poll ceiling" {
  grep -q 'date +%s' "$PHASE_FILE"
  grep -q '300' "$PHASE_FILE"
}

@test "P12-801 stale probe branch detection" {
  grep -q 'autonomous-dev-wizard-probe-' "$PHASE_FILE"
  grep -q 'Clean up before proceeding' "$PHASE_FILE"
}

@test "P12-901 templates exist" {
  [ -f "$TPL_DIR/autonomous-dev-ci.yml" ]
  [ -f "$TPL_DIR/autonomous-dev-cd.yml" ]
  [ -f "$TPL_DIR/observe.yml.example" ]
}

@test "P12-902 PAT read uses set +x and -rs" {
  grep -q 'set +x' "$PHASE_FILE"
  grep -q 'read -rs' "$PHASE_FILE"
}
