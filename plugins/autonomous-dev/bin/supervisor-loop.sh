#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# supervisor-loop.sh - Autonomous Dev Daemon Supervisor
#
# The main daemon supervisor script for the autonomous-dev plugin.
# Runs as a long-lived process that polls for work and dispatches
# Claude CLI sessions.
###############################################################################

# --- Constants ---------------------------------------------------------------
# All paths derived from $HOME and the script's own location.

readonly PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly LIB_DIR="${PLUGIN_DIR}/bin/lib"
readonly DAEMON_HOME="${HOME}/.autonomous-dev"
readonly INTAKE_DB="${DAEMON_HOME}/intake.db"
readonly LOCK_FILE="${DAEMON_HOME}/daemon.lock"
readonly HEARTBEAT_FILE="${DAEMON_HOME}/heartbeat.json"
readonly CRASH_STATE_FILE="${DAEMON_HOME}/crash-state.json"
readonly KILL_SWITCH_FILE="${DAEMON_HOME}/kill-switch.flag"
readonly COST_LEDGER_FILE="${DAEMON_HOME}/cost-ledger.json"
readonly LOG_DIR="${DAEMON_HOME}/logs"
readonly LOG_FILE="${LOG_DIR}/daemon.log"
readonly CONFIG_FILE="${HOME}/.claude/autonomous-dev.json"
# AUTONOMOUS_DEV_CONFIG is the path expected by lib/typed-limits.sh per
# SPEC-018-2-02. We export the existing CONFIG_FILE under that name so the
# helper library can stand alone and be sourced by the bats test harness.
export AUTONOMOUS_DEV_CONFIG="${CONFIG_FILE}"
readonly DEFAULTS_FILE="${PLUGIN_DIR}/config/defaults.json"
readonly ALERTS_DIR="${DAEMON_HOME}/alerts"
readonly PORTAL_REQUEST_ACTIONS_DIR="${AUTONOMOUS_DEV_STATE_DIR:-${HOME}/.autonomous-dev}/request-actions"
readonly GATE_DECISIONS_DIR="${AUTONOMOUS_DEV_STATE_DIR:-${HOME}/.autonomous-dev}/gate-decisions"
# PRD-025 FR-025-05 / #353: portal-originated config-change markers. The portal
# writes proposed config edits here instead of mutating CONFIG_FILE directly;
# consume_config_changes() validates + applies them during reconcile.
readonly CONFIG_CHANGES_DIR="${AUTONOMOUS_DEV_STATE_DIR:-${HOME}/.autonomous-dev}/config-changes"
# #500: portal-originated artifact-revise markers. When the operator leaves
# comments on a rendered artifact and clicks "revise", the portal writes a
# feedback artifact into the request's repo dir AND a marker here. The daemon's
# consume_revise_markers() validates each marker and resets state.json's
# current_phase back to the author phase so the supervisor re-dispatches it
# (the same loopback the daemon uses on a *_review fail). The re-run injects
# the operator feedback (resolve_phase_prompt, phase-helpers.sh).
readonly REVISE_REQUESTS_DIR="${AUTONOMOUS_DEV_STATE_DIR:-${HOME}/.autonomous-dev}/revise-requests"

# --- Runtime State Variables -------------------------------------------------

POLL_INTERVAL=30
CIRCUIT_BREAKER_THRESHOLD=3
HEARTBEAT_INTERVAL=30
IDLE_BACKOFF_MAX=900
GRACEFUL_SHUTDOWN_TIMEOUT=300
ERROR_BACKOFF_BASE=30
ERROR_BACKOFF_MAX=900
MAX_RETRIES_PER_PHASE=3
LOG_MAX_SIZE_MB=50
LOG_RETENTION_DAYS=7
DAILY_COST_CAP=50.00
MONTHLY_COST_CAP=500.00
PER_REQUEST_COST_CAP=50.00
MAX_CONCURRENT_REQUESTS=3
RATE_LIMIT_BACKOFF_BASE=30
RATE_LIMIT_BACKOFF_MAX=900
IDLE_BACKOFF_CURRENT=30
IDLE_BACKOFF_BASE=30
ONCE_MODE=false
SHUTDOWN_REQUESTED=false
CURRENT_CHILD_PID=""
ITERATION_COUNT=0
# UTC ISO-8601 timestamp of when this daemon instance started (#356). Set once at
# startup before the main loop; the portal derives uptime from it.
DAEMON_START_TIME=""
EFFECTIVE_CONFIG=""
CONSECUTIVE_CRASHES=0
CIRCUIT_BREAKER_TRIPPED=false
POLL_COUNT=0
RECONCILE_EVERY_N_POLLS=${RECONCILE_EVERY_N_POLLS:-60}
# Issue #501: bound on how many times a single request may be re-entered into
# the code phase to address operator PR review comments. A hard ceiling that
# prevents a comment-driven feedback loop from re-running the code phase
# indefinitely (e.g. an operator who keeps commenting, or an agent whose push
# itself generates review events). Overridable via daemon.max_pr_comment_reentries.
MAX_PR_COMMENT_REENTRIES=${MAX_PR_COMMENT_REENTRIES:-3}
# Issue #501: how often (in poll iterations) to scan terminal/awaiting-human
# requests for new PR review comments. Mirrors RECONCILE_EVERY_N_POLLS so the
# extra `gh` calls stay infrequent and off the hot dispatch path.
PR_COMMENT_SCAN_EVERY_N_POLLS=${PR_COMMENT_SCAN_EVERY_N_POLLS:-60}
# Marketplace auto-update: detect newer cached versions and (Phase 2)
# stage a self-upgrade when idle. See check_upgrade_available() and
# stage_upgrade() for the mechanism.
UPGRADE_CHECK_EVERY_N_POLLS=${UPGRADE_CHECK_EVERY_N_POLLS:-60}
LAST_UPGRADE_LOGGED_VERSION=""
# Phase 2: throttle file + last-good-version pointer. The throttle is a
# touch file whose mtime gates additional attempts (default: 1 attempt
# per hour). LAST_GOOD_VERSION_FILE is written before exec'ing into the
# upgrade helper, so Phase 3 can roll back if the new daemon doesn't
# settle.
UPGRADE_THROTTLE_FILE="${DAEMON_HOME}/.upgrade-throttle"
UPGRADE_THROTTLE_SECONDS=${UPGRADE_THROTTLE_SECONDS:-3600}
LAST_GOOD_VERSION_FILE="${DAEMON_HOME}/.last-good-version"
# Phase 3 rollback: trial flag + probation. When stage_upgrade hands off
# to a new version, it leaves a JSON trial flag containing the target
# version + a deadline. The new daemon at startup reads it; if its mtime
# is past the deadline AND we're the target version, it means previous
# attempts of THIS version's daemon kept crashing — roll back to the
# version stored in .last-good-version. If we make it past
# UPGRADE_TRIAL_PROBATION_ITERATIONS healthy iterations, we clear the
# flag (trial passed).
UPGRADE_TRIAL_FLAG="${DAEMON_HOME}/.upgrade-trial-pending"
UPGRADE_TRIAL_DEADLINE_SECONDS=${UPGRADE_TRIAL_DEADLINE_SECONDS:-180}
UPGRADE_TRIAL_PROBATION_ITERATIONS=${UPGRADE_TRIAL_PROBATION_ITERATIONS:-5}
UPGRADE_TRIAL_PENDING=false

# Per-process dedup table for the legacy phase-fallback warning
# (SPEC-018-2-01 §Warning Deduplication). Keyed by absolute state file path.
# Reset only by daemon restart — that is the intentional "re-surface migration
# debt" cadence per TDD-001's daily restart contract.
if [[ "${BASH_VERSINFO[0]}" -ge 4 ]]; then
    declare -gA _phase_legacy_warned=()
fi


###############################################################################
# Logging Functions
###############################################################################

# log_json(level, message) -> void
#   Writes a single JSONL entry to $LOG_FILE.
#   Uses jq for safe JSON construction to handle special characters.
log_json() {
    local level="$1"
    local message="$2"
    local ts

    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")"

    jq -n -c \
        --arg ts "$ts" \
        --arg lvl "$level" \
        --argjson pid "$$" \
        --argjson iter "$ITERATION_COUNT" \
        --arg msg "$message" \
        '{timestamp:$ts,level:$lvl,pid:$pid,iteration:$iter,message:$msg}' \
        >> "$LOG_FILE"
}

# log_info(message) -> void
log_info() {
    log_json "INFO" "$1"
}

# log_warn(message) -> void
log_warn() {
    log_json "WARN" "$1"
}

# log_error(message) -> void
log_error() {
    log_json "ERROR" "$1"
}

###############################################################################
# Dependency Validation
###############################################################################

# validate_dependencies() -> void
#   Checks that all required commands are available in PATH.
#   Logs the Claude CLI version on success.
#   Exits with code 1 if any required command is missing.
validate_dependencies() {
    local missing=()
    local required_cmds=(bash jq git claude)

    for cmd in "${required_cmds[@]}"; do
        if ! command -v "${cmd}" >/dev/null 2>&1; then
            missing+=("${cmd}")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        local msg="FATAL: Missing required commands: ${missing[*]}"
        echo "${msg}" >&2
        # Log if log infrastructure is available
        if [[ -d "$LOG_DIR" ]]; then
            log_error "${msg}"
        fi
        exit 1
    fi

    # Capture Claude CLI version
    local claude_version
    claude_version=$(claude --version 2>/dev/null || echo "unknown")
    log_info "Claude CLI version: ${claude_version}"

    # Warn on bash < 4 but do not exit
    if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
        log_warn "WARNING: bash ${BASH_VERSION} detected. bash 4+ is recommended. Install via Homebrew: brew install bash"
    fi
}

###############################################################################
# Utility Functions
###############################################################################

# validate_request_id(id) -> bool
#   Validates that a request ID matches ^REQ-[0-9]{6}$.
#   Returns 0 (true) if valid, 1 (false) if invalid.
validate_request_id() {
    local id="$1"
    [[ "$id" =~ ^REQ-[0-9]{6}$ ]]
}

# resolve_timeout_bin() -> string
#   Echoes the path to a GNU-style `timeout` (or `gtimeout` on macOS w/
#   coreutils), or empty string if neither is available. macOS has no
#   `timeout` by default; without it, phase sessions run without a
#   wall-clock cap (a hung session blocks the daemon — install coreutils
#   to get the cap). Warns once per daemon run when absent.
_TIMEOUT_BIN_WARNED=false
resolve_timeout_bin() {
    local bin
    bin=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || echo "")

    # PID-based file guard: this function is called inside subshells
    # (`$(resolve_timeout_bin)` at L1118), so the in-process variable alone
    # can't suppress the warning across calls. The file marker is the
    # actual guard; the variable just short-circuits the no-subshell case.
    # Uses $$ (always the daemon's parent-shell PID under bash) and the same
    # state-dir resolution pattern as PORTAL_REQUEST_ACTIONS_DIR / GATE_DECISIONS_DIR.
    local state_dir="${AUTONOMOUS_DEV_STATE_DIR:-${HOME}/.autonomous-dev}"
    local warn_file="${state_dir}/.timeout-warning-$$"
    if [[ -z "${bin}" && "${_TIMEOUT_BIN_WARNED}" != "true" && ! -f "$warn_file" ]]; then
        log_warn "Neither 'timeout' nor 'gtimeout' found; phase sessions will run without a wall-clock cap. Install GNU coreutils (e.g. 'brew install coreutils') to enable it."
        _TIMEOUT_BIN_WARNED=true
        mkdir -p "$state_dir" 2>/dev/null || true
        touch "$warn_file" 2>/dev/null || true  # Ignore errors if state dir doesn't exist
    fi
    echo "${bin}"
}

###############################################################################
# Lock File Management
###############################################################################

# acquire_lock() -> void
#   Creates a PID-based lock file to ensure single-instance execution.
#   Detects and removes stale locks (PID no longer running or empty file).
#   Exits with code 1 if another live instance holds the lock.
acquire_lock() {
    if [[ -f "${LOCK_FILE}" ]]; then
        local existing_pid
        existing_pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")

        if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
            log_error "Another instance is running (PID ${existing_pid}). Exiting."
            exit 1
        else
            log_warn "Stale lock file found (PID ${existing_pid} not running). Removing."
            rm -f "${LOCK_FILE}"
        fi
    fi

    echo "$$" > "${LOCK_FILE}"
    log_info "Lock acquired (PID $$)"
}

# release_lock() -> void
#   Removes the lock file. Safe to call multiple times.
release_lock() {
    rm -f "${LOCK_FILE}"
    log_info "Lock released"
}

###############################################################################
# Argument Parsing
###############################################################################

# parse_args(args...) -> void
#   Parses CLI arguments. Sets global variables accordingly.
#   Unknown arguments cause an error exit.
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --once)
                ONCE_MODE=true
                shift
                ;;
            *)
                echo "ERROR: Unknown argument: $1" >&2
                # Attempt structured log if LOG_DIR exists
                if [[ -d "$LOG_DIR" ]]; then
                    log_error "Unknown argument: $1"
                fi
                exit 1
                ;;
        esac
    done
}

###############################################################################
# Heartbeat Writing
###############################################################################

# write_heartbeat(active_request_id?) -> void
#   Writes a JSON heartbeat file atomically to $HEARTBEAT_FILE.
#   Uses a tmp+mv pattern to guarantee no partial writes.
#   When active_request_id is not provided, the field is set to JSON null.
write_heartbeat() {
    local active_request="${1:-null}"
    local ts
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    local tmp="${HEARTBEAT_FILE}.tmp"
    jq -n \
        --arg ts "${ts}" \
        --argjson pid "$$" \
        --argjson iter "${ITERATION_COUNT}" \
        --arg req "${active_request}" \
        --arg start "${DAEMON_START_TIME}" \
        '{
            timestamp: $ts,
            pid: $pid,
            iteration_count: $iter,
            active_request_id: (if $req == "null" then null else $req end),
            start_time: (if $start == "" then null else $start end)
        }' > "${tmp}"

    mv "${tmp}" "${HEARTBEAT_FILE}"
}

###############################################################################
# Stale Heartbeat Detection
###############################################################################

# detect_stale_heartbeat() -> void
#   Called once during init (before the main loop).
#   Checks if a previous heartbeat exists and whether it is stale.
#   If stale, triggers recovery. If recent, logs normal startup.
detect_stale_heartbeat() {
    if [[ ! -f "${HEARTBEAT_FILE}" ]]; then
        log_info "No heartbeat file found. Fresh start."
        return
    fi

    local last_ts
    last_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")

    if [[ -z "${last_ts}" || "${last_ts}" == "null" ]]; then
        log_warn "Heartbeat file unreadable. Treating as stale."
        recover_from_stale_heartbeat
        return
    fi

    local now_epoch last_epoch staleness_seconds
    now_epoch=$(date -u +%s)
    # macOS date: -j -u -f format
    # GNU date: -u -d string
    last_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${last_ts}" +%s 2>/dev/null \
                 || date -u -d "${last_ts}" +%s 2>/dev/null \
                 || echo "0")
    staleness_seconds=$(( now_epoch - last_epoch ))

    # Treat negative staleness (clock went backwards) as 0 (fresh)
    if [[ ${staleness_seconds} -lt 0 ]]; then
        staleness_seconds=0
    fi

    local threshold=$(( HEARTBEAT_INTERVAL * 2 ))

    if [[ ${staleness_seconds} -gt ${threshold} ]]; then
        log_warn "Stale heartbeat detected (${staleness_seconds}s old, threshold ${threshold}s). Prior crash or sleep event."
        recover_from_stale_heartbeat
    else
        log_info "Recent heartbeat found (${staleness_seconds}s old). Normal startup."
    fi
}

# compute_heartbeat_staleness() -> int
#   Returns the staleness of the heartbeat file in seconds.
#   Returns 999999 if the heartbeat timestamp is unreadable.
compute_heartbeat_staleness() {
    local last_ts
    last_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -z "${last_ts}" ]]; then
        echo "999999"
        return
    fi

    local now_epoch last_epoch
    now_epoch=$(date -u +%s)
    last_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${last_ts}" +%s 2>/dev/null \
                 || date -u -d "${last_ts}" +%s 2>/dev/null \
                 || echo "0")
    echo $(( now_epoch - last_epoch ))
}

# recover_from_stale_heartbeat() -> void
#   Full implementation (SPEC-001-3-03). Handles orphaned process cleanup,
#   sleep vs. crash classification, and interrupted session recovery.
recover_from_stale_heartbeat() {
    # 1. Cleanup orphaned processes (from Plan 1)
    local stale_pid
    stale_pid=$(jq -r '.pid' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -n "${stale_pid}" && "${stale_pid}" != "$$" ]]; then
        if kill -0 "${stale_pid}" 2>/dev/null; then
            log_warn "Orphaned process ${stale_pid} still running. Sending SIGTERM."
            kill -TERM "${stale_pid}" 2>/dev/null || true
            sleep 2
            if kill -0 "${stale_pid}" 2>/dev/null; then
                kill -KILL "${stale_pid}" 2>/dev/null || true
            fi
            log_info "Orphaned process ${stale_pid} terminated."
        else
            log_info "No orphaned process found (PID ${stale_pid} not running)."
        fi
    fi

    # 2. Determine if this was a sleep event vs. a crash
    local staleness_seconds
    staleness_seconds=$(compute_heartbeat_staleness)
    local crash_state_updated_at=""
    if [[ -f "${CRASH_STATE_FILE}" ]]; then
        crash_state_updated_at=$(jq -r '.updated_at // ""' "${CRASH_STATE_FILE}" 2>/dev/null || echo "")
    fi

    local is_sleep_event=false
    if [[ ${staleness_seconds} -gt 600 ]]; then
        # Staleness > 10 minutes
        if [[ -z "${crash_state_updated_at}" ]]; then
            is_sleep_event=true
        else
            # Check if crash state was recently updated (within last 5 minutes before stale heartbeat)
            local crash_epoch
            crash_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${crash_state_updated_at}" +%s 2>/dev/null \
                          || date -u -d "${crash_state_updated_at}" +%s 2>/dev/null \
                          || echo "0")
            local heartbeat_epoch
            local heartbeat_ts
            heartbeat_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
            heartbeat_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${heartbeat_ts}" +%s 2>/dev/null \
                              || date -u -d "${heartbeat_ts}" +%s 2>/dev/null \
                              || echo "0")
            local gap=$(( heartbeat_epoch - crash_epoch ))
            if [[ ${gap} -gt 300 ]]; then
                # Crash state was NOT recently updated before the heartbeat went stale
                is_sleep_event=true
            fi
        fi
    fi

    if [[ "${is_sleep_event}" == "true" ]]; then
        log_info "Classifying stale heartbeat as sleep/wake event (NOT incrementing crash counter)."
    else
        log_info "Classifying stale heartbeat as potential crash event."
    fi

    # 3. Scan all active requests for session_active: true
    local repos
    repos=$(jq -r '.repositories.allowlist[]' "${EFFECTIVE_CONFIG}" 2>/dev/null || echo "")

    while IFS= read -r repo; do
        [[ -z "${repo}" ]] && continue
        local req_dir="${repo}/.autonomous-dev/requests"
        [[ -d "${req_dir}" ]] || continue

        for state_file in "${req_dir}"/*/state.json; do
            [[ -f "${state_file}" ]] || continue

            local session_active
            session_active=$(jq -r '.current_phase_metadata.session_active // false' "${state_file}" 2>/dev/null || echo "false")

            if [[ "${session_active}" == "true" ]]; then
                local req_id
                req_id=$(jq -r '.id' "${state_file}" 2>/dev/null || echo "unknown")
                log_warn "Found interrupted session for request ${req_id}. Restoring from checkpoint."

                local req_subdir
                req_subdir=$(dirname "${state_file}")
                restore_interrupted_session "${req_id}" "${req_subdir}" "${repo}"
            fi
        done
    done <<< "${repos}"

    log_info "Sleep/wake recovery complete."
}

# restore_interrupted_session(request_id, req_dir, project) -> void
#   Restores a request that had an active session when the daemon was
#   interrupted (sleep/wake or crash). Restores from checkpoint if available,
#   clears session_active, and logs a recovery event.
restore_interrupted_session() {
    local request_id="$1"
    local req_dir="$2"
    local project="$3"
    local state_file="${req_dir}/state.json"
    local checkpoint_file="${req_dir}/checkpoint.json"
    local events_file="${req_dir}/events.jsonl"

    # Restore from checkpoint if available
    if [[ -f "${checkpoint_file}" ]]; then
        if jq empty "${checkpoint_file}" 2>/dev/null; then
            cp "${checkpoint_file}" "${state_file}"
            log_info "Restored state.json from checkpoint for ${request_id}"
        else
            log_warn "Checkpoint is also corrupt for ${request_id}. Keeping current state."
        fi
    else
        log_warn "No checkpoint found for ${request_id}. Clearing session_active flag only."
    fi

    # Clear session_active flag
    local tmp="${state_file}.tmp"
    jq '.current_phase_metadata.session_active = false' "${state_file}" > "${tmp}" 2>/dev/null
    # LEDGER-EXEMPT: status/current_phase not modified
    mv "${tmp}" "${state_file}"

    # Append recovery event
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local event
    event=$(jq -n \
        --arg ts "${ts}" \
        --arg req "${request_id}" \
        '{
            timestamp: $ts,
            type: "session_interrupted",
            request_id: $req,
            details: {
                recovery_action: "restored_from_checkpoint"
            }
        }')
    echo "${event}" >> "${events_file}"
}

###############################################################################
# State File Validation (SPEC-001-3-03 Task 8)
###############################################################################

# validate_state_file(state_file: string) -> int
#   Validates that a state.json file exists and contains valid JSON.
#   On corruption, attempts recovery from checkpoint.json.
#   If both are corrupt, transitions the request to failed status.
#
# Arguments:
#   $1 -- state_file: Absolute path to the state.json file.
#
# Returns:
#   0 if state file is valid (possibly after checkpoint recovery).
#   1 if state file is missing or unrecoverable.
validate_state_file() {
    local state_file="$1"

    # Fast path: file exists and is valid JSON
    if [[ -f "${state_file}" ]] && jq empty "${state_file}" 2>/dev/null; then
        return 0
    fi

    # File does not exist
    if [[ ! -f "${state_file}" ]]; then
        log_error "State file missing: ${state_file}"
        return 1
    fi

    # File exists but is invalid JSON
    log_warn "State file corrupt: ${state_file}. Attempting checkpoint recovery."

    local req_dir
    req_dir=$(dirname "${state_file}")
    local checkpoint_file="${req_dir}/checkpoint.json"

    if [[ -f "${checkpoint_file}" ]] && jq empty "${checkpoint_file}" 2>/dev/null; then
        cp "${checkpoint_file}" "${state_file}"
        log_info "Restored state.json from checkpoint: ${state_file}"
        return 0
    fi

    # Both corrupt or checkpoint missing
    local request_id
    request_id=$(basename "${req_dir}")
    log_error "Unrecoverable state corruption for ${request_id}. Both state.json and checkpoint.json are invalid."

    # Attempt to transition to failed (write a minimal valid state)
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -n \
        --arg id "${request_id}" \
        --arg ts "${ts}" \
        '{
            id: $id,
            status: "failed",
            updated_at: $ts,
            current_phase_metadata: {
                failure_reason: "state_corruption",
                failed_at: $ts
            }
        }' > "${state_file}"

    emit_alert "state_corruption" "Unrecoverable state corruption for request ${request_id}"

    return 1
}

###############################################################################
# Graceful Shutdown Escalation (SPEC-001-3-04 Task 10)
###############################################################################

# graceful_shutdown_child() -> void
#   Called when SHUTDOWN_REQUESTED=true and CURRENT_CHILD_PID is non-empty.
#   Progressively escalates from waiting to SIGTERM to SIGKILL for hung
#   child processes.
graceful_shutdown_child() {
    local child_pid="${CURRENT_CHILD_PID}"
    if [[ -z "${child_pid}" ]]; then
        return
    fi

    # Check if child is still running
    if ! kill -0 "${child_pid}" 2>/dev/null; then
        log_info "Child process ${child_pid} already exited."
        return
    fi

    local grace_period="${GRACEFUL_SHUTDOWN_TIMEOUT:-300}"
    log_info "Waiting up to ${grace_period}s for child process ${child_pid} to exit naturally..."

    # Phase 1: Wait for natural exit
    local waited=0
    local poll_step=5
    while kill -0 "${child_pid}" 2>/dev/null && [[ ${waited} -lt ${grace_period} ]]; do
        sleep "${poll_step}"
        waited=$(( waited + poll_step ))
        if (( waited % 30 == 0 )); then
            log_info "Still waiting for child ${child_pid}... (${waited}/${grace_period}s)"
        fi
    done

    # Check if child exited during wait
    if ! kill -0 "${child_pid}" 2>/dev/null; then
        log_info "Child process ${child_pid} exited within grace period."
        return
    fi

    # Phase 2: SIGTERM
    log_warn "Child ${child_pid} did not exit within grace period (${grace_period}s). Sending SIGTERM."
    kill -TERM "${child_pid}" 2>/dev/null || true

    local sigterm_wait=10
    local sigterm_waited=0
    while kill -0 "${child_pid}" 2>/dev/null && [[ ${sigterm_waited} -lt ${sigterm_wait} ]]; do
        sleep 1
        sigterm_waited=$(( sigterm_waited + 1 ))
    done

    # Check again
    if ! kill -0 "${child_pid}" 2>/dev/null; then
        log_info "Child process ${child_pid} exited after SIGTERM."
        return
    fi

    # Phase 3: SIGKILL
    log_error "Child ${child_pid} did not respond to SIGTERM after ${sigterm_wait}s. Sending SIGKILL."
    kill -KILL "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true

    log_info "Child process ${child_pid} forcefully terminated."
}

###############################################################################
# Signal Handlers
###############################################################################

# handle_shutdown(signal: string) -> void
#   Signal handler for SIGTERM and SIGINT. Sets the SHUTDOWN_REQUESTED flag
#   so the main loop can exit gracefully. The actual child process handling
#   happens in the main loop after the `wait` call is interrupted by the signal.
handle_shutdown() {
    local signal="$1"
    log_info "Received ${signal}, initiating graceful shutdown..."
    SHUTDOWN_REQUESTED=true
    # The actual child process handling happens in the main loop
    # after the `wait` call is interrupted by the signal.
}

trap 'handle_shutdown SIGTERM' SIGTERM
trap 'handle_shutdown SIGINT' SIGINT

###############################################################################
# Configuration Loading
###############################################################################

# load_config() -> void
#   Reads defaults from $DEFAULTS_FILE, optionally merges with user config
#   from $CONFIG_FILE, writes effective config to a temp file, and populates
#   shell variables for use by the main loop.
load_config() {
    # 1. Validate that $DEFAULTS_FILE exists and is valid JSON
    if [[ ! -f "${DEFAULTS_FILE}" ]]; then
        log_error "Defaults config not found: ${DEFAULTS_FILE}"
        exit 1
    fi
    if ! jq empty "${DEFAULTS_FILE}" 2>/dev/null; then
        log_error "Defaults config is invalid JSON: ${DEFAULTS_FILE}"
        exit 1
    fi

    # 1a. One-time cleanup of the literal-placeholder file that older
    # daemon builds left behind (PR #267 follow-up). Pre-fix daemons used
    # `mktemp "...effective-config.XXXXXX.json"` which on BSD mktemp wrote
    # a file with the literal `XXXXXX`. That file blocks subsequent
    # mktemp calls. Operators upgrading from before #267 will still have
    # one of these sitting in DAEMON_HOME the first time the new code
    # runs; remove it so the new template substitutes cleanly.
    if [[ -f "${DAEMON_HOME}/effective-config.XXXXXX.json" ]]; then
        log_info "Cleaning up stale effective-config.XXXXXX.json placeholder from a pre-fix daemon run."
        rm -f "${DAEMON_HOME}/effective-config.XXXXXX.json"
    fi

    # 2/3. Merge with user config or use defaults as-is
    if [[ -f "${CONFIG_FILE}" ]]; then
        # Validate user config is valid JSON
        if ! jq empty "${CONFIG_FILE}" 2>/dev/null; then
            log_error "User config is invalid JSON: ${CONFIG_FILE}"
            exit 1
        fi
        # Deep recursive merge: defaults * user_config.
        # See PR #267 commit body for the BSD-mktemp template gotcha that
        # made this look like a single `mktemp <path.XXXXXX.json>` call.
        # `trap` covers a crash between mktemp and mv (would otherwise
        # leak the temp file).
        _tmp=$(mktemp "${DAEMON_HOME}/effective-config.XXXXXX")
        trap 'rm -f "${_tmp}" 2>/dev/null' RETURN
        EFFECTIVE_CONFIG="${_tmp}.json"
        if ! mv "${_tmp}" "${EFFECTIVE_CONFIG}"; then
            log_error "Failed to rename effective-config temp file: ${_tmp} -> ${EFFECTIVE_CONFIG}"
            rm -f "${_tmp}" 2>/dev/null
            exit 1
        fi
        jq -s '.[0] * .[1]' "${DEFAULTS_FILE}" "${CONFIG_FILE}" > "${EFFECTIVE_CONFIG}"
    else
        # No user config -- use defaults as-is. Same mktemp-then-mv idiom.
        _tmp=$(mktemp "${DAEMON_HOME}/effective-config.XXXXXX")
        trap 'rm -f "${_tmp}" 2>/dev/null' RETURN
        EFFECTIVE_CONFIG="${_tmp}.json"
        if ! mv "${_tmp}" "${EFFECTIVE_CONFIG}"; then
            log_error "Failed to rename effective-config temp file: ${_tmp} -> ${EFFECTIVE_CONFIG}"
            rm -f "${_tmp}" 2>/dev/null
            exit 1
        fi
        cp "${DEFAULTS_FILE}" "${EFFECTIVE_CONFIG}"
        log_info "No user config found at ${CONFIG_FILE}. Using defaults."
    fi

    # 4. Populate shell variables from effective config
    POLL_INTERVAL=$(jq -r '.daemon.poll_interval_seconds // 30' "${EFFECTIVE_CONFIG}")
    CIRCUIT_BREAKER_THRESHOLD=$(jq -r '.daemon.circuit_breaker_threshold // 3' "${EFFECTIVE_CONFIG}")
    HEARTBEAT_INTERVAL=$(jq -r '.daemon.heartbeat_interval_seconds // 30' "${EFFECTIVE_CONFIG}")
    IDLE_BACKOFF_MAX=$(jq -r '.daemon.idle_backoff_max_seconds // 900' "${EFFECTIVE_CONFIG}")
    GRACEFUL_SHUTDOWN_TIMEOUT=$(jq -r '.daemon.graceful_shutdown_timeout_seconds // 300' "${EFFECTIVE_CONFIG}")
    ERROR_BACKOFF_BASE=$(jq -r '.daemon.error_backoff_base_seconds // 30' "${EFFECTIVE_CONFIG}")
    ERROR_BACKOFF_MAX=$(jq -r '.daemon.error_backoff_max_seconds // 900' "${EFFECTIVE_CONFIG}")
    MAX_RETRIES_PER_PHASE=$(jq -r '.daemon.max_retries_per_phase // 3' "${EFFECTIVE_CONFIG}")
    # Issue #501: bound on comment-driven code-phase re-entries (loop guard).
    MAX_PR_COMMENT_REENTRIES=$(jq -r '.daemon.max_pr_comment_reentries // 3' "${EFFECTIVE_CONFIG}")
    LOG_MAX_SIZE_MB=$(jq -r '.daemon.log_max_size_mb // 50' "${EFFECTIVE_CONFIG}")
    LOG_RETENTION_DAYS=$(jq -r '.daemon.log_retention_days // 7' "${EFFECTIVE_CONFIG}")
    # Cost caps and concurrency live under `.governance` in config_defaults.json.
    # The previous `.daemon.*` paths never matched, so these silently fell back
    # to the hardcoded defaults and ignored operator config (PRD-025 FR-025-11).
    # Read `.governance.*` first, keeping `.daemon.*` as a back-compat fallback.
    DAILY_COST_CAP=$(jq -r '.governance.daily_cost_cap_usd // .daemon.daily_cost_cap_usd // 50.00' "${EFFECTIVE_CONFIG}")
    MONTHLY_COST_CAP=$(jq -r '.governance.monthly_cost_cap_usd // .daemon.monthly_cost_cap_usd // 500.00' "${EFFECTIVE_CONFIG}")
    PER_REQUEST_COST_CAP=$(jq -r '.governance.per_request_cost_cap_usd // 50.00' "${EFFECTIVE_CONFIG}")
    MAX_CONCURRENT_REQUESTS=$(jq -r '.governance.max_concurrent_requests // 3' "${EFFECTIVE_CONFIG}")
    RATE_LIMIT_BACKOFF_BASE=$(jq -r '.governance.rate_limit_backoff_base_seconds // 30' "${EFFECTIVE_CONFIG}")
    RATE_LIMIT_BACKOFF_MAX=$(jq -r '.governance.rate_limit_backoff_max_seconds // 900' "${EFFECTIVE_CONFIG}")

    # 5. Update idle backoff variables
    IDLE_BACKOFF_CURRENT=${POLL_INTERVAL}
    IDLE_BACKOFF_BASE=${POLL_INTERVAL}

    # 6. Log effective config summary
    log_info "Config loaded: poll_interval=${POLL_INTERVAL}s, circuit_breaker_threshold=${CIRCUIT_BREAKER_THRESHOLD}, heartbeat_interval=${HEARTBEAT_INTERVAL}s"
}

# cleanup_effective_config() -> void
#   Removes the temporary effective config file if it exists.
cleanup_effective_config() {
    if [[ -n "${EFFECTIVE_CONFIG}" && -f "${EFFECTIVE_CONFIG}" ]]; then
        rm -f "${EFFECTIVE_CONFIG}"
    fi
}

###############################################################################
# Request Selection (SPEC-001-2-02 Task 3)
###############################################################################

# select_request() -> string
#   Scans the repository allowlist for actionable requests and returns the
#   highest-priority one. Priority is lowest-number-wins (0 = highest).
#   Ties are broken by earliest created_at (oldest wins).
#
# Returns:
#   Stdout: "{request_id}|{project_path}" if work found, or empty string.
#   Exit 0 always.
#
# Filters (non-actionable, skipped):
#   - status in {paused, failed, cancelled, monitor}
#   - blocked_by array is non-empty
#   - next_retry_after is in the future (error backoff)
#   - state.json is unparseable (logged as warning)
select_request() {
    local repos
    repos=$(jq -r '.repositories.allowlist[]' "${EFFECTIVE_CONFIG}" 2>/dev/null)

    if [[ -z "${repos}" ]]; then
        return 0
    fi

    local best_id="" best_project="" best_priority=999999 best_created=""

    while IFS= read -r repo; do
        [[ -z "${repo}" ]] && continue
        local req_dir="${repo}/.autonomous-dev/requests"
        [[ -d "${req_dir}" ]] || continue

        for state_file in "${req_dir}"/*/state.json; do
            [[ -f "${state_file}" ]] || continue
            validate_state_file "${state_file}" || continue  # Skip corrupt files

            local parsed
            parsed=$(jq -r '[.id, .status, (.priority // 999 | tostring), .created_at, (.blocked_by // [] | length | tostring), (.current_phase_metadata.next_retry_after // "")] | join("|")' "${state_file}" 2>/dev/null)

            if [[ -z "${parsed}" ]]; then
                log_warn "Failed to parse state file: ${state_file}"
                continue
            fi

            local req_id status priority created_at blocked_by_count next_retry_after
            IFS='|' read -r req_id status priority created_at blocked_by_count next_retry_after <<< "${parsed}"

            # Filter non-actionable lifecycle states (terminal + paused).
            # PRD-019 statuses: queued|running|gate|done|cancelled; PRD-020 added
            # `failed`. The terminal three (`done`, `cancelled`, `failed`) must
            # be skipped — without `done` here, the daemon kept re-selecting
            # completed requests and re-dispatching the `monitor` agent on them,
            # wasting cost. See B-13 in docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md
            # (Path-C build-out test 2026-05-13). (`monitor` was previously in this
            # list but never matched — it's a phase, not a status.)
            case "${status}" in
                done|cancelled|failed|paused) continue ;;
            esac

            # Filter blocked requests
            [[ "${blocked_by_count}" -gt 0 ]] && continue

            # Filter requests in error backoff
            if [[ -n "${next_retry_after}" ]]; then
                local now_epoch retry_epoch
                now_epoch=$(date -u +%s)
                retry_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${next_retry_after}" +%s 2>/dev/null \
                              || date -u -d "${next_retry_after}" +%s 2>/dev/null \
                              || echo "0")
                if [[ ${retry_epoch} -gt ${now_epoch} ]]; then
                    continue  # Still in backoff period
                fi
            fi

            # Compare to find the best (lowest priority number wins, then oldest)
            if [[ ${priority} -lt ${best_priority} ]] || \
               { [[ ${priority} -eq ${best_priority} ]] && [[ "${created_at}" < "${best_created}" ]]; }; then
                best_id="${req_id}"
                best_project="${repo}"
                best_priority=${priority}
                best_created="${created_at}"
            fi
        done
    done <<< "${repos}"

    if [[ -n "${best_id}" ]]; then
        echo "${best_id}|${best_project}"
    fi
}

###############################################################################
# Type-Aware Phase Progression (SPEC-018-2-01)
###############################################################################
# These helpers replace the implicit hardcoded 14-phase progression with a
# v1.1-aware lookup against the state file's phase_overrides[] array. When
# phase_overrides is absent (legacy v1.0 state), they fall back to the
# LEGACY_PHASES array sourced from lib/phase-legacy.sh and emit a
# deduplicated WARN line so operators see the migration debt once per
# daemon process per request.

# warn_legacy_fallback_once(state_file: string) -> void
#   Emits a single WARN line per state_file per supervisor process lifetime.
#   The dedup table is reset on daemon restart, which by TDD-001 is daily —
#   so an unmigrated state file surfaces the warning at most once per day.
warn_legacy_fallback_once() {
    local state_file="$1"
    if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
        # No associative arrays on bash 3.x: fall back to a per-call warn
        # rather than maintain a string-keyed file. macOS users with stock
        # bash hit this path; the validate_dependencies() preamble already
        # warns on bash < 4 once at startup, so the duplication here is
        # acceptable for an edge platform.
        printf 'WARN select_request: state %s lacks phase_overrides, using legacy sequence\n' \
            "${state_file}" >&2
        return 0
    fi
    if [[ -z "${_phase_legacy_warned[${state_file}]:-}" ]]; then
        printf 'WARN select_request: state %s lacks phase_overrides, using legacy sequence\n' \
            "${state_file}" >&2
        _phase_legacy_warned[${state_file}]=1
    fi
}

# next_phase_for_state(state_file: string) -> string
#   Returns the phase name that should follow .current_phase for the given
#   state. Lookup order:
#     1. state.json .phase_overrides[] (v1.1) — find current_phase, return next.
#     2. LEGACY_PHASES (v1.0 fallback) — same logic, with a WARN emitted once.
#
#   Returns empty string when current_phase is the terminal element.
#   Returns non-zero exit (and emits ERROR to stderr) when current_phase is
#   not present in the resolved sequence — surfaces a corrupted state file
#   rather than silently masking it.
#
#   Pure: does not modify state.json.
next_phase_for_state() {
    local state_file="$1"
    if [[ ! -f "${state_file}" ]]; then
        printf 'ERROR next_phase_for_state: state file not found: %s\n' \
            "${state_file}" >&2
        return 2
    fi

    local current_phase
    current_phase=$(jq -r '.current_phase // empty' "${state_file}" 2>/dev/null || true)
    if [[ -z "${current_phase}" ]]; then
        printf 'ERROR next_phase_for_state: .current_phase missing in %s\n' \
            "${state_file}" >&2
        return 2
    fi

    # Check if phase_overrides key exists (regardless of length)
    local has_overrides_key
    if jq -e 'has("phase_overrides")' "${state_file}" >/dev/null 2>&1; then
        has_overrides_key="true"
    else
        has_overrides_key="false"
    fi

    local -a phases=()
    if [[ "${has_overrides_key}" == "true" ]]; then
        # v1.1 path: phase_overrides key exists - use it (even if empty)
        local phases_raw
        phases_raw=$(jq -r '.phase_overrides[]' "${state_file}" 2>/dev/null || true)
        while IFS= read -r p; do
            [[ -n "${p}" ]] && phases+=("${p}")
        done <<< "${phases_raw}"

        # If phase_overrides is empty, fall back to legacy sequence but without warning
        if [[ ${#phases[@]} -eq 0 ]]; then
            phases=("${LEGACY_PHASES[@]}")
        fi
    else
        # v1.0 fallback: phase_overrides key is missing - warn once
        warn_legacy_fallback_once "${state_file}"
        phases=("${LEGACY_PHASES[@]}")
    fi

    local idx=-1 i
    for i in "${!phases[@]}"; do
        if [[ "${phases[$i]}" == "${current_phase}" ]]; then
            idx=$i
            break
        fi
    done

    if [[ ${idx} -lt 0 ]]; then
        printf "ERROR select_request: phase '%s' not in sequence for %s\n" \
            "${current_phase}" "${state_file}" >&2
        return 1
    fi

    local next_idx=$(( idx + 1 ))
    if [[ ${next_idx} -ge ${#phases[@]} ]]; then
        # Terminal phase: empty string (success, exit 0)
        echo ""
        return 0
    fi

    echo "${phases[${next_idx}]}"
    return 0
}

# is_enhanced_phase(state_file: string, phase: string) -> int
#   Returns 0 (true) if phase is in .type_config.enhancedPhases for this
#   state, 1 (false) otherwise. Returns 1 when type_config is absent.
#   Used by the supervisor to decide whether to pass --strict-mode to the
#   score-evaluator on review phases.
is_enhanced_phase() {
    local state_file="$1" phase="$2"
    [[ -f "${state_file}" ]] || return 1
    local enhanced
    enhanced=$(jq -r --arg p "${phase}" \
        '(.type_config.enhancedPhases // []) | index($p) // empty' \
        "${state_file}" 2>/dev/null || true)
    [[ -n "${enhanced}" ]]
}

# invoke_score_evaluator(state_file: string, phase: string) -> int
#   Wires the type-aware --strict-mode flag into the score-evaluator
#   invocation. Returns the evaluator's exit code.
invoke_score_evaluator() {
    local state_file="$1" phase="$2"
    local -a score_args=()
    if is_enhanced_phase "${state_file}" "${phase}"; then
        score_args+=(--strict-mode)
    fi
    "${PLUGIN_DIR}/bin/score-evaluator.sh" "${score_args[@]}" "${state_file}"
}

# check_phase_advancement_blocked(state_file: string) -> int
#   SPEC-018-2-03 Task 4. Returns 0 (no block) when the current phase has
#   no required additionalGates or when the gate artifact is present.
#   Returns 1 (blocked) and idempotently writes status_reason="awaiting
#   gate: <gate>" into state.json when the artifact is missing.
#
#   Called by the lifecycle engine immediately before advancing the phase.
#   The supervisor itself does not advance phases — the spawned Claude
#   session does — so this helper exists for future wiring. Wiring it into
#   the existing main_loop is intentionally deferred until PLAN-018-3 ships
#   the agent-side phase-advancement contract.
check_phase_advancement_blocked() {
    local state_file="$1"
    [[ -f "${state_file}" ]] || return 0

    local current_phase
    current_phase=$(jq -r '.current_phase // .status // ""' "${state_file}" 2>/dev/null || true)
    [[ -n "${current_phase}" ]] || return 0

    if [[ ! -f "${LIB_DIR}/gate-check.sh" ]]; then
        return 0  # helper not present, nothing to enforce
    fi
    # shellcheck source=lib/gate-check.sh
    source "${LIB_DIR}/gate-check.sh"

    local missing
    missing=$(check_required_gates "${state_file}" "${current_phase}")
    if [[ -n "${missing}" ]]; then
        update_status_reason_awaiting "${state_file}" "${missing}"
        return 1
    fi
    return 0
}

###############################################################################
# Phase-Aware Max-Turns Resolution (SPEC-001-2-02 Task 4)
###############################################################################

# resolve_max_turns(phase: string) -> int
#   Determines the turn budget for a given phase. Checks the effective config
#   for a phase-specific override first; falls back to built-in defaults.
#
# Arguments:
#   $1 -- phase: The current status/phase name (e.g., "code", "intake").
#
# Stdout:
#   Integer turn count.
resolve_max_turns() {
    local phase="${1:-}"

    local turns
    turns=$(jq -r ".daemon.max_turns_by_phase.\"${phase}\" // null" "${EFFECTIVE_CONFIG}")

    if [[ "${turns}" == "null" || -z "${turns}" ]]; then
        case "${phase}" in
            intake)                                                       turns=10  ;;
            prd|tdd|plan|spec)                                            turns=50  ;;
            prd_review|tdd_review|plan_review|spec_review|code_review)    turns=30  ;;
            code)                                                         turns=200 ;;
            integration)                                                  turns=100 ;;
            deploy)                                                       turns=30  ;;
            monitor)                                                      turns=20  ;;
            *)                                                            turns=50  ;;
        esac
    fi

    echo "${turns}"
}


###############################################################################
# Phase-to-Agent Resolution (TASK-008)
###############################################################################

# resolve_agent(phase: string) -> string
#   Maps a pipeline phase to its owning agent name per TDD-038 §6.2.
#   Returns empty string + exit 1 for unknown phases (including intake).
#
# Arguments:
#   $1 -- phase: The current pipeline phase (e.g., "prd", "code_review").
#
# Stdout:
#   Agent name string (e.g., "prd-author"), or empty string if unmapped.
#
# Returns:
#   0 if agent found, 1 if phase unknown or intake
resolve_agent() {
    local phase="${1:-}"

    case "${phase}" in
        intake)         echo ""; return 1 ;;
        prd)            echo "prd-author" ;;
        prd_review)     echo "doc-reviewer" ;;
        tdd)            echo "tdd-author" ;;
        tdd_review)     echo "doc-reviewer" ;;
        plan)           echo "plan-author" ;;
        plan_review)    echo "doc-reviewer" ;;
        spec)           echo "spec-author" ;;
        spec_review)    echo "doc-reviewer" ;;
        code)           echo "code-executor" ;;
        code_review)    echo "quality-reviewer" ;;
        integration)    echo "test-executor" ;;
        deploy)         echo "deploy-executor" ;;
        monitor)        echo "performance-analyst" ;;
        *)              echo ""; return 1 ;;
    esac
}

###############################################################################
# Scoped Runtime Context (ONBOARD #597 / #598)
###############################################################################
# At run time, a request whose target repo resolves (via ownership) to a
# repoId/projectId can have scoped MEMORY, a scoped AGENT, and promoted scoped
# SKILLS. These helpers consume that context best-effort. They are ADDITIVE and
# SAFE: a repo with no scoped artifacts (the common case) yields empty output
# and the caller keeps its default agent/prompt byte-for-byte.

# resolve_scope_context(project, phase, default_agent) -> string
#   Echoes the scope-context.ts JSON for the repo, or empty string when scope
#   resolution is unavailable/empty/invalid. Never fails the caller: a missing
#   bun, missing helper, or any non-JSON output collapses to "no scope".
resolve_scope_context() {
    local project="${1:-}" phase="${2:-}" default_agent="${3:-}"
    [[ -z "${project}" ]] && return 0
    # bun is the runtime for the TS helper (mirrors agent-cli.ts). If it is not
    # on the daemon PATH, skip scope enrichment — the default path is unchanged.
    command -v bun >/dev/null 2>&1 || return 0
    local helper="${PLUGIN_DIR}/bin/scope-context.ts"
    [[ -f "${helper}" ]] || return 0

    local out
    out=$(bun run "${helper}" \
            --repo "${project}" \
            --phase "${phase}" \
            --default-agent "${default_agent}" 2>/dev/null || echo "")

    # Only emit when the output is valid JSON AND the repo actually resolved to
    # a scope (scoped=true). Anything else => no scope (fallback).
    if [[ -n "${out}" ]] && echo "${out}" | jq empty 2>/dev/null; then
        local scoped
        scoped=$(echo "${out}" | jq -r '.scoped // false' 2>/dev/null || echo "false")
        if [[ "${scoped}" == "true" ]]; then
            echo "${out}"
        fi
    fi
}

# build_scope_prompt_appendix(scope_json) -> string
#   Renders the scoped memory + skill file paths into a prompt appendix the
#   phase session can read. Empty when there is no memory and no skill to surface.
build_scope_prompt_appendix() {
    local scope_json="${1:-}"
    [[ -z "${scope_json}" ]] && return 0

    local mem skills
    mem=$(echo "${scope_json}" | jq -r '(.memoryPaths // [])[]' 2>/dev/null || echo "")
    skills=$(echo "${scope_json}" | jq -r '(.skillPaths // [])[]' 2>/dev/null || echo "")
    [[ -z "${mem}" && -z "${skills}" ]] && return 0

    local appendix="── Scoped knowledge for this repository (ONBOARD) ──
Operator-curated context applies to this repo/project. Read and apply it."

    if [[ -n "${mem}" ]]; then
        appendix="${appendix}

Scoped memory (general → specific — read all layers):"
        local p
        while IFS= read -r p; do
            [[ -n "${p}" ]] && appendix="${appendix}
  - ${p}"
        done <<< "${mem}"
    fi

    if [[ -n "${skills}" ]]; then
        appendix="${appendix}

Promoted skills available for this run (most-specific scope wins):"
        local s
        while IFS= read -r s; do
            [[ -n "${s}" ]] && appendix="${appendix}
  - ${s}"
        done <<< "${skills}"
    fi

    echo "${appendix}"
}

###############################################################################
# Phase Session Dispatch (TASK-009, TASK-026)
###############################################################################

# repo_has_deploy_target(project) -> 0 if the repo has a deployable target, 1 if not.
#   Used to skip the deploy phase for docs/no-infra changes: a repo with nothing to
#   deploy makes the deploy agent improvise git ops that then fail verification.
#   Conservative — deploy still runs whenever ANY marker is present; it is skipped
#   only when NONE are. Operators can force it via .autonomous-dev/deploy.{yaml,yml,json}.
repo_has_deploy_target() {
    local project="$1"
    [[ -f "${project}/Dockerfile" || -f "${project}/Containerfile" ]] && return 0
    [[ -f "${project}/Procfile" || -f "${project}/fly.toml" || -f "${project}/app.yaml" || -f "${project}/Chart.yaml" ]] && return 0
    [[ -f "${project}/.autonomous-dev/deploy.yaml" || -f "${project}/.autonomous-dev/deploy.yml" || -f "${project}/.autonomous-dev/deploy.json" ]] && return 0
    local f
    for f in "${project}"/docker-compose*.y*ml "${project}"/serverless*.y*ml "${project}"/*.tf \
             "${project}"/k8s/*.y*ml "${project}"/kubernetes/*.y*ml "${project}"/deploy/*.y*ml; do
        [[ -e "${f}" ]] && return 0
    done
    if [[ -d "${project}/.github/workflows" ]]; then
        grep -liE "deploy|release|publish" "${project}"/.github/workflows/*.y*ml >/dev/null 2>&1 && return 0
    fi
    return 1
}

# should_use_review_chain(phase: string) -> 0|1
#   FLAG-GATED routing predicate for the reviewer-chain gate (#561/#568).
#   Returns 0 (use the chain) ONLY when AUTONOMOUS_DEV_REVIEW_CHAINS=1 AND the
#   phase is `code_review` OR `spec_review`. Every other phase, and the flag in
#   any state other than exactly "1", returns 1 so that dispatch_phase_session
#   takes its byte-identical single-agent path.
#
#   SAFETY: with the flag unset or 0 (the default) this ALWAYS returns 1; the
#   only way to reach 0 is an explicit opt-in via the env var on the code_review
#   or spec_review phase. The remaining *_review phases (prd/tdd/plan) are
#   intentionally DEFERRED — they are separable and have no consumer yet. The
#   PlanPreAuthor/SpecPreAuthor hook emission (#568 part 2) IS wired — see
#   emit_pre_author_hook() below.
should_use_review_chain() {
    local phase="${1:-}"
    [[ "${AUTONOMOUS_DEV_REVIEW_CHAINS:-0}" == "1" && ( "${phase}" == "code_review" || "${phase}" == "spec_review" ) ]]
}

# emit_pre_author_hook(request_id, project, phase) -> 0 (always)
#   Best-effort emission of the plan-pre-author / spec-pre-author hook points
#   (#561 item 1 / #568 part 2). Fires every plugin hook registered for the
#   point via bin/hooks-emit.ts; a deliberate NO-OP when none are registered.
#   The mechanism is wired and ready for future consumers — today nothing
#   registers for these points, so the common outcome is `{ran:0}`.
#
#   CHEAPNESS GUARD: before paying bun's startup cost (incurred on EVERY plan
#   and spec phase otherwise), a cheap glob checks the plugins root for ANY
#   `*/hooks.json`. With no plugin manifests on disk (the default) the
#   subprocess is skipped entirely. The root mirrors the hooks-cli loader:
#   AUTONOMOUS_DEV_PLUGINS_ROOT, else $HOME/.claude/plugins.
#
#   SAFETY: stdout/stderr -> daemon log; the `|| true` plus the CLI's own
#   best-effort exit-0 contract guarantee a failure here can NEVER block plan
#   or spec authoring. Non-plan/spec phases short-circuit to a no-op.
emit_pre_author_hook() {
    local request_id="${1:-}"
    local project="${2:-}"
    local phase="${3:-}"

    local point=""
    case "${phase}" in
        plan) point="plan-pre-author" ;;
        spec) point="spec-pre-author" ;;
        *)    return 0 ;;
    esac

    # Cheapness guard: skip the bun subprocess unless at least one plugin
    # manifest exists under the plugins root the hooks-cli loader scans.
    local plugins_root="${AUTONOMOUS_DEV_PLUGINS_ROOT:-${HOME}/.claude/plugins}"
    if ! compgen -G "${plugins_root}/*/hooks.json" > /dev/null 2>&1; then
        return 0
    fi

    log_info "Emitting ${point} hook for ${request_id} (phase=${phase})"
    bun run "${PLUGIN_DIR}/bin/hooks-emit.ts" emit "${point}" \
        --request-id "${request_id}" \
        --repo "${project}" \
        --phase "${phase}" >> "${LOG_FILE}" 2>&1 || true
    return 0
}

# run_review_gate_phase(request_id, project, state_file, phase) -> "code|cost|file"
#   Routes a review phase through the multi-reviewer chain CLI
#   (bin/review-gate.ts) instead of the single hardcoded agent, then writes
#   phase-result-<phase>.json so the EXISTING advance_phase() consumes it
#   unchanged. Only reached when should_use_review_chain() is true.
#
#   GateDecision contract (verified against review-gate-orchestrator.ts):
#     stdout = JSON with `.outcome` ∈ {APPROVE, REQUEST_CHANGES} (+ .reason,
#     .results, .warnings, ...). Mapping to phase-result.status:
#       APPROVE          -> pass
#       REQUEST_CHANGES  -> fail
#       anything else    -> error
#
#   FAIL-CLOSED: on a non-zero CLI exit, non-JSON stdout, a missing `.outcome`,
#   or a result-write failure, a SYNTHESIZED `error` phase-result is written
#   (via spawn-session.sh's write_synthesized_phase_result). advance_phase()
#   treats `error` like `fail` for a *_review phase, so the request loops back
#   to its author phase and retries rather than hanging.
run_review_gate_phase() {
    local request_id="${1:-}" project="${2:-}" state_file="${3:-}" phase="${4:-}"
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local result_file="${req_dir}/phase-result-${phase}.json"

    local timestamp output_file
    timestamp=$(date +%s)
    output_file="${req_dir}/session-${timestamp}.txt"

    # Request type drives chain selection (mirrors resolve_request_type's default).
    local request_type
    request_type=$(jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature")

    log_info "Reviewer-chain gate ENABLED for ${request_id}/${phase} (AUTONOMOUS_DEV_REVIEW_CHAINS=1); request_type=${request_type}"

    # Invoke the chain CLI. stdout is the GateDecision JSON; stderr (diagnostics)
    # is captured into the session log. The gate name mirrors the phase name.
    local gate_json exit_code
    gate_json=$(bun run "${PLUGIN_DIR}/bin/review-gate.ts" \
        --repo "${project}" \
        --request-type "${request_type}" \
        --gate "${phase}" \
        --request-id "${request_id}" 2>"${output_file}")
    exit_code=$?

    if [[ ${exit_code} -ne 0 ]]; then
        log_warn "review-gate CLI exited ${exit_code} for ${request_id}/${phase}; synthesizing error result"
        bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; write_synthesized_phase_result '${result_file}' 'error' 'REVIEW_GATE_CLI_NONZERO' '${exit_code}' '${phase}'"
        echo "${exit_code}|0|${output_file}"
        return 0
    fi

    local outcome
    outcome=$(printf '%s' "${gate_json}" | jq -r '.outcome // empty' 2>/dev/null || echo "")
    if [[ -z "${outcome}" ]]; then
        log_warn "review-gate CLI produced no parseable .outcome for ${request_id}/${phase}; synthesizing error result"
        bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; write_synthesized_phase_result '${result_file}' 'error' 'REVIEW_GATE_BAD_JSON' '0' '${phase}'"
        echo "1|0|${output_file}"
        return 0
    fi

    local status
    case "${outcome}" in
        APPROVE)         status="pass" ;;
        REQUEST_CHANGES) status="fail" ;;
        *)               status="error" ;;
    esac

    # Persist the FULL GateDecision as the phase-result (so advance_phase + the
    # portal/telemetry see the real reviewer verdicts), augmenting it with the
    # status/phase/feedback fields the pipeline expects.
    local ts tmp
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    tmp="${result_file}.tmp.$$"
    if printf '%s' "${gate_json}" | jq \
        --arg s "${status}" --arg p "${phase}" --arg ts "${ts}" \
        '. + {status: $s, phase: $p, feedback: (.reason // ""), review_chain: true, completed_at: $ts}' \
        > "${tmp}" 2>/dev/null && [[ -s "${tmp}" ]]; then
        mv "${tmp}" "${result_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
        log_warn "review-gate result write failed for ${request_id}/${phase}; synthesizing error result"
        bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; write_synthesized_phase_result '${result_file}' 'error' 'REVIEW_GATE_RESULT_WRITE_FAILED' '0' '${phase}'"
        echo "1|0|${output_file}"
        return 0
    fi

    log_info "Reviewer-chain gate ${request_id}/${phase}: outcome=${outcome} -> status=${status}"
    echo "0|0|${output_file}"
    return 0
}

###############################################################################
# Dispatch Timeout Helpers (REQ-000051)
###############################################################################

# snapshot_working_tree(project: string) -> string (stdout)
#   Returns a compact snapshot of the working tree state for progress detection.
#   For non-git paths: prints literal "non-git" and exits 0.
#   For git repos: prints "<HEAD-sha>|<dirty-file-count>" and exits 0.
#   The dirty count includes untracked files (default git status --porcelain
#   behavior). Uses 2>/dev/null so that an empty repo or racy git state
#   never causes an error.
snapshot_working_tree() {
    local project="${1:-}"
    if [[ -z "${project}" || ! -d "${project}/.git" ]]; then
        printf 'non-git\n'
        return 0
    fi
    local head dirty
    head=$(git -C "${project}" rev-parse HEAD 2>/dev/null || true)
    dirty=$(git -C "${project}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    printf '%s|%s\n' "${head}" "${dirty}"
}

# working_tree_advanced(pre: string, post: string) -> int (exit code)
#   Returns 0 (true) iff all of:
#     1. pre and post are both non-empty.
#     2. Neither is the literal sentinel "non-git".
#     3. pre != post (string comparison).
#   Returns 1 (false) otherwise. Prints nothing to stdout/stderr.
working_tree_advanced() {
    local pre="${1:-}" post="${2:-}"
    if [[ -z "${pre}" || -z "${post}" ]]; then
        return 1
    fi
    if [[ "${pre}" == "non-git" || "${post}" == "non-git" ]]; then
        return 1
    fi
    if [[ "${pre}" == "${post}" ]]; then
        return 1
    fi
    return 0
}

# emit_soft_timeout_promotion_alert(request_id, phase, soft_timeout_count) -> void
#   Appends a soft_timeout_promoted_to_hard event to events.jsonl and fires
#   emit_alert so the operator is notified via the alerts directory.
emit_soft_timeout_promotion_alert() {
    local request_id="$1"
    local phase="$2"
    local soft_timeout_count="$3"
    local project="${4:-${CURRENT_PROJECT:-}}"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Best-effort: if we can locate the events file, append the event.
    # We accept project as optional 4th arg or fall back to env; if neither
    # is available skip the file append without error.
    local events_file=""
    if [[ -n "${project}" ]]; then
        events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"
    fi

    if [[ -n "${events_file}" && -d "$(dirname "${events_file}")" ]]; then
        local event
        event=$(jq -n \
            --arg ts "${ts}" \
            --arg req "${request_id}" \
            --arg phase "${phase}" \
            --argjson stc "${soft_timeout_count}" \
            '{
                timestamp: $ts,
                type: "soft_timeout_promoted_to_hard",
                request_id: $req,
                details: {
                    phase: $phase,
                    soft_timeout_count: $stc
                }
            }')
        echo "${event}" >> "${events_file}"
    fi

    emit_alert "soft_timeout_promoted_to_hard" \
        "Request ${request_id} promoted soft-timeout to hard after ${soft_timeout_count} productive timeouts in phase '${phase}'"
}

# record_soft_timeout(
#   request_id: string,
#   project: path,
#   phase: string,
#   pre_tree: string,
#   post_tree: string,
#   timeout_seconds: int
# ) -> int (exit 0 always)
#   Atomically increments soft_timeout_count in state.json, sets
#   session_active=false, records last_error, and appends a
#   session_soft_timeout event to events.jsonl.
#   Does NOT touch retry_count, escalation_count, next_retry_after, or status.
#   On write failure: logs via log_warn and returns 0 (never cascades to hard).
record_soft_timeout() {
    local request_id="$1"
    local project="$2"
    local phase="$3"
    local pre_tree="$4"
    local post_tree="$5"
    local timeout_seconds="$6"

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local state_file="${req_dir}/state.json"
    local events_file="${req_dir}/events.jsonl"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Parse pre/post tree snapshots into head+dirty_count parts.
    # For the "non-git" sentinel, both head and dirty_count are null.
    local pre_head pre_dirty post_head post_dirty
    if [[ "${pre_tree}" == "non-git" ]]; then
        pre_head="null"; pre_dirty="null"
    else
        pre_head="${pre_tree%%|*}"
        pre_dirty="${pre_tree##*|}"
        # Ensure dirty is numeric; default null if not
        [[ "${pre_dirty}" =~ ^[0-9]+$ ]] || pre_dirty="null"
    fi
    if [[ "${post_tree}" == "non-git" ]]; then
        post_head="null"; post_dirty="null"
    else
        post_head="${post_tree%%|*}"
        post_dirty="${post_tree##*|}"
        [[ "${post_dirty}" =~ ^[0-9]+$ ]] || post_dirty="null"
    fi

    # Atomic state.json update — mirror the tmp+mv idiom used elsewhere.
    local tmp="${state_file}.tmp.$$"
    local new_soft_count
    if jq \
        --arg ts "${ts}" \
        --arg secs "${timeout_seconds}" \
        '
        .current_phase_metadata.soft_timeout_count =
            ((.current_phase_metadata.soft_timeout_count // 0) + 1) |
        .current_phase_metadata.last_session_completed_at = $ts |
        .current_phase_metadata.session_active = false |
        .current_phase_metadata.last_error =
            ("Soft timeout after " + $secs + "s (progress detected)") |
        .current_phase_metadata.last_error_at = $ts |
        .updated_at = $ts
        ' "${state_file}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${state_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
        log_warn "record_soft_timeout: failed to update state.json for ${request_id}"
        return 0
    fi

    # Read the new count for the event
    new_soft_count=$(jq -r '.current_phase_metadata.soft_timeout_count // 1' \
        "${state_file}" 2>/dev/null || echo "1")

    # Append session_soft_timeout event — mirror the pattern used at
    # update_request_state (L2358-L2372): build with jq -n, echo >> file.
    local pre_head_json post_head_json pre_dirty_json post_dirty_json
    if [[ "${pre_head}" == "null" ]]; then
        pre_head_json="null"
    else
        pre_head_json=$(jq -n --arg v "${pre_head}" '$v')
    fi
    if [[ "${post_head}" == "null" ]]; then
        post_head_json="null"
    else
        post_head_json=$(jq -n --arg v "${post_head}" '$v')
    fi
    if [[ "${pre_dirty}" == "null" ]]; then
        pre_dirty_json="null"
    else
        pre_dirty_json="${pre_dirty}"
    fi
    if [[ "${post_dirty}" == "null" ]]; then
        post_dirty_json="null"
    else
        post_dirty_json="${post_dirty}"
    fi

    local event
    event=$(jq -n \
        --arg ts "${ts}" \
        --arg req "${request_id}" \
        --arg phase "${phase}" \
        --argjson secs "${timeout_seconds}" \
        --argjson pre_head "${pre_head_json}" \
        --argjson post_head "${post_head_json}" \
        --argjson pre_dirty "${pre_dirty_json}" \
        --argjson post_dirty "${post_dirty_json}" \
        --argjson stc "${new_soft_count}" \
        '{
            timestamp: $ts,
            type: "session_soft_timeout",
            request_id: $req,
            details: {
                phase: $phase,
                timeout_seconds: $secs,
                pre_head: $pre_head,
                post_head: $post_head,
                pre_dirty_count: $pre_dirty,
                post_dirty_count: $post_dirty,
                soft_timeout_count: $stc
            }
        }') || {
        log_warn "record_soft_timeout: failed to build event JSON for ${request_id}"
        return 0
    }
    echo "${event}" >> "${events_file}" || {
        log_warn "record_soft_timeout: failed to append events.jsonl for ${request_id}"
    }
    return 0
}

# dispatch_phase_session(request_id: string, project: string) -> string
#   Validates request, resolves agent for current phase, and dispatches session
#   via spawn_session_typed with per-phase timeout. Handles errors gracefully.
#
# Arguments:
#   $1 -- request_id: The request ID to process.
#   $2 -- project:    Absolute path to the project/repository root.
#
# Stdout:
#   "{exit_code}|{session_cost}|{output_file}"
#
# Returns:
#   0 on success, 1 on shell error, 2 on invalid request_id, 3 on unknown phase
dispatch_phase_session() {
    local request_id="${1:-}"
    local project="${2:-}"

    # Validate request_id first
    if ! validate_request_id "${request_id}"; then
        log_error "Invalid request_id: ${request_id}"
        echo "2|0|"
        return 2
    fi

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    # Validate state file
    if ! validate_state_file "${state_file}"; then
        log_error "State file invalid or missing: ${state_file}"
        echo "1|0|"
        return 1
    fi

    # Read current phase
    local phase
    phase=$(jq -r '.current_phase // .status' "${state_file}")

    # Skip the deploy phase when the repo has no deploy target. A docs/no-infra
    # change has nothing to deploy; dispatching the deploy agent makes it
    # improvise git operations that then fail verification. Write a clean pass
    # result and let the pipeline advance (to monitor).
    if [[ "${phase}" == "deploy" ]] && ! repo_has_deploy_target "${project}"; then
        local skip_req_dir="${project}/.autonomous-dev/requests/${request_id}"
        jq -n '{
            status: "pass",
            phase: "deploy",
            feedback: "No deploy target detected (no Dockerfile/compose/terraform/k8s/serverless/CI deploy config); deploy phase skipped.",
            artifacts: [],
            evidence: [],
            skipped: true
        }' > "${skip_req_dir}/phase-result-deploy.json"
        log_info "deploy phase skipped for ${request_id}: no deploy target in ${project}"
        echo "0|0|"
        return 0
    fi

    # Resolve agent for this phase
    local agent
    if ! agent=$(resolve_agent "${phase}"); then
        log_warn "No agent for phase '${phase}'; skipping"
        echo "3|0|"
        return 3
    fi

    if [[ -z "${agent}" ]]; then
        log_warn "No agent for phase '${phase}'; skipping"
        echo "3|0|"
        return 3
    fi

    # Mark session as active and set dispatch timestamp
    local tmp="${state_file}.tmp.$$"
    local iso_timestamp
    iso_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg timestamp "${iso_timestamp}" \
       --arg phase "${phase}" \
       '.current_phase_metadata.session_active = true |
        .current_phase_metadata.dispatched_at = $timestamp |
        .current_phase_metadata.dispatched_phase = $phase' \
       "${state_file}" > "${tmp}"
    # LEDGER-EXEMPT: status/current_phase not modified
    mv "${tmp}" "${state_file}"

    # Checkpoint
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    cp "${state_file}" "${req_dir}/checkpoint.json"

    # ── Pre-author hook emission (#561 item 1 / #568 part 2, best-effort) ─────
    # Fire the plan-pre-author / spec-pre-author hook points so plugins can
    # observe (and, in future, enrich) plan/spec authoring. NO-OP today (no
    # registered consumers); guarded for cost and fully non-blocking. Runs
    # AFTER session_active/checkpoint bookkeeping and BEFORE the review-chain
    # branch so a no-op emission never perturbs either path.
    emit_pre_author_hook "${request_id}" "${project}" "${phase}"

    # ── Reviewer-chain gate (#561/#568, FLAG-GATED, default OFF) ──────────────
    # When AUTONOMOUS_DEV_REVIEW_CHAINS=1 AND phase is code_review OR spec_review,
    # route this review through the multi-reviewer chain CLI instead of the
    # single hardcoded agent resolved above. code_review + spec_review are wired;
    # the remaining *_review phases (prd/tdd/plan) and the
    # PlanPreAuthor/SpecPreAuthor hook emission (#568 part 2) are DEFERRED.
    # SAFETY: with the flag unset/0 (the default) should_use_review_chain is
    # false, this branch is skipped, and the single-agent spawn path below runs
    # byte-for-byte as before. The session_active/dispatched_phase bookkeeping
    # set above already applies, so advance_phase reads phase-result-<phase>.
    if should_use_review_chain "${phase}"; then
        local rg_out
        rg_out=$(run_review_gate_phase "${request_id}" "${project}" "${state_file}" "${phase}")
        # Clear the session-active flag (mirrors the single-agent path's teardown).
        local rg_tmp="${state_file}.tmp.$$"
        if jq '.current_phase_metadata.session_active = false' "${state_file}" > "${rg_tmp}" 2>/dev/null; then
            mv "${rg_tmp}" "${state_file}"
        else
            rm -f "${rg_tmp}" 2>/dev/null || true
        fi
        echo "${rg_out}"
        return 0
    fi

    # Prepare output file for session
    local timestamp
    timestamp=$(date +%s)
    local output_file="${req_dir}/session-${timestamp}.txt"

    # Invoke spawn_session_typed with timeout
    local exit_code session_cost=0
    local timeout_seconds
    timeout_seconds=$(resolve_dispatch_timeout "${state_file}" "${phase}")

    # Resolve prompt using supervisor-loop.sh's rich version (includes code-phase instructions)
    local prompt_override
    prompt_override=$(resolve_phase_prompt "${phase}" "${request_id}" "${project}")

    # ── ONBOARD #597/#598: scoped runtime context (best-effort, additive) ──
    # If the target repo resolves (via ownership) to a repoId/projectId, enrich
    # this session with the scoped AGENT (override of the default), scoped
    # MEMORY, and promoted scoped SKILLS. Reset the add-dir env each dispatch so
    # a prior request's scope can never leak into this one. When the repo has no
    # scope (the common case), scope_json is empty and nothing below changes —
    # the agent, prompt, and claude flags are byte-identical to the default path.
    export AUTONOMOUS_DEV_SCOPE_ADD_DIRS=""
    local scope_json
    scope_json=$(resolve_scope_context "${project}" "${phase}" "${agent}")
    if [[ -n "${scope_json}" ]]; then
        local scoped_agent
        scoped_agent=$(echo "${scope_json}" | jq -r '.agent // empty' 2>/dev/null || echo "")
        if [[ -n "${scoped_agent}" && "${scoped_agent}" != "${agent}" ]]; then
            log_info "Scoped agent override for ${request_id}/${phase}: ${agent} -> ${scoped_agent}"
            agent="${scoped_agent}"
        fi

        local scope_appendix
        scope_appendix=$(build_scope_prompt_appendix "${scope_json}")
        if [[ -n "${scope_appendix}" ]]; then
            prompt_override="${prompt_override}

${scope_appendix}"
        fi

        # Colon-separated dirs the session needs read access to. spawn-session.sh
        # turns each existing entry into an extra --add-dir.
        local scope_add_dirs
        scope_add_dirs=$(echo "${scope_json}" | jq -r '(.addDirs // [])[]' 2>/dev/null | tr '\n' ':' || echo "")
        export AUTONOMOUS_DEV_SCOPE_ADD_DIRS="${scope_add_dirs}"
    fi

    # Snapshot working tree before session for progress detection (REQ-000051).
    local pre_tree
    pre_tree=$(snapshot_working_tree "${project}")

    # Use a subshell with explicit error handling. Wrap in `timeout`/`gtimeout`
    # when available; otherwise run directly (no wall-clock cap — see
    # resolve_timeout_bin). Exit 124 is the GNU-timeout "timed out" code.
    local timeout_bin
    timeout_bin=$(resolve_timeout_bin)
    (
        set -euo pipefail
        if [[ -n "${timeout_bin}" ]]; then
            "${timeout_bin}" --kill-after=10s "${timeout_seconds}" \
                bash "${PLUGIN_DIR}/bin/spawn-session.sh" \
                     "${state_file}" "${phase}" "${agent}" \
                     "${prompt_override}" \
            > "${output_file}" 2>&1
        else
            bash "${PLUGIN_DIR}/bin/spawn-session.sh" \
                 "${state_file}" "${phase}" "${agent}" \
                 "${prompt_override}" \
            > "${output_file}" 2>&1
        fi
    )
    exit_code=$?

    # Snapshot working tree after session for progress detection (REQ-000051).
    local post_tree
    post_tree=$(snapshot_working_tree "${project}")

    # Handle timeout case
    if [[ ${exit_code} -eq 124 ]]; then
        local result_file="${req_dir}/phase-result-${phase}.json"
        if working_tree_advanced "${pre_tree}" "${post_tree}"; then
            # Soft timeout: session timed out but working tree advanced.
            # Check whether the soft-timeout ceiling has been reached.
            local max_soft cur_soft
            max_soft=$(resolve_max_soft_timeout_reentries "${state_file}")
            cur_soft=$(jq -r '.current_phase_metadata.soft_timeout_count // 0' \
                "${state_file}" 2>/dev/null || echo "0")
            if (( cur_soft + 1 >= max_soft )); then
                log_warn "Phase ${request_id}/${phase} soft-timeout ceiling reached (${max_soft}); promoting to hard timeout"
                bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; \
                    write_synthesized_phase_result '${result_file}' 'fail' \
                    'WALL_CLOCK_TIMEOUT' '124' '${phase}'"
                emit_soft_timeout_promotion_alert \
                    "${request_id}" "${phase}" "${cur_soft}" "${project}"
                # exit_code stays 124 → existing hard-fail path runs unchanged
            else
                log_warn "Phase ${request_id}/${phase} timed out after ${timeout_seconds}s WITH progress; soft-timeout $((cur_soft + 1))/${max_soft}"
                bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; \
                    write_synthesized_phase_result '${result_file}' 'fail' \
                    'WALL_CLOCK_TIMEOUT_WITH_PROGRESS' '124' '${phase}'"
                record_soft_timeout "${request_id}" "${project}" "${phase}" \
                    "${pre_tree}" "${post_tree}" "${timeout_seconds}"
                exit_code=125  # sentinel: soft timeout; caller MUST NOT run the hard error path
                # ADR-004: 125 is assigned only here, never returned from spawn-session,
                # so a real exit-125 from the agent is impossible by construction.
            fi
        else
            log_warn "Phase ${request_id}/${phase} timed out after ${timeout_seconds}s WITHOUT progress"
            local result_file="${req_dir}/phase-result-${phase}.json"
            bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; \
                write_synthesized_phase_result '${result_file}' 'fail' \
                'WALL_CLOCK_TIMEOUT' '124' '${phase}'"
        fi
    else
        # Extract session cost from claude JSON output if available
        if [[ -f "${output_file}" ]]; then
            session_cost=$(jq -r '.total_cost_usd // .cost_usd // .result.cost_usd // 0' "${output_file}" 2>/dev/null || echo "0")
        fi
    fi

    # Belt-and-suspenders: synthesize fail result for ANY nonzero exit if no phase-result exists.
    # Exclude 124 (already handled above) and 125 (soft-timeout sentinel; result already written).
    local result_file="${req_dir}/phase-result-${phase}.json"
    if [[ ${exit_code} -ne 0 && ${exit_code} -ne 124 && ${exit_code} -ne 125 && ! -f "${result_file}" ]]; then
        log_warn "spawn-session.sh exited ${exit_code} without creating phase-result; synthesizing fail result"
        bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; write_synthesized_phase_result '${result_file}' 'fail' 'AGENT_EXITED_NONZERO' '${exit_code}' '${phase}'"
    fi

    # Clear session active flag
    jq '.current_phase_metadata.session_active = false' "${state_file}" > "${tmp}"
    mv "${tmp}" "${state_file}"

    echo "${exit_code}|${session_cost}|${output_file}"
    return ${exit_code}
}

###############################################################################
# Phase Prompt Resolution (SPEC-001-2-03 Task 5)
###############################################################################


###############################################################################
# Session Spawning (SPEC-001-2-03 Task 6)
###############################################################################

# spawn_session(request_id: string, project: string) -> string
#   Checkpoints state, builds the claude CLI command, spawns it as a
#   background process, waits for exit, and captures results.
#
# Arguments:
#   $1 -- request_id: The request ID to process.
#   $2 -- project:    Absolute path to the project/repository root.
#
# Stdout:
#   "{exit_code}|{session_cost}|{output_file}"
spawn_session() {
    local request_id="${1:-}"
    local project="${2:-}"

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"

    # Guard: state file must exist and be valid
    if ! validate_state_file "${state_file}"; then
        log_error "State file invalid or missing: ${state_file}"
        echo "1|0|"
        return
    fi

    # Read current phase (with fallback to .status for backward compatibility)
    local phase
    phase=$(jq -r '.current_phase // .status' "${state_file}")

    # Resolve max turns and phase prompt
    local max_turns phase_prompt
    max_turns=$(resolve_max_turns "${phase}")
    phase_prompt=$(resolve_phase_prompt "${phase}" "${request_id}" "${project}")

    # Checkpoint -- copy current state as recovery point
    cp "${state_file}" "${req_dir}/checkpoint.json"
    log_info "Checkpoint created for ${request_id}"

    # Mark session as active in state metadata
    local tmp="${state_file}.tmp"
    jq '.current_phase_metadata.session_active = true' "${state_file}" > "${tmp}"
    # LEDGER-EXEMPT: status/current_phase not modified
    mv "${tmp}" "${state_file}"

    # Update heartbeat with active request
    write_heartbeat "${request_id}"

    # Log the spawn
    log_info "Spawning session: request=${request_id} phase=${phase} max_turns=${max_turns}"

    # Build output file path
    local timestamp
    timestamp=$(date +%s)
    local output_file="${LOG_DIR}/session-${request_id}-${timestamp}.json"

    # Spawn the claude process
    claude \
        --print \
        --output-format json \
        --max-turns "${max_turns}" \
        --prompt "${phase_prompt}" \
        --project-directory "${project}" \
        > "${output_file}" 2>&1 &
    CURRENT_CHILD_PID=$!

    # Wait for the child process
    local exit_code=0
    wait "${CURRENT_CHILD_PID}" || exit_code=$?

    # Handle signal interruption during wait -- escalate shutdown on child
    if [[ "${SHUTDOWN_REQUESTED}" == "true" && -n "${CURRENT_CHILD_PID}" ]]; then
        log_info "Session wait interrupted by shutdown signal"
        graceful_shutdown_child
    fi
    CURRENT_CHILD_PID=""

    # Clear session active flag
    if [[ -f "${state_file}" ]]; then
        local tmp="${state_file}.tmp"
        jq '.current_phase_metadata.session_active = false' "${state_file}" > "${tmp}"
        # LEDGER-EXEMPT: status/current_phase not modified
        mv "${tmp}" "${state_file}"
    fi

    # Log exit
    log_info "Session exited: request=${request_id} exit_code=${exit_code}"

    # Parse session cost from output
    local session_cost="0"
    if [[ -f "${output_file}" ]]; then
        session_cost=$(jq -r '.cost_usd // .result.cost_usd // 0' "${output_file}" 2>/dev/null || echo "0")
    fi

    # Clear heartbeat active request
    write_heartbeat

    # Return result
    echo "${exit_code}|${session_cost}|${output_file}"
}

###############################################################################
# Crash State Persistence (SPEC-001-3-01 Task 1)
###############################################################################

# load_crash_state() -> void
#   Loads the crash counter and circuit breaker state from $CRASH_STATE_FILE.
#   If the file is missing, initializes to defaults (0 crashes, not tripped).
#   If the file is corrupt JSON, logs a warning, resets to defaults, and
#   overwrites the file.
load_crash_state() {
    if [[ -f "${CRASH_STATE_FILE}" ]]; then
        # Validate JSON before reading
        if ! jq empty "${CRASH_STATE_FILE}" 2>/dev/null; then
            log_warn "Crash state file is corrupt. Resetting to defaults."
            CONSECUTIVE_CRASHES=0
            CIRCUIT_BREAKER_TRIPPED=false
            save_crash_state
            return
        fi
        CONSECUTIVE_CRASHES=$(jq -r '.consecutive_crashes // 0' "${CRASH_STATE_FILE}")
        CIRCUIT_BREAKER_TRIPPED=$(jq -r '.circuit_breaker_tripped // false' "${CRASH_STATE_FILE}")
        log_info "Crash state loaded: consecutive_crashes=${CONSECUTIVE_CRASHES}, circuit_breaker_tripped=${CIRCUIT_BREAKER_TRIPPED}"
    else
        CONSECUTIVE_CRASHES=0
        CIRCUIT_BREAKER_TRIPPED=false
        log_info "No crash state file found. Starting fresh."
    fi
}

# save_crash_state(exit_code?: string, request_id?: string, phase?: string) -> void
#   Atomic write of the crash state to $CRASH_STATE_FILE using tmp+mv.
save_crash_state() {
    local exit_code="${1:-}"
    local request_id="${2:-}"
    local phase="${3:-}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local tmp="${CRASH_STATE_FILE}.tmp"

    jq -n \
        --argjson crashes "${CONSECUTIVE_CRASHES}" \
        --argjson tripped "${CIRCUIT_BREAKER_TRIPPED}" \
        --arg ts "${ts}" \
        --arg exit_code "${exit_code}" \
        --arg request_id "${request_id}" \
        --arg phase "${phase}" \
        '{
            consecutive_crashes: $crashes,
            circuit_breaker_tripped: $tripped,
            updated_at: $ts,
            last_crash_exit_code: (if $exit_code == "" then null else ($exit_code | tonumber? // null) end),
            last_crash_request_id: (if $request_id == "" then null else $request_id end),
            last_crash_phase: (if $phase == "" then null else $phase end)
        }' > "${tmp}"
    mv "${tmp}" "${CRASH_STATE_FILE}"
}

###############################################################################
# Circuit Breaker (SPEC-001-3-01 Task 2)
###############################################################################

# record_crash(request_id?: string, exit_code?: string) -> void
#   Increments the consecutive crash counter. If the threshold is reached,
#   trips the circuit breaker and emits an alert.
record_crash() {
    local request_id="${1:-}"
    local exit_code="${2:-}"

    CONSECUTIVE_CRASHES=$(( CONSECUTIVE_CRASHES + 1 ))
    log_error "Crash recorded. Consecutive crashes: ${CONSECUTIVE_CRASHES}/${CIRCUIT_BREAKER_THRESHOLD}"

    # Read the phase from the request's state if available
    local phase=""
    if [[ -n "${request_id}" ]]; then
        # Try to read the phase from the most recently used project
        # This is best-effort; the phase may not be resolvable here
        phase=""  # Populated by the caller context if needed
    fi

    if [[ ${CONSECUTIVE_CRASHES} -ge ${CIRCUIT_BREAKER_THRESHOLD} ]]; then
        CIRCUIT_BREAKER_TRIPPED=true
        log_error "CIRCUIT BREAKER TRIPPED after ${CONSECUTIVE_CRASHES} consecutive crashes."
        emit_alert "circuit_breaker" "Circuit breaker tripped after ${CONSECUTIVE_CRASHES} consecutive crashes. Last request: ${request_id}, exit code: ${exit_code}"
    fi

    save_crash_state "${exit_code}" "${request_id}" "${phase}"
}

# record_success() -> void
#   Resets the consecutive crash counter and clears the circuit breaker.
#   Persists the reset state to disk.
record_success() {
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    save_crash_state
    log_info "Success recorded. Crash counter reset."
}

###############################################################################
# Alert Emission (SPEC-001-3-01 Task 3)
###############################################################################

# emit_alert(alert_type: string, message: string) -> void
#   Writes a JSON alert file to $ALERTS_DIR and logs at ERROR level.
#   Alert types: circuit_breaker, retry_exhaustion, state_corruption,
#   cost_ledger_corruption, permission_violation.
emit_alert() {
    local alert_type="$1"
    local message="$2"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Ensure alerts directory exists
    mkdir -p "${ALERTS_DIR}"

    # Generate unique filename
    local alert_file="${ALERTS_DIR}/alert-${alert_type}-$(date +%s)-$$.json"

    # Write alert file atomically
    local tmp="${alert_file}.tmp"
    jq -n \
        --arg type "${alert_type}" \
        --arg msg "${message}" \
        --arg ts "${ts}" \
        --argjson pid "$$" \
        '{
            type: $type,
            message: $msg,
            timestamp: $ts,
            daemon_pid: $pid
        }' > "${tmp}"
    mv "${tmp}" "${alert_file}"

    # Also log at ERROR level
    log_error "ALERT [${alert_type}]: ${message}"
}

###############################################################################
# Per-Request Error Backoff (SPEC-001-3-02 Task 4)
###############################################################################

# compute_next_retry_after(retry_count: int) -> string
#   Computes the ISO-8601 UTC timestamp at which a request becomes retryable
#   using exponential backoff: delay = min(BASE * 2^(retry_count-1), MAX).
#
# Arguments:
#   $1 -- retry_count: Current retry count (1-based, after increment).
#
# Stdout:
#   ISO-8601 timestamp string, or empty string on date-parse failure.
compute_next_retry_after() {
    local retry_count="$1"
    local exponent=$(( retry_count - 1 ))

    # Guard against overflow: if exponent > 30, go straight to max
    if [[ ${exponent} -gt 30 ]]; then
        local future_epoch
        future_epoch=$(( $(date -u +%s) + ERROR_BACKOFF_MAX ))
        local timestamp
        timestamp=$(date -u -j -f "%s" "${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                    || date -u -d "@${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                    || echo "")
        echo "${timestamp}"
        return
    fi

    # Compute 2^exponent using bit shift
    local multiplier=1
    local i
    for (( i=0; i<exponent; i++ )); do
        multiplier=$(( multiplier * 2 ))
    done

    local delay=$(( ERROR_BACKOFF_BASE * multiplier ))
    if [[ ${delay} -gt ${ERROR_BACKOFF_MAX} ]]; then
        delay=${ERROR_BACKOFF_MAX}
    fi

    # Compute future timestamp
    local future_epoch
    future_epoch=$(( $(date -u +%s) + delay ))

    # Convert epoch to ISO-8601 UTC
    # macOS: date -u -j -f "%s" "${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ"
    # Linux: date -u -d "@${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ"
    local timestamp
    timestamp=$(date -u -j -f "%s" "${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                || date -u -d "@${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                || echo "")

    echo "${timestamp}"
}

###############################################################################
# Retry Exhaustion Escalation (SPEC-001-3-02 Task 5)
###############################################################################

# check_retry_exhaustion(request_id: string, project: string) -> int
#   Called after updating state on error. Returns 0 if retries remain, 1 if
#   exhausted (and the request has been escalated to paused).
#
# Arguments:
#   $1 -- request_id: The request ID.
#   $2 -- project:    Absolute path to the project root.
#
# Returns:
#   0 if retries remain.
#   1 if retries are exhausted (request escalated to paused).
check_retry_exhaustion() {
    local request_id="$1"
    local project="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    local retry_count status
    retry_count=$(jq -r '.current_phase_metadata.retry_count // 0' "${state_file}")
    status=$(jq -r '.status' "${state_file}")

    # SPEC-018-2-02: prefer the type-aware budget from .type_config.maxRetries.
    # Falls through to the previous .daemon.max_retries_by_phase override and
    # finally to the typed-limits hard-coded default. The existing per-phase
    # config override remains the secondary source of truth.
    local max_retries
    if [[ -f "${LIB_DIR}/typed-limits.sh" ]]; then
        # shellcheck source=lib/typed-limits.sh
        source "${LIB_DIR}/typed-limits.sh"
        # Type-aware lookup first
        local typed_max
        typed_max=$(resolve_max_retries "${state_file}")
        # Phase-specific config override wins over the typed default only
        # when explicitly set (preserves operator escape hatch).
        local phase_override
        phase_override=$(jq -r ".daemon.max_retries_by_phase.\"${status}\" // empty" \
            "${EFFECTIVE_CONFIG}" 2>/dev/null || true)
        if [[ -n "${phase_override}" && "${phase_override}" != "null" ]]; then
            max_retries="${phase_override}"
        else
            max_retries="${typed_max}"
        fi
    else
        max_retries=$(jq -r ".daemon.max_retries_by_phase.\"${status}\" // .daemon.max_retries_per_phase // 3" "${EFFECTIVE_CONFIG}" 2>/dev/null)
        if [[ "${max_retries}" == "null" || -z "${max_retries}" ]]; then
            max_retries="${MAX_RETRIES_PER_PHASE}"
        fi
    fi

    if [[ ${retry_count} -ge ${max_retries} ]]; then
        local req_type
        req_type=$(jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature")
        # Contract regex (SPEC-018-2-02 §Escalation Message Format):
        # Phase '[a-z_]+' (exceeded timeout|exhausted retries) \(.*type=...\)
        log_warn "Phase '${status}' exhausted retries (limit=${max_retries}, type=${req_type})"
        escalate_to_paused "${request_id}" "${project}" "${status}" "${retry_count}"
        return 1
    fi

    return 0
}

###############################################################################
# Type-Aware Phase-Timeout Enforcement (SPEC-018-2-02)
###############################################################################

# check_phase_timeout(request_id: string, project: string) -> int
#   Compares (now - .phase_started_at) against resolve_phase_timeout for
#   the current phase. If exceeded, raises a contract-format escalation
#   message and returns 1 (caller should `continue` the supervisor loop).
#   Returns 0 when the phase is within budget OR when phase_started_at is
#   absent (no clock to compare against).
check_phase_timeout() {
    local request_id="$1"
    local project="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    [[ -f "${state_file}" ]] || return 0

    local started
    started=$(jq -r '.phase_started_at // empty' "${state_file}" 2>/dev/null || true)
    [[ -n "${started}" && "${started}" != "null" ]] || return 0

    # Allow either an integer epoch second or an ISO-8601 string.
    local started_epoch
    if [[ "${started}" =~ ^[0-9]+$ ]]; then
        started_epoch="${started}"
    else
        started_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${started}" +%s 2>/dev/null \
                        || date -u -d "${started}" +%s 2>/dev/null \
                        || echo "")
        [[ -n "${started_epoch}" ]] || return 0
    fi

    if [[ ! -f "${LIB_DIR}/typed-limits.sh" ]]; then
        return 0
    fi
    # shellcheck source=lib/typed-limits.sh
    source "${LIB_DIR}/typed-limits.sh"

    local current_phase
    current_phase=$(jq -r '.current_phase // .status // ""' "${state_file}" 2>/dev/null || true)
    [[ -n "${current_phase}" ]] || return 0

    local timeout
    timeout=$(resolve_phase_timeout "${state_file}" "${current_phase}")

    local now_epoch
    now_epoch=$(date -u +%s)
    local elapsed=$(( now_epoch - started_epoch ))

    if (( elapsed > timeout )); then
        local req_type
        req_type=$(resolve_request_type "${state_file}")
        # Contract regex (SPEC-018-2-02 §Escalation Message Format)
        log_warn "Phase '${current_phase}' exceeded timeout (${timeout} seconds, type=${req_type})"
        return 1
    fi

    return 0
}

# escalate_to_paused(request_id: string, project: string, phase: string, retry_count: int) -> void
#   Transitions a request to paused status due to retry exhaustion.
#   Writes the paused reason into state, appends a retry_exhaustion event,
#   and emits an alert.
escalate_to_paused() {
    local request_id="$1"
    local project="$2"
    local phase="$3"
    local retry_count="$4"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Transition to paused
    local tmp="${state_file}.tmp"
    jq --arg ts "${ts}" \
        --arg reason "Retry exhaustion in phase ${phase}" \
        '
        .status = "paused" |
        .current_phase_metadata.paused_reason = $reason |
        .current_phase_metadata.paused_at = $ts |
        .updated_at = $ts
        ' "${state_file}" > "${tmp}"
    mv "${tmp}" "${state_file}"

    # NEW (REQ-000014 FR-A1, ADR-3): read current_phase for ledger mirror.
    # Use the authoritative state.json value post-mv; fall back to caller-supplied
    # phase if state.json is malformed or current_phase is absent.
    local current_phase
    current_phase=$(jq -r '.current_phase // empty' "${state_file}" 2>/dev/null || echo "")
    if [[ -z "${current_phase}" ]]; then
        current_phase="${phase}"
    fi

    # Append escalation event
    local event
    event=$(jq -n \
        --arg ts "${ts}" \
        --arg req "${request_id}" \
        --arg phase "${phase}" \
        --argjson retries "${retry_count}" \
        '{
            timestamp: $ts,
            type: "retry_exhaustion",
            request_id: $req,
            details: {
                phase: $phase,
                retry_count: $retries,
                escalated_to: "paused"
            }
        }')
    echo "${event}" >> "${events_file}"

    # NEW (REQ-000014 FR-A1, FR-A2, FR-A3): mirror state.json into intake.db.
    # Non-fatal by contract; sync_intake_db_row always returns 0 and logs every
    # failure mode (ERROR/WARN/INFO).
    sync_intake_db_row "${request_id}" "${current_phase}" "paused" "${ts}"

    # Emit alert
    emit_alert "retry_exhaustion" "Request ${request_id} paused after ${retry_count} retries in phase '${phase}'"

    log_error "Request ${request_id} escalated to PAUSED (retry exhaustion in ${phase})"
}

# check_per_request_cost_cap(request_id: string, project: string) -> void
#   PRD-025 FR-025-11 (PRD-001 FR-503). Called after a session's cost has been
#   recorded. If the request's accumulated `cost_accrued_usd` has reached the
#   configured per-request cap, pause the request and escalate so a single
#   runaway request can't consume the whole daily/monthly budget. No-op for
#   requests already in a terminal/paused state.
check_per_request_cost_cap() {
    local request_id="$1"
    local project="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    [[ -f "${state_file}" ]] || return 0

    local accrued status
    accrued=$(jq -r '.cost_accrued_usd // 0' "${state_file}" 2>/dev/null || echo "0")
    status=$(jq -r '.status // ""' "${state_file}" 2>/dev/null || echo "")
    case "${status}" in done|cancelled|failed|paused) return 0 ;; esac

    # Numeric, cap-aware comparison (awk handles floats; bash [[ ]] does not).
    if ! awk "BEGIN {exit !(${accrued} >= ${PER_REQUEST_COST_CAP})}" 2>/dev/null; then
        return 0
    fi

    local phase ts tmp events_file
    phase=$(jq -r '.current_phase // "unknown"' "${state_file}" 2>/dev/null || echo "unknown")
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    tmp="${state_file}.tmp.$$"
    if jq --arg ts "${ts}" \
          --arg reason "Per-request cost cap reached (\$${accrued} >= \$${PER_REQUEST_COST_CAP})" \
          '.status = "paused"
           | .current_phase_metadata.paused_reason = $reason
           | .current_phase_metadata.paused_at = $ts
           | .updated_at = $ts' \
          "${state_file}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${state_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
        log_warn "Failed to pause ${request_id} after per-request cost cap"
        return 0
    fi

    events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"
    jq -nc --arg ts "${ts}" --arg req "${request_id}" --arg phase "${phase}" \
           --argjson accrued "${accrued}" --argjson cap "${PER_REQUEST_COST_CAP}" \
           '{timestamp:$ts, type:"cost_cap_exceeded", request_id:$req,
             details:{phase:$phase, scope:"per_request",
                      cost_accrued_usd:$accrued, per_request_cap_usd:$cap,
                      escalated_to:"paused"}}' >> "${events_file}" 2>/dev/null || true

    emit_alert "per_request_cost_cap" "Request ${request_id} paused: cost \$${accrued} reached per-request cap \$${PER_REQUEST_COST_CAP}"
    log_warn "Per-request cost cap reached for ${request_id}: \$${accrued} >= \$${PER_REQUEST_COST_CAP}. Request paused."
}

###############################################################################
# Turn Budget Exhaustion Detection (SPEC-001-3-02 Task 6)
###############################################################################

# detect_turn_exhaustion(exit_code: int, output_file: string) -> int
#   Checks whether a session ended due to turn budget exhaustion.
#   Returns 0 if turn exhaustion detected, 1 otherwise.
#
# Arguments:
#   $1 -- exit_code:   The session process exit code.
#   $2 -- output_file: Path to the session output JSON file.
#
# Returns:
#   0 if turn exhaustion is detected.
#   1 otherwise.
detect_turn_exhaustion() {
    local exit_code="$1"
    local output_file="$2"

    # Check exit code 2 (conventional for max-turns-reached)
    if [[ ${exit_code} -eq 2 ]]; then
        return 0
    fi

    # Check output for max_turns_reached indicator
    if [[ -f "${output_file}" ]]; then
        local reason
        reason=$(jq -r '.reason // .result.reason // ""' "${output_file}" 2>/dev/null || echo "")
        if [[ "${reason}" == "max_turns_reached" ]]; then
            return 0
        fi
    fi

    return 1
}

###############################################################################
# Idle Backoff
###############################################################################

# idle_backoff_sleep() -> void
#   Sleeps with exponential backoff when no work is found.
#
#   BUG-20 fix: chunk the long backoff into HEARTBEAT_INTERVAL slices and
#   re-write the heartbeat between each one. Without this, an idle daemon
#   at max backoff (900s) only refreshes the heartbeat once every 15 min,
#   which the portal correctly classifies as "dead". The total wait is
#   still IDLE_BACKOFF_CURRENT — we just advertise liveness during it.
idle_backoff_sleep() {
    local remaining=${IDLE_BACKOFF_CURRENT}
    local chunk=${HEARTBEAT_INTERVAL}
    log_info "No actionable work. Sleeping ${remaining}s (${chunk}s heartbeat chunks)."
    while (( remaining > 0 )); do
        local this_chunk=${chunk}
        if (( remaining < chunk )); then
            this_chunk=${remaining}
        fi
        sleep "${this_chunk}" &
        local sleep_pid=$!
        wait "${sleep_pid}" 2>/dev/null || true
        if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
            return
        fi
        remaining=$(( remaining - this_chunk ))
        # Re-write heartbeat so portal/operators see daemon is alive even
        # while it's resting on long backoff.
        write_heartbeat
    done
    IDLE_BACKOFF_CURRENT=$(( IDLE_BACKOFF_CURRENT * 2 ))
    if [[ ${IDLE_BACKOFF_CURRENT} -gt ${IDLE_BACKOFF_MAX} ]]; then
        IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_MAX}
    fi
}

# idle_backoff_reset() -> void
#   Resets the idle backoff to its base value after work is found.
idle_backoff_reset() {
    IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_BASE}
}

###############################################################################
# Log Rotation (SPEC-001-3-04 Task 11)
###############################################################################

# rotate_logs_if_needed() -> void
#   Size-based rotation called at the end of each loop iteration.
#   Rotation chain: daemon.log.2 is deleted, daemon.log.1 -> daemon.log.2,
#   daemon.log -> daemon.log.1, fresh daemon.log created.
rotate_logs_if_needed() {
    if [[ ! -f "${LOG_FILE}" ]]; then
        return
    fi

    # Get file size in bytes
    local size_bytes
    if [[ "$(uname)" == "Darwin" ]]; then
        size_bytes=$(stat -f%z "${LOG_FILE}" 2>/dev/null || echo "0")
    else
        size_bytes=$(stat -c%s "${LOG_FILE}" 2>/dev/null || echo "0")
    fi

    local max_bytes=$(( LOG_MAX_SIZE_MB * 1024 * 1024 ))

    if [[ ${size_bytes} -ge ${max_bytes} ]]; then
        log_info "Log rotation triggered: ${LOG_FILE} is ${size_bytes} bytes (max ${max_bytes})"

        # Rotate: daemon.log.2 is deleted, daemon.log.1 -> daemon.log.2, daemon.log -> daemon.log.1
        rm -f "${LOG_FILE}.2"
        if [[ -f "${LOG_FILE}.1" ]]; then
            mv "${LOG_FILE}.1" "${LOG_FILE}.2"
        fi
        mv "${LOG_FILE}" "${LOG_FILE}.1"

        # Create a fresh log file
        touch "${LOG_FILE}"

        log_info "Log rotation complete. Previous log: ${LOG_FILE}.1"
    fi
}

# cleanup_old_logs() -> void
#   Age-based cleanup of old log files and session output files.
#   Removes files older than LOG_RETENTION_DAYS.
cleanup_old_logs() {
    local retention_days="${LOG_RETENTION_DAYS:-7}"

    # Clean up rotated daemon logs older than retention
    if [[ "$(uname)" == "Darwin" ]]; then
        find "${LOG_DIR}" -name "daemon.log.*" -mtime "+${retention_days}" -delete 2>/dev/null || true
        find "${LOG_DIR}" -name "session-*.json" -mtime "+${retention_days}" -delete 2>/dev/null || true
        find "${LOG_DIR}" -name "launchd-*.log" -mtime "+${retention_days}" -delete 2>/dev/null || true
    else
        find "${LOG_DIR}" -name "daemon.log.*" -mtime "+${retention_days}" -delete 2>/dev/null || true
        find "${LOG_DIR}" -name "session-*.json" -mtime "+${retention_days}" -delete 2>/dev/null || true
    fi

    log_info "Log cleanup complete (retention: ${retention_days} days)"
}

###############################################################################
# Post-Session State Update (SPEC-001-2-04 Task 7)
###############################################################################

# update_request_state(request_id, project, outcome, session_cost, exit_code?) -> void
#   Updates state.json and appends to events.jsonl after a Claude session
#   completes. Handles both success and error outcomes.
#
# Arguments:
#   $1 -- request_id:   The request ID (e.g., "REQ-20260408-abcd").
#   $2 -- project:      Absolute path to the project root.
#   $3 -- outcome:      Either "success" or "error".
#   $4 -- session_cost: Cost in USD as a decimal string (e.g., "2.50").
#   $5 -- exit_code:    (Optional) The exit code on error (e.g., "1", "2").
#
# Side effects:
#   - Atomically updates {project}/.autonomous-dev/requests/{request_id}/state.json
#   - Appends a JSONL event to {project}/.autonomous-dev/requests/{request_id}/events.jsonl
update_request_state() {
    local request_id="$1"
    local project="$2"
    local outcome="$3"
    local session_cost="$4"
    local exit_code="${5:-unknown}"

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local state_file="${req_dir}/state.json"
    local events_file="${req_dir}/events.jsonl"

    # Validate session_cost is numeric; default to 0 if not
    if ! echo "${session_cost}" | jq -e 'tonumber' >/dev/null 2>&1; then
        log_warn "Non-numeric session_cost '${session_cost}', defaulting to 0"
        session_cost="0"
    fi

    # Validate state file before updating
    if ! validate_state_file "${state_file}"; then
        log_error "Cannot update state for ${request_id}: state file invalid"
        return 1
    fi

    # Read current state
    local current_state
    current_state=$(cat "${state_file}")

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [[ "${outcome}" == "success" ]]; then
        # --- Success Path ---
        # Update current_phase_metadata and accumulate cost
        local tmp="${state_file}.tmp"
        echo "${current_state}" | jq \
            --arg ts "${ts}" \
            --arg cost "${session_cost}" \
            '
            .current_phase_metadata.last_session_completed_at = $ts |
            .current_phase_metadata.session_active = false |
            .current_phase_metadata.retry_count = 0 |
            .current_phase_metadata.last_error = null |
            .cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber)) |
            .updated_at = $ts
            ' > "${tmp}"
        # LEDGER-EXEMPT: status/current_phase not modified
        mv "${tmp}" "${state_file}"

        # Append session_complete event
        local event
        event=$(jq -n \
            --arg ts "${ts}" \
            --arg req "${request_id}" \
            --arg type "session_complete" \
            --arg cost "${session_cost}" \
            '{
                timestamp: $ts,
                type: $type,
                request_id: $req,
                details: {
                    session_cost_usd: ($cost | tonumber),
                    exit_code: 0
                }
            }')
        echo "${event}" >> "${events_file}"

        log_info "State updated: request=${request_id} outcome=success cost=${session_cost}"
    else
        # --- Error Path ---

        # Sentinel-125: soft timeout with progress (REQ-000051 / ADR-004).
        # record_soft_timeout() already mutated state.json and appended
        # events.jsonl. All we need here is to accrue the session cost so
        # the per-request and daily/monthly budgets stay accurate.
        if [[ "${exit_code:-0}" -eq 125 ]]; then
            local tmp_soft="${state_file}.tmp"
            jq \
                --arg cost "${session_cost}" \
                '.cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber))' \
                "${state_file}" > "${tmp_soft}" 2>/dev/null \
                && mv "${tmp_soft}" "${state_file}" \
                || rm -f "${tmp_soft}" 2>/dev/null || true
            log_info "State updated: request=${request_id} outcome=soft_timeout"
            return 0
        fi

        # Increment retry_count and record last_error
        local tmp="${state_file}.tmp"
        echo "${current_state}" | jq \
            --arg ts "${ts}" \
            --arg cost "${session_cost}" \
            --arg exit_code "${exit_code}" \
            '
            .current_phase_metadata.retry_count = ((.current_phase_metadata.retry_count // 0) + 1) |
            .current_phase_metadata.last_error = ("Session exited with code " + $exit_code) |
            .current_phase_metadata.last_error_at = $ts |
            .current_phase_metadata.session_active = false |
            .cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber)) |
            .updated_at = $ts
            ' > "${tmp}"
        # LEDGER-EXEMPT: status/current_phase not modified
        mv "${tmp}" "${state_file}"

        # Compute and write next_retry_after (SPEC-001-3-02 Task 4)
        local new_retry_count
        new_retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")
        local next_retry
        next_retry=$(compute_next_retry_after "${new_retry_count}")

        if [[ -n "${next_retry}" ]]; then
            local tmp2="${state_file}.tmp"
            jq --arg nra "${next_retry}" \
                '.current_phase_metadata.next_retry_after = $nra' "${state_file}" > "${tmp2}"
            # LEDGER-EXEMPT: status/current_phase not modified
            mv "${tmp2}" "${state_file}"
            log_info "Request ${request_id} backoff until ${next_retry} (retry ${new_retry_count})"
        fi

        # Append session_error event
        local event
        event=$(jq -n \
            --arg ts "${ts}" \
            --arg req "${request_id}" \
            --arg type "session_error" \
            --arg cost "${session_cost}" \
            --arg exit_code "${exit_code}" \
            '{
                timestamp: $ts,
                type: $type,
                request_id: $req,
                details: {
                    session_cost_usd: ($cost | tonumber),
                    exit_code: ($exit_code | tonumber? // $exit_code),
                    error: ("Session exited with code " + $exit_code)
                }
            }')
        echo "${event}" >> "${events_file}"

        log_warn "State updated: request=${request_id} outcome=error exit_code=${exit_code} retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")"
    fi
}

###############################################################################
# Portal Request Action Writer (SPEC-039-3-01, SPEC-039-3-02)
###############################################################################

# write_portal_request_action(request_id, project) -> int
#   Reads state.json for the given request and writes a portal-facing JSON file
#   at ${PORTAL_REQUEST_ACTIONS_DIR}/<request_id>.json. Computes waitedMin for
#   gated requests. Returns 0 on success, 0 on tolerated errors (missing state).
write_portal_request_action() {
    local request_id="$1"
    local project="$2"

    if ! validate_request_id "$request_id"; then
        log_warn "Invalid request ID in write_portal_request_action: $request_id"
        return 0
    fi

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local out_file="${PORTAL_REQUEST_ACTIONS_DIR}/${request_id}.json"
    local tmp_file="${out_file}.tmp.$$"

    # Ensure portal directory exists
    mkdir -p "${PORTAL_REQUEST_ACTIONS_DIR}"

    # Check if state.json exists and is readable
    if [[ ! -f "$state_file" ]]; then
        log_warn "State file missing for $request_id, writing minimal cancelled action"
        # Write minimal cancelled action for reconcile_orphans case
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n \
            --arg id "$request_id" \
            --arg ts "$ts" \
            '{
                id: $id,
                status: "cancelled",
                completedAt: $ts
            }' > "$tmp_file"
        mv "$tmp_file" "$out_file"
        return 0
    fi

    # Compute waitedMin for gated requests (SPEC-039-3-02)
    local waited_min=0
    local status
    status=$(jq -r '.status // ""' "$state_file" 2>/dev/null || echo "")

    if [[ "$status" == "gate" ]]; then
        local gate_entered_at
        gate_entered_at=$(jq -r '.current_phase_metadata.gate_entered_at // ""' "$state_file" 2>/dev/null || echo "")

        if [[ -n "$gate_entered_at" ]]; then
            local now_epoch entered_epoch
            now_epoch=$(date +%s)

            # Parse ISO-8601 timestamp to epoch seconds
            # Try multiple approaches for cross-platform compatibility

            # Method 1: Try GNU date (Linux)
            if entered_epoch=$(date -d "$gate_entered_at" +%s 2>/dev/null); then
                waited_min=$(( (now_epoch - entered_epoch) / 60 ))
            # Method 2: Try gdate (macOS with GNU coreutils)
            elif entered_epoch=$(gdate -d "$gate_entered_at" +%s 2>/dev/null); then
                waited_min=$(( (now_epoch - entered_epoch) / 60 ))
            # Method 3: Use Node.js for cross-platform parsing.
            # Passes the timestamp via argv to avoid string interpolation
            # into JS source (untrusted state.json content otherwise
            # could break out of the literal and execute code).
            elif command -v node >/dev/null 2>&1 && entered_epoch=$(node -e "const d=new Date(process.argv[1]); if(isNaN(d.getTime()))process.exit(1); console.log(Math.floor(d.getTime()/1000))" "$gate_entered_at" 2>/dev/null) && [[ "$entered_epoch" =~ ^[0-9]+$ ]]; then
                waited_min=$(( (now_epoch - entered_epoch) / 60 ))
            else
                # All parsing methods failed, leave waited_min as 0
                log_warn "Failed to parse gate_entered_at timestamp: $gate_entered_at"
                waited_min=0
            fi

            # Ensure non-negative
            if [[ "$waited_min" -lt 0 ]]; then
                waited_min=0
            fi
        fi
    fi

    # Extract and transform fields from state.json
    local repo_basename
    repo_basename=$(basename "$project")

    # Build the portal action file using jq with safe field extraction
    jq -n \
        --arg id "$(jq -r '.id // ""' "$state_file" 2>/dev/null || echo "$request_id")" \
        --arg repo "$repo_basename" \
        --arg title "$(jq -r '.title // ""' "$state_file" 2>/dev/null || echo "")" \
        --arg phase "$(jq -r '.current_phase // ""' "$state_file" 2>/dev/null | tr '[:lower:]' '[:upper:]')" \
        --arg status "$status" \
        --argjson cost "$(jq -r '.cost_accrued_usd // 0' "$state_file" 2>/dev/null || echo "0")" \
        --arg variant "$(jq -r '.variant // ""' "$state_file" 2>/dev/null || echo "")" \
        --arg created_at "$(jq -r '.created_at // ""' "$state_file" 2>/dev/null || echo "")" \
        --argjson waited_min "$waited_min" \
        --argjson turns "$(jq -r '.turn_count // 0' "$state_file" 2>/dev/null || echo "0")" \
        '{
            id: $id,
            repo: $repo,
            title: $title,
            phase: $phase,
            status: $status,
            cost: $cost,
            variant: $variant,
            createdAt: $created_at,
            waitedMin: $waited_min,
            turns: $turns
        }' > "$tmp_file"

    # Add completedAt for terminal statuses
    if [[ "$status" == "done" || "$status" == "cancelled" || "$status" == "failed" ]]; then
        local completed_at
        completed_at=$(jq -r '.updated_at // ""' "$state_file" 2>/dev/null || echo "")
        if [[ -n "$completed_at" ]]; then
            # Add completedAt field to the existing JSON
            jq --arg completed_at "$completed_at" '. + {completedAt: $completed_at}' "$tmp_file" > "${tmp_file}.2"
            mv "${tmp_file}.2" "$tmp_file"
        fi
    fi

    # Add score if present
    local score
    score=$(jq -r '.score // empty' "$state_file" 2>/dev/null || echo "")
    if [[ -n "$score" ]]; then
        jq --argjson score "$score" '. + {score: $score}' "$tmp_file" > "${tmp_file}.2"
        mv "${tmp_file}.2" "$tmp_file"
    fi

    # Atomic rename
    mv "$tmp_file" "$out_file"

    return 0
}

# write_gate_decision(request_id, project, phase) -> int
#   Writes a gate decision file for portal /approvals consumption.
#   Returns 0 on success or tolerated errors (defensive - never crashes daemon).
write_gate_decision() {
    local request_id="$1"
    local project="$2"
    local phase="$3"

    if ! validate_request_id "$request_id"; then
        log_warn "Invalid request ID in write_gate_decision: $request_id"
        return 0
    fi

    local repo_basename
    repo_basename=$(basename "$project")
    local out_file="${GATE_DECISIONS_DIR}/${repo_basename}__${request_id}.json"
    local tmp_file="${out_file}.tmp.$$"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Ensure gate decisions directory exists
    mkdir -p "${GATE_DECISIONS_DIR}" 2>/dev/null || {
        log_warn "Failed to create gate decisions directory: $GATE_DECISIONS_DIR"
        return 0
    }

    # Write gate decision file with defensive error handling
    if ! jq -n \
        --arg id "$request_id" \
        --arg repo "$repo_basename" \
        --arg phase "$phase" \
        --arg state "pending" \
        --arg entered_at "$ts" \
        '{
            id: $id,
            repo: $repo,
            phase: $phase,
            state: $state,
            waitedMin: 0,
            gate_entered_at: $entered_at
        }' > "$tmp_file" 2>/dev/null; then
        log_warn "Failed to write gate decision file for $request_id"
        rm -f "$tmp_file" 2>/dev/null || true
        return 0
    fi

    # Atomic rename with error handling
    if ! mv "$tmp_file" "$out_file" 2>/dev/null; then
        log_warn "Failed to move gate decision file for $request_id"
        rm -f "$tmp_file" 2>/dev/null || true
        return 0
    fi

    return 0
}

# update_state_cost(request_id, project, session_cost) -> void
#   Adds session_cost to state.json.cost_accrued_usd atomically.
#   Defensive - does not crash daemon on errors.
update_state_cost() {
    local request_id="$1"
    local project="$2"
    local session_cost="$3"

    if ! validate_request_id "$request_id"; then
        log_warn "Invalid request ID in update_state_cost: $request_id"
        return 0
    fi

    # Validate session_cost is numeric
    if ! echo "${session_cost}" | jq -e 'tonumber' >/dev/null 2>&1; then
        log_warn "Non-numeric session_cost '${session_cost}' in update_state_cost, defaulting to 0"
        session_cost="0"
    fi

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    if [[ ! -f "$state_file" ]]; then
        log_warn "State file missing in update_state_cost: $state_file"
        return 0
    fi

    local tmp="${state_file}.tmp.$$"

    # Add session cost to cost_accrued_usd atomically
    if ! jq --argjson cost "${session_cost}" \
        '.cost_accrued_usd = ((.cost_accrued_usd // 0) + $cost)' \
        "$state_file" > "$tmp" 2>/dev/null; then
        log_warn "Failed to update cost in state file for request $request_id"
        rm -f "$tmp" 2>/dev/null || true
        return 0
    fi

    # LEDGER-EXEMPT: status/current_phase not modified
    if ! mv "$tmp" "$state_file" 2>/dev/null; then
        log_warn "Failed to move updated state file for request $request_id"
        rm -f "$tmp" 2>/dev/null || true
        return 0
    fi

    return 0
}

###############################################################################
# Intake DB Ledger Mirror (REQ-000013)
###############################################################################

# map_state_status_to_intake(state_status) -> echoes mapped intake status; rc 0/1
#   Pure function. No side effects. No I/O. No logging.
#   Maps a state.json status vocabulary token to the intake.db CHECK-constrained
#   vocabulary. Any unmapped value echoes "" and returns 1.
#   queued        -> "queued"
#   running|gate  -> "active"
#   paused        -> "paused"
#   done          -> "done"
#   failed        -> "failed"
#   <anything>    -> echo "" ; return 1
map_state_status_to_intake() {
    local s="$1"
    case "$s" in
        queued)        echo "queued" ;;
        running|gate)  echo "active" ;;
        paused)        echo "paused" ;;
        done)          echo "done"   ;;
        failed)        echo "failed" ;;
        *)             echo ""; return 1 ;;
    esac
    return 0
}

# ─── AUDIT REFERENCE ───────────────────────────────────────────────────────
# Every state.json writer in this file that mutates `.status` or
# `.current_phase` MUST call this helper. See docs/triage/state-json-writers.md
# for the canonical writer audit (MIRROR / EXEMPT / OUT_OF_SCOPE).
# Adding a new state.json writer? Update that audit and either call this
# helper or document the exemption inline.
# ───────────────────────────────────────────────────────────────────────────
# sync_intake_db_row(request_id, phase, state_status, ts) -> always returns 0
#   Best-effort, non-fatal mirror of a state.json transition into intake.db.
#   Logs exactly one terminal line on every path. Never aborts the caller.
#   Parameters:
#     $1 request_id   - Request ID (e.g. REQ-000013). Single-quote-escaped before binding.
#     $2 phase        - Phase name written to current_phase verbatim (free-form TEXT).
#     $3 state_status - A state.json status; mapped via map_state_status_to_intake.
#     $4 ts           - ISO-8601 UTC timestamp (%Y-%m-%dT%H:%M:%SZ). Written to updated_at.
sync_intake_db_row() {
    local request_id="$1" phase="$2" state_status="$3" ts="$4"

    # 1) sqlite3 must be available.
    if ! command -v sqlite3 >/dev/null 2>&1; then
        log_error "sync_intake_db_row: sqlite3 CLI not found; cannot mirror ${request_id} -> ${phase}"
        return 0
    fi

    # 2) DB file must exist.
    if [[ ! -f "$INTAKE_DB" ]]; then
        log_warn "sync_intake_db_row: ${INTAKE_DB} not present; skipping ledger update for ${request_id}"
        return 0
    fi

    # 3) Map status; skip on unmapped/empty.
    local mapped
    if ! mapped=$(map_state_status_to_intake "$state_status") || [[ -z "$mapped" ]]; then
        log_error "sync_intake_db_row: unmapped state status '${state_status}' for ${request_id}; not writing ledger"
        return 0
    fi

    # 4) Parameter-bound UPDATE + changes() in one connection.
    #    Values are double-quote-escaped and bound via double-quoted SQL strings
    #    in .parameter set. Double-quoting handles apostrophes in values (e.g.
    #    REQ-O'BRIEN) that confuse the sqlite3 CLI when single-quoted. Real
    #    request IDs and phase names are alphanumeric so neither ' nor " appear
    #    in practice; the escaping is defense-in-depth.
    #    Use "cmd && rc=0 || rc=$?" to capture the exit code safely under
    #    set -euo pipefail: the &&/|| list context suppresses errexit so the
    #    function does not abort when sqlite3 returns non-zero.
    local rid="${request_id//\"/\"\"}"
    local ph="${phase//\"/\"\"}"
    local update_out rc=0
    update_out=$(sqlite3 "$INTAKE_DB" <<SQL 2>&1
.parameter set :rid "${rid}"
.parameter set :phase "${ph}"
.parameter set :status "${mapped}"
.parameter set :ts "${ts}"
UPDATE requests
   SET current_phase = :phase,
       status        = :status,
       updated_at    = :ts
 WHERE request_id = :rid;
SELECT changes();
SQL
) && rc=0 || rc=$?

    # 5) Non-zero exit -> ERROR, non-fatal.
    if [[ $rc -ne 0 ]]; then
        log_error "sync_intake_db_row: sqlite3 UPDATE failed for ${request_id} -> (${phase}, ${mapped}); rc=${rc}; out=${update_out}"
        return 0
    fi

    # 6) Zero-row match -> WARN.
    local changed
    changed=$(printf '%s\n' "$update_out" | tail -n1)
    if [[ "$changed" == "0" ]]; then
        log_warn "sync_intake_db_row: 0 rows updated for ${request_id} (no ledger row?) -> (${phase}, ${mapped})"
        return 0
    fi

    # 7) Success.
    log_info "sync_intake_db_row: ledger updated ${request_id} -> (${phase}, ${mapped})"
    return 0
}

###############################################################################
# Trust-Gated PR Merge (#487)
###############################################################################

# resolve_effective_trust(repo_path) -> echoes integer 0..3 (always exit 0)
#   Resolves the effective trust level for a repository from CONFIG_FILE
#   (~/.claude/autonomous-dev.json), mirroring the precedence of the TS
#   resolver in src/trust/trust-resolver.ts but using the live config schema
#   exercised by consume_config_changes (#507):
#
#     1. trust.per_repo_overrides[<repo_path>]   (per-repo override)
#     2. trust.system_default_level              (system default)
#     3. 0                                        (hardcoded fallback)
#
#   The per-repo value may be either a bare integer (e.g. 3) or an object with
#   a `default_level` field (the shape the TS RepositoryTrustConfig uses); both
#   are accepted. Any value outside 0..3, a missing config, or unparseable JSON
#   falls through to the next tier and ultimately to 0.
#
#   This is replicated in bash (no `node` shell-out) because the daemon loop is
#   bash and runs this on the hot path. The fallback is 0 — the most restrictive
#   level — so that a missing/corrupt config NEVER yields auto-merge authority.
#
#   Pure read; never mutates config or state.
resolve_effective_trust() {
    local repo_path="${1:-}"

    # Validate an integer is in 0..3; echo it and succeed, else fail.
    _trust_is_valid_level() {
        local v="$1"
        [[ "$v" =~ ^[0-3]$ ]]
    }

    # No config file -> conservative fallback.
    if [[ -z "${CONFIG_FILE:-}" || ! -f "${CONFIG_FILE}" ]]; then
        echo "0"
        return 0
    fi

    # Tier 1: per-repo override. Accept either a bare integer or {default_level}.
    # jq returns "null" when the key/path is absent or the file is unparseable
    # (2>/dev/null + `// empty` collapse both to empty).
    local per_repo
    per_repo=$(jq -r --arg p "${repo_path}" '
        (.trust.per_repo_overrides[$p]) as $o
        | if   ($o | type) == "number" then ($o | tostring)
          elif ($o | type) == "object" and (($o.default_level | type) == "number")
               then ($o.default_level | tostring)
          else empty end
        ' "${CONFIG_FILE}" 2>/dev/null || echo "")
    if _trust_is_valid_level "${per_repo}"; then
        echo "${per_repo}"
        return 0
    fi

    # Tier 2: system default.
    local sys_default
    sys_default=$(jq -r '
        (.trust.system_default_level) as $s
        | if ($s | type) == "number" then ($s | tostring) else empty end
        ' "${CONFIG_FILE}" 2>/dev/null || echo "")
    if _trust_is_valid_level "${sys_default}"; then
        echo "${sys_default}"
        return 0
    fi

    # Tier 3: hardcoded conservative fallback.
    echo "0"
    return 0
}

# read_request_pr_url(project, request_id) -> echoes PR URL or empty (always 0)
#   The PR URL is recorded by the `code` phase in phase-result-code.json's
#   artifacts[] with kind == "github_pr" (.url preferred, else .path). The
#   `integration` phase has no artifact of its own, so the merge gate reads the
#   code phase's result. Returns the FIRST github_pr artifact's URL. Empty when
#   the file is missing, has no such artifact, or is unparseable.
read_request_pr_url() {
    local project="$1" request_id="$2"
    local result_code="${project}/.autonomous-dev/requests/${request_id}/phase-result-code.json"
    [[ -f "${result_code}" ]] || { echo ""; return 0; }
    jq -r '
        ([.artifacts[]? | select((.kind // "") == "github_pr")]
         | .[0] // {}) as $a
        | ($a.url // $a.path // "")
        ' "${result_code}" 2>/dev/null || echo ""
}

# ===========================================================================
# Merge-gate helpers (REQ-000053): G1-G4 gates for order-aware auto-merge.
# All helpers are pure (read-only) except where noted. None are exported.
# ===========================================================================

# _pr_branch_up_to_date(project, pr_url) -> rc
#   Inputs : project (path), pr_url (string).
#   Returns: 0 when the PR branch IS up-to-date with origin/<base>;
#            1 when behind;
#            2 when status could not be determined (treat as "unknown").
#   Reads  : `gh pr view --json baseRefName,headRefName,headRefOid`
#            and `git merge-base --is-ancestor` for ancestor check.
#   Side effects: none (read-only against gh + local refs).
_pr_branch_up_to_date() {
    local project="$1" pr_url="$2"
    local refs_json base_ref head_oid
    refs_json=$( (cd "${project}" 2>/dev/null && \
        gh pr view "${pr_url}" \
            --json baseRefName,headRefName,headRefOid \
            < /dev/null 2>/dev/null) || echo "")
    if [[ -z "${refs_json}" ]] || ! echo "${refs_json}" | jq empty 2>/dev/null; then
        return 2
    fi
    base_ref=$(echo "${refs_json}" | jq -r '.baseRefName // ""' 2>/dev/null || echo "")
    head_oid=$(echo "${refs_json}" | jq -r '.headRefOid // ""' 2>/dev/null || echo "")
    if [[ -z "${base_ref}" || -z "${head_oid}" ]]; then
        return 2
    fi
    # Fetch latest base ref so we have an up-to-date local pointer.
    (cd "${project}" 2>/dev/null && \
        git fetch --quiet origin "${base_ref}" 2>/dev/null) || true
    # rc=0 from merge-base means head_oid IS a descendant of origin/<base>
    # (i.e., origin/<base> is an ancestor of head_oid -> up-to-date).
    if (cd "${project}" 2>/dev/null && \
        git merge-base --is-ancestor "origin/${base_ref}" "${head_oid}" 2>/dev/null); then
        return 0   # up-to-date
    else
        return 1   # behind
    fi
}

# _attempt_rebase_pr(project, pr_url) -> rc; stdout = stderr captured on failure
#   Runs `gh pr update-branch <pr_url>` (GitHub's server-side update).
#   NEVER uses --admin / --force / --rebase.
#   Stderr is captured and echoed to stdout on failure for inclusion in
#   the merge_decision `reason` field.
#   Side effects: mutates the PR branch on GitHub (server-side merge of base
#                 into head). No local repo mutation.
_attempt_rebase_pr() {
    local project="$1" pr_url="$2"
    local stderr_out rc=0
    stderr_out=$( (cd "${project}" 2>/dev/null && \
        gh pr update-branch "${pr_url}" < /dev/null 2>&1 >/dev/null) ) || rc=$?
    if [[ ${rc} -ne 0 ]]; then
        echo "${stderr_out}"
    fi
    return ${rc}
}

# _list_inflight_pr_files(project, exclude_request_id) -> stdout = TSV rows
#   For every directory matching <project>/.autonomous-dev/requests/REQ-*
#   where state.json: .status == "running" AND .merge_status != "merged" AND
#   a phase-result-code.json with a github_pr artifact exists AND
#   request_id != exclude_request_id — emit one line per touched file:
#       <req_id>\t<dispatched_at>\t<pr_url>\t<file_path>
#   Side effects: none.
_list_inflight_pr_files() {
    local project="$1" exclude_id="$2"
    local req_dir req_id state_file code_file
    for req_dir in "${project}/.autonomous-dev/requests/REQ-"*/; do
        req_id=$(basename "${req_dir}")
        [[ "${req_id}" == "${exclude_id}" ]] && continue
        state_file="${req_dir}state.json"
        code_file="${req_dir}phase-result-code.json"
        [[ -f "${state_file}" && -f "${code_file}" ]] || continue
        # Check status == "running" and merge_status != "merged"
        local st ms
        st=$(jq -r '.status // ""' "${state_file}" 2>/dev/null || echo "")
        ms=$(jq -r '.merge_status // ""' "${state_file}" 2>/dev/null || echo "")
        [[ "${st}" == "running" ]] || continue
        [[ "${ms}" == "merged" ]] && continue
        # Extract github_pr URL.
        local pr_url dispatched_at
        pr_url=$(jq -r '
            ([.artifacts[]? | select((.kind // "") == "github_pr")]
             | .[0] // {}) as $a
            | ($a.url // $a.path // "")
            ' "${code_file}" 2>/dev/null || echo "")
        [[ -n "${pr_url}" ]] || continue
        dispatched_at=$(jq -r '.current_phase_metadata.dispatched_at // ""' \
            "${state_file}" 2>/dev/null || echo "")
        # Fetch files from this PR and emit TSV rows.
        local file_path
        while IFS= read -r file_path; do
            [[ -n "${file_path}" ]] || continue
            printf '%s\t%s\t%s\t%s\n' \
                "${req_id}" "${dispatched_at}" "${pr_url}" "${file_path}"
        done < <( (cd "${project}" 2>/dev/null && \
            gh pr view "${pr_url}" --json files \
                --jq '.files[].path' < /dev/null 2>/dev/null) || \
            { log_warn "_list_inflight_pr_files: gh pr view failed for ${pr_url} (${req_id}) — skipping"; echo ""; })
    done
    return 0
}

# _this_pr_files(project, pr_url) -> stdout = NL list of file paths
#   `gh pr view <pr_url> --json files --jq '.files[].path'`.
#   Side effects: none. rc=0 even on gh failure (empty output = unknown).
_this_pr_files() {
    local project="$1" pr_url="$2"
    (cd "${project}" 2>/dev/null && \
        gh pr view "${pr_url}" --json files \
            --jq '.files[].path' < /dev/null 2>/dev/null) || true
    return 0
}

# _pr_has_duplicate_patches(project, pr_url) -> rc; stdout = NL of dup SHAs
#   Compute patch-id for each commit on the PR and compare against commits
#   merged into base since the PR branched. Any match -> duplicate.
#   rc=0: duplicate found; stdout lists duplicated PR-side commit SHAs.
#   rc=1: no duplicates.
#   rc=2: could not compute (git patch-id unavailable or refs missing).
#   Side effects: none (read-only against local refs).
_pr_has_duplicate_patches() {
    local project="$1" pr_url="$2"
    # Require git patch-id.
    if ! command -v git >/dev/null 2>&1; then
        return 2
    fi
    # Fetch PR refs info.
    local refs_json base_ref head_oid
    refs_json=$( (cd "${project}" 2>/dev/null && \
        gh pr view "${pr_url}" \
            --json baseRefName,headRefName,headRefOid \
            < /dev/null 2>/dev/null) || echo "")
    if [[ -z "${refs_json}" ]] || ! echo "${refs_json}" | jq empty 2>/dev/null; then
        return 2
    fi
    base_ref=$(echo "${refs_json}" | jq -r '.baseRefName // ""' 2>/dev/null || echo "")
    head_oid=$(echo "${refs_json}" | jq -r '.headRefOid // ""' 2>/dev/null || echo "")
    [[ -n "${base_ref}" && -n "${head_oid}" ]] || return 2
    # Compute the merge-base between head and base.
    local merge_base
    merge_base=$( (cd "${project}" 2>/dev/null && \
        git merge-base "origin/${base_ref}" "${head_oid}" 2>/dev/null) || echo "")
    [[ -n "${merge_base}" ]] || return 2
    # Build patch-ids for commits on the PR (head since merge-base).
    local pr_patch_ids
    pr_patch_ids=$( (cd "${project}" 2>/dev/null && \
        git log --format="%H" "${merge_base}..${head_oid}" 2>/dev/null | \
        while IFS= read -r sha; do
            git show "${sha}" 2>/dev/null | git patch-id 2>/dev/null || true
        done) || echo "")
    # Build patch-ids for commits merged into base since merge-base.
    local base_patch_ids
    base_patch_ids=$( (cd "${project}" 2>/dev/null && \
        git log --format="%H" "${merge_base}..origin/${base_ref}" 2>/dev/null | \
        while IFS= read -r sha; do
            git show "${sha}" 2>/dev/null | git patch-id 2>/dev/null || true
        done) || echo "")
    # Find overlapping patch-ids; emit duplicated PR-side SHAs.
    local found_dup=1
    while IFS=' ' read -r pid pr_sha; do
        [[ -n "${pid}" ]] || continue
        if echo "${base_patch_ids}" | grep -qF "${pid}"; then
            echo "${pr_sha}"
            found_dup=0
        fi
    done < <(echo "${pr_patch_ids}")
    return ${found_dup}
}

# _reverify_pr_after_rebase(project, request_id) -> rc
#   Re-dispatch the integration phase agent against the rebased head.
#   Sets state.current_phase_metadata.reverify_after_rebase = true.
#   Reads the resulting phase-result-integration.json: rc=0 iff .status=="pass".
#   Side effects: mutates state.json (sets flag); may write
#                 phase-result-integration.json (re-dispatch result).
#   IMPORTANT: reuses the existing dispatch_phase chain (ADR-005).
_reverify_pr_after_rebase() {
    local project="$1" request_id="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local result_file="${project}/.autonomous-dev/requests/${request_id}/phase-result-integration.json"
    [[ -f "${state_file}" ]] || return 2
    # Set the reverify flag in state.json (tmp -> mv idiom).
    local tmp="${state_file}.reverify.$$"
    if jq '.current_phase_metadata.reverify_after_rebase = true' \
           "${state_file}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${state_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
    fi
    # Re-dispatch the integration phase via the existing mechanism.
    local rc=0
    dispatch_phase "${request_id}" "integration" "${project}" || rc=$?
    if [[ ${rc} -ne 0 ]]; then
        return 2
    fi
    # Read the result.
    [[ -f "${result_file}" ]] || return 2
    local result_status
    result_status=$(jq -r '.status // "fail"' "${result_file}" 2>/dev/null || echo "fail")
    if [[ "${result_status}" == "pass" ]]; then
        return 0
    fi
    return 1
}

# maybe_merge_integration_pr(request_id, project, state_file, events_file, ts) -> 0
#   Trust-gated, ORDER-AWARE merge decision (REQ-000053 — resolves #623, #626).
#   Invoked from advance_phase() when the `integration` phase PASSES. Records a
#   merge_decision event on EVERY path including the effective trust level + reason.
#
#   SAFETY (this auto-merges to the default branch — read carefully):
#     * Only effective trust L3 (==3) may auto-merge. Any lower level leaves the
#       PR OPEN and marks the request "PR ready for human merge".
#     * A merge is attempted ONLY when `gh pr view` reports the PR is
#       state==OPEN AND mergeable==MERGEABLE AND mergeStateStatus==CLEAN. Any
#       other combination is skipped — the daemon never forces a merge.
#     * Idempotent: an already-MERGED (or non-OPEN) PR is never re-merged.
#     * `gh pr merge --squash` only. NEVER --admin / --force — branch protection
#       is respected. If protection blocks the merge, gh fails and we record the
#       failure rather than bypassing it.
#     * NEW (REQ-000053): before merging, four gates run in order:
#         G1 (rebase)     — require up-to-date base; attempt `gh pr update-branch`
#                           when behind. Tracks rebase_attempts (cap 2).
#                           Decisions: skip_rebase_failed, skip_rebase_loop_exhausted.
#         G2 (serialize)  — defer if another in-flight PR touches overlapping files
#                           and is ahead in the queue. Bypassed for type=hotfix.
#                           Decision: skip_serialized.
#         G3 (duplicate)  — detect patch-id matches with already-merged commits.
#                           Best-effort (skipped if git patch-id unavailable).
#                           Decision: skip_duplicate.
#         G4 (re-verify)  — re-dispatch integration phase on the rebased head
#                           (only when G1 performed a rebase). Uses existing
#                           dispatch_phase chain; never inlines tsc/bun test.
#                           Decision: skip_reverify_failed.
#       All new skips route through _mark_pr_ready_for_human (operator dashboard).
#
#   This function never aborts advance_phase: it returns 0 on every path. A
#   merge that fails the `gh` call is logged as an error and the PR is left open
#   (the request still reaches `done`); it is never retried with elevated flags.
#
#   The actual git/gh work is delegated to `gh`; tests stub `gh` and `git` on
#   PATH so this performs no real merges and never touches GitHub.
maybe_merge_integration_pr() {
    local request_id="$1" project="$2" state_file="$3" events_file="$4" ts="$5"

    local trust
    trust=$(resolve_effective_trust "${project}")

    local pr_url
    pr_url=$(read_request_pr_url "${project}" "${request_id}")

    # _record_merge_decision(decision, reason, [merged_bool], [pr_url_override])
    #   Writes a merge_decision event + an audit log line. merged defaults false.
    _record_merge_decision() {
        local decision="$1" reason="$2" merged="${3:-false}" url="${4:-${pr_url}}"
        local ev
        ev=$(jq -n \
            --arg ts "${ts}" \
            --arg req "${request_id}" \
            --arg decision "${decision}" \
            --arg reason "${reason}" \
            --argjson trust "${trust}" \
            --argjson merged "${merged}" \
            --arg url "${url}" \
            '{
                event: "merge_decision",
                timestamp: $ts,
                request_id: $req,
                decision: $decision,
                reason: $reason,
                effective_trust: $trust,
                merged: $merged,
                pr_url: $url
            }')
        echo "${ev}" >> "${events_file}"
        log_info "merge_decision ${request_id}: decision=${decision} trust=${trust} merged=${merged} reason='${reason}' pr='${url}'"
    }

    # _mark_pr_ready_for_human()
    #   Idempotently stamp state.json so the operator knows a merge is pending
    #   human action. Used for every non-merge terminal-ish outcome that left an
    #   OPEN PR behind.
    _mark_pr_ready_for_human() {
        local reason="$1"
        local tmp="${state_file}.merge.$$"
        if jq --arg reason "${reason}" \
              --arg url "${pr_url}" \
              --argjson trust "${trust}" \
              --arg ts "${ts}" \
              '.status_reason = $reason |
               .merge_status = "pr_ready_for_human" |
               .pr_ready_for_human = true |
               .pr_url = $url |
               .effective_trust = $trust |
               .updated_at = $ts' \
              "${state_file}" > "${tmp}" 2>/dev/null; then
            mv "${tmp}" "${state_file}"
        else
            rm -f "${tmp}" 2>/dev/null || true
            log_warn "maybe_merge_integration_pr: failed to mark ${request_id} PR-ready"
        fi
    }

    # No PR URL recorded -> nothing to merge. Not a failure (the change may not
    # have produced a PR), but record it so the trail is complete.
    if [[ -z "${pr_url}" ]]; then
        _record_merge_decision "skip_no_pr" "no github_pr artifact in phase-result-code.json"
        return 0
    fi

    # Below L3: human gate. Leave the PR OPEN, mark it ready for a human merge.
    if [[ "${trust}" != "3" ]]; then
        _mark_pr_ready_for_human "PR ready for human merge (trust L${trust} < L3; auto-merge disabled)"
        _record_merge_decision "skip_below_l3" "effective trust L${trust} < L3; PR left open for human merge"
        return 0
    fi

    # ---- L3 path: auto-merge, but only if genuinely mergeable. ----

    # gh must be available; if not, do NOT merge — leave the PR for a human.
    if ! command -v gh >/dev/null 2>&1; then
        _mark_pr_ready_for_human "PR ready for human merge (gh CLI unavailable; auto-merge skipped)"
        _record_merge_decision "skip_no_gh" "gh CLI not found; cannot verify/merge — left open"
        return 0
    fi

    # Read PR status. Run inside the project dir so gh resolves the repo, and
    # </dev/null so gh never blocks on a prompt. Failure here = do not merge.
    local pr_json
    pr_json=$( (cd "${project}" 2>/dev/null && gh pr view "${pr_url}" \
                  --json state,mergeable,mergeStateStatus < /dev/null 2>/dev/null) || echo "")
    if [[ -z "${pr_json}" ]] || ! echo "${pr_json}" | jq empty 2>/dev/null; then
        _mark_pr_ready_for_human "PR ready for human merge (could not read PR status; auto-merge skipped)"
        _record_merge_decision "skip_status_unreadable" "gh pr view returned no/invalid JSON — left open"
        return 0
    fi

    local pr_state pr_mergeable pr_mergestate
    pr_state=$(echo "${pr_json}" | jq -r '.state // ""' 2>/dev/null || echo "")
    pr_mergeable=$(echo "${pr_json}" | jq -r '.mergeable // ""' 2>/dev/null || echo "")
    pr_mergestate=$(echo "${pr_json}" | jq -r '.mergeStateStatus // ""' 2>/dev/null || echo "")

    # Idempotency: an already-merged (or otherwise closed) PR is terminal. Do
    # not attempt a merge; record success-shaped skip.
    if [[ "${pr_state}" == "MERGED" ]]; then
        local tmp="${state_file}.merge.$$"
        jq --arg url "${pr_url}" --argjson trust "${trust}" --arg ts "${ts}" \
           '.merge_status = "merged" | .pr_url = $url | .effective_trust = $trust | .updated_at = $ts' \
           "${state_file}" > "${tmp}" 2>/dev/null && mv "${tmp}" "${state_file}" || rm -f "${tmp}" 2>/dev/null || true
        _record_merge_decision "skip_already_merged" "PR already MERGED; idempotent no-op" "true"
        return 0
    fi
    if [[ "${pr_state}" != "OPEN" ]]; then
        _mark_pr_ready_for_human "PR ready for human merge (PR state=${pr_state}; auto-merge skipped)"
        _record_merge_decision "skip_not_open" "PR state=${pr_state} (not OPEN); left as-is"
        return 0
    fi

    # The hard safety gate: only MERGEABLE + CLEAN. Anything else (CONFLICTING,
    # BLOCKED, UNKNOWN, DIRTY, DRAFT, BEHIND, ...) is left for a human.
    if [[ "${pr_mergeable}" != "MERGEABLE" || "${pr_mergestate}" != "CLEAN" ]]; then
        _mark_pr_ready_for_human "PR ready for human merge (not mergeable: mergeable=${pr_mergeable}, mergeStateStatus=${pr_mergestate})"
        _record_merge_decision "skip_not_mergeable" "mergeable=${pr_mergeable} mergeStateStatus=${pr_mergestate} (need MERGEABLE+CLEAN)"
        return 0
    fi

    # =========================================================================
    # NEW GATES (REQ-000053): G1 rebase → G2 serialize → G3 duplicate → G4 re-verify
    # =========================================================================

    # Read rebase_attempts counter (0 when absent).
    local rebase_attempts
    rebase_attempts=$(jq -r '.current_phase_metadata.rebase_attempts // 0' \
        "${state_file}" 2>/dev/null || echo "0")

    # G1 — Up-to-date with base / rebase gate.
    local g1_rc
    _pr_branch_up_to_date "${project}" "${pr_url}"; g1_rc=$?
    if [[ ${g1_rc} -eq 1 ]]; then
        # PR is behind base. Check rebase counter before attempting.
        if [[ "${rebase_attempts}" -ge 2 ]]; then
            _mark_pr_ready_for_human "PR ready for human merge (rebase_attempts=${rebase_attempts} exceeds cap of 2)"
            _record_merge_decision "skip_rebase_loop_exhausted" \
                "rebase_attempts=${rebase_attempts} exceeds cap of 2; PR left open for human merge"
            return 0
        fi
        # Increment counter before the attempt.
        rebase_attempts=$(( rebase_attempts + 1 ))
        local tmp_ra="${state_file}.merge.$$"
        if jq --argjson ra "${rebase_attempts}" \
              '.current_phase_metadata.rebase_attempts = $ra' \
              "${state_file}" > "${tmp_ra}" 2>/dev/null; then
            mv "${tmp_ra}" "${state_file}"
        else
            rm -f "${tmp_ra}" 2>/dev/null || true
        fi
        # Attempt the server-side rebase.
        local rebase_stderr rebase_rc=0
        rebase_stderr=$(_attempt_rebase_pr "${project}" "${pr_url}") || rebase_rc=$?
        if [[ ${rebase_rc} -ne 0 ]]; then
            _mark_pr_ready_for_human "PR ready for human merge (gh pr update-branch failed)"
            _record_merge_decision "skip_rebase_failed" \
                "gh pr update-branch rc=${rebase_rc}: '${rebase_stderr}'"
            return 0
        fi
        # Rebase succeeded — re-read PR state (mergeability may have changed).
        pr_json=$( (cd "${project}" 2>/dev/null && gh pr view "${pr_url}" \
                      --json state,mergeable,mergeStateStatus < /dev/null 2>/dev/null) || echo "")
        if [[ -z "${pr_json}" ]] || ! echo "${pr_json}" | jq empty 2>/dev/null; then
            _mark_pr_ready_for_human "PR ready for human merge (could not re-read PR status after rebase)"
            _record_merge_decision "skip_status_unreadable" \
                "gh pr view returned no/invalid JSON after rebase — left open"
            return 0
        fi
        pr_state=$(echo "${pr_json}" | jq -r '.state // ""' 2>/dev/null || echo "")
        pr_mergeable=$(echo "${pr_json}" | jq -r '.mergeable // ""' 2>/dev/null || echo "")
        pr_mergestate=$(echo "${pr_json}" | jq -r '.mergeStateStatus // ""' 2>/dev/null || echo "")
        if [[ "${pr_mergeable}" != "MERGEABLE" || "${pr_mergestate}" != "CLEAN" ]]; then
            _mark_pr_ready_for_human "PR ready for human merge (not mergeable post-rebase: mergeable=${pr_mergeable}, mergeStateStatus=${pr_mergestate})"
            _record_merge_decision "skip_not_mergeable" \
                "post-rebase: mergeable=${pr_mergeable} mergeStateStatus=${pr_mergestate} (need MERGEABLE+CLEAN)"
            return 0
        fi
    elif [[ ${g1_rc} -eq 2 ]]; then
        # Could not determine status — conservatively skip.
        _mark_pr_ready_for_human "PR ready for human merge (could not determine if PR is up-to-date)"
        _record_merge_decision "skip_status_unreadable" \
            "could not determine if PR branch is up-to-date with base — left open"
        return 0
    fi
    # g1_rc == 0: already up-to-date; fall through.

    # G2 — Concurrent-PR overlap / serialize (skipped for hotfix type).
    local req_type
    req_type=$(jq -r '.type // ""' "${state_file}" 2>/dev/null || echo "")
    if [[ "${req_type}" != "hotfix" ]]; then
        local this_files inflight_rows
        this_files=$(_this_pr_files "${project}" "${pr_url}")
        if [[ -n "${this_files}" ]]; then
            inflight_rows=$(_list_inflight_pr_files "${project}" "${request_id}")
            if [[ -n "${inflight_rows}" ]]; then
                # Find an earlier in-flight PR that overlaps in files.
                local blocking_req blocking_pr blocking_at
                while IFS=$'\t' read -r other_id other_at other_pr other_file; do
                    [[ -n "${other_id}" ]] || continue
                    # Check if this file overlaps with our PR's files.
                    if echo "${this_files}" | grep -qxF "${other_file}"; then
                        # Determine ordering: earlier dispatched_at or smaller REQ id.
                        # Simple lexicographic compare on (dispatched_at, req_id).
                        local my_at
                        my_at=$(jq -r '.current_phase_metadata.dispatched_at // ""' \
                            "${state_file}" 2>/dev/null || echo "")
                        local is_earlier=0
                        if [[ -n "${other_at}" && -n "${my_at}" ]]; then
                            [[ "${other_at}" < "${my_at}" ]] && is_earlier=1
                        elif [[ -z "${my_at}" && -n "${other_at}" ]]; then
                            is_earlier=1
                        fi
                        # Tie-break by numerically-smaller REQ id.
                        if [[ ${is_earlier} -eq 0 ]]; then
                            local other_num my_num
                            other_num=$(echo "${other_id}" | tr -d 'REQ-' | sed 's/^0*//')
                            my_num=$(echo "${request_id}" | tr -d 'REQ-' | sed 's/^0*//')
                            [[ -n "${other_num}" && -n "${my_num}" ]] && \
                                [[ "${other_num}" -lt "${my_num}" ]] 2>/dev/null && is_earlier=1
                        fi
                        if [[ ${is_earlier} -eq 1 ]]; then
                            blocking_req="${other_id}"
                            blocking_pr="${other_pr}"
                            blocking_at="${other_at}"
                            break
                        fi
                    fi
                done < <(echo "${inflight_rows}")
                if [[ -n "${blocking_req}" ]]; then
                    _mark_pr_ready_for_human "PR ready for human merge (serialized behind ${blocking_req})"
                    _record_merge_decision "skip_serialized" \
                        "deferred behind ${blocking_req} (PR ${blocking_pr}; dispatched_at=${blocking_at}) — overlaps files: ${other_file}"
                    return 0
                fi
            fi
        fi
    fi

    # G3 — Duplicate-work detection via git patch-id.
    local dup_rc dup_shas
    dup_shas=$(_pr_has_duplicate_patches "${project}" "${pr_url}"); dup_rc=$?
    if [[ ${dup_rc} -eq 0 && -n "${dup_shas}" ]]; then
        _mark_pr_ready_for_human "PR ready for human merge (duplicate work detected)"
        _record_merge_decision "skip_duplicate" \
            "patch-id match: PR commits $(echo "${dup_shas}" | tr '\n' ',' | sed 's/,$//') already merged into base"
        return 0
    elif [[ ${dup_rc} -eq 2 ]]; then
        log_warn "maybe_merge_integration_pr: git patch-id unavailable — G3 disabled this tick"
        # Fall through (best-effort; do NOT block the merge).
    fi

    # G4 — Re-verify on rebased head (only runs when G1 performed a rebase).
    if [[ "${rebase_attempts}" -gt 0 ]]; then
        local reverify_rc=0
        _reverify_pr_after_rebase "${project}" "${request_id}"; reverify_rc=$?
        if [[ ${reverify_rc} -ne 0 ]]; then
            local reverify_feedback
            local reverify_result="${project}/.autonomous-dev/requests/${request_id}/phase-result-integration.json"
            reverify_feedback=$(jq -r '.feedback // "unknown failure"' \
                "${reverify_result}" 2>/dev/null | head -c 200 || echo "reverify dispatch unavailable")
            _mark_pr_ready_for_human "PR ready for human merge (re-verify failed after rebase)"
            _record_merge_decision "skip_reverify_failed" \
                "reverify failed: ${reverify_feedback}"
            return 0
        fi
    fi

    # =========================================================================
    # All checks passed. Squash-merge WITHOUT --admin/--force (branch protection
    # is respected). On failure, leave the PR open and record an error — never
    # retry with elevated privileges.
    # =========================================================================
    local merge_out merge_rc=0
    merge_out=$( (cd "${project}" 2>/dev/null && gh pr merge "${pr_url}" --squash < /dev/null 2>&1) ) || merge_rc=$?
    if [[ ${merge_rc} -eq 0 ]]; then
        local tmp="${state_file}.merge.$$"
        if jq --arg url "${pr_url}" --argjson trust "${trust}" --arg ts "${ts}" \
              '.merge_status = "merged" |
               .pr_ready_for_human = false |
               .status_reason = "PR auto-merged (trust L3)" |
               .pr_url = $url |
               .effective_trust = $trust |
               .updated_at = $ts |
               .current_phase_metadata.rebase_attempts = 0' \
              "${state_file}" > "${tmp}" 2>/dev/null; then
            mv "${tmp}" "${state_file}"
        else
            rm -f "${tmp}" 2>/dev/null || true
        fi
        _record_merge_decision "merged" "auto-merged at trust L3 (--squash, no --admin); PR was OPEN+MERGEABLE+CLEAN" "true"
    else
        _mark_pr_ready_for_human "PR ready for human merge (auto-merge failed rc=${merge_rc}; branch protection respected)"
        _record_merge_decision "merge_failed" "gh pr merge --squash failed rc=${merge_rc}: ${merge_out}"
        log_error "maybe_merge_integration_pr: gh pr merge failed for ${request_id} (${pr_url}) rc=${merge_rc}: ${merge_out}"
    fi
    return 0
}

###############################################################################
# PR Review-Comment Loopback (issue #501)
#
# When a request has produced a PR (github_pr artifact) and the operator leaves
# review comments on it, the daemon re-enters that request into the `code` phase
# so the author agent revises the change and pushes to the SAME branch (which
# updates the existing PR — never a force-push, never a new PR).
#
# The trigger is intentionally SEPARATE from select_request(): a request that
# reaches a terminal/awaiting-human state (status=done, or merge_status=
# pr_ready_for_human) is normally skipped by select_request. reenter_pr_comment_
# requests() scans exactly those requests, asks GitHub (via `gh`, stubbed in
# tests) whether there are NEW unaddressed comments, and if so flips the request
# back to running/code with the comments captured as feedback.
#
# SAFETY / LOOP BOUNDING (read before changing):
#   * Never acts on a PR whose gh state != OPEN (MERGED / CLOSED are terminal).
#   * Each re-entry increments a counter in pr-comment-seen.json; once it hits
#     MAX_PR_COMMENT_REENTRIES the request is left alone (a stuck "pr_comment_
#     loop_exhausted" marker is written so the trail is explicit). This bounds
#     the loop even if comments keep arriving.
#   * The IDs of the comments that drove a re-entry are recorded as "addressed"
#     AT re-entry time, so the same comment can never re-trigger — only comments
#     created AFTER the last re-entry count as new.
#   * Re-uses the code-phase author/branch/push path verbatim (resolve_phase_
#     prompt code instructions) — no new git operations are introduced here.
###############################################################################

# pr_comment_seen_file(project, request_id) -> echoes path (always 0)
#   Per-request marker that tracks which review-comment IDs have already been
#   routed to the agent and how many comment-driven re-entries have happened.
pr_comment_seen_file() {
    local project="$1" request_id="$2"
    echo "${project}/.autonomous-dev/requests/${request_id}/pr-comment-seen.json"
}

# read_pr_comment_payload(project, request_id, pr_url) -> echoes JSON or empty
#   Fetches the PR's state plus its review-thread comments and top-level
#   (issue) comments via `gh`, normalizing them into:
#     { "state": "OPEN|MERGED|CLOSED", "comments": [ {id, body, author, ts} ] }
#   Runs `gh` inside the project dir with </dev/null so it never blocks on a
#   prompt. Returns empty string on any failure (caller treats empty = skip).
#
#   `gh` is stubbed on PATH in tests — this performs no real network calls.
read_pr_comment_payload() {
    local project="$1" request_id="$2" pr_url="$3"

    [[ -n "${pr_url}" ]] || { echo ""; return 0; }
    command -v gh >/dev/null 2>&1 || { echo ""; return 0; }

    # `gh pr view --json reviews,comments,state` returns:
    #   .state                     -> OPEN|MERGED|CLOSED
    #   .comments[]                -> top-level issue comments {id, body, author{login}, createdAt}
    #   .reviews[]                 -> review submissions {id, body, author{login}, submittedAt}
    # Review-thread (inline diff) comments are NOT in `gh pr view`; we fold in
    # `gh api repos/{owner}/{repo}/pulls/{n}/comments` for those. Both are
    # optional — a failure in either degrades to whatever we could read.
    local view_json
    view_json=$( (cd "${project}" 2>/dev/null && gh pr view "${pr_url}" \
                    --json state,reviews,comments < /dev/null 2>/dev/null) || echo "")
    if [[ -z "${view_json}" ]] || ! echo "${view_json}" | jq empty 2>/dev/null; then
        echo ""
        return 0
    fi

    local pr_state
    pr_state=$(echo "${view_json}" | jq -r '.state // ""' 2>/dev/null || echo "")

    # Inline review-thread comments (best-effort; empty on any failure).
    local api_json
    api_json=$( (cd "${project}" 2>/dev/null && gh api \
                    "repos/{owner}/{repo}/pulls/comments" --paginate \
                    < /dev/null 2>/dev/null) || echo "")
    echo "${api_json}" | jq empty 2>/dev/null || api_json="[]"

    # Normalize + merge both sources into a single comments[] array. Each entry
    # carries a stable string id (prefixed by source so issue/review/thread ids
    # can't collide), the body, the author login, and an ISO timestamp.
    jq -n \
        --arg state "${pr_state}" \
        --argjson view "${view_json}" \
        --argjson api "${api_json}" \
        '
        def norm_view_comments:
            ([ ($view.comments // [])[]
               | { id: ("issue:" + ((.id // .databaseId // "") | tostring)),
                   body: (.body // ""),
                   author: (.author.login // .user.login // ""),
                   ts: (.createdAt // "") } ]);
        def norm_reviews:
            ([ ($view.reviews // [])[]
               # Skip empty-body review submissions (e.g. a bare APPROVE) —
               # they carry no actionable feedback.
               | select((.body // "") != "")
               | { id: ("review:" + ((.id // .databaseId // "") | tostring)),
                   body: (.body // ""),
                   author: (.author.login // .user.login // ""),
                   ts: (.submittedAt // .createdAt // "") } ]);
        def norm_thread:
            ([ ($api // [])[]
               | { id: ("thread:" + ((.id // .databaseId // "") | tostring)),
                   body: (.body // ""),
                   author: (.user.login // .author.login // ""),
                   ts: (.created_at // .createdAt // "") } ]);
        { state: $state,
          comments: (norm_view_comments + norm_reviews + norm_thread) }
        ' 2>/dev/null || echo ""
}

# pr_comment_new_ids(payload_json, seen_file) -> echoes newline-separated ids
#   Given the normalized payload and the seen-marker file, returns the IDs of
#   comments that have NOT yet been addressed. The seen file's .addressed_ids[]
#   is the source of truth; anything not in it is new.
pr_comment_new_ids() {
    local payload_json="$1" seen_file="$2"
    local seen_ids="[]"
    if [[ -f "${seen_file}" ]]; then
        seen_ids=$(jq -c '.addressed_ids // []' "${seen_file}" 2>/dev/null || echo "[]")
    fi
    echo "${payload_json}" | jq -r \
        --argjson seen "${seen_ids}" \
        '[ (.comments // [])[] | .id ] - $seen | .[]' 2>/dev/null || true
}

# reenter_pr_comment_requests() -> void
#   Scans every allowlisted repo for requests sitting in a terminal/awaiting-
#   human state that have an OPEN PR with NEW review comments, and re-enters
#   them into the `code` phase with the comments captured as feedback. Runs on
#   the reconcile cadence (every PR_COMMENT_SCAN_EVERY_N_POLLS polls), NOT on
#   the hot dispatch path.
#
#   Never aborts the caller: every error path logs and continues.
reenter_pr_comment_requests() {
    # No gh -> cannot read comments at all; nothing to do.
    command -v gh >/dev/null 2>&1 || return 0

    local repos
    repos=$(jq -r '.repositories.allowlist[]?' "${EFFECTIVE_CONFIG}" 2>/dev/null || echo "")
    [[ -n "${repos}" ]] || return 0

    while IFS= read -r repo; do
        [[ -z "${repo}" || ! -d "${repo}" ]] && continue
        local req_dir="${repo}/.autonomous-dev/requests"
        [[ -d "${req_dir}" ]] || continue

        for state_file in "${req_dir}"/*/state.json; do
            [[ -f "${state_file}" ]] || continue
            validate_state_file "${state_file}" || continue

            local request_id status merge_status
            request_id=$(jq -r '.id // ""' "${state_file}" 2>/dev/null || echo "")
            status=$(jq -r '.status // ""' "${state_file}" 2>/dev/null || echo "")
            merge_status=$(jq -r '.merge_status // ""' "${state_file}" 2>/dev/null || echo "")
            [[ -n "${request_id}" ]] || continue

            # Only consider requests the normal scheduler would NOT pick up and
            # that left a PR behind: terminal `done`, or any state explicitly
            # marked awaiting a human merge. An actively-running/gated request is
            # left to the normal pipeline (avoids racing a live session).
            local eligible="false"
            if [[ "${status}" == "done" ]]; then
                eligible="true"
            elif [[ "${merge_status}" == "pr_ready_for_human" ]]; then
                eligible="true"
            fi
            [[ "${eligible}" == "true" ]] || continue

            maybe_reenter_for_pr_comments "${request_id}" "${repo}" "${state_file}" || true
        done
    done <<< "${repos}"
}

# maybe_reenter_for_pr_comments(request_id, project, state_file) -> void
#   The per-request decision + action. Extracted from the scan loop so it is
#   unit-testable in isolation. Reads the PR, computes new comments, enforces
#   the re-entry bound, and (when warranted) flips the request to running/code
#   with the comments captured as feedback.
maybe_reenter_for_pr_comments() {
    local request_id="$1" project="$2" state_file="$3"
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local events_file="${req_dir}/events.jsonl"
    local seen_file
    seen_file=$(pr_comment_seen_file "${project}" "${request_id}")

    local pr_url
    pr_url=$(read_request_pr_url "${project}" "${request_id}")
    [[ -n "${pr_url}" ]] || return 0   # no PR -> nothing to address

    # The pipeline must actually contain a `code` phase, or flipping to it would
    # leave next_phase_for_state unable to find current_phase in the sequence
    # (corrupting advancement). A request with a PR but no `code` phase in its
    # phase_overrides (e.g. a doc-only artifact PR) is left for the operator.
    local has_code_phase
    has_code_phase=$(jq -r '(.phase_overrides // []) | index("code") // empty' "${state_file}" 2>/dev/null || echo "")
    [[ -n "${has_code_phase}" ]] || return 0

    local payload
    payload=$(read_pr_comment_payload "${project}" "${request_id}" "${pr_url}")
    # Empty payload = could not read PR (gh failed / no JSON). Skip silently;
    # the next scan retries. Do NOT treat as "no comments".
    [[ -n "${payload}" ]] || return 0

    local pr_state
    pr_state=$(echo "${payload}" | jq -r '.state // ""' 2>/dev/null || echo "")

    # SAFETY: never act on a closed/merged PR. The change has landed (or been
    # abandoned); re-running the code phase against it would be wrong.
    if [[ "${pr_state}" != "OPEN" ]]; then
        return 0
    fi

    # Which comments are new (not yet addressed)?
    local -a new_ids=()
    while IFS= read -r cid; do
        [[ -n "${cid}" ]] && new_ids+=("${cid}")
    done < <(pr_comment_new_ids "${payload}" "${seen_file}")

    [[ ${#new_ids[@]} -gt 0 ]] || return 0   # nothing new -> done

    # LOOP BOUND: how many comment-driven re-entries has this request had?
    local reentries=0
    if [[ -f "${seen_file}" ]]; then
        reentries=$(jq -r '.reentries // 0' "${seen_file}" 2>/dev/null || echo "0")
    fi
    [[ "${reentries}" =~ ^[0-9]+$ ]] || reentries=0

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [[ "${reentries}" -ge "${MAX_PR_COMMENT_REENTRIES}" ]]; then
        # Exhausted. Mark the new comments addressed so we don't log this every
        # scan, and stamp an explicit exhaustion marker for the operator.
        _pr_comment_mark_addressed "${seen_file}" "${payload}" "${reentries}"
        local already
        already=$(jq -r '.exhausted_logged // false' "${seen_file}" 2>/dev/null || echo "false")
        if [[ "${already}" != "true" ]]; then
            local tmp_seen="${seen_file}.tmp.$$"
            jq '.exhausted_logged = true' "${seen_file}" > "${tmp_seen}" 2>/dev/null \
                && mv "${tmp_seen}" "${seen_file}" || rm -f "${tmp_seen}" 2>/dev/null || true
            local ev
            ev=$(jq -n --arg ts "${ts}" --arg req "${request_id}" \
                       --argjson max "${MAX_PR_COMMENT_REENTRIES}" --arg url "${pr_url}" \
                '{ event: "pr_comment_loop_exhausted", timestamp: $ts,
                   request_id: $req, max_reentries: $max, pr_url: $url }')
            echo "${ev}" >> "${events_file}"
            log_warn "pr_comment loop exhausted for ${request_id}: ${reentries} re-entries >= max ${MAX_PR_COMMENT_REENTRIES}; leaving for human (${pr_url})"
        fi
        return 0
    fi

    # ---- Re-entry: record feedback, mark comments addressed, flip to code. ----

    # Compose human-readable feedback (the new comments' bodies, attributed).
    local feedback_text
    feedback_text=$(echo "${payload}" | jq -r \
        --argjson ids "$(printf '%s\n' "${new_ids[@]}" | jq -R . | jq -s .)" \
        '
        [ (.comments // [])[] | select(.id as $i | $ids | index($i)) ]
        | map("- @" + (.author // "operator") + ": " + (.body // "" | gsub("\\s+";" ")))
        | join("\n")
        ' 2>/dev/null || echo "")

    local new_count="${#new_ids[@]}"

    # Capture feedback into current_phase_metadata (mirrors the review_feedback
    # convention) AND flip current_phase=code / status=running so the normal
    # dispatcher picks it up next poll. Clear the awaiting-human markers.
    local tmp="${state_file}.prc.$$"
    if jq --arg ts "${ts}" \
          --arg fb "${feedback_text}" \
          --arg url "${pr_url}" \
          '.current_phase = "code" |
           .status = "running" |
           .updated_at = $ts |
           .pr_ready_for_human = false |
           (.merge_status // empty) as $ms |
           (if $ms == "pr_ready_for_human" then .merge_status = "pr_comment_revision" else . end) |
           .current_phase_metadata.dispatched_phase = null |
           .current_phase_metadata.pr_comment_feedback = $fb |
           .current_phase_metadata.pr_comment_url = $url' \
          "${state_file}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${state_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
        log_error "maybe_reenter_for_pr_comments: failed to flip ${request_id} to code phase"
        return 0
    fi

    # Mark these comment IDs addressed and bump the re-entry counter BEFORE the
    # session runs, so a crash mid-revision still consumes the re-entry (fail
    # safe: we under-loop rather than risk an infinite loop).
    _pr_comment_mark_addressed "${seen_file}" "${payload}" "$(( reentries + 1 ))"

    # Mirror to the intake ledger so the portal reflects the resumed work.
    sync_intake_db_row "${request_id}" "code" "running" "${ts}" || true

    # Audit event.
    local ev
    ev=$(jq -n --arg ts "${ts}" --arg req "${request_id}" \
               --argjson n "${new_count}" --argjson re "$(( reentries + 1 ))" \
               --arg url "${pr_url}" \
        '{ event: "pr_comment_reentry", timestamp: $ts, request_id: $req,
           new_comments: $n, reentry: $re, pr_url: $url }')
    echo "${ev}" >> "${events_file}"

    write_portal_request_action "${request_id}" "${project}" || true

    log_info "pr_comment_reentry ${request_id}: ${new_count} new comment(s) -> code phase (re-entry $(( reentries + 1 ))/${MAX_PR_COMMENT_REENTRIES}) pr=${pr_url}"
}

# _pr_comment_mark_addressed(seen_file, payload_json, reentries) -> void
#   Idempotently records EVERY comment id currently visible on the PR as
#   addressed and stores the re-entry counter. Recording all visible ids (not
#   just the new ones) means a comment can never re-trigger after one pass.
_pr_comment_mark_addressed() {
    local seen_file="$1" payload_json="$2" reentries="$3"
    local existing="[]"
    if [[ -f "${seen_file}" ]]; then
        existing=$(jq -c '.addressed_ids // []' "${seen_file}" 2>/dev/null || echo "[]")
    fi
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local tmp="${seen_file}.tmp.$$"
    if echo "${payload_json}" | jq \
          --argjson existing "${existing}" \
          --argjson re "${reentries}" \
          --arg ts "${ts}" \
          '{ addressed_ids: (($existing + [ (.comments // [])[] | .id ]) | unique),
             reentries: $re,
             updated_at: $ts }' > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${seen_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
        log_warn "_pr_comment_mark_addressed: failed to update ${seen_file}"
    fi
}

###############################################################################
# Phase Advancement (SPEC-039-2-05)
###############################################################################

# record_phase_history(state_file, completed_phase, next_phase, ts) -> void
#   Records a completed phase in state.json's phase_history[] (issue #489).
#   advance_phase historically only mutated current_phase/status and never
#   appended to phase_history, so it was stuck at its seed entry. This closes
#   the completed phase's open entry (or appends a closed one if absent) and,
#   when next_phase is non-empty, opens a new entry for the phase being
#   entered. Entry shape matches lib/state/lifecycle_engine.sh so existing
#   readers and the cost tracker stay compatible. Atomic via tmp + mv.
record_phase_history() {
    local state_file="$1"
    local completed_phase="$2"
    local next_phase="$3"
    local ts="$4"

    local tmp="${state_file}.hist.$$"
    jq --arg completed "$completed_phase" \
       --arg next "$next_phase" \
       --arg ts "$ts" \
       '
       # Normalize: ensure phase_history is an array.
       .phase_history = (.phase_history // []) |

       # Close out the completed phase. If the last entry is still open and
       # matches the completed phase, stamp its exit; otherwise append a
       # closed entry so every completed phase is recorded even when the
       # daemon never seeded an open one.
       (if (.phase_history | length) > 0
             and (.phase_history[-1] | type) == "object"
             and .phase_history[-1].state == $completed
             and (.phase_history[-1].exited_at == null)
        then
          .phase_history[-1].exited_at = $ts |
          .phase_history[-1].exit_reason = "completed"
        else
          .phase_history += [{
            state: $completed,
            entered_at: null,
            exited_at: $ts,
            session_id: null,
            turns_used: 0,
            cost_usd: 0,
            retry_count: 0,
            soft_timeout_count: 0,
            exit_reason: "completed"
          }]
        end) |

       # Open an entry for the phase being entered (skip on terminal).
       (if $next != "" then
          .phase_history += [{
            state: $next,
            entered_at: $ts,
            exited_at: null,
            session_id: null,
            turns_used: 0,
            cost_usd: 0,
            retry_count: 0,
            soft_timeout_count: 0,
            exit_reason: null
          }]
        else . end)
       ' \
       "$state_file" > "$tmp" && mv "$tmp" "$state_file" || {
        rm -f "$tmp" 2>/dev/null || true
        log_warn "record_phase_history: failed to update phase_history for $state_file"
        return 1
    }
}

# advance_phase(request_id, project) -> void
#   Reads phase-result-<phase>.json, decides the next phase per TDD §7.1
#   transition table, atomically updates state.json (current_phase, status,
#   updated_at), appends to events.jsonl. Implements retry budget enforcement:
#   on MAX_RETRIES_PER_PHASE exhaustion, marks status='failed' per SPEC-039-1-06.
advance_phase() {
    local request_id="$1"
    local project="$2"

    if ! validate_request_id "$request_id"; then
        log_error "Invalid request ID in advance_phase: $request_id"
        return 1
    fi

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"

    # Read current phase (prefer dispatched_phase to avoid agent-mutated current_phase)
    local current_phase
    current_phase=$(jq -r '.current_phase_metadata.dispatched_phase // .current_phase // .status' "$state_file" 2>/dev/null || echo "")
    if [[ -z "$current_phase" ]]; then
        log_error "Cannot determine current_phase from state file: $state_file"
        return 1
    fi

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local result_file="${req_dir}/phase-result-${current_phase}.json"

    # Read result status
    local result_status
    if [[ -f "$result_file" ]]; then
        result_status=$(jq -r '.status // "pass"' "$result_file" 2>/dev/null || echo "pass")
        local synthesized
        synthesized=$(jq -r '.synthesized // false' "$result_file" 2>/dev/null || echo "false")
        if [[ "$synthesized" == "true" ]]; then
            log_warn "synthesized phase result for $request_id $current_phase (exit code only; trust=low)"
        fi
    else
        log_warn "phase-result missing for $request_id phase $current_phase; treating as pass"
        result_status="pass"
    fi

    # Self-feed the self-improvement loop: at a `<X>_review` completion, record an
    # InvocationMetric for the reviewed agent so `agent improve`/`agent analyze`
    # accumulate real data. Best-effort — never affects phase advancement; gated by
    # config agent_factory.metrics.record_from_pipeline (default true).
    record_phase_metric "$request_id" "$project" "$current_phase" "$result_status" || true

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    case "$result_status" in
        "pass")
            # Before computing next phase, ensure current_phase reflects the dispatched phase
            # (in case agent mutated it during the session)
            local tmp_restore="${state_file}.restore.$$"
            jq --arg phase "$current_phase" \
               '.current_phase = $phase' \
               "$state_file" > "$tmp_restore"
            mv "$tmp_restore" "$state_file"

            # Issue #501: once the code phase completes, drop the one-shot
            # PR-comment feedback so it can never leak into a later, unrelated
            # code dispatch. (A fresh re-entry rewrites it.)
            if [[ "$current_phase" == "code" ]]; then
                local tmp_prc="${state_file}.prcclr.$$"
                jq 'del(.current_phase_metadata.pr_comment_feedback) |
                    del(.current_phase_metadata.pr_comment_url)' \
                   "$state_file" > "$tmp_prc" 2>/dev/null \
                    && mv "$tmp_prc" "$state_file" || rm -f "$tmp_prc" 2>/dev/null || true
            fi

            # #487: trust-gated PR merge. When the `integration` phase passes
            # verification, decide whether to auto-merge the PR based on the
            # repo's effective trust level. L3 auto-merges a genuinely-mergeable
            # PR; below L3 leaves it OPEN and marks the request "PR ready for
            # human merge". This runs BEFORE the phase transition so the merge
            # decision's state fields are recorded alongside the advance; the
            # gate never aborts advancement (always returns 0).
            if [[ "$current_phase" == "integration" ]]; then
                maybe_merge_integration_pr "$request_id" "$project" "$state_file" "$events_file" "$ts" || true
            fi

            # Determine next phase
            local next_phase
            next_phase=$(next_phase_for_state "$state_file")

            if [[ -z "$next_phase" ]]; then
                # Terminal - mark done
                local tmp="${state_file}.tmp.$$"
                jq --arg ts "$ts" \
                   '.status = "done" |
                    .updated_at = $ts |
                    .current_phase_metadata.dispatched_phase = null' \
                   "$state_file" > "$tmp"
                mv "$tmp" "$state_file"

                # Record the completed final phase in phase_history (issue #489)
                record_phase_history "$state_file" "$current_phase" "" "$ts"

                # Append completed event
                local event
                event=$(jq -n \
                    --arg ts "$ts" \
                    --arg req "$request_id" \
                    --arg phase "$current_phase" \
                    '{
                        event: "completed",
                        timestamp: $ts,
                        request_id: $req,
                        phase: $phase
                    }')
                echo "$event" >> "$events_file"

                # Mirror terminal completion to the intake ledger (REQ-000013 Call site C)
                sync_intake_db_row "$request_id" "$current_phase" "done" "$ts"

                # Clean up gate decision file for completed request
                local repo_basename
                repo_basename=$(basename "$project")
                local gate_file="${GATE_DECISIONS_DIR}/${repo_basename}__${request_id}.json"
                rm -f "$gate_file" 2>/dev/null || true

                log_info "Request $request_id completed successfully"
            else
                # Advance to next phase
                local next_status
                if [[ "$next_phase" == *_review ]]; then
                    next_status="gate"
                else
                    next_status="running"
                fi

                local tmp="${state_file}.tmp.$$"
                if [[ "$next_status" == "gate" ]]; then
                    jq --arg phase "$next_phase" \
                       --arg status "$next_status" \
                       --arg ts "$ts" \
                       '.current_phase = $phase |
                        .status = $status |
                        .updated_at = $ts |
                        .current_phase_metadata.gate_entered_at = $ts |
                        .current_phase_metadata.dispatched_phase = null |
                        .current_phase_metadata.soft_timeout_count = 0' \
                       "$state_file" > "$tmp"
                else
                    jq --arg phase "$next_phase" \
                       --arg status "$next_status" \
                       --arg ts "$ts" \
                       '.current_phase = $phase |
                        .status = $status |
                        .updated_at = $ts |
                        .current_phase_metadata.dispatched_phase = null |
                        .current_phase_metadata.soft_timeout_count = 0' \
                       "$state_file" > "$tmp"
                fi
                mv "$tmp" "$state_file"

                # Record the completed phase and open the next one in
                # phase_history (issue #489)
                record_phase_history "$state_file" "$current_phase" "$next_phase" "$ts"

                # Append phase_advance event
                local event
                event=$(jq -n \
                    --arg ts "$ts" \
                    --arg req "$request_id" \
                    --arg from "$current_phase" \
                    --arg to "$next_phase" \
                    '{
                        event: "phase_advance",
                        timestamp: $ts,
                        request_id: $req,
                        from: $from,
                        to: $to
                    }')
                echo "$event" >> "$events_file"

                # Mirror phase advance to the intake ledger (REQ-000013 Call site B)
                sync_intake_db_row "$request_id" "$next_phase" "$next_status" "$ts"

                log_info "Phase advanced: $request_id $current_phase -> $next_phase (status=$next_status)"

                # Write gate decision when entering a gate
                if [[ "$next_status" == "gate" ]]; then
                    write_gate_decision "$request_id" "$project" "$next_phase"
                fi
            fi

            # Write portal request action after state update
            write_portal_request_action "$request_id" "$project"
            ;;

        "fail"|"error")
            # Increment escalation_count
            local escalation_count
            escalation_count=$(jq -r '.escalation_count // 0' "$state_file" 2>/dev/null || echo "0")
            escalation_count=$((escalation_count + 1))

            # Update escalation_count atomically
            local tmp="${state_file}.tmp.$$"
            jq --argjson count "$escalation_count" \
               --arg ts "$ts" \
               '.escalation_count = $count | .updated_at = $ts' \
               "$state_file" > "$tmp"
            # LEDGER-EXEMPT: status/current_phase not modified
            mv "$tmp" "$state_file"

            # Append phase_failed event
            local event
            event=$(jq -n \
                --arg ts "$ts" \
                --arg req "$request_id" \
                --arg phase "$current_phase" \
                --argjson count "$escalation_count" \
                '{
                    event: "phase_failed",
                    timestamp: $ts,
                    request_id: $req,
                    phase: $phase,
                    escalation_count: $count
                }')
            echo "$event" >> "$events_file"

            # Handle phase failure (calls handle_phase_failure which checks retry exhaustion)
            handle_phase_failure "$request_id" "$state_file"

            # If this is a review phase failure and not exhausted, reset to author phase
            if [[ "$current_phase" == *_review && "$escalation_count" -lt "$MAX_RETRIES_PER_PHASE" ]]; then
                local author_phase="${current_phase%_review}"
                local tmp="${state_file}.tmp.$$"
                jq --arg phase "$author_phase" \
                   --arg ts "$ts" \
                   '.current_phase = $phase | .updated_at = $ts' \
                   "$state_file" > "$tmp"
                mv "$tmp" "$state_file"

                # Mirror review-fail reset to the intake ledger (REQ-000013 Call site E)
                sync_intake_db_row "$request_id" "$author_phase" "running" "$ts"

                log_info "Review phase $current_phase failed, reset to author phase $author_phase"
            fi

            # Mirror a terminal failure (retry-exhausted) to the ledger (REQ-000013 Call site F).
            # handle_phase_failure may have set state.json status=failed; re-read to confirm.
            local post_status
            post_status=$(jq -r '.status // ""' "$state_file" 2>/dev/null || echo "")
            if [[ "$post_status" == "failed" ]]; then
                sync_intake_db_row "$request_id" "$current_phase" "failed" "$ts"
            fi

            # Write portal request action after all failure handling
            write_portal_request_action "$request_id" "$project"
            ;;

        *)
            log_warn "unknown phase-result.status: $result_status; treating as pass"
            # Recursive call with pass status
            result_status="pass"
            advance_phase "$request_id" "$project"
            ;;
    esac
}

###############################################################################
# Intake to PRD Auto-Transition (SPEC-039-2-06)
###############################################################################

# intake_to_prd_if_needed(request_id, project) -> int
#   Checks if request is in queued/intake state and auto-transitions it to the
#   running state at its FIRST real phase. That phase is whatever follows
#   `intake` in the state's phase_overrides[] (via next_phase_for_state) — `prd`
#   for a standard request, but `spec` for a trivial-docs request whose
#   lighter pipeline (#526) skips prd/prd_review/tdd/tdd_review/plan/plan_review.
#   (#548: this transition previously HARDCODED `prd`, which made size-based
#   phase_overrides inert on the very first hop — the lighter pipeline still ran
#   prd. HOTFIX was unaffected because it skips tdd, a later phase, not prd.)
#   Returns 0 if transition happened, 1 if no transition needed.
intake_to_prd_if_needed() {
    local request_id="$1"
    local project="$2"

    if ! validate_request_id "$request_id"; then
        log_error "Invalid request ID in intake_to_prd_if_needed: $request_id"
        return 1
    fi

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"

    # Check current state
    local current_phase status
    current_phase=$(jq -r '.current_phase // ""' "$state_file" 2>/dev/null || echo "")
    status=$(jq -r '.status // ""' "$state_file" 2>/dev/null || echo "")

    if [[ "$current_phase" == "intake" && "$status" == "queued" ]]; then
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        # Honor phase_overrides for the first transition. next_phase_for_state
        # reads current_phase (intake) and returns the next element of the
        # state's phase sequence (overrides or legacy). Fall back to "prd" only
        # if it cannot be resolved (unreadable / corrupt state), preserving the
        # legacy behavior for safety.
        local next_phase
        next_phase=$(next_phase_for_state "$state_file" 2>/dev/null || true)
        if [[ -z "$next_phase" ]]; then
            next_phase="prd"
        fi

        # Atomically transition to running/<next_phase>
        local tmp="${state_file}.tmp.$$"
        jq --arg ts "$ts" --arg np "$next_phase" \
           '.current_phase = $np | .status = "running" | .updated_at = $ts' \
           "$state_file" > "$tmp"
        mv "$tmp" "$state_file"

        # Append the intake-transition event (event name kept as intake_to_prd
        # for downstream-consumer compatibility; `to` reflects the actual phase).
        local event
        event=$(jq -n \
            --arg ts "$ts" \
            --arg req "$request_id" \
            --arg np "$next_phase" \
            '{
                event: "intake_to_prd",
                timestamp: $ts,
                request_id: $req,
                from: "intake",
                to: $np
            }')
        echo "$event" >> "$events_file"

        # Mirror intake->next transition to the intake ledger (REQ-000013 Call site A)
        sync_intake_db_row "$request_id" "$next_phase" "running" "$ts"

        log_info "Auto-transitioned $request_id from intake to $next_phase"

        # Write portal request action after state transition
        write_portal_request_action "$request_id" "$project"

        return 0
    fi

    return 1
}

###############################################################################
# Cost Ledger (SPEC-001-2-04 Task 8)
###############################################################################

# initialize_cost_ledger() -> void
#   Creates the cost ledger file with an empty structure if it does not exist.
#   Idempotent: does nothing if the ledger already exists.
initialize_cost_ledger() {
    if [[ ! -f "${COST_LEDGER_FILE}" ]]; then
        local tmp="${COST_LEDGER_FILE}.tmp"
        jq -n '{ daily: {} }' > "${tmp}"
        mv "${tmp}" "${COST_LEDGER_FILE}"
        log_info "Cost ledger initialized"
    fi
}

# read_cost_ledger() -> string
#   Reads the cost ledger and outputs its JSON content on stdout.
#   Returns an empty default if the file does not exist.
#   Returns empty string and exit 1 if the file is corrupt.
read_cost_ledger() {
    if [[ ! -f "${COST_LEDGER_FILE}" ]]; then
        echo '{ "daily": {} }'
        return
    fi
    local content
    content=$(cat "${COST_LEDGER_FILE}")
    if ! echo "${content}" | jq empty 2>/dev/null; then
        log_error "Cost ledger is corrupt"
        echo ""
        return 1
    fi
    echo "${content}"
}

# update_cost_ledger(session_cost, request_id?) -> void
#   Appends a session cost entry to the cost ledger. Accumulates the cost
#   in today's daily bucket.
#
# Arguments:
#   $1 -- session_cost: Cost in USD as a decimal string (e.g., "2.50").
#   $2 -- request_id:   (Optional) The request ID for the session entry.
#
# Returns:
#   0 on success
#   1 if ledger is corrupt or unreadable
update_cost_ledger() {
    local session_cost="$1"
    local request_id="${2:-unknown}"

    # Validate session_cost is numeric; default to 0 if not
    if ! echo "${session_cost}" | jq -e 'tonumber' >/dev/null 2>&1; then
        log_warn "Non-numeric session_cost '${session_cost}' in cost ledger update, defaulting to 0"
        session_cost="0"
    fi

    local ledger
    ledger=$(read_cost_ledger)
    if [[ -z "${ledger}" ]]; then
        log_error "Cannot update cost ledger (corrupt or unreadable)"
        log_error "Recovery: Run 'autonomous-dev config init --reset-ledger' to reinitialize."
        emit_alert "cost_ledger_corruption" "Cost ledger is corrupt. Cannot record session cost."
        return 1
    fi

    local today
    today=$(date -u +"%Y-%m-%d")

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local tmp="${COST_LEDGER_FILE}.tmp"
    echo "${ledger}" | jq \
        --arg date "${today}" \
        --arg cost "${session_cost}" \
        --arg req "${request_id}" \
        --arg ts "${ts}" \
        '
        .daily[$date] //= { total_usd: 0, sessions: [] } |
        .daily[$date].total_usd += ($cost | tonumber) |
        .daily[$date].sessions += [{
            request_id: $req,
            cost_usd: ($cost | tonumber),
            timestamp: $ts
        }]
        ' > "${tmp}"
    mv "${tmp}" "${COST_LEDGER_FILE}"

    log_info "Cost ledger updated: +\$${session_cost} for ${today}"
}

###############################################################################
# Gate Checks
###############################################################################

# check_cost_caps() -> int
#   Reads the cost ledger and compares daily/monthly spend against configured
#   limits. Returns 0 if under all caps (or no ledger exists), 1 if any cap
#   is exceeded or the ledger is corrupt.
check_cost_caps() {
    # No ledger file means no spend recorded
    if [[ ! -f "${COST_LEDGER_FILE}" ]]; then
        return 0
    fi

    # Validate the ledger is parseable JSON
    if ! jq empty "${COST_LEDGER_FILE}" 2>/dev/null; then
        log_error "Cost ledger is corrupt. Refusing to process work."
        log_error "Recovery: Run 'autonomous-dev config init --reset-ledger' to reinitialize."
        emit_alert "cost_ledger_corruption" "Cost ledger at ${COST_LEDGER_FILE} is corrupt. Daemon will not process work until repaired."
        return 1
    fi

    # Compute today's date key and read today's spend
    local today
    today=$(date -u +"%Y-%m-%d")
    local daily_spend
    daily_spend=$(jq -r ".daily[\"${today}\"].total_usd // 0" "${COST_LEDGER_FILE}")

    # Compute current month key and read this month's spend
    local month
    month=$(date -u +"%Y-%m")
    local monthly_spend
    monthly_spend=$(jq -r "[.daily | to_entries[] | select(.key | startswith(\"${month}\")) | .value.total_usd] | add // 0" "${COST_LEDGER_FILE}")

    # Compare against daily cap
    if awk "BEGIN {exit !(${daily_spend} >= ${DAILY_COST_CAP})}"; then
        log_warn "Daily cost cap reached: \$${daily_spend} >= \$${DAILY_COST_CAP}"
        return 1
    fi

    # Compare against monthly cap
    if awk "BEGIN {exit !(${monthly_spend} >= ${MONTHLY_COST_CAP})}"; then
        log_warn "Monthly cost cap reached: \$${monthly_spend} >= \$${MONTHLY_COST_CAP}"
        return 1
    fi

    return 0
}

# check_gates() -> int
#   Pre-iteration gate checks. Returns 0 if all gates pass, 1 if any gate
#   blocks work. Checks are ordered: kill switch, circuit breaker, cost caps.
check_gates() {
    # Kill switch: file existence check
    if [[ -f "${KILL_SWITCH_FILE}" ]]; then
        log_warn "Kill switch is engaged. Skipping iteration."
        return 1
    fi

    # Circuit breaker check (SPEC-001-3-01 Task 2)
    if [[ "${CIRCUIT_BREAKER_TRIPPED}" == "true" ]]; then
        log_warn "Circuit breaker is tripped. Skipping iteration. Run 'autonomous-dev circuit-breaker reset' to clear."
        return 1
    fi

    # Cost cap check
    if ! check_cost_caps; then
        return 1
    fi

    # Rate-limit backoff gate (PRD-025 FR-025-12): if a recent session hit an
    # API rate limit, honor the exponential-backoff window (or the persistent
    # kill-switch state after the ladder maxes out) before doing more work.
    if declare -F check_rate_limit_state >/dev/null 2>&1 && ! check_rate_limit_state; then
        log_warn "Rate-limit backoff active. Skipping iteration."
        return 1
    fi

    return 0
}

# handle_phase_failure(request_id, state_file) -> void
#   Stub for TASK-031: handle phase failure when retries exhausted.
#   Sets status='failed', error='MAX_RETRIES_EXCEEDED' atomically.
#   NOTE: This is a minimal implementation for PR-1. Full advance_phase
#   logic will be implemented in PR-2/PR-3.
handle_phase_failure() {
    local request_id="$1"
    local state_file="$2"

    if ! validate_request_id "$request_id"; then
        log_error "Invalid request ID in handle_phase_failure: $request_id"
        return 1
    fi

    # Read current escalation count
    local escalation_count
    escalation_count=$(jq -r '.escalation_count // 0' "$state_file" 2>/dev/null || echo "0")

    # Check if retries exhausted
    if [[ "$escalation_count" -ge "$MAX_RETRIES_PER_PHASE" ]]; then
        log_info "Retries exhausted for ${request_id}, marking as failed"

        # Create updated state atomically
        local tmp_file="${state_file}.tmp.$$"
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq --arg ts "$ts" \
           '.status = "failed" | .error = "MAX_RETRIES_EXCEEDED" | .updated_at = $ts' \
           "$state_file" > "$tmp_file" && mv "$tmp_file" "$state_file"

        # Emit failed event to events.jsonl
        local events_file="${state_file%state.json}events.jsonl"
        local event
        event=$(jq -n \
            --arg ts "$ts" \
            --arg req "$request_id" \
            '{
                event: "failed",
                timestamp: $ts,
                request_id: $req,
                reason: "max_retries_exceeded"
            }')
        echo "$event" >> "$events_file"

        log_info "Request ${request_id} marked as failed due to retry exhaustion"

        # Best-effort auto-file a GitHub issue for the failure (opt-in via
        # AUTODEV_FAILURE_ISSUES=1). Backgrounded + `|| true` so it can never
        # block or break the loop; the CLI verb dedups by fingerprint and never
        # throws. The repo slug is resolved from the request path via ownership;
        # AUTODEV_SYSTEM_ISSUE_REPO (optional) is the fallback for unresolvable
        # repos. Triggered requests are already covered by the watch-tick.
        if [[ "${AUTODEV_FAILURE_ISSUES:-0}" == "1" ]]; then
            local fail_repo_path="${state_file%%/.autonomous-dev/requests/*}"
            local fail_phase
            fail_phase=$(jq -r '.current_phase // ""' "$state_file" 2>/dev/null || echo "")
            ( autonomous-dev triggers file-failure-issue \
                --repo-path "$fail_repo_path" \
                --request "$request_id" \
                --class pipeline-failed \
                --phase "$fail_phase" \
                --detail "max retries exceeded" \
                --system-repo "${AUTODEV_SYSTEM_ISSUE_REPO:-}" \
                >/dev/null 2>&1 || true ) &
        fi
    else
        log_info "Request ${request_id} escalation_count ${escalation_count} < ${MAX_RETRIES_PER_PHASE}, not marking as failed"
    fi
}

###############################################################################
# Orphan Reconciliation
###############################################################################

# consume_config_changes() -> void
#   PRD-025 FR-025-05 / #353. Applies portal-originated config-change markers.
#   The portal writes a marker {id, source:"portal", actor, ts, summary,
#   proposed:<partial user config>} into CONFIG_CHANGES_DIR rather than mutating
#   CONFIG_FILE directly (FR-925). This validates each marker, then DEEP-
#   MERGES `.proposed` over the existing CONFIG_FILE (proposed scalars/arrays
#   win; nested objects merge recursively; keys absent from proposed are
#   preserved at every level), logs an audit line, and archives the marker.
#   A partial proposal must never destroy unmentioned keys -- not just at the
#   top level (repositories.allowlist, #386) but also NESTED ones: e.g. a
#   trust-level-only change `{trust:{system_default_level:2}}` must keep the
#   sibling `trust.per_repo_overrides` (#507). The earlier shallow `+` merge
#   preserved only top-level keys and silently dropped such nested siblings.
#   Arrays are still REPLACED wholesale (jq `*` semantics), so a proposed
#   `repositories.allowlist` overwrites the old list as before (#386). Invalid
#   markers are moved to a `rejected/` subdir (never applied, never retried
#   forever). Runs during reconcile. Safe under `set -e`.
consume_config_changes() {
    [[ -d "${CONFIG_CHANGES_DIR}" ]] || return 0

    local applied_dir="${CONFIG_CHANGES_DIR}/applied"
    local rejected_dir="${CONFIG_CHANGES_DIR}/rejected"
    local applied_count=0

    # Apply in CHRONOLOGICAL (.ts) order, not glob/filename order. Marker
    # filenames are random UUIDs, so glob order is arbitrary — two pending
    # saves could apply newest-first and the older one would clobber the
    # newer (observed live: a webhook save reversed by an earlier save).
    # Markers with no parseable ts sort first (empty key) and still get
    # the corrupt-marker rejection below.
    local marker_list
    marker_list=$(
        for m in "${CONFIG_CHANGES_DIR}"/*.json; do
            [[ -f "$m" ]] || continue
            printf '%s\t%s\n' "$(jq -r '.ts // ""' "$m" 2>/dev/null)" "$m"
        done | sort | cut -f2-
    )
    [[ -z "${marker_list}" ]] && return 0

    local marker
    while IFS= read -r marker; do
        [[ -f "${marker}" ]] || continue   # removed mid-loop

        # 1. Validate: parseable JSON, source=="portal", .proposed is an object.
        if ! jq empty "${marker}" 2>/dev/null; then
            log_warn "Config-change marker is corrupt JSON; rejecting: ${marker}"
            mkdir -p "${rejected_dir}"; mv "${marker}" "${rejected_dir}/" 2>/dev/null || rm -f "${marker}"
            continue
        fi
        local src proposed_type
        src=$(jq -r '.source // ""' "${marker}" 2>/dev/null || echo "")
        proposed_type=$(jq -r '.proposed | type' "${marker}" 2>/dev/null || echo "null")
        if [[ "${src}" != "portal" || "${proposed_type}" != "object" ]]; then
            log_warn "Config-change marker failed validation (source='${src}', proposed=${proposed_type}); rejecting: ${marker}"
            mkdir -p "${rejected_dir}"; mv "${marker}" "${rejected_dir}/" 2>/dev/null || rm -f "${marker}"
            continue
        fi

        local id actor summary
        id=$(jq -r '.id // "unknown"' "${marker}" 2>/dev/null || echo "unknown")
        actor=$(jq -r '.actor // "unknown"' "${marker}" 2>/dev/null || echo "unknown")
        summary=$(jq -r '.summary // ""' "${marker}" 2>/dev/null || echo "")

        # 2. Apply: DEEP-merge `.proposed` OVER the existing config, then write
        # atomically. jq's `*` recurses into nested objects so a partial
        # proposal preserves unmentioned keys at EVERY level -- not just the
        # top (repositories.allowlist, #386) but also nested siblings like
        # trust.per_repo_overrides when only trust.system_default_level changed
        # (#507). Arrays and scalars from proposed still REPLACE the old value
        # (so a proposed allowlist overwrites the old one, per #386). Merge from
        # files (not a shell arg) so config values can't be interpolated by the
        # shell.
        local cfg_tmp="${CONFIG_FILE}.tmp.$$"
        mkdir -p "$(dirname "${CONFIG_FILE}")" 2>/dev/null || true
        [[ -f "${CONFIG_FILE}" ]] || echo '{}' > "${CONFIG_FILE}"
        if jq -s '.[0] * .[1].proposed' "${CONFIG_FILE}" "${marker}" > "${cfg_tmp}" 2>/dev/null && mv "${cfg_tmp}" "${CONFIG_FILE}"; then
            # 3. Audit (structured log line is the daemon's audit trail) + archive.
            log_info "Applied portal config change ${id} by '${actor}': ${summary}"
            mkdir -p "${applied_dir}"; mv "${marker}" "${applied_dir}/" 2>/dev/null || rm -f "${marker}"
            applied_count=$(( applied_count + 1 ))
        else
            rm -f "${cfg_tmp}" 2>/dev/null || true
            log_warn "Failed to apply config-change marker ${id}; leaving for retry: ${marker}"
        fi
    done <<< "${marker_list}"

    # Reload so applied changes take effect this run (poll interval, caps, etc.).
    if [[ ${applied_count} -gt 0 ]]; then
        load_config || log_warn "Config reload after applying ${applied_count} change(s) failed"
    fi
    return 0
}

# consume_revise_markers() -> void
#   #500. Applies portal-originated artifact-revise markers. When the operator
#   leaves comments on a rendered artifact and clicks "revise", the portal
#   writes:
#     1. a feedback artifact at
#        <repo>/.autonomous-dev/requests/<id>/artifact-feedback/<phase>.json
#     2. a marker here: <REVISE_REQUESTS_DIR>/<repo>__<id>.json
#        = { v, id, repo, phase, source:"portal", actor, ts }
#
#   For each marker this:
#     - validates parseable JSON + source=="portal" + a phase field,
#     - locates the request's canonical state.json in an allowlisted repo,
#     - SKIPS (leaves for next poll) requests that are mid-phase (status
#       "running" with a different current_phase) so we never yank a phase out
#       from under a live agent; only acts when the request is settled at a
#       gate / done-with-this-phase boundary OR already on the target phase,
#     - refuses terminal requests (done/cancelled/failed) — archives the
#       marker as obsolete,
#     - confirms the feedback artifact exists (don't reset a phase with no
#       feedback to inject),
#     - resets current_phase to the marker's phase + status=running (the same
#       jq reset the *_review-fail loopback performs) so the supervisor
#       re-dispatches the author; the re-run injects the feedback via
#       resolve_phase_prompt.
#
#   Tolerant: missing dirs/files/jq are skipped; failures are logged, not
#   fatal. Safe under `set -e`. Valid-but-not-yet-actionable markers are left
#   in place (retried next poll); applied/obsolete/invalid markers are moved
#   to applied/ or rejected/ so they never loop forever.
consume_revise_markers() {
    [[ -d "${REVISE_REQUESTS_DIR}" ]] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local repos
    repos=$(jq -r '.repositories.allowlist[]?' "${EFFECTIVE_CONFIG}" 2>/dev/null)
    [[ -z "${repos}" ]] && return 0

    local applied_dir="${REVISE_REQUESTS_DIR}/applied"
    local rejected_dir="${REVISE_REQUESTS_DIR}/rejected"

    local marker
    for marker in "${REVISE_REQUESTS_DIR}"/*.json; do
        [[ -f "${marker}" ]] || continue

        # 1. Validate JSON + source + required fields.
        if ! jq empty "${marker}" 2>/dev/null; then
            log_warn "Revise marker is corrupt JSON; rejecting: ${marker}"
            mkdir -p "${rejected_dir}"; mv "${marker}" "${rejected_dir}/" 2>/dev/null || rm -f "${marker}"
            continue
        fi
        local src req_id phase actor
        src=$(jq -r '.source // ""' "${marker}" 2>/dev/null || echo "")
        req_id=$(jq -r '.id // ""' "${marker}" 2>/dev/null || echo "")
        phase=$(jq -r '.phase // ""' "${marker}" 2>/dev/null || echo "")
        actor=$(jq -r '.actor // "operator"' "${marker}" 2>/dev/null || echo "operator")
        if [[ "${src}" != "portal" || -z "${req_id}" || -z "${phase}" ]]; then
            log_warn "Revise marker failed validation (source='${src}', id='${req_id}', phase='${phase}'); rejecting: ${marker}"
            mkdir -p "${rejected_dir}"; mv "${marker}" "${rejected_dir}/" 2>/dev/null || rm -f "${marker}"
            continue
        fi
        # Defense-in-depth: the phase becomes a filename component below.
        if [[ ! "${phase}" =~ ^[a-z][a-z0-9_-]{0,63}$ ]]; then
            log_warn "Revise marker phase '${phase}' is malformed; rejecting: ${marker}"
            mkdir -p "${rejected_dir}"; mv "${marker}" "${rejected_dir}/" 2>/dev/null || rm -f "${marker}"
            continue
        fi

        # 2. Locate the canonical state.json in an allowlisted repo.
        local repo state_file found_repo=""
        while IFS= read -r repo; do
            [[ -z "${repo}" ]] && continue
            state_file="${repo}/.autonomous-dev/requests/${req_id}/state.json"
            if [[ -f "${state_file}" ]]; then
                found_repo="${repo}"
                break
            fi
        done <<< "${repos}"

        if [[ -z "${found_repo}" ]]; then
            # The request isn't in any allowlisted repo (yet?). Leave the
            # marker for a later poll rather than rejecting — the request may
            # be created shortly. (reconcile cadence bounds the retry.)
            log_info "consume_revise_markers: no state.json for ${req_id} yet; leaving marker"
            continue
        fi
        state_file="${found_repo}/.autonomous-dev/requests/${req_id}/state.json"

        local s_status s_phase
        s_status=$(jq -r '.status // ""' "${state_file}" 2>/dev/null || echo "")
        s_phase=$(jq -r '.current_phase // ""' "${state_file}" 2>/dev/null || echo "")

        # 3. Terminal requests can't be revised — archive as obsolete.
        case "${s_status}" in
            done|cancelled|failed)
                log_info "consume_revise_markers: ${req_id} is terminal (${s_status}); discarding revise marker"
                mkdir -p "${applied_dir}"; mv "${marker}" "${applied_dir}/" 2>/dev/null || rm -f "${marker}"
                continue
                ;;
        esac

        # 4. Don't yank a phase out from under a live agent: if the request is
        #    actively running a DIFFERENT phase, defer until it settles.
        if [[ "${s_status}" == "running" && -n "${s_phase}" && "${s_phase}" != "${phase}" ]]; then
            log_info "consume_revise_markers: ${req_id} running ${s_phase}; deferring revise to ${phase}"
            continue
        fi

        # 5. Require the feedback artifact (nothing to inject otherwise).
        local feedback_file="${found_repo}/.autonomous-dev/requests/${req_id}/artifact-feedback/${phase}.json"
        if [[ ! -f "${feedback_file}" ]]; then
            log_warn "consume_revise_markers: feedback artifact missing for ${req_id} ${phase}; rejecting marker"
            mkdir -p "${rejected_dir}"; mv "${marker}" "${rejected_dir}/" 2>/dev/null || rm -f "${marker}"
            continue
        fi

        # 6. Reset current_phase to the author phase + status=running (mirrors
        #    the *_review-fail loopback). The supervisor re-dispatches it next
        #    selection; resolve_phase_prompt injects the feedback.
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        local tmp="${state_file}.tmp.$$"
        if jq --arg phase "${phase}" --arg ts "${ts}" \
              '.current_phase = $phase | .status = "running" | .updated_at = $ts' \
              "${state_file}" > "${tmp}" 2>/dev/null && mv "${tmp}" "${state_file}"; then
            sync_intake_db_row "${req_id}" "${phase}" "running" "${ts}" 2>/dev/null || true
            write_portal_request_action "${req_id}" "${found_repo}" 2>/dev/null || true
            log_info "Applied operator revise for ${req_id} by '${actor}': reset to author phase ${phase}"
            mkdir -p "${applied_dir}"; mv "${marker}" "${applied_dir}/" 2>/dev/null || rm -f "${marker}"
        else
            rm -f "${tmp}" 2>/dev/null || true
            log_warn "consume_revise_markers: failed to reset ${req_id} to ${phase}; leaving marker for retry"
        fi
    done
    return 0
}

# reconcile_orphans() -> void
#   Reconcile orphan SQLite rows and state.json files per SPEC-039-1-04.
#   Runs at startup and every RECONCILE_EVERY_N_POLLS iterations.
#
#   Implementation note: shells out to the `sqlite3` CLI rather than to
#   `node` + `better-sqlite3`. The latter requires a native binding that
#   is rebuilt per Node version; under newer Node releases the cached
#   plugin's prebuilt binding is missing and every reconcile iteration
#   logged "Failed to query orphan SQLite rows". The `sqlite3` CLI ships
#   with macOS and is a hard transitive dependency anyway (the daemon
#   reads/writes the same intake.db), so this removes a runtime failure
#   mode without changing semantics.
reconcile_orphans() {
    log_info "Starting orphan reconciliation"

    if ! command -v sqlite3 >/dev/null 2>&1; then
        log_error "Orphan reconciliation requires the sqlite3 CLI; skipping"
        return 1
    fi

    if [[ ! -f "$INTAKE_DB" ]]; then
        log_info "Intake DB ${INTAKE_DB} not present; skipping orphan reconciliation"
        return 0
    fi

    # Cutoff = now minus 24 hours, in the same ISO8601-with-millis format the
    # intake DB stores (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')). The string is
    # lexicographically comparable in that format, so a literal `<` works.
    local cutoff
    cutoff=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null \
        || date -u -d "24 hours ago" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null \
        || true)
    if [[ -z "$cutoff" ]]; then
        log_error "Failed to compute reconciliation cutoff timestamp"
        return 1
    fi

    # Find orphan SQLite rows (queued + older than 24h). Open the database
    # read-only so the reconciliation pass cannot accidentally lock the
    # writer path. COALESCE protects against NULL target_repo, which would
    # otherwise yield a blank field and confuse the IFS='|' read below.
    local orphan_rows
    if ! orphan_rows=$(sqlite3 -readonly -separator '|' "$INTAKE_DB" \
            "SELECT request_id, COALESCE(target_repo, ''), created_at
             FROM requests
             WHERE status = 'queued'
               AND created_at < '${cutoff}'
             ORDER BY created_at ASC;" 2>/dev/null); then
        log_error "Failed to query orphan SQLite rows"
        return 1
    fi

    # Process each orphan SQLite row
    while IFS='|' read -r request_id target_repo created_at; do
        [[ -z "$request_id" ]] && continue

        # Check if state.json exists
        local state_file="${target_repo}/.autonomous-dev/requests/${request_id}/state.json"
        if [[ -n "$target_repo" && ! -f "$state_file" ]]; then
            log_info "Marking orphan SQLite row as cancelled: ${request_id} (state file missing)"
            local now_iso
            now_iso=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
            # Use parameter binding to avoid SQL injection from request_id /
            # reason. sqlite3 CLI supports `.parameter set` since 3.43.
            if sqlite3 "$INTAKE_DB" <<SQL >/dev/null 2>&1
.parameter set :rid '${request_id//\'/\'\'}'
.parameter set :reason 'state-file-lost'
.parameter set :now '${now_iso}'
UPDATE requests
   SET status = 'cancelled',
       cancelled_reason = :reason,
       updated_at = :now
 WHERE request_id = :rid;
SQL
            then
                # Write portal request action for the cancelled orphan
                write_portal_request_action "$request_id" "$target_repo"
            else
                log_error "Failed to mark ${request_id} as cancelled"
            fi
        fi
    done <<< "$orphan_rows"

    # Find orphan state.json files
    local known_repos
    known_repos=$(jq -r '.repositories.allowlist[]?' "$EFFECTIVE_CONFIG" 2>/dev/null || echo "")

    while read -r repo_path; do
        [[ -z "$repo_path" || ! -d "$repo_path" ]] && continue
        local requests_dir="${repo_path}/.autonomous-dev/requests"
        [[ ! -d "$requests_dir" ]] && continue

        # Walk through state.json files
        while IFS= read -r -d '' state_file; do
            # Extract request_id from path
            local req_dir
            req_dir=$(dirname "$state_file")
            local request_id
            request_id=$(basename "$req_dir")

            # Check if SQLite row exists. Quote single-quotes in request_id to
            # avoid breaking out of the SQL literal (request IDs are typically
            # alphanumeric but defense-in-depth is cheap here).
            local escaped_id="${request_id//\'/\'\'}"
            local row_count
            if row_count=$(sqlite3 -readonly "$INTAKE_DB" \
                    "SELECT COUNT(*) FROM requests WHERE request_id = '${escaped_id}';" 2>/dev/null); then
                if [[ "$row_count" == "0" ]]; then
                    log_warn "Orphan state.json file found: ${state_file} (no SQLite row for ${request_id})"
                fi
            else
                log_warn "Failed to check SQLite row for ${request_id}"
            fi
        done < <(find "$requests_dir" -name "state.json" -print0 2>/dev/null || true)
    done <<< "$known_repos"

    log_info "Orphan reconciliation complete"
}

# reconcile_portal_markers() -> void
#   #390 daemon half. Portal request-action markers and gate-decision files
#   go stale when a request reaches a terminal state outside the supervisor's
#   phase-advance path (CLI cancel runs in a different process; the failed
#   path historically skipped gate cleanup; crashes skip everything). Sweep
#   every marker against its canonical state.json: refresh markers whose
#   status disagrees on terminality, and remove gate-decision files for
#   terminal requests so the portal can never resurrect them as in-gate.
#   Tolerant: missing dirs/files are skipped; failures are logged, not fatal.
reconcile_portal_markers() {
    [[ -d "${PORTAL_REQUEST_ACTIONS_DIR}" ]] || return 0
    local repos
    repos=$(jq -r '.repositories.allowlist[]?' "${EFFECTIVE_CONFIG}" 2>/dev/null)
    [[ -z "${repos}" ]] && return 0

    local marker req_id m_status repo state_file s_status
    for marker in "${PORTAL_REQUEST_ACTIONS_DIR}"/*.json; do
        [[ -f "$marker" ]] || continue
        req_id=$(jq -r '.id // empty' "$marker" 2>/dev/null)
        [[ -z "$req_id" ]] && continue
        m_status=$(jq -r '.status // empty' "$marker" 2>/dev/null)
        # Terminal markers are already correct; nothing to reconcile.
        case "$m_status" in
            done|cancelled|failed) continue ;;
        esac
        # Find the request's canonical state.json in an allowlisted repo.
        while IFS= read -r repo; do
            [[ -z "$repo" ]] && continue
            state_file="${repo}/.autonomous-dev/requests/${req_id}/state.json"
            [[ -f "$state_file" ]] || continue
            s_status=$(jq -r '.status // empty' "$state_file" 2>/dev/null)
            case "$s_status" in
                done|cancelled|failed)
                    log_info "reconcile_portal_markers: refreshing stale marker for ${req_id} (marker=${m_status:-unset} state=${s_status})"
                    write_portal_request_action "$req_id" "$repo"
                    rm -f "${GATE_DECISIONS_DIR}/$(basename "$repo")__${req_id}.json" 2>/dev/null || true
                    ;;
            esac
            break
        done <<< "${repos}"
    done
}

###############################################################################
# Marketplace auto-update
###############################################################################

# check_upgrade_available() -> int
#   Composes the version-helpers primitives to see if a newer plugin
#   version is sitting in the cache. Logs `daemon_upgrade_available`
#   once per distinct newer version. When called from an idle context
#   (no active request) it also attempts to stage the upgrade —
#   `stage_upgrade()` enforces the throttle and the active-request
#   guard, so this function is safe to call from any iteration.
check_upgrade_available() {
    # shellcheck disable=SC1091
    source "${LIB_DIR}/version-helpers.sh"
    local running latest cmp
    running=$(current_version "${BASH_SOURCE[0]}")
    if [[ "${running}" == "unknown" ]]; then
        # The script isn't running from the plugin cache layout (likely
        # a dev checkout). Self-upgrade doesn't apply.
        return 0
    fi
    latest=$(latest_cached_version)
    if [[ -z "${latest}" ]]; then
        return 0
    fi
    cmp=$(compare_semver "${running}" "${latest}")
    if [[ "${cmp}" != "-1" ]]; then
        return 0
    fi
    if [[ "${LAST_UPGRADE_LOGGED_VERSION}" != "${latest}" ]]; then
        log_info "daemon_upgrade_available: running=${running} latest=${latest} cache=${HOME}/.claude/plugins/cache/autonomous-dev/autonomous-dev/${latest}"
        LAST_UPGRADE_LOGGED_VERSION="${latest}"
    fi
    # Phase 2: try to stage the upgrade. stage_upgrade is the gatekeeper —
    # it skips when active, throttled, or the helper script is missing.
    stage_upgrade "${running}" "${latest}" || true
    return 0
}

# upgrade_throttled() -> 0 if a previous attempt is still within
# UPGRADE_THROTTLE_SECONDS, 1 otherwise.
upgrade_throttled() {
    if [[ ! -f "${UPGRADE_THROTTLE_FILE}" ]]; then
        return 1
    fi
    local last_mtime now age
    last_mtime=$(stat -f %m "${UPGRADE_THROTTLE_FILE}" 2>/dev/null \
        || stat -c %Y "${UPGRADE_THROTTLE_FILE}" 2>/dev/null \
        || echo 0)
    now=$(date +%s)
    age=$(( now - last_mtime ))
    if (( age < UPGRADE_THROTTLE_SECONDS )); then
        return 0
    fi
    return 1
}

# stage_upgrade(from_version, to_version) -> int
#   Detached helper that rewrites the plist for the new version and
#   bootouts/bootstraps via launchctl. The running daemon exits 0 so
#   `KeepAlive.SuccessfulExit: false` doesn't auto-respawn the old
#   path. Detached helper then bootstraps the new version.
#
#   Skipped when:
#     - The heartbeat reports an active request (don't upgrade mid-phase)
#     - The throttle file says we attempted within the last hour
#     - The new version's install-daemon.sh isn't readable
stage_upgrade() {
    local from_version="${1:-}"
    local to_version="${2:-}"
    if [[ -z "${to_version}" || "${to_version}" == "${from_version}" ]]; then
        return 1
    fi

    # Guard: don't upgrade mid-request. The heartbeat is the authoritative
    # source — we wrote it at the top of this iteration.
    local active_id
    active_id=$(jq -r '.active_request_id // empty' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -n "${active_id}" ]]; then
        return 1
    fi

    if upgrade_throttled; then
        return 1
    fi

    local cache_root="${HOME}/.claude/plugins/cache/autonomous-dev/autonomous-dev"
    local installer="${cache_root}/${to_version}/bin/install-daemon.sh"
    if [[ ! -x "${installer}" && ! -r "${installer}" ]]; then
        log_warn "stage_upgrade: installer not readable at ${installer}; skipping"
        return 1
    fi

    # Record current as last-known-good BEFORE handing off. Phase 3 reads
    # this to roll back if the new daemon doesn't settle.
    echo "${from_version}" > "${LAST_GOOD_VERSION_FILE}"
    touch "${UPGRADE_THROTTLE_FILE}"

    # Phase 3: leave a trial flag with the target version + deadline.
    # The new daemon reads it on startup; clears it after probation
    # iterations; or rolls back if the deadline passes without clearing.
    local deadline now
    now=$(date +%s)
    deadline=$(( now + UPGRADE_TRIAL_DEADLINE_SECONDS ))
    jq -n --arg target "${to_version}" --arg from "${from_version}" \
        --argjson started "${now}" --argjson deadline "${deadline}" \
        '{target: $target, from: $from, started: $started, deadline: $deadline}' \
        > "${UPGRADE_TRIAL_FLAG}" 2>/dev/null || true

    log_info "daemon_upgrade_staging: from=${from_version} to=${to_version} installer=${installer} trial_deadline=${deadline}"

    # Spawn the upgrade helper as a SEPARATE OS-managed job (not a
    # detached subshell). The 2026-05-18 v0.3.0 → v0.3.1 live trial
    # established that `nohup ... &` + `disown` does NOT survive
    # launchd's job reap on macOS — the subshell gets killed when the
    # supervisor exits, before install-daemon.sh can run. A separate
    # launchd job has its own lifecycle and survives our exit.
    #
    # Linux fallback uses systemd-run --user --no-block to register a
    # transient unit; same idea, different supervisor.
    if ! _spawn_upgrade_helper "${installer}"; then
        log_error "daemon_upgrade_helper_spawn_failed: could not bootstrap upgrade helper. Aborting upgrade."
        return 1
    fi

    log_info "daemon_upgrade_exiting: exiting cleanly so launchd respawns under ${to_version}"
    # Mark shutdown so the main loop terminates after this iteration.
    SHUTDOWN_REQUESTED=true
    return 0
}

# _spawn_upgrade_helper(installer_path) -> int
#   Spawns the install-daemon.sh command as a SEPARATE OS-managed job
#   so it survives the supervisor's exit. This is the fix for the
#   2026-05-18 first-live-trial bug where nohup+disown didn't survive
#   launchd's process-tree reap.
#
#   macOS: renders a one-shot launchd plist + bootstraps it
#   Linux: uses systemd-run --user --no-block (transient unit)
#   Other: falls back to the old nohup pattern (best-effort)
_spawn_upgrade_helper() {
    local installer="$1"
    case "$(uname -s)" in
        Darwin) _spawn_upgrade_helper_macos "${installer}" ;;
        Linux)  _spawn_upgrade_helper_linux "${installer}" ;;
        *)      _spawn_upgrade_helper_fallback "${installer}" ;;
    esac
}

_spawn_upgrade_helper_macos() {
    local installer="$1"
    local upgrader_label="com.autonomous-dev.daemon.upgrader"
    local upgrader_plist="${HOME}/Library/LaunchAgents/${upgrader_label}.plist"
    local template="${PLUGIN_DIR}/templates/com.autonomous-dev.daemon.upgrader.plist.template"

    if [[ ! -f "${template}" ]]; then
        log_warn "_spawn_upgrade_helper_macos: template missing at ${template}; falling back to nohup"
        _spawn_upgrade_helper_fallback "${installer}"
        return $?
    fi

    # Find a usable bash 4+ — same logic as install-daemon.sh's resolve_paths
    local bash_path=""
    local candidate version
    for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash; do
        if [[ -x "${candidate}" ]]; then
            version=$("${candidate}" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo "0")
            if [[ ${version} -ge 4 ]]; then
                bash_path="${candidate}"
                break
            fi
        fi
    done
    # macOS system bash is 3.2; if no 4+ is on disk we still need a bash to
    # run the installer. Use /bin/bash as a last resort — install-daemon.sh
    # itself uses bash 3.2-safe idioms.
    [[ -z "${bash_path}" ]] && bash_path="/bin/bash"

    # Live-trial 2 (v0.3.2 → v0.3.3 on 2026-05-18) revealed that the
    # upgrader job's PATH must include wherever the `claude` CLI lives,
    # because install-daemon.sh calls `command -v claude` to compute
    # EXTRA_PATH_DIRS for the daemon plist it renders. If `claude`
    # isn't in PATH at that moment, the new daemon's plist gets a
    # stripped PATH and FATAL-exits with "Missing required commands:
    # claude".
    #
    # Fix: inject the SUPERVISOR's current PATH into the upgrader plist.
    # The supervisor is running, has a working PATH (otherwise the
    # daemon wouldn't have started). Bash escapes for sed: we use a
    # delimiter that won't appear in PATH (#) and strip any & chars.
    local path_value="${PATH//&/\&}"

    # Render the upgrader plist
    sed \
        -e "s|{{BASH_PATH}}|${bash_path}|g" \
        -e "s|{{INSTALLER_PATH}}|${installer}|g" \
        -e "s|{{DAEMON_HOME}}|${DAEMON_HOME}|g" \
        -e "s|{{USER_HOME}}|${HOME}|g" \
        -e "s#{{PATH_VALUE}}#${path_value}#g" \
        "${template}" > "${upgrader_plist}"

    if ! plutil -lint "${upgrader_plist}" >/dev/null 2>&1; then
        log_warn "_spawn_upgrade_helper_macos: rendered plist failed plutil -lint; falling back to nohup"
        rm -f "${upgrader_plist}"
        _spawn_upgrade_helper_fallback "${installer}"
        return $?
    fi

    # If a previous upgrader is still loaded (shouldn't be — they're
    # one-shot — but defend), bootout first.
    if launchctl print "gui/$(id -u)/${upgrader_label}" >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)/${upgrader_label}" 2>/dev/null || true
    fi

    # Bootstrap — RunAtLoad=true in the template means it starts immediately
    if ! launchctl bootstrap "gui/$(id -u)" "${upgrader_plist}" 2>/dev/null; then
        log_warn "_spawn_upgrade_helper_macos: launchctl bootstrap failed; falling back to nohup"
        _spawn_upgrade_helper_fallback "${installer}"
        return $?
    fi

    log_info "daemon_upgrade_helper_launched: macos/launchd label=${upgrader_label} installer=${installer}"
    return 0
}

_spawn_upgrade_helper_linux() {
    local installer="$1"
    if ! command -v systemd-run >/dev/null 2>&1; then
        _spawn_upgrade_helper_fallback "${installer}"
        return $?
    fi
    if systemd-run --user --no-block \
        --unit="autonomous-dev-upgrader-$(date +%s)" \
        --description="autonomous-dev daemon self-upgrade helper" \
        bash -c "'${installer}' --force" \
        >/dev/null 2>&1
    then
        log_info "daemon_upgrade_helper_launched: linux/systemd-run installer=${installer}"
        return 0
    fi
    _spawn_upgrade_helper_fallback "${installer}"
}

_spawn_upgrade_helper_fallback() {
    local installer="$1"
    # Best-effort detached spawn — known to be unreliable on macOS but
    # the only option when launchctl/systemd-run aren't available.
    nohup bash -c "sleep 2 && '${installer}' --force" \
        </dev/null \
        >"${LOG_DIR}/upgrade-helper.log" 2>&1 &
    disown $! 2>/dev/null || true
    log_warn "daemon_upgrade_helper_launched_fallback: using nohup detach (may be reaped by parent). If new daemon doesn't come up within ~10s, run '${installer} --force' manually."
    return 0
}

# check_upgrade_trial() -> int
#   Called once at daemon startup. Reads the trial flag (if any) and
#   decides one of three outcomes:
#     1. No flag, or flag is stale (different target than us, or no
#        valid JSON) — clear and return.
#     2. Flag targets us, deadline not yet passed — enter probation
#        (UPGRADE_TRIAL_PENDING=true). The main loop will clear the
#        flag after UPGRADE_TRIAL_PROBATION_ITERATIONS healthy ticks.
#     3. Flag targets us, deadline has passed — previous starts of
#        this version must have crash-looped (we never made it to
#        probation-clear). Roll back to .last-good-version by
#        spawning a detached install-daemon.sh for that version, then
#        exit. Mirrors stage_upgrade's mechanism but in reverse.
check_upgrade_trial() {
    if [[ ! -f "${UPGRADE_TRIAL_FLAG}" ]]; then
        return 0
    fi
    # shellcheck disable=SC1091
    source "${LIB_DIR}/version-helpers.sh"
    local my_version target deadline now last_good installer
    my_version=$(current_version "${BASH_SOURCE[0]}")
    target=$(jq -r '.target // empty' "${UPGRADE_TRIAL_FLAG}" 2>/dev/null || echo "")
    deadline=$(jq -r '.deadline // 0' "${UPGRADE_TRIAL_FLAG}" 2>/dev/null || echo 0)
    if [[ -z "${target}" ]]; then
        rm -f "${UPGRADE_TRIAL_FLAG}"
        return 0
    fi
    if [[ "${target}" != "${my_version}" ]]; then
        # Flag is for a different version — leftover from a different
        # upgrade attempt. The new daemon (if any) will manage it.
        return 0
    fi
    now=$(date +%s)
    if (( now <= deadline )); then
        log_info "upgrade_trial_probation: target=${target} deadline=${deadline} now=${now}"
        UPGRADE_TRIAL_PENDING=true
        return 0
    fi
    # Deadline passed without the previous run clearing the flag.
    # We assume crash-loop and try to roll back to last-good.
    if [[ ! -f "${LAST_GOOD_VERSION_FILE}" ]]; then
        log_warn "upgrade_trial_failed but no .last-good-version on disk; clearing flag and continuing"
        rm -f "${UPGRADE_TRIAL_FLAG}"
        return 0
    fi
    last_good=$(cat "${LAST_GOOD_VERSION_FILE}" 2>/dev/null || echo "")
    if [[ -z "${last_good}" || "${last_good}" == "${my_version}" ]]; then
        rm -f "${UPGRADE_TRIAL_FLAG}"
        return 0
    fi
    installer="${HOME}/.claude/plugins/cache/autonomous-dev/autonomous-dev/${last_good}/bin/install-daemon.sh"
    if [[ ! -r "${installer}" ]]; then
        log_warn "upgrade_trial_failed but rollback installer missing at ${installer}; clearing flag"
        rm -f "${UPGRADE_TRIAL_FLAG}"
        return 0
    fi
    log_warn "upgrade_trial_failed: rolling back ${my_version} → ${last_good}"
    rm -f "${UPGRADE_TRIAL_FLAG}"
    nohup bash -c "sleep 2 && '${installer}' --force" \
        </dev/null \
        >>"${LOG_DIR}/upgrade-helper.log" 2>&1 &
    disown $! 2>/dev/null || true
    # Exit ourselves so launchd respawns from the rolled-back plist.
    SHUTDOWN_REQUESTED=true
    return 0
}

# clear_upgrade_trial_if_probation_passed() -> int
#   Called inside the main loop. When we're in probation
#   (UPGRADE_TRIAL_PENDING=true) and we've reached the iteration
#   threshold, clear the flag — the new version has proven itself.
clear_upgrade_trial_if_probation_passed() {
    if [[ "${UPGRADE_TRIAL_PENDING}" != "true" ]]; then
        return 0
    fi
    if (( ITERATION_COUNT < UPGRADE_TRIAL_PROBATION_ITERATIONS )); then
        return 0
    fi
    rm -f "${UPGRADE_TRIAL_FLAG}" 2>/dev/null || true
    UPGRADE_TRIAL_PENDING=false
    log_info "upgrade_trial_passed: cleared trial flag at iteration ${ITERATION_COUNT}"
    return 0
}

###############################################################################
# Main Loop
###############################################################################

# main_loop() -> void
#   The main supervisor loop. Polls for work, dispatches sessions, and
#   handles graceful shutdown. Gate checks run at the top of each iteration
#   and can block work selection.
main_loop() {
    while true; do
        ITERATION_COUNT=$(( ITERATION_COUNT + 1 ))
        POLL_COUNT=$(( POLL_COUNT + 1 ))
        write_heartbeat

        # Run orphan reconciliation on first poll and every N polls
        if [[ $(( POLL_COUNT % RECONCILE_EVERY_N_POLLS )) -eq 1 ]]; then
            reconcile_orphans || log_error "Orphan reconciliation failed"
            reconcile_portal_markers || log_error "Portal marker reconciliation failed"
        fi

        # Issue #501: scan terminal/awaiting-human requests for new PR review
        # comments and re-enter them into the code phase to address them. Runs
        # off the hot path (same cadence as reconcile) and is bounded per
        # request by MAX_PR_COMMENT_REENTRIES. Never aborts the loop.
        if [[ $(( POLL_COUNT % PR_COMMENT_SCAN_EVERY_N_POLLS )) -eq 1 ]]; then
            reenter_pr_comment_requests || log_error "PR-comment re-entry scan failed"
        fi

        # Apply any portal-originated config-change markers (PRD-025 FR-025-05).
        consume_config_changes || log_error "Config-change consumption failed"

        # #500 — apply any portal-originated artifact-revise markers (reset the
        # author phase so the supervisor re-runs it with operator feedback).
        consume_revise_markers || log_error "Revise-marker consumption failed"

        # Marketplace auto-update.
        if [[ $(( POLL_COUNT % UPGRADE_CHECK_EVERY_N_POLLS )) -eq 1 ]]; then
            check_upgrade_available || true
        fi
        # Phase 3: if we're in trial probation, clear the trial flag once
        # we've completed enough healthy iterations.
        clear_upgrade_trial_if_probation_passed || true

        # Check shutdown flag
        if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
            log_info "Shutdown requested. Exiting main loop."
            break
        fi

        # Gate checks (kill switch, circuit breaker, cost caps)
        if ! check_gates; then
            sleep "${POLL_INTERVAL}" &
            local sleep_pid=$!
            wait "${sleep_pid}" 2>/dev/null || true
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue
        fi

        # Select highest-priority actionable request across all repos
        local selection
        selection=$(select_request)

        if [[ -z "${selection}" ]]; then
            idle_backoff_sleep
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue
        fi

        # Work found -- dispatch session
        idle_backoff_reset

        local request_id project
        IFS='|' read -r request_id project <<< "${selection}"
        log_info "Work selected: request=${request_id} project=${project}"

        # Check for intake -> prd auto-transition
        if intake_to_prd_if_needed "$request_id" "$project"; then
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue  # Poll again to pick up under phase prd
        fi

        # Dispatch a Claude session for the selected request
        local session_result
        session_result=$(dispatch_phase_session "${request_id}" "${project}")

        local exit_code session_cost output_file
        IFS='|' read -r exit_code session_cost output_file <<< "${session_result}"

        # PRD-025 FR-025-12: an API rate limit is a transient infra condition,
        # not a code failure. Detect it in the session output BEFORE the normal
        # branching: record the cost already incurred, advance the backoff state
        # machine, and re-poll (the phase is left in place to retry once the
        # backoff window — enforced by check_gates -> check_rate_limit_state —
        # elapses). Do NOT record_crash or advance the phase.
        if declare -F detect_rate_limit >/dev/null 2>&1 \
           && [[ -f "${output_file}" ]] \
           && detect_rate_limit "$(cat "${output_file}" 2>/dev/null || echo "")"; then
            log_warn "API rate limit detected for ${request_id}; engaging exponential backoff (phase retained for retry)."
            update_state_cost "${request_id}" "${project}" "${session_cost}" || true
            update_cost_ledger "${session_cost}" "${request_id}" || true
            handle_rate_limit "$(cat "${EFFECTIVE_CONFIG}" 2>/dev/null || echo '{}')" || true
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue
        fi

        # Post-session state update, crash tracking, and cost ledger
        # Three-way branching: turn exhaustion / success / hard failure (SPEC-001-3-02)
        if [[ ${exit_code} -ne 0 ]] && detect_turn_exhaustion "${exit_code}" "${output_file}"; then
            # Turn exhaustion: treat as soft failure
            local current_phase
            current_phase=$(jq -r '.current_phase // .status' "${project}/.autonomous-dev/requests/${request_id}/state.json" 2>/dev/null || echo "unknown")
            log_warn "Turn budget exhausted for ${request_id}. Consider increasing max_turns for phase '${current_phase}'."
            log_warn "Hint: Set daemon.max_turns_by_phase.${current_phase} in ~/.claude/autonomous-dev.json"

            # Still counts as an error for retry purposes, but does NOT trip the circuit breaker
            update_state_cost "${request_id}" "${project}" "${session_cost}"
            update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
            check_retry_exhaustion "${request_id}" "${project}"
            # Do NOT call record_crash -- turn exhaustion is not a crash
            update_cost_ledger "${session_cost}" "${request_id}"
        elif [[ ${exit_code} -eq 0 ]]; then
            record_success
            # A clean session clears any rate-limit backoff so the consecutive
            # counter resets (PRD-025 FR-025-12).
            if declare -F clear_rate_limit_state >/dev/null 2>&1; then
                clear_rate_limit_state || true
            fi
            update_state_cost "${request_id}" "${project}" "${session_cost}"
            advance_phase "${request_id}" "${project}"
            update_cost_ledger "${session_cost}" "${request_id}"
        else
            record_crash "${request_id}" "${exit_code}"
            update_state_cost "${request_id}" "${project}" "${session_cost}"
            update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
            check_retry_exhaustion "${request_id}" "${project}"
            update_cost_ledger "${session_cost}" "${request_id}"
        fi

        # PRD-025 FR-025-11: after the session's cost is recorded, pause the
        # request if it has reached the per-request cost cap (guards against a
        # single request burning the whole budget).
        check_per_request_cost_cap "${request_id}" "${project}"

        # Log rotation and cleanup (SPEC-001-3-04 Task 11)
        rotate_logs_if_needed
        cleanup_old_logs

        # Check for shutdown after session completes
        if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
            log_info "Shutdown requested after session. Exiting."
            break
        fi

        [[ "${ONCE_MODE}" == "true" ]] && break
    done
}

###############################################################################
# Main Entry Point
###############################################################################

# Source the legacy phase sequence once at startup
# shellcheck source=bin/lib/phase-legacy.sh
if [[ -f "${LIB_DIR}/phase-legacy.sh" ]]; then
    source "${LIB_DIR}/phase-legacy.sh"
fi

# Source shared phase helper functions
# shellcheck source=bin/lib/phase-helpers.sh
if [[ -f "${LIB_DIR}/phase-helpers.sh" ]]; then
    source "${LIB_DIR}/phase-helpers.sh"
fi

# Source typed-limits helpers (resolve_dispatch_timeout, coerce_timeout_to_seconds,
# resolve_max_soft_timeout_reentries, and existing resolve_max_retries / resolve_phase_timeout).
# Sourced here so dispatch_phase_session can call resolve_dispatch_timeout without
# conditionally re-sourcing inside the function body.
# shellcheck source=bin/lib/typed-limits.sh
if [[ -f "${LIB_DIR}/typed-limits.sh" ]]; then
    source "${LIB_DIR}/typed-limits.sh"
fi

# Rate-limit detection + exponential-backoff state machine (PRD-025 FR-025-12).
# Provides detect_rate_limit / handle_rate_limit / check_rate_limit_state /
# clear_rate_limit_state. Its logging is self-contained and delegates to this
# daemon's loggers when present. Both files run `set -euo pipefail`, so sourcing
# introduces no shell-option change.
# shellcheck source=lib/rate_limit_handler.sh
if [[ -f "${PLUGIN_DIR}/lib/rate_limit_handler.sh" ]]; then
    source "${PLUGIN_DIR}/lib/rate_limit_handler.sh"
fi

# Guard: allow the script to be sourced for unit testing without executing main.
# When sourced, the caller can invoke individual functions directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    parse_args "$@"

    # Ensure daemon home, log, and alerts directories exist before any logging or lock ops
    mkdir -p "$DAEMON_HOME"
    mkdir -p "$LOG_DIR"
    mkdir -p "$ALERTS_DIR"
    mkdir -p "$PORTAL_REQUEST_ACTIONS_DIR"
    mkdir -p "$GATE_DECISIONS_DIR"

    log_info "Daemon starting (PID $$, once_mode=${ONCE_MODE})"

    # Validate all required dependencies before acquiring lock
    validate_dependencies

    # Acquire single-instance lock and register cleanup trap.
    # The EXIT trap handles both lock release and effective config cleanup.
    acquire_lock
    trap 'cleanup_effective_config; release_lock' EXIT

    # Record this instance's start time (#356) so the heartbeat can report uptime.
    DAEMON_START_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    # Load and merge configuration (defaults + optional user overrides)
    # Must happen before stale heartbeat detection, as recovery scans repos from config.
    load_config

    # Detect stale heartbeat from prior crash or sleep/wake event
    detect_stale_heartbeat

    # Load crash state from persistent file (SPEC-001-3-01)
    load_crash_state

    # Initialize cost ledger if it does not exist
    initialize_cost_ledger

    # Marketplace auto-update Phase 3: check the trial flag. If we are
    # the target of a still-running trial, enter probation. If the trial
    # deadline has passed, roll back to .last-good-version and exit.
    check_upgrade_trial || true

    # Enter the main supervisor loop
    main_loop

    log_info "Daemon exiting cleanly (iterations=${ITERATION_COUNT})"
fi
