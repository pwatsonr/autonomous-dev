#!/usr/bin/env bats
# tests/setup-wizard/idempotency-checks.bats
# Truth-table coverage for lib/idempotency-checks.sh per SPEC-033-1-02 §7
# and SPEC-033-3-01 §7.

LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/idempotency-checks.sh"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export AUTONOMOUS_DEV_CONFIG="${TMPDIR_BATS}/config.json"
  export WIZARD_STATE_FILE="${TMPDIR_BATS}/wizard-state.json"
  export ORIG_PATH="$PATH"
}

teardown() {
  rm -rf "$TMPDIR_BATS"
  export PATH="$ORIG_PATH"
}

# --- file_exists_with_hash --------------------------------------------------

@test "T-101 file_exists_with_hash: matching" {
  local f="$TMPDIR_BATS/foo.txt"
  printf 'hello' > "$f"
  local sha
  if command -v sha256sum >/dev/null 2>&1; then
    sha="$(sha256sum "$f" | awk '{print $1}')"
  else
    sha="$(shasum -a 256 "$f" | awk '{print $1}')"
  fi
  run bash "$LIB" file_exists_with_hash "$f" "$sha"
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "T-102 file_exists_with_hash: mismatching" {
  local f="$TMPDIR_BATS/foo.txt"
  printf 'hello' > "$f"
  run bash "$LIB" file_exists_with_hash "$f" 0000000000000000000000000000000000000000000000000000000000000000
  [ "$status" -eq 0 ]
  [ "$output" = "resume-from:rescaffold" ]
}

@test "T-103 file_exists_with_hash: missing" {
  run bash "$LIB" file_exists_with_hash "$TMPDIR_BATS/no-such" abcd
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

# --- wizard_state_phase_complete --------------------------------------------

@test "T-401 wizard_state_phase_complete: status=complete" {
  printf '%s' '{"phases":{"08":{"status":"complete"}}}' > "$WIZARD_STATE_FILE"
  run bash "$LIB" wizard_state_phase_complete 08
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "T-402 wizard_state_phase_complete: status=in-progress" {
  printf '%s' '{"phases":{"08":{"status":"in-progress"}}}' > "$WIZARD_STATE_FILE"
  run bash "$LIB" wizard_state_phase_complete 08
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "T-403 wizard_state_phase_complete: state file missing" {
  rm -f "$WIZARD_STATE_FILE"
  run bash "$LIB" wizard_state_phase_complete 08
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

# --- config_key_equals (idempotency variant emits stdout) -------------------

@test "T-501 config_key_equals: match → already-complete" {
  printf '%s' '{"intake":{"discord":{"enabled":"true"}}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" config_key_equals intake.discord.enabled true
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "T-502 config_key_equals: no match → start-fresh" {
  printf '%s' '{"intake":{"discord":{"enabled":"false"}}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" config_key_equals intake.discord.enabled true
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

# --- workflow_template_hash_matches alias -----------------------------------

@test "IC-401 workflow_template_hash_matches: missing file" {
  run bash "$LIB" workflow_template_hash_matches /no-such/path abcd
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

# --- standards_yaml_exists_at -----------------------------------------------

@test "IC-701 standards_yaml_exists_at: missing file → start-fresh" {
  run bash "$LIB" standards_yaml_exists_at "$TMPDIR_BATS/no/standards.yaml"
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "IC-704 standards_yaml_exists_at: CLI missing + file present → exit 2" {
  mkdir -p "$TMPDIR_BATS/repo/.autonomous-dev"
  local f="$TMPDIR_BATS/repo/.autonomous-dev/standards.yaml"
  printf 'rules: []\n' > "$f"
  # Strip autonomous-dev from PATH
  mkdir -p "$TMPDIR_BATS/nocli"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq dirname find sha256sum shasum; do
    src="$(command -v $tool 2>/dev/null || true)"
    if [[ -n "$src" ]]; then
      ln -sf "$src" "$TMPDIR_BATS/nocli/$tool"
    fi
  done
  PATH="$TMPDIR_BATS/nocli" run bash "$LIB" standards_yaml_exists_at "$f"
  [ "$status" -eq 2 ]
  [[ "$output" == *"autonomous-dev-cli-missing"* ]]
}

# --- reviewer_chain_yaml_matches --------------------------------------------

@test "IC-801 reviewer_chain_yaml_matches: missing file" {
  run bash "$LIB" reviewer_chain_yaml_matches /no-such abcd
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "IC-802 reviewer_chain_yaml_matches: hash matches" {
  local f="$TMPDIR_BATS/chains.yaml"
  printf 'chains: []\n' > "$f"
  local sha
  if command -v sha256sum >/dev/null 2>&1; then
    sha="$(sha256sum "$f" | awk '{print $1}')"
  else
    sha="$(shasum -a 256 "$f" | awk '{print $1}')"
  fi
  run bash "$LIB" reviewer_chain_yaml_matches "$f" "$sha"
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "IC-803 reviewer_chain_yaml_matches: hash differs" {
  local f="$TMPDIR_BATS/chains.yaml"
  printf 'chains: []\n' > "$f"
  run bash "$LIB" reviewer_chain_yaml_matches "$f" 0000000000000000000000000000000000000000000000000000000000000000
  [ "$status" -eq 0 ]
  [ "$output" = "resume-with-diff" ]
}

# --- read-only invariant ----------------------------------------------------

@test "T-901 read-only invariant: helpers do not write" {
  printf '%s' '{"intake":{"discord":{"enabled":"true"}}}' > "$AUTONOMOUS_DEV_CONFIG"
  printf '%s' '{"phases":{"08":{"status":"complete"}}}' > "$WIZARD_STATE_FILE"
  before="$(find "$TMPDIR_BATS" -type f -newer "$AUTONOMOUS_DEV_CONFIG" 2>/dev/null | wc -l | tr -d ' ')"
  run bash "$LIB" wizard_state_phase_complete 08
  run bash "$LIB" config_key_equals intake.discord.enabled true
  after="$(find "$TMPDIR_BATS" -type f -newer "$AUTONOMOUS_DEV_CONFIG" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$before" = "$after" ]
}
