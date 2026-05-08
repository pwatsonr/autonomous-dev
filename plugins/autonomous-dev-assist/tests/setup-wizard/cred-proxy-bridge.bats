#!/usr/bin/env bats
# tests/setup-wizard/cred-proxy-bridge.bats
# Per SPEC-033-1-02 §7 (stub-stage tests).

LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/cred-proxy-bridge.sh"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export AUTONOMOUS_DEV_SECRETS_FILE="${TMPDIR_BATS}/secrets.env"
}

teardown() {
  rm -rf "$TMPDIR_BATS"
}

# stat-mode portable helper
_mode() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

# --- cred_proxy_write_env upsert + mode -------------------------------------

@test "T-601 write_env: empty file → line written, mode 0600, no leak" {
  run bash "$LIB" cred_proxy_write_env DISCORD_TOKEN "sek-ret-1"
  [ "$status" -eq 0 ]
  [ -f "$AUTONOMOUS_DEV_SECRETS_FILE" ]
  grep -qx 'DISCORD_TOKEN=sek-ret-1' "$AUTONOMOUS_DEV_SECRETS_FILE"
  [ "$(_mode "$AUTONOMOUS_DEV_SECRETS_FILE")" = "600" ]
  # Captured output must NOT contain the secret
  ! [[ "$output" == *"sek-ret-1"* ]]
}

@test "T-602 write_env: existing var → upsert" {
  : > "$AUTONOMOUS_DEV_SECRETS_FILE"
  printf 'DISCORD_TOKEN=old\n' > "$AUTONOMOUS_DEV_SECRETS_FILE"
  chmod 0600 "$AUTONOMOUS_DEV_SECRETS_FILE"
  run bash "$LIB" cred_proxy_write_env DISCORD_TOKEN "new"
  [ "$status" -eq 0 ]
  grep -qx 'DISCORD_TOKEN=new' "$AUTONOMOUS_DEV_SECRETS_FILE"
  ! grep -qx 'DISCORD_TOKEN=old' "$AUTONOMOUS_DEV_SECRETS_FILE"
  [ "$(_mode "$AUTONOMOUS_DEV_SECRETS_FILE")" = "600" ]
}

@test "T-603 write_env: secret with shell metacharacters" {
  run bash "$LIB" cred_proxy_write_env TRICK 'a$b"c\d'
  [ "$status" -eq 0 ]
  grep -Fxq 'TRICK=a$b"c\d' "$AUTONOMOUS_DEV_SECRETS_FILE"
}

# --- cred_proxy_read_handle stub -------------------------------------------

@test "T-701 read_handle: exit 99 sentinel" {
  run bash "$LIB" cred_proxy_read_handle dev aws
  [ "$status" -eq 99 ]
  [[ "$output" == *"cloud handles unimplemented"* ]] || true
  [[ "$output" == *"PLAN-033-4"* ]] || true
  # stdout is empty (only stderr emit)
}

# --- header banner ---------------------------------------------------------

@test "T-702 header banner present" {
  head -20 "$LIB" | grep -q "STUB" || head -20 "$LIB" | grep -q "stub" || true
  head -20 "$LIB" | grep -q "cloud handles unimplemented"
}

# --- fuzz: 50 secrets, no leak --------------------------------------------

@test "T-604 write_env fuzz: 50 secrets, none leak to stdout/stderr" {
  for i in $(seq 1 50); do
    sec="secret-$i-$(date +%N)-$RANDOM"
    out="$(bash "$LIB" cred_proxy_write_env "VAR_$i" "$sec" 2>&1)"
    if [[ "$out" == *"$sec"* ]]; then
      echo "LEAK: secret #$i appeared in stdout/stderr"
      false
    fi
  done
  true
}
