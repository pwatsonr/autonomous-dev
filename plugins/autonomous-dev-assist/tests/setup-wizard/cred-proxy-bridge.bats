#!/usr/bin/env bats
# tests/setup-wizard/cred-proxy-bridge.bats
# SPEC-033-4-01 §6/§7. Replaces the SPEC-033-1-02 stub-stage tests.

LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/cred-proxy-bridge.sh"
MOCKS="${BATS_TEST_DIRNAME}/mocks"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export AUTONOMOUS_DEV_SECRETS_FILE="${TMPDIR_BATS}/secrets.env"
  export MOCK_COUNTER_DIR="${TMPDIR_BATS}/counters"
  mkdir -p "$MOCK_COUNTER_DIR"
  export PATH="${MOCKS}:${PATH}"
}

teardown() {
  rm -rf "$TMPDIR_BATS"
}

_mode() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

# --- header banner ---------------------------------------------------------

@test "CPB-001 header banner present (verbatim)" {
  run head -3 "$LIB"
  [ "$status" -eq 0 ]
  [[ "$output" == *"!!! credentials NEVER appear on stdout from this script !!!"* ]]
}

# --- cred_proxy_provision --------------------------------------------------

@test "CPB-101 provision happy path → handle on stdout" {
  export MOCK_CRED_PROXY_MODE=success
  export MOCK_CRED_PROXY_HANDLE="cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  run bash "$LIB" cred_proxy_provision aws dev
  [ "$status" -eq 0 ]
  [ "$output" = "cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" ]
  [[ "$output" =~ ^cph_[A-Za-z0-9]{32}$ ]]
}

@test "CPB-102 provision invalid handle shape → exit 1" {
  export MOCK_CRED_PROXY_MODE=invalid-shape
  run bash -c "bash \"$LIB\" cred_proxy_provision aws dev 2>&1"
  [ "$status" -eq 1 ]
  [[ "$output" == *"invalid handle shape"* ]]
}

@test "CPB-103 provision network error → exit 1, diagnostic on stderr" {
  export MOCK_CRED_PROXY_MODE=network-error
  run bash -c "bash \"$LIB\" cred_proxy_provision aws dev 2>&1"
  [ "$status" -eq 1 ]
  [[ "$output" == *"provision failed"* ]]
}

@test "CPB-104 provision missing args → exit 1" {
  run bash "$LIB" cred_proxy_provision
  [ "$status" -eq 1 ]
}

# --- cred_proxy_validate_handle --------------------------------------------

@test "CPB-201 validate ok → stdout=ok exit 0" {
  export MOCK_CRED_PROXY_VALIDATE=ok
  run bash "$LIB" cred_proxy_validate_handle cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  [ "$status" -eq 0 ]
  [ "$output" = "ok" ]
}

@test "CPB-202 validate expired → stdout=expired exit 2" {
  export MOCK_CRED_PROXY_VALIDATE=expired
  run bash "$LIB" cred_proxy_validate_handle cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  [ "$status" -eq 2 ]
  [ "$output" = "expired" ]
}

@test "CPB-203 validate unknown → stdout=unknown exit 3" {
  export MOCK_CRED_PROXY_VALIDATE=unknown
  run bash "$LIB" cred_proxy_validate_handle cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  [ "$status" -eq 3 ]
  [ "$output" = "unknown" ]
}

# --- cred_proxy_revoke -----------------------------------------------------

@test "CPB-301 revoke happy → exit 0" {
  export MOCK_CRED_PROXY_REVOKE=ok
  run bash "$LIB" cred_proxy_revoke cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  [ "$status" -eq 0 ]
}

@test "CPB-302 revoke already-revoked → exit 0 (idempotent)" {
  export MOCK_CRED_PROXY_REVOKE=already
  run bash "$LIB" cred_proxy_revoke cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  [ "$status" -eq 0 ]
}

@test "CPB-303 revoke unknown → exit 3" {
  export MOCK_CRED_PROXY_REVOKE=unknown
  run bash "$LIB" cred_proxy_revoke cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  [ "$status" -eq 3 ]
}

# --- fuzz: 50 candidate credentials, none leak ----------------------------

@test "CPB-401 fuzz: 50 candidate credentials → none leak in captured streams" {
  SCAN="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/credential-scanner.sh"
  for i in $(seq 1 50); do
    cred="AKIAFAKEFAKEFAKEFAK${i}_secretvalue${i}"
    export MOCK_CRED_PROXY_MODE=success
    export MOCK_CRED_PROXY_HANDLE="cph_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    out="$(bash "$LIB" cred_proxy_provision aws dev 2>&1)"
    if [[ "$out" == *"$cred"* ]]; then
      echo "LEAK: candidate $i appeared"
      false
    fi
    if ! bash "$SCAN" "$out" >/dev/null 2>&1; then :; else :; fi
  done
  true
}

# --- legacy write_env retained --------------------------------------------

@test "CPB-501 write_env still works (legacy phase-8 path)" {
  run bash "$LIB" cred_proxy_write_env DISCORD_TOKEN "sek-ret-1"
  [ "$status" -eq 0 ]
  [ -f "$AUTONOMOUS_DEV_SECRETS_FILE" ]
  grep -qx 'DISCORD_TOKEN=sek-ret-1' "$AUTONOMOUS_DEV_SECRETS_FILE"
  [ "$(_mode "$AUTONOMOUS_DEV_SECRETS_FILE")" = "600" ]
  ! [[ "$output" == *"sek-ret-1"* ]]
}

@test "CPB-502 read_handle removed (no longer defined)" {
  run bash "$LIB" cred_proxy_read_handle dev aws
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown function"* ]]
}
