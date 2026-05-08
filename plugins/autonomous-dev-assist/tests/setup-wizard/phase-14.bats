#!/usr/bin/env bats
# tests/setup-wizard/phase-14.bats — front-matter + skip + probe coverage
# for SPEC-033-3-02. Operator-flow steps are covered by the eval cases.

PHASES_DIR="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases"
LIB_DIR="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib"
PHASE14="${PHASES_DIR}/phase-14-eng-standards.md"

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

# --- Front-matter contract (FR-1, FR-2, FR-6) -------------------------------

@test "P14-101 phase-14-eng-standards.md exists with front-matter" {
  [ -f "$PHASE14" ]
  run head -1 "$PHASE14"
  [ "$status" -eq 0 ]
  [ "$output" = "---" ]
}

@test "P14-102 front-matter sets phase=14 and tdd_anchors=[TDD-021]" {
  run grep -E '^phase: 14$' "$PHASE14"
  [ "$status" -eq 0 ]
  run grep -E '^tdd_anchors: \[TDD-021\]' "$PHASE14"
  [ "$status" -eq 0 ]
}

@test "P14-103 front-matter declares all four config_keys_written" {
  for key in standards.pack_id standards.path standards.two_person_approval_enabled standards.last_dry_run_at; do
    run grep -F -- "- $key" "$PHASE14"
    [ "$status" -eq 0 ]
  done
}

@test "P14-104 front-matter declares standards.yaml + dated dry-run JSON" {
  run grep -F 'standards.yaml' "$PHASE14"
  [ "$status" -eq 0 ]
  run grep -F 'standards-dry-run-<YYYY-MM-DD>.json' "$PHASE14"
  [ "$status" -eq 0 ]
}

@test "P14-105 skip_predicate is phase_14_skip_predicate" {
  run grep -F 'skip-predicates.sh phase_14_skip_predicate' "$PHASE14"
  [ "$status" -eq 0 ]
}

# --- Skip-with-consequence (FR-3, FR-4) ------------------------------------

@test "P14-201 verbatim consequence text present" {
  run grep -F "Author agents will not be standards-aware" "$PHASE14"
  [ "$status" -eq 0 ]
}

@test "P14-202 phase_14_skip_predicate exits 0 when wizard.skip_phase_14=true" {
  printf '%s' '{"wizard":{"skip_phase_14":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/skip-predicates.sh" phase_14_skip_predicate
  [ "$status" -eq 0 ]
}

@test "P14-203 phase_14_skip_predicate exits 1 when flag absent" {
  printf '{}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/skip-predicates.sh" phase_14_skip_predicate
  [ "$status" -eq 1 ]
}

# --- Probe wrapper (FR-5) ---------------------------------------------------

@test "P14-301 phase-14-probe: standards.yaml missing → start-fresh" {
  rm -f "$WIZARD_REPO/.autonomous-dev/standards.yaml"
  run bash "$LIB_DIR/idempotency-checks.sh" phase-14-probe
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "P14-302 phase-14-probe: file present + validate fails → resume-from:offer-pack" {
  printf 'rules: []\n' > "$WIZARD_REPO/.autonomous-dev/standards.yaml"
  local stubdir="$TMPDIR_BATS/stubdir"
  mkdir -p "$stubdir"
  cat > "$stubdir/autonomous-dev" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "standards validate" ]] && exit 1
exit 0
EOF
  chmod +x "$stubdir/autonomous-dev"
  PATH="$stubdir:$PATH" run bash "$LIB_DIR/idempotency-checks.sh" phase-14-probe
  [ "$status" -eq 0 ]
  [ "$output" = "resume-from:offer-pack" ]
}

@test "P14-303 phase-14-probe: valid yaml + no today dry-run → resume-from:meta-reviewer-dry-run" {
  printf 'rules: []\n' > "$WIZARD_REPO/.autonomous-dev/standards.yaml"
  local stubdir="$TMPDIR_BATS/stubdir"
  mkdir -p "$stubdir"
  cat > "$stubdir/autonomous-dev" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "standards validate" ]] && exit 0
exit 0
EOF
  chmod +x "$stubdir/autonomous-dev"
  PATH="$stubdir:$PATH" run bash "$LIB_DIR/idempotency-checks.sh" phase-14-probe
  [ "$status" -eq 0 ]
  [ "$output" = "resume-from:meta-reviewer-dry-run" ]
}

@test "P14-304 phase-14-probe: valid yaml + today's dry-run present → already-complete" {
  printf 'rules: []\n' > "$WIZARD_REPO/.autonomous-dev/standards.yaml"
  today="$(date -u +%Y-%m-%d)"
  printf '{}\n' > "$WIZARD_REPO/.autonomous-dev/standards-dry-run-${today}.json"
  local stubdir="$TMPDIR_BATS/stubdir"
  mkdir -p "$stubdir"
  cat > "$stubdir/autonomous-dev" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "standards validate" ]] && exit 0
exit 0
EOF
  chmod +x "$stubdir/autonomous-dev"
  PATH="$stubdir:$PATH" run bash "$LIB_DIR/idempotency-checks.sh" phase-14-probe
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

# --- Eval cases exist (FR-18) -----------------------------------------------

@test "P14-401 four eval cases exist" {
  local d="${BATS_TEST_DIRNAME}/../../evals/test-cases/setup-wizard/phase-14-eng-standards"
  [ -f "$d/happy-path.md" ]
  [ -f "$d/skip-with-consequence.md" ]
  [ -f "$d/error-recovery.md" ]
  [ -f "$d/idempotency-resume.md" ]
}
