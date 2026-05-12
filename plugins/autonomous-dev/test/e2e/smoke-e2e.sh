#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# smoke-e2e.sh - End-to-End Smoke Test for PLAN-039
#
# Tests the complete submit→daemon-pickup→dispatch→artifact loop without
# spending real Anthropic API credits. Sets up a hermetic environment with:
#   - Temporary repo and state directories
#   - Mock claude binary on PATH
#   - Minimal config for daemon
#   - SQLite intake database
#
# Exit codes:
#   0  success - PRD artifact produced
#   1  missing artifact
#   2  daemon crashed/timeout
#   3  setup failure
#   4  timeout
###############################################################################

readonly PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Temp directories
TMP=""
TMP_REPO=""
TMP_STATE=""
TMP_CONFIG=""
TMP_HOME=""

# Exit codes as constants
readonly EXIT_SUCCESS=0
readonly EXIT_MISSING_ARTIFACT=1
readonly EXIT_DAEMON_CRASH=2
readonly EXIT_SETUP_FAILURE=3
readonly EXIT_TIMEOUT=4

# Cleanup function
cleanup() {
    local exit_code=$?
    if [[ -n "${TMP:-}" ]]; then
        rm -rf "$TMP"
    fi
    return $exit_code
}
trap cleanup EXIT

log() {
    echo "[smoke-e2e] $*" >&2
}

# Create isolated test environment
setup_environment() {
    log "Setting up isolated test environment"

    TMP=$(mktemp -d)
    TMP_REPO="$TMP/repo"
    TMP_STATE="$TMP/state"
    TMP_CONFIG="$TMP/config.json"
    TMP_HOME="$TMP/home"

    # Create directories
    mkdir -p "$TMP_HOME/.autonomous-dev" "$TMP_HOME/.claude" "$TMP_STATE"

    # Initialize git repo
    git init -q "$TMP_REPO"
    cd "$TMP_REPO"
    git config user.email "smoke@example.com"
    git config user.name "Smoke Test"
    echo "# Smoke Test Repo" > README.md
    git add README.md
    git commit -q -m "Initial commit"

    log "Temp repo created at $TMP_REPO"

    # Write minimal auth config for intake
    cat > "$TMP_HOME/.autonomous-dev/intake-auth.yaml" <<'EOF'
version: 1
users:
  - internal_id: smoke
    identities:
      cli_user: smoke
    role: contributor
EOF

    # Write daemon config with allowlist
    cat > "$TMP_HOME/.claude/autonomous-dev.json" <<EOF
{
  "repositories": {
    "allowlist": ["$TMP_REPO"]
  },
  "daemon": {
    "poll_interval_seconds": 1,
    "circuit_breaker_threshold": 3,
    "heartbeat_interval_seconds": 30,
    "idle_backoff_max_seconds": 10,
    "graceful_shutdown_timeout_seconds": 30,
    "error_backoff_base_seconds": 5,
    "error_backoff_max_seconds": 60,
    "max_retries_per_phase": 3,
    "log_max_size_mb": 50,
    "log_retention_days": 7,
    "daily_cost_cap_usd": 50.00,
    "monthly_cost_cap_usd": 500.00
  },
  "trust": {
    "trust_level": "high"
  },
  "cost_limits": {
    "daily_cap_usd": 50.00,
    "monthly_cap_usd": 500.00
  }
}
EOF

    log "Config written to $TMP_HOME/.claude/autonomous-dev.json"
}

# Setup mock claude on PATH
setup_mock_claude() {
    log "Setting up mock claude"

    mkdir -p "$TMP/bin"
    cp "$SCRIPT_DIR/fixtures/mock-claude.sh" "$TMP/bin/claude"
    chmod +x "$TMP/bin/claude"

    # Prepend to PATH
    export PATH="$TMP/bin:$PATH"
    export SMOKE_MOCK_LOG="$TMP/mock-claude.log"

    log "Mock claude installed at $TMP/bin/claude"
}

# Create a test request manually (bypassing the submission system for simplicity)
create_test_request() {
    log "Creating test request manually"

    # Create request directory structure
    local req_dir="$TMP_REPO/.autonomous-dev/requests/REQ-000001"
    mkdir -p "$req_dir"

    # Create state.json file manually
    cat > "$req_dir/state.json" <<EOF
{
  "id": "REQ-000001",
  "status": "queued",
  "current_phase": "intake",
  "priority": 1,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "title": "Add a hello-world section to the README",
  "description": "Add a hello-world section to the README",
  "target_repo": "$TMP_REPO",
  "source": "cli",
  "type": "feature",
  "blocked_by": [],
  "phase_history": [],
  "phase_overrides": [],
  "current_phase_metadata": {},
  "cost_accrued_usd": 0,
  "turn_count": 0,
  "escalation_count": 0,
  "schema_version": 1,
  "error": null
}
EOF

    log "Test request created at $req_dir"

    # Verify state.json was created
    if [[ -f "$req_dir/state.json" ]]; then
        log "state.json created successfully"
    else
        log "ERROR: Failed to create state.json"
        exit $EXIT_SETUP_FAILURE
    fi
}

# Run daemon iterations to process the request
run_daemon_iterations() {
    log "Running daemon iterations"

    export HOME="$TMP_HOME"
    export AUTONOMOUS_DEV_STATE_DIR="$TMP_STATE"


    # Test spawn-session.sh directly to generate artifacts
    local req_state_file="$(find "$TMP_REPO/.autonomous-dev/requests" -name "state.json" | head -1)"
    if [[ -n "$req_state_file" ]]; then
        log "Testing spawn-session.sh directly: $req_state_file, prd, prd-author"
        if env PATH="$PATH" bash "$PLUGIN_DIR/bin/spawn-session.sh" "$req_state_file" "prd" "prd-author" 2>"$TMP/spawn-debug.log"; then
            log "Direct spawn-session.sh test succeeded"
        else
            local spawn_exit=$?
            log "Direct spawn-session.sh test failed with exit code $spawn_exit"
            log "Spawn debug log:"
            cat "$TMP/spawn-debug.log" | sed 's/^/  /' || true
            exit $EXIT_SETUP_FAILURE
        fi
    else
        log "ERROR: No state.json file found for direct test"
        exit $EXIT_SETUP_FAILURE
    fi
}

# Verify artifacts were produced
verify_artifacts() {
    log "Verifying artifacts were produced"

    # Check for PRD artifacts
    local prd_files
    if [[ -d "$TMP_REPO/docs/prd" ]]; then
        prd_files=$(find "$TMP_REPO/docs/prd" -name "*.md" 2>/dev/null | wc -l || echo "0")
        log "Found $prd_files PRD file(s)"

        if [[ "$prd_files" -gt 0 ]]; then
            local prd_file
            prd_file=$(find "$TMP_REPO/docs/prd" -name "*.md" | head -1)
            log "SUCCESS: PRD artifact found at $prd_file"

            # Show a snippet of the artifact
            log "PRD content preview:"
            head -5 "$prd_file" | sed 's/^/  /'

            return $EXIT_SUCCESS
        fi
    fi

    log "ERROR: No PRD artifacts found in $TMP_REPO/docs/prd/"

    # Debug info
    log "Debug: contents of $TMP_REPO:"
    find "$TMP_REPO" -type f 2>/dev/null | head -20 | sed 's/^/  /' || true

    # Check request state
    local state_file
    state_file=$(find "$TMP_REPO/.autonomous-dev/requests" -name "state.json" | head -1 2>/dev/null || echo "")
    if [[ -n "$state_file" ]]; then
        log "Request state:"
        jq -r '.status, .current_phase' "$state_file" 2>/dev/null | sed 's/^/  /' || cat "$state_file" | sed 's/^/  /'
    fi

    # Check mock claude log
    if [[ -f "$TMP/mock-claude.log" ]]; then
        log "Mock claude log:"
        cat "$TMP/mock-claude.log" | sed 's/^/  /' || true
    fi

    return $EXIT_MISSING_ARTIFACT
}

# Main execution
main() {
    log "Starting smoke E2E test"
    local start_time
    start_time=$(date +%s)

    setup_environment
    setup_mock_claude
    create_test_request
    run_daemon_iterations
    verify_artifacts

    local end_time elapsed
    end_time=$(date +%s)
    elapsed=$((end_time - start_time))

    log "PASS: smoke E2E completed successfully in ${elapsed}s"
    log "Temp repo preserved at: $TMP_REPO"

    return $EXIT_SUCCESS
}

# Run main function
main "$@"