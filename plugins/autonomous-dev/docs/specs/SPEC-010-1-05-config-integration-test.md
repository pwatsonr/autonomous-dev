# SPEC-010-1-05: Integration Test for Full Config Load with All Layers

## Metadata
- **Parent Plan**: PLAN-010-1
- **Tasks Covered**: Task 12
- **Estimated effort**: 3 hours

## Description

End-to-end integration test that creates global, project, and CLI layers on a real filesystem, loads them through `config_loader.sh`, validates the merged result, and confirms precedence is correct at every layer.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `test/integration/test_config_integration.sh` | Full-stack config loading integration test |

## Implementation Details

### Test Setup

The test creates a temporary directory structure simulating a real environment:

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  FAKE_HOME="${TEST_DIR}/home"
  FAKE_REPO="${TEST_DIR}/repo"
  
  mkdir -p "${FAKE_HOME}/.claude"
  mkdir -p "${FAKE_REPO}/.claude"
  mkdir -p "${FAKE_REPO}/.git"  # Make it look like a repo
  
  # Override paths for testing
  export HOME="$FAKE_HOME"
  export REPO_ROOT="$FAKE_REPO"
  export PLUGIN_ROOT="$PROJECT_ROOT"
}

teardown() {
  rm -rf "$TEST_DIR"
}
```

### Test Cases

#### Test 1: Defaults Only

No global or project config files exist. Load config with no CLI overrides.

```bash
test_defaults_only() {
  local config
  config=$(load_config)
  
  # Spot-check default values
  assert_eq "default daily cap" "100" "$(echo "$config" | jq '.governance.daily_cost_cap_usd')"
  assert_eq "default monthly cap" "2000" "$(echo "$config" | jq '.governance.monthly_cost_cap_usd')"
  assert_eq "default poll interval" "30" "$(echo "$config" | jq '.daemon.poll_interval_seconds')"
  assert_eq "default max worktrees" "5" "$(echo "$config" | jq '.parallel.max_worktrees')"
  assert_eq "default allowlist" "[]" "$(echo "$config" | jq -c '.repositories.allowlist')"
}
```

#### Test 2: Global Override

Global config sets `governance.daily_cost_cap_usd` to 200 and `repositories.allowlist` to one repo.

```bash
test_global_override() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{
  "governance": {
    "daily_cost_cap_usd": 200.00
  },
  "repositories": {
    "allowlist": ["/tmp/test-repo"]
  }
}
EOF
  
  local config
  config=$(load_config)
  
  assert_eq "global daily cap" "200" "$(echo "$config" | jq '.governance.daily_cost_cap_usd')"
  assert_eq "default monthly cap unchanged" "2000" "$(echo "$config" | jq '.governance.monthly_cost_cap_usd')"
  assert_eq "global allowlist" '["/tmp/test-repo"]' "$(echo "$config" | jq -c '.repositories.allowlist')"
}
```

#### Test 3: Project Overrides Global

Global sets `daily_cost_cap_usd=200`, project sets it to `150`.

```bash
test_project_overrides_global() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 200.00}}
EOF
  cat > "${FAKE_REPO}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 150.00}}
EOF
  
  local config
  config=$(load_config)
  
  assert_eq "project overrides global" "150" "$(echo "$config" | jq '.governance.daily_cost_cap_usd')"
}
```

#### Test 4: CLI Overrides Everything

Global sets 200, project sets 150, CLI sets 50.

```bash
test_cli_overrides_all() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 200.00}}
EOF
  cat > "${FAKE_REPO}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 150.00}}
EOF
  
  local config
  config=$(load_config --config.governance.daily_cost_cap_usd=50)
  
  assert_eq "CLI overrides all" "50" "$(echo "$config" | jq '.governance.daily_cost_cap_usd')"
}
```

#### Test 5: Array Replacement Across Layers

Global sets allowlist to `["/a", "/b"]`. Project sets it to `["/c"]`. Result is `["/c"]` only.

```bash
test_array_replacement() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{"repositories": {"allowlist": ["/a", "/b"]}}
EOF
  cat > "${FAKE_REPO}/.claude/autonomous-dev.json" <<'EOF'
{"repositories": {"allowlist": ["/c"]}}
EOF
  
  local config
  config=$(load_config)
  
  assert_eq "array replaced not concatenated" '["/c"]' "$(echo "$config" | jq -c '.repositories.allowlist')"
}
```

#### Test 6: Deep Merge Preserves Sibling Keys

Global sets `daemon.max_turns_by_phase.code=100`. Project sets `daemon.max_turns_by_phase.prd=30`. Both keys appear in the result, alongside the other defaults.

```bash
test_deep_merge_siblings() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{"daemon": {"max_turns_by_phase": {"code": 100}}}
EOF
  cat > "${FAKE_REPO}/.claude/autonomous-dev.json" <<'EOF'
{"daemon": {"max_turns_by_phase": {"prd": 30}}}
EOF
  
  local config
  config=$(load_config)
  
  assert_eq "global code override" "100" "$(echo "$config" | jq '.daemon.max_turns_by_phase.code')"
  assert_eq "project prd override" "30" "$(echo "$config" | jq '.daemon.max_turns_by_phase.prd')"
  assert_eq "default intake unchanged" "10" "$(echo "$config" | jq '.daemon.max_turns_by_phase.intake')"
}
```

#### Test 7: Hot Reload (Config Change Between Loads)

Load config once. Modify the global file. Load again. Second load reflects the change.

```bash
test_hot_reload() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 100.00}}
EOF
  
  local config1
  config1=$(load_config)
  assert_eq "first load" "100" "$(echo "$config1" | jq '.governance.daily_cost_cap_usd')"
  
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 250.00}}
EOF
  
  local config2
  config2=$(load_config)
  assert_eq "second load (hot reload)" "250" "$(echo "$config2" | jq '.governance.daily_cost_cap_usd')"
}
```

#### Test 8: Missing Global, Valid Project

Global config file does not exist. Project config sets one field. No error. Result is defaults + project.

```bash
test_missing_global() {
  cat > "${FAKE_REPO}/.claude/autonomous-dev.json" <<'EOF'
{"governance": {"daily_cost_cap_usd": 75.00}}
EOF
  
  local config
  config=$(load_config 2>/dev/null)
  
  assert_eq "project value used" "75" "$(echo "$config" | jq '.governance.daily_cost_cap_usd')"
}
```

#### Test 9: Corrupt Global, Load Fails

Global config contains invalid JSON. `load_config` returns non-zero.

```bash
test_corrupt_global_fails() {
  echo "{invalid json" > "${FAKE_HOME}/.claude/autonomous-dev.json"
  
  assert_exit_code "corrupt global fails" 1 load_config
}
```

#### Test 10: Validation Runs on Merged Config

Global config creates a cross-field violation (daily > monthly). Load should fail validation.

```bash
test_validation_on_merged() {
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{
  "governance": {
    "daily_cost_cap_usd": 5000.00,
    "monthly_cost_cap_usd": 1000.00
  }
}
EOF
  
  assert_exit_code "cross-field violation caught" 1 load_config
}
```

### Cleanup

```bash
teardown() {
  rm -rf "$TEST_DIR"
  # Restore original HOME if needed
}
```

The teardown runs unconditionally (via `trap teardown EXIT`).

## Acceptance Criteria

1. Test creates temporary global and project config files with known values.
2. Test invokes `load_config` with CLI overrides.
3. Test asserts the merged output matches expected values at every precedence layer.
4. Precedence is verified: CLI > project > global > defaults.
5. Array replacement is verified (not concatenation).
6. Deep nested merge is verified (sibling keys preserved).
7. Hot reload is verified (second load reflects file changes).
8. Missing layer handling is verified (no crash, graceful fallback).
9. Corrupt file handling is verified (load fails with non-zero exit).
10. Cross-field validation is verified on the merged result.
11. All temp files are cleaned up after the test.

## Test Cases

All 10 test cases are detailed in the Implementation Details section above. Summary:

1. Defaults-only load produces correct values.
2. Global config overrides defaults.
3. Project config overrides global config.
4. CLI overrides take highest precedence.
5. Arrays are replaced, not concatenated.
6. Deep merge preserves sibling keys across layers.
7. Hot reload: re-reading after file change picks up new values.
8. Missing global file does not cause errors.
9. Corrupt global file causes load to fail.
10. Cross-field validation runs on the merged result and catches violations.
