#!/usr/bin/env bash
# migrate-state-files.sh - Migrates v1.0 autonomous-dev state files to v1.1.
#
# IMPORTANT: Stop the autonomous-dev daemon before running. The script will
# refuse to run if it detects a live daemon via ~/.autonomous-dev/daemon.lock.
#
# Usage: bin/migrate-state-files.sh [STATE_ROOT]
#   STATE_ROOT defaults to ~/.autonomous-dev
#
# Behavior:
#   - Finds all `state.json` files under STATE_ROOT.
#   - For each file:
#       schema_version == 1.1  -> log "Already v1.1" and skip
#       schema_version == 1.0  -> back up to .v1.0.backup, rewrite as v1.1
#       anything else          -> log warning and skip
#   - Idempotent: re-running on a migrated tree is a no-op.
#   - Safe to run on a tree containing only v1.1 files (no-op).
#
# Implements SPEC-018-1-03 Task 6.

set -euo pipefail

STATE_ROOT="${1:-${HOME}/.autonomous-dev}"
LOCK_FILE="${HOME}/.autonomous-dev/daemon.lock"

log()  { printf '[migrate-state-files] %s\n' "$*"; }
warn() { printf '[migrate-state-files] WARN: %s\n' "$*" >&2; }
die()  { printf '[migrate-state-files] ERROR: %s\n' "$*" >&2; exit 1; }

check_daemon_not_running() {
    [[ -f "$LOCK_FILE" ]] || return 0
    local pid
    pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        die "Daemon appears to be running (PID $pid). Stop it before migrating."
    fi
    warn "Stale lock file at $LOCK_FILE (PID $pid not alive); proceeding."
}

migrate_state_file() {
    local state_file="$1"
    local version
    version="$(jq -r '.schema_version' "$state_file" 2>/dev/null || echo 'unknown')"

    case "$version" in
        1.1)
            log "Already v1.1: $state_file"
            return 0
            ;;
        1.0)
            ;;
        *)
            warn "Unrecognized schema_version '$version' in $state_file; skipping."
            return 0
            ;;
    esac

    cp -p "$state_file" "${state_file}.v1.0.backup"

    jq '. + {
        "schema_version": 1.1,
        "request_type": "feature",
        "phase_overrides": [
            "intake", "prd", "prd_review", "tdd", "tdd_review",
            "plan", "plan_review", "spec", "spec_review",
            "code", "code_review", "integration", "deploy", "monitor"
        ],
        "type_config": {
            "skippedPhases": [],
            "enhancedPhases": [],
            "expeditedReviews": false,
            "additionalGates": [],
            "maxRetries": 3,
            "phaseTimeouts": {}
        }
    }' "$state_file" > "${state_file}.tmp"

    mv "${state_file}.tmp" "$state_file"
    log "Migrated: $state_file (backup at ${state_file}.v1.0.backup)"
}

main() {
    command -v jq >/dev/null 2>&1 || die "jq is required but not installed."
    [[ -d "$STATE_ROOT" ]] || die "STATE_ROOT does not exist: $STATE_ROOT"
    check_daemon_not_running

    local count=0
    # shellcheck disable=SC2312  # find's exit status is not load-bearing here.
    while IFS= read -r -d '' file; do
        migrate_state_file "$file"
        count=$((count + 1))
    done < <(find "$STATE_ROOT" -name 'state.json' -type f -print0)

    log "Processed $count state file(s) under $STATE_ROOT."
}

main "$@"
