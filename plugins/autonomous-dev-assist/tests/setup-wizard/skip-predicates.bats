#!/usr/bin/env bats
# tests/setup-wizard/skip-predicates.bats
# Truth-table coverage for lib/skip-predicates.sh per SPEC-033-1-01 §7.

LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/skip-predicates.sh"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export AUTONOMOUS_DEV_CONFIG="${TMPDIR_BATS}/config.json"
  export ORIG_PATH="$PATH"
}

teardown() {
  rm -rf "$TMPDIR_BATS"
  export PATH="$ORIG_PATH"
}

# --- is_github_origin -------------------------------------------------------

@test "T-101 is_github_origin: github.com origin" {
  cd "$TMPDIR_BATS"
  git init -q
  git remote add origin "git@github.com:pwatsonr/foo.git"
  run bash "$LIB" is_github_origin
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "T-102 is_github_origin: gitlab origin" {
  cd "$TMPDIR_BATS"
  git init -q
  git remote add origin "https://gitlab.com/x/y.git"
  run bash "$LIB" is_github_origin
  [ "$status" -eq 1 ]
}

@test "T-103 is_github_origin: non-repo dir" {
  cd "$TMPDIR_BATS"
  run bash "$LIB" is_github_origin
  [ "$status" -eq 1 ]
}

@test "T-104 is_github_origin: GHES origin" {
  cd "$TMPDIR_BATS"
  git init -q
  git remote add origin "git@github.example-corp.com:x/y.git"
  run bash "$LIB" is_github_origin
  [ "$status" -eq 0 ]
}

# --- has_config_key ---------------------------------------------------------

@test "T-201 has_config_key: nested key present" {
  printf '%s' '{"intake":{"discord":{"enabled":true}}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" has_config_key intake.discord.enabled
  [ "$status" -eq 0 ]
}

@test "T-202 has_config_key: missing key" {
  printf '%s' '{"intake":{"discord":{"enabled":true}}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" has_config_key intake.slack.enabled
  [ "$status" -eq 1 ]
}

@test "T-203 has_config_key: missing config file" {
  rm -f "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" has_config_key any.key
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}

# --- config_key_equals ------------------------------------------------------

@test "T-301 config_key_equals: matching value" {
  printf '%s' '{"wizard":{"cli_only":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" config_key_equals wizard.cli_only true
  [ "$status" -eq 0 ]
}

@test "T-302 config_key_equals: non-matching value" {
  printf '%s' '{"wizard":{"cli_only":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" config_key_equals wizard.cli_only false
  [ "$status" -eq 1 ]
}

@test "T-303 config_key_equals: missing key" {
  printf '%s' '{"wizard":{}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" config_key_equals wizard.cli_only true
  [ "$status" -eq 1 ]
}

# --- is_cli_only_mode -------------------------------------------------------

@test "T-401 is_cli_only_mode: cli_only=true" {
  printf '%s' '{"wizard":{"cli_only":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" is_cli_only_mode
  [ "$status" -eq 0 ]
}

# --- is_macos / is_linux ----------------------------------------------------

@test "T-501 is_macos: detect via uname -s" {
  run bash "$LIB" is_macos
  if [[ "$(uname -s)" == "Darwin" ]]; then
    [ "$status" -eq 0 ]
  else
    [ "$status" -eq 1 ]
  fi
}

@test "T-601 is_linux: detect via uname -s" {
  run bash "$LIB" is_linux
  if [[ "$(uname -s)" == "Linux" ]]; then
    [ "$status" -eq 0 ]
  else
    [ "$status" -eq 1 ]
  fi
}

# --- portal_install_default_skip --------------------------------------------

@test "PI-101 portal_install_default_skip: opt-in NOT set → skip" {
  printf '%s' '{}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" portal_install_default_skip
  [ "$status" -eq 0 ]
}

@test "PI-102 portal_install_default_skip: opt-in true → run" {
  printf '%s' '{"wizard":{"portal_install_opt_in":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" portal_install_default_skip
  [ "$status" -eq 1 ]
}

# --- phase_12_skip_predicate ------------------------------------------------

@test "P12SK-101 phase_12_skip_predicate: github origin → run" {
  cd "$TMPDIR_BATS"
  git init -q
  git remote add origin "git@github.com:x/y.git"
  run bash "$LIB" phase_12_skip_predicate
  [ "$status" -eq 1 ]
}

@test "P12SK-102 phase_12_skip_predicate: gitlab origin → skip" {
  cd "$TMPDIR_BATS"
  git init -q
  git remote add origin "https://gitlab.com/x/y.git"
  run bash "$LIB" phase_12_skip_predicate
  [ "$status" -eq 0 ]
}

# --- phase_NN_skip_predicate (13/14/15/16) ----------------------------------

@test "PSP-101 phase_13_skip_predicate: flag false → run" {
  printf '%s' '{}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" phase_13_skip_predicate
  [ "$status" -eq 1 ]
}

@test "PSP-102 phase_13_skip_predicate: flag true → skip" {
  printf '%s' '{"wizard":{"skip_phase_13":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" phase_13_skip_predicate
  [ "$status" -eq 0 ]
}

@test "PSP-103 phase_16_skip_predicate: flag true → skip" {
  printf '%s' '{"wizard":{"skip_phase_16":"true"}}' > "$AUTONOMOUS_DEV_CONFIG"
  run bash "$LIB" phase_16_skip_predicate
  [ "$status" -eq 0 ]
}

# --- error path -------------------------------------------------------------

@test "T-701 error path: jq missing" {
  printf '%s' '{}' > "$AUTONOMOUS_DEV_CONFIG"
  # Strip jq from PATH
  mkdir -p "$TMPDIR_BATS/nojqbin"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env; do
    src="$(command -v $tool 2>/dev/null || true)"
    if [[ -n "$src" ]]; then
      ln -sf "$src" "$TMPDIR_BATS/nojqbin/$tool"
    fi
  done
  PATH="$TMPDIR_BATS/nojqbin" run bash "$LIB" has_config_key any.key
  [ "$status" -eq 2 ]
  [[ "$output" == *"[skip-predicates]"* ]]
}

# --- read-only invariant ----------------------------------------------------

@test "T-801 read-only invariant: no fs writes during helper exec" {
  printf '%s' '{"intake":{"discord":{"enabled":true}}}' > "$AUTONOMOUS_DEV_CONFIG"
  cd "$TMPDIR_BATS"
  git init -q
  git remote add origin "git@github.com:x/y.git"
  before="$(find "$TMPDIR_BATS" -type f -newer "$AUTONOMOUS_DEV_CONFIG" 2>/dev/null | wc -l | tr -d ' ')"
  run bash "$LIB" is_github_origin
  run bash "$LIB" has_config_key intake.discord.enabled
  after="$(find "$TMPDIR_BATS" -type f -newer "$AUTONOMOUS_DEV_CONFIG" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$before" = "$after" ]
}

# --- gh_token_has_admin_scope (mocked gh) -----------------------------------

@test "SP-303 gh_token_has_admin_scope: missing gh CLI" {
  mkdir -p "$TMPDIR_BATS/nogh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq; do
    src="$(command -v $tool 2>/dev/null || true)"
    if [[ -n "$src" ]]; then
      ln -sf "$src" "$TMPDIR_BATS/nogh/$tool"
    fi
  done
  export FAKE_TOK=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  PATH="$TMPDIR_BATS/nogh" run bash "$LIB" gh_token_has_admin_scope FAKE_TOK foo/bar
  [ "$status" -eq 2 ]
  [[ "$output" == *"gh-cli-or-token-missing"* ]]
}

@test "SP-304 gh_token_has_admin_scope: env var unset" {
  # Use a gh shim to satisfy command -v
  mkdir -p "$TMPDIR_BATS/withgh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq; do
    src="$(command -v $tool 2>/dev/null || true)"
    if [[ -n "$src" ]]; then
      ln -sf "$src" "$TMPDIR_BATS/withgh/$tool"
    fi
  done
  cat > "$TMPDIR_BATS/withgh/gh" <<'GH'
#!/usr/bin/env bash
exit 0
GH
  chmod +x "$TMPDIR_BATS/withgh/gh"
  unset MISSING_TOK || true
  PATH="$TMPDIR_BATS/withgh" run bash "$LIB" gh_token_has_admin_scope MISSING_TOK foo/bar
  [ "$status" -eq 2 ]
  [[ "$output" == *"gh-cli-or-token-missing"* ]]
}
