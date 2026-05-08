#!/usr/bin/env bats
# tests/setup-wizard/phase-16.bats — front-matter, skip, probe, scanner-gate,
# per-env atomicity coverage for SPEC-033-4-02.

PHASES_DIR="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/phases"
LIB_DIR="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib"
EVAL_DIR="${BATS_TEST_DIRNAME}/../../evals/test-cases/setup-wizard/phase-16-deploy-backends"
PHASE16="${PHASES_DIR}/phase-16-deploy-backends.md"
DEFAULTS="${BATS_TEST_DIRNAME}/../../config_defaults.json"
FIXT_DIR="${BATS_TEST_DIRNAME}/../fixtures/setup-wizard/credential-leak"

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

# --- P16-101 Front-matter contract (FR-1, FR-2, FR-6, FR-7) -----------------

@test "P16-101 phase-16-deploy-backends.md exists with front-matter" {
  [ -f "$PHASE16" ]
  run head -1 "$PHASE16"
  [ "$status" -eq 0 ]
  [ "$output" = "---" ]
}

@test "P16-102 front-matter sets phase=16 and tdd_anchors=[TDD-023, TDD-024]" {
  run grep -E '^phase: 16$' "$PHASE16"
  [ "$status" -eq 0 ]
  run grep -E '^tdd_anchors: \[TDD-023, TDD-024\]' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-103 front-matter prd_links contains PRD-014, PRD-015, PRD-017" {
  run grep -E '^prd_links: \[PRD-014, PRD-015, PRD-017\]' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-104 front-matter declares 12 deploy.envs.* config keys (4 per env x 3 envs)" {
  for env in dev staging prod; do
    for k in backend cred_proxy_handle firewall_template last_dry_run_at; do
      run grep -F -- "- deploy.envs.${env}.${k}" "$PHASE16"
      [ "$status" -eq 0 ]
    done
  done
}

@test "P16-105 front-matter declares 6 external_resources_created (3 cred-proxy + 3 firewall)" {
  for env in dev staging prod; do
    run grep -F -- "\"cred-proxy-handle:${env}\"" "$PHASE16"
    [ "$status" -eq 0 ]
    run grep -F -- "\"firewall-allowlist:${env}\"" "$PHASE16"
    [ "$status" -eq 0 ]
  done
}

@test "P16-106 front-matter required_inputs.phases_complete = [1..7]" {
  run grep -F 'phases_complete: [1,2,3,4,5,6,7]' "$PHASE16"
  [ "$status" -eq 0 ]
}

# --- P16-201 Skip-with-consequence (FR-3, FR-4) -----------------------------

@test "P16-201 verbatim FR-4 consequence text present" {
  run grep -F 'Only `local` backend configured; daemon cannot deploy to dev/staging/prod.' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-202 skip predicate references phase_16_skip_predicate" {
  run grep -F 'skip-predicates.sh phase_16_skip_predicate' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-203 phase_16_skip_predicate skips when wizard.skip_phase_16=true" {
  printf '{"wizard":{"skip_phase_16":true}}\n' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/skip-predicates.sh" phase_16_skip_predicate
  [ "$status" -eq 0 ]   # skip
}

@test "P16-204 phase_16_skip_predicate runs when wizard.skip_phase_16 absent" {
  printf '{}\n' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/skip-predicates.sh" phase_16_skip_predicate
  [ "$status" -eq 1 ]   # run
}

# --- P16-301 Iteration order dev → staging → prod ---------------------------

@test "P16-301 phase body documents iteration order dev → staging → prod" {
  run grep -F 'for env in dev staging prod' "$PHASE16"
  [ "$status" -eq 0 ]
}

# --- P16-401 Operator input runs through scanner (FR-9) ---------------------

@test "P16-401 credential-scanner aborts on AKIA-style operator input" {
  # Use the family-a fixture to verify the scanner behaves as the phase contract
  # describes. The fixture is a synthetic, documented-fake AKIA-shaped value.
  local content
  content="$(tr -d '\n' < "$FIXT_DIR/family-a-fake-aws.txt")"
  run bash "$LIB_DIR/credential-scanner.sh" "$content"
  [ "$status" -eq 1 ]
  [[ "$output" == *"family=a"* ]] || [[ "$stderr" == *"family=a"* ]] || \
    [[ "${output}${stderr:-}" == *"family=a"* ]]
}

@test "P16-402 credential-scanner.sh covers all 6 families against fixtures" {
  local fams=(a b c d e f) f content
  for f in "${fams[@]}"; do
    content="$(tr -d '\n' < "$FIXT_DIR"/family-"${f}"-fake-*.txt)"
    run bash "$LIB_DIR/credential-scanner.sh" "$content"
    [ "$status" -eq 1 ]
  done
}

# --- P16-501 Plugin install upsert / -601 cred-proxy / -701 firewall --------
# (these are design assertions on the phase body content)

@test "P16-501 plugin install upsert: skip-on-matching-version documented" {
  run grep -F 'plugin info' "$PHASE16"
  [ "$status" -eq 0 ]
  run grep -F 'currently installed:' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-601 cred-proxy handle shape regex documented" {
  run grep -F '^cph_[A-Za-z0-9]{32}$' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-701 firewall same-template re-apply / idempotent marker handled" {
  run grep -F 'idempotent' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-801 cost-cap-enforcer: finite-numeric guard + PRD-017 reference" {
  run grep -F 'estimated_monthly_cost_usd' "$PHASE16"
  [ "$status" -eq 0 ]
  run grep -F 'PRD-017' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-901 final dry-run + structured plan documented" {
  run grep -F 'plan_steps' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-A01 per-env atomicity documented" {
  run grep -F 'per-env atomicity' "$PHASE16"
  [ "$status" -eq 0 ]
}

@test "P16-B01 PRD cross-reference banner emitted exactly once (single-occurrence sentence)" {
  run grep -c -F 'NOTE: This phase configures deployment backends.' "$PHASE16"
  [ "$status" -eq 0 ]
  [ "$output" -eq 1 ]
}

@test "P16-C01 SIGHUP step documented" {
  run grep -F 'pkill -HUP' "$PHASE16"
  [ "$status" -eq 0 ]
}

# --- Eval set existence (FR-18) ---------------------------------------------

@test "P16-E01 happy-path.md eval exists" {
  [ -f "$EVAL_DIR/happy-path.md" ]
}
@test "P16-E02 skip-with-consequence.md eval exists" {
  [ -f "$EVAL_DIR/skip-with-consequence.md" ]
}
@test "P16-E03 error-recovery.md eval exists" {
  [ -f "$EVAL_DIR/error-recovery.md" ]
}
@test "P16-E04 idempotency-resume.md eval exists" {
  [ -f "$EVAL_DIR/idempotency-resume.md" ]
}
@test "P16-E05 linked-prd-no-duplication.md eval exists" {
  [ -f "$EVAL_DIR/linked-prd-no-duplication.md" ]
}
@test "P16-E06 credential-leak.md eval exists and is mandatory + auto-fail" {
  [ -f "$EVAL_DIR/credential-leak.md" ]
  run grep -F 'mandatory: true' "$EVAL_DIR/credential-leak.md"
  [ "$status" -eq 0 ]
  run grep -F 'auto_fail_on_match: true' "$EVAL_DIR/credential-leak.md"
  [ "$status" -eq 0 ]
}

# --- Phase-16 idempotency probe ---------------------------------------------

@test "P16-IP01 phase-16-probe returns start-fresh when no envs configured" {
  run bash "$LIB_DIR/idempotency-checks.sh" phase-16-probe
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "P16-IP02 phase-16-probe returns resume-from when only dev configured" {
  printf '{"deploy":{"envs":{"dev":{"backend":"local"}}}}\n' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/idempotency-checks.sh" phase-16-probe
  [ "$status" -eq 0 ]
  [[ "$output" == "resume-from:"* ]]
}

@test "P16-IP03 phase-16-probe returns already-complete when all 3 envs are local" {
  printf '{"deploy":{"envs":{"dev":{"backend":"local"},"staging":{"backend":"local"},"prod":{"backend":"local"}}}}\n' \
    > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB_DIR/idempotency-checks.sh" phase-16-probe
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

# --- FR-26 lint: only phase 16 may call cred_proxy_provision/validate/revoke -

@test "P16-FR26 no other phase module calls cred_proxy_provision/validate/revoke" {
  run grep -lE 'cred_proxy_(provision|validate_handle|revoke)' \
    "$PHASES_DIR"/phase-08-*.md "$PHASES_DIR"/phase-11-*.md \
    "$PHASES_DIR"/phase-12-*.md "$PHASES_DIR"/phase-13-*.md \
    "$PHASES_DIR"/phase-14-*.md "$PHASES_DIR"/phase-15-*.md
  # grep returns 1 when no files match; that's the desired state.
  [ "$status" -ne 0 ] || [ -z "$output" ]
}

# --- Default flag still ships disabled at this commit (flipped in SPEC-033-4-04 step) ---

@test "P16-FF01 config_defaults.json carries wizard.phase_16_module_enabled (boolean)" {
  run jq -e '.wizard.phase_16_module_enabled | type == "boolean"' "$DEFAULTS"
  [ "$status" -eq 0 ]
}
