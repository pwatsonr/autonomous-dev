#!/usr/bin/env bats
# tests/setup-wizard/phase-15.bats — front-matter + skip + probe + flag-default
# coverage for SPEC-033-3-03.

PHASES_DIR="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases"
LIB_DIR="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib"
PHASE15="${PHASES_DIR}/phase-15-reviewer-chains.md"
DEFAULTS="${BATS_TEST_DIRNAME}/../../config_defaults.json"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export AUTONOMOUS_DEV_CONFIG="${TMPDIR_BATS}/config.json"
  export WIZARD_STATE_FILE="${TMPDIR_BATS}/wizard-state.json"
  export WIZARD_REPO="${TMPDIR_BATS}/repo"
  mkdir -p "$WIZARD_REPO/.autonomous-dev"
  printf '{}\n' > "$AUTONOMOUS_DEV_CONFIG"
}

teardown() {
  rm -rf "$TMPDIR_BATS"
}

# --- Front-matter contract (FR-1, FR-2, FR-6) ------------------------------

@test "P15-101 phase-15-reviewer-chains.md exists with front-matter" {
  [ -f "$PHASE15" ]
  run head -1 "$PHASE15"
  [ "$status" -eq 0 ]
  [ "$output" = "---" ]
}

@test "P15-102 front-matter sets phase=15 and tdd_anchors=[TDD-020, TDD-021]" {
  run grep -E '^phase: 15$' "$PHASE15"
  [ "$status" -eq 0 ]
  run grep -E '^tdd_anchors: \[TDD-020, TDD-021\]' "$PHASE15"
  [ "$status" -eq 0 ]
}

@test "P15-103 front-matter declares reviewer_chains.* config keys" {
  for key in reviewer_chains.path reviewer_chains.last_dry_run_at reviewer_chains.specialists_enabled_count; do
    run grep -F -- "- $key" "$PHASE15"
    [ "$status" -eq 0 ]
  done
}

@test "P15-104 front-matter declares reviewer-chains.yaml file output" {
  run grep -F 'reviewer-chains.yaml' "$PHASE15"
  [ "$status" -eq 0 ]
}

@test "P15-105 prd_links contains PRD-015" {
  run grep -E '^prd_links: \[PRD-015\]' "$PHASE15"
  [ "$status" -eq 0 ]
}

# --- Skip-with-consequence (FR-3, FR-4) ------------------------------------

@test "P15-201 verbatim consequence text present" {
  run grep -F "Only the generic reviewer will run; security/performance/accessibility findings will not be surfaced automatically." "$PHASE15"
  [ "$status" -eq 0 ]
}

@test "P15-202 phase_15_skip_predicate exits 0 when wizard.skip_phase_15=true" {
  printf '%s' '{"wizard":{"skip_phase_15":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/skip-predicates.sh" phase_15_skip_predicate
  [ "$status" -eq 0 ]
}

# --- Forward-reference banner (FR-12) --------------------------------------

@test "P15-501 forward-reference banner text appears in module" {
  run grep -F 'NOTE: This phase configures specialist reviewer chains for DRY-RUN' "$PHASE15"
  [ "$status" -eq 0 ]
  run grep -F 'docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md' "$PHASE15"
  [ "$status" -eq 0 ]
}

# --- Probe wrapper ---------------------------------------------------------

@test "P15-301 phase-15-probe: chain.yaml missing → start-fresh" {
  rm -f "$WIZARD_REPO/.autonomous-dev/reviewer-chains.yaml"
  run bash "$LIB_DIR/idempotency-checks.sh" phase-15-probe
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "P15-302 phase-15-probe: chain.yaml present + recent dry-run → already-complete" {
  printf 'specialists: []\n' > "$WIZARD_REPO/.autonomous-dev/reviewer-chains.yaml"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s' "{\"reviewer_chains\":{\"last_dry_run_at\":\"$now\"}}" > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/idempotency-checks.sh" phase-15-probe
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "P15-303 phase-15-probe: chain.yaml present + last_dry_run_at missing → resume-from:enumerate" {
  printf 'specialists: []\n' > "$WIZARD_REPO/.autonomous-dev/reviewer-chains.yaml"
  printf '{}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/idempotency-checks.sh" phase-15-probe
  [ "$status" -eq 0 ]
  [ "$output" = "resume-from:enumerate" ]
}

# --- Eval cases exist (FR-17) -----------------------------------------------

@test "P15-401 four eval cases exist" {
  local d="${BATS_TEST_DIRNAME}/../../evals/test-cases/setup-wizard/phase-15-reviewer-chains"
  [ -f "$d/happy-path.md" ]
  [ -f "$d/skip-with-consequence.md" ]
  [ -f "$d/error-recovery.md" ]
  [ -f "$d/idempotency-resume.md" ]
}

# --- Feature flag defaults (FR-24) -----------------------------------------

@test "P15-C01 config_defaults.json sets phase_14 and phase_15 module flags to true" {
  run jq -r '.wizard.phase_14_module_enabled' "$DEFAULTS"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
  run jq -r '.wizard.phase_15_module_enabled' "$DEFAULTS"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

# --- Catalog data-drivenness (FR-7) -----------------------------------------

@test "P15-301 specialist-reviewers.json catalog exists and is a valid JSON array" {
  local catalog="${BATS_TEST_DIRNAME}/../../../autonomous-dev/config/specialist-reviewers.json"
  [ -f "$catalog" ]
  run jq -e 'type == "array" and length > 0' "$catalog"
  [ "$status" -eq 0 ]
}

@test "P15-302 every catalog entry declares the five contract fields" {
  local catalog="${BATS_TEST_DIRNAME}/../../../autonomous-dev/config/specialist-reviewers.json"
  # required: id, description, default_weight, default_threshold, requires_standards
  run jq -e 'all(.[]; has("id") and has("description") and has("default_weight") and has("default_threshold") and has("requires_standards"))' "$catalog"
  [ "$status" -eq 0 ]
}

# --- Sort determinism (FR-9) ------------------------------------------------

@test "P15-401 reviewer-chain-render produces deterministic byte-identical output across replays" {
  local renderer="$LIB_DIR/reviewer-chain-render.sh"
  [ -f "$renderer" ]
  local input='{"id":"security","weight":2,"threshold":0.8}
{"id":"performance","weight":1,"threshold":0.7}
{"id":"accessibility","weight":2,"threshold":0.6}'
  local out1 out2
  out1="$(printf '%s' "$input" | bash "$renderer")"
  out2="$(printf '%s' "$input" | bash "$renderer")"
  [ "$out1" = "$out2" ]
}

@test "P15-402 reviewer-chain-render: weight asc, ties broken by id asc" {
  local renderer="$LIB_DIR/reviewer-chain-render.sh"
  local input='{"id":"security","weight":2,"threshold":0.8}
{"id":"performance","weight":1,"threshold":0.7}
{"id":"accessibility","weight":2,"threshold":0.6}'
  local out
  out="$(printf '%s' "$input" | bash "$renderer")"
  # Expect: performance (w=1) first, then accessibility (w=2 id<security), then security (w=2 id>access).
  echo "$out" | grep -q '^  - id: performance$'
  echo "$out" | grep -q '^  - id: accessibility$'
  echo "$out" | grep -q '^  - id: security$'
  # Order check
  local i_perf i_acc i_sec
  i_perf="$(echo "$out" | grep -n '^  - id: performance$' | head -1 | cut -d: -f1)"
  i_acc="$(echo "$out" | grep -n '^  - id: accessibility$' | head -1 | cut -d: -f1)"
  i_sec="$(echo "$out" | grep -n '^  - id: security$' | head -1 | cut -d: -f1)"
  [ "$i_perf" -lt "$i_acc" ]
  [ "$i_acc" -lt "$i_sec" ]
}

@test "P15-403 reviewer-chain-render: empty input emits empty specialist list" {
  local renderer="$LIB_DIR/reviewer-chain-render.sh"
  local out
  out="$(printf '' | bash "$renderer")"
  echo "$out" | grep -q '^specialists: \[\]$'
}

# --- Feature-flag override (FR-25) ------------------------------------------

@test "P15-C02 phase_15_module_enabled override path documented in SKILL.md" {
  # The orchestrator emits "Phase NN unavailable" per SPEC-033-1-03 FR-4.
  # SKILL.md documents this contract.
  local skill="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/SKILL.md"
  run grep -F 'Phase NN unavailable' "$skill"
  [ "$status" -eq 0 ]
  run grep -F 'phase_NN_module_enabled' "$skill"
  [ "$status" -eq 0 ]
}
