#!/usr/bin/env bats
# tests/setup-wizard/phase-12-helpers.bats
# Phase 12 helper extensions per SPEC-033-2-01 §7.

SP_LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/skip-predicates.sh"
IC_LIB="${BATS_TEST_DIRNAME}/../../skills/setup-wizard/lib/idempotency-checks.sh"

setup() {
  TMPDIR_BATS="$(mktemp -d)"
  export AUTONOMOUS_DEV_CONFIG="${TMPDIR_BATS}/config.json"
  export ORIG_PATH="$PATH"
  # Provide a minimal env-vars-only PATH for tests that need to strip tools
  export TESTBIN="${TMPDIR_BATS}/bin"
  mkdir -p "$TESTBIN"
}

teardown() {
  rm -rf "$TMPDIR_BATS"
  export PATH="$ORIG_PATH"
}

# --- is_github_origin truth-table extension ---------------------------------

@test "SP-201 is_github_origin: github.com SSH" {
  cd "$TMPDIR_BATS"; git init -q
  git remote add origin "git@github.com:foo/bar.git"
  run bash "$SP_LIB" is_github_origin
  [ "$status" -eq 0 ]
}

@test "SP-202 is_github_origin: github.com HTTPS" {
  cd "$TMPDIR_BATS"; git init -q
  git remote add origin "https://github.com/foo/bar.git"
  run bash "$SP_LIB" is_github_origin
  [ "$status" -eq 0 ]
}

@test "SP-204 is_github_origin: GHES *.github.example" {
  cd "$TMPDIR_BATS"; git init -q
  git remote add origin "git@github.example-corp.com:foo/bar.git"
  run bash "$SP_LIB" is_github_origin
  [ "$status" -eq 0 ]
}

@test "SP-205 is_github_origin: no remote" {
  cd "$TMPDIR_BATS"; git init -q
  run bash "$SP_LIB" is_github_origin
  [ "$status" -eq 1 ]
}

# --- gh_token_has_admin_scope (mocked gh) -----------------------------------

# Build a minimal isolated PATH containing the test gh shim plus essentials.
_make_path_with_gh_shim() {
  local resp_file="$1"
  cat > "$TESTBIN/gh" <<GH
#!/usr/bin/env bash
# A minimal gh shim that emits canned responses.
case "\$1" in
  api)
    cat "$resp_file"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
GH
  chmod +x "$TESTBIN/gh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq sleep; do
    src="$(command -v $tool 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$TESTBIN/$tool"
  done
}

@test "SP-301 gh_token_has_admin_scope: admin=true" {
  echo '{"permissions":{"admin":true}}' > "$TMPDIR_BATS/resp.json"
  _make_path_with_gh_shim "$TMPDIR_BATS/resp.json"
  export FAKE_TOKEN=ghp_FAKETESTTOKEN
  PATH="$TESTBIN" run bash "$SP_LIB" gh_token_has_admin_scope FAKE_TOKEN foo/bar
  [ "$status" -eq 0 ]
}

@test "SP-302 gh_token_has_admin_scope: admin=false" {
  echo '{"permissions":{"admin":false}}' > "$TMPDIR_BATS/resp.json"
  _make_path_with_gh_shim "$TMPDIR_BATS/resp.json"
  export FAKE_TOKEN=ghp_FAKETESTTOKEN
  PATH="$TESTBIN" run bash "$SP_LIB" gh_token_has_admin_scope FAKE_TOKEN foo/bar
  [ "$status" -eq 1 ]
}

# --- gh_branch_protection_configured ----------------------------------------

@test "IC-301 gh_branch_protection_configured: 404 → start-fresh" {
  cat > "$TESTBIN/gh" <<'GH'
#!/usr/bin/env bash
# 404 → exit non-zero
exit 1
GH
  chmod +x "$TESTBIN/gh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq sleep; do
    src="$(command -v $tool 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$TESTBIN/$tool"
  done
  PATH="$TESTBIN" run bash "$IC_LIB" gh_branch_protection_configured foo/bar
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "IC-303 gh_branch_protection_configured: 200 with contexts → already-complete" {
  cat > "$TESTBIN/gh" <<'GH'
#!/usr/bin/env bash
# Emit JSON with required_status_checks.contexts
cat <<EOF
{"required_status_checks":{"contexts":["autonomous-dev-ci","autonomous-dev-cd"]}}
EOF
GH
  chmod +x "$TESTBIN/gh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq sleep; do
    src="$(command -v $tool 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$TESTBIN/$tool"
  done
  PATH="$TESTBIN" run bash "$IC_LIB" gh_branch_protection_configured foo/bar
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "IC-304 gh_branch_protection_configured: contexts match CSV arg" {
  cat > "$TESTBIN/gh" <<'GH'
#!/usr/bin/env bash
cat <<EOF
{"required_status_checks":{"contexts":["autonomous-dev-ci","autonomous-dev-cd"]}}
EOF
GH
  chmod +x "$TESTBIN/gh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq sleep; do
    src="$(command -v $tool 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$TESTBIN/$tool"
  done
  PATH="$TESTBIN" run bash "$IC_LIB" gh_branch_protection_configured foo/bar "autonomous-dev-ci,autonomous-dev-cd"
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "IC-305 gh_branch_protection_configured: contexts missing one" {
  cat > "$TESTBIN/gh" <<'GH'
#!/usr/bin/env bash
cat <<EOF
{"required_status_checks":{"contexts":["autonomous-dev-ci"]}}
EOF
GH
  chmod +x "$TESTBIN/gh"
  for tool in bash sh git uname grep awk sed cat printf cp mv rm mkdir env jq sleep; do
    src="$(command -v $tool 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$TESTBIN/$tool"
  done
  PATH="$TESTBIN" run bash "$IC_LIB" gh_branch_protection_configured foo/bar "autonomous-dev-ci,autonomous-dev-cd"
  [ "$status" -eq 0 ]
  [ "$output" = "resume-from:partial"  ]
}

# --- workflow_template_hash_matches truth table -----------------------------

@test "IC-401 workflow_template_hash_matches: missing → start-fresh" {
  run bash "$IC_LIB" workflow_template_hash_matches /no/such abcd
  [ "$status" -eq 0 ]
  [ "$output" = "start-fresh" ]
}

@test "IC-402 workflow_template_hash_matches: matches" {
  local f="$TMPDIR_BATS/wf.yml"
  printf 'name: ci\n' > "$f"
  local sha
  if command -v sha256sum >/dev/null 2>&1; then sha="$(sha256sum "$f" | awk '{print $1}')"; else sha="$(shasum -a 256 "$f" | awk '{print $1}')"; fi
  run bash "$IC_LIB" workflow_template_hash_matches "$f" "$sha"
  [ "$status" -eq 0 ]
  [ "$output" = "already-complete" ]
}

@test "IC-403 workflow_template_hash_matches: differs → resume-from:rescaffold" {
  local f="$TMPDIR_BATS/wf.yml"
  printf 'name: ci\n' > "$f"
  run bash "$IC_LIB" workflow_template_hash_matches "$f" 0000000000000000000000000000000000000000000000000000000000000000
  [ "$status" -eq 0 ]
  [ "$output" = "resume-from:rescaffold" ]
}
