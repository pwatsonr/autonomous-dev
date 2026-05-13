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

readonly PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
readonly LIB_DIR="${PLUGIN_DIR}/bin/lib"
readonly DAEMON_HOME="${HOME}/.autonomous-dev"
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
IDLE_BACKOFF_CURRENT=30
IDLE_BACKOFF_BASE=30
ONCE_MODE=false
SHUTDOWN_REQUESTED=false
CURRENT_CHILD_PID=""
ITERATION_COUNT=0
EFFECTIVE_CONFIG=""
CONSECUTIVE_CRASHES=0
CIRCUIT_BREAKER_TRIPPED=false
POLL_COUNT=0
RECONCILE_EVERY_N_POLLS=${RECONCILE_EVERY_N_POLLS:-60}

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
#   to get the cap). Warns once per process when absent.
_TIMEOUT_BIN_WARNED=false
resolve_timeout_bin() {
    local bin
    bin=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || echo "")
    if [[ -z "${bin}" && "${_TIMEOUT_BIN_WARNED}" != "true" ]]; then
        log_warn "Neither 'timeout' nor 'gtimeout' found; phase sessions will run without a wall-clock cap. Install GNU coreutils (e.g. 'brew install coreutils') to enable it."
        _TIMEOUT_BIN_WARNED=true
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
        '{
            timestamp: $ts,
            pid: $pid,
            iteration_count: $iter,
            active_request_id: (if $req == "null" then null else $req end)
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

    # 2/3. Merge with user config or use defaults as-is
    if [[ -f "${CONFIG_FILE}" ]]; then
        # Validate user config is valid JSON
        if ! jq empty "${CONFIG_FILE}" 2>/dev/null; then
            log_error "User config is invalid JSON: ${CONFIG_FILE}"
            exit 1
        fi
        # Deep recursive merge: defaults * user_config
        EFFECTIVE_CONFIG=$(mktemp "${DAEMON_HOME}/effective-config.XXXXXX.json")
        jq -s '.[0] * .[1]' "${DEFAULTS_FILE}" "${CONFIG_FILE}" > "${EFFECTIVE_CONFIG}"
    else
        # No user config -- use defaults as-is
        EFFECTIVE_CONFIG=$(mktemp "${DAEMON_HOME}/effective-config.XXXXXX.json")
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
    LOG_MAX_SIZE_MB=$(jq -r '.daemon.log_max_size_mb // 50' "${EFFECTIVE_CONFIG}")
    LOG_RETENTION_DAYS=$(jq -r '.daemon.log_retention_days // 7' "${EFFECTIVE_CONFIG}")
    DAILY_COST_CAP=$(jq -r '.daemon.daily_cost_cap_usd // 50.00' "${EFFECTIVE_CONFIG}")
    MONTHLY_COST_CAP=$(jq -r '.daemon.monthly_cost_cap_usd // 500.00' "${EFFECTIVE_CONFIG}")

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

            # Filter non-actionable states
            case "${status}" in
                paused|failed|cancelled|monitor) continue ;;
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

    local overrides_len
    overrides_len=$(jq -r '(.phase_overrides // []) | length' "${state_file}" 2>/dev/null || echo "0")

    local -a phases=()
    if [[ "${overrides_len}" -gt 0 ]]; then
        # v1.1 path: read phase_overrides[] in order
        local phases_raw
        phases_raw=$(jq -r '.phase_overrides[]' "${state_file}" 2>/dev/null || true)
        while IFS= read -r p; do
            [[ -n "${p}" ]] && phases+=("${p}")
        done <<< "${phases_raw}"
    else
        # v1.0 fallback: source legacy sequence and warn once
        # shellcheck source=lib/phase-legacy.sh
        source "${LIB_DIR}/phase-legacy.sh"
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

# resolve_phase_budget(phase: string) -> string
#   Determines the budget (USD) for a given phase. Checks the effective config
#   for a phase-specific override first; falls back to built-in defaults.
#
# Arguments:
#   $1 -- phase: The current phase name (e.g., "code", "intake").
#
# Stdout:
#   Budget amount as string (e.g., "10.0").
resolve_phase_budget() {
    local phase="${1:-}"

    local budget
    budget=$(jq -r ".daemon.max_budget_usd_by_phase.\"${phase}\" // null" "${EFFECTIVE_CONFIG}")

    if [[ "${budget}" == "null" || -z "${budget}" ]]; then
        case "${phase}" in
            intake)                                                       budget="1.0"  ;;
            prd|tdd|plan|spec)                                            budget="5.0"  ;;
            prd_review|tdd_review|plan_review|spec_review|security_review) budget="2.0"  ;;
            code_review)                                                  budget="2.0"  ;;
            code)                                                         budget="10.0" ;;
            integration)                                                  budget="5.0"  ;;
            deploy)                                                       budget="5.0"  ;;
            monitor)                                                      budget="2.0"  ;;
            *)                                                            budget="5.0"  ;;
        esac
    fi

    echo "${budget}"
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
# Phase Session Dispatch (TASK-009, TASK-026)
###############################################################################

# dispatch_phase_session(request_id: string, project: string) -> string
#   Validates request, resolves agent for current phase, and dispatches session
#   via spawn_session_typed with 30-minute timeout. Handles errors gracefully.
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
    mv "${tmp}" "${state_file}"

    # Checkpoint
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    cp "${state_file}" "${req_dir}/checkpoint.json"

    # Prepare output file for session
    local timestamp
    timestamp=$(date +%s)
    local output_file="${req_dir}/session-${timestamp}.txt"

    # Invoke spawn_session_typed with timeout
    local exit_code session_cost=0
    local timeout_duration="${DISPATCH_TIMEOUT:-30m}"

    # Resolve prompt using supervisor-loop.sh's rich version (includes code-phase instructions)
    local prompt_override
    prompt_override=$(resolve_phase_prompt "${phase}" "${request_id}" "${project}")

    # Use a subshell with explicit error handling. Wrap in `timeout`/`gtimeout`
    # when available; otherwise run directly (no wall-clock cap — see
    # resolve_timeout_bin). Exit 124 is the GNU-timeout "timed out" code.
    local timeout_bin
    timeout_bin=$(resolve_timeout_bin)
    (
        set -euo pipefail
        if [[ -n "${timeout_bin}" ]]; then
            "${timeout_bin}" --kill-after=10s "${timeout_duration}" \
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

    # Handle timeout case
    if [[ ${exit_code} -eq 124 ]]; then
        log_warn "Phase session timed out for ${request_id}/${phase} after ${timeout_duration}"

        # Synthesize fail result using shared helper
        local result_file="${req_dir}/phase-result-${phase}.json"
        # Use the shared write_synthesized_phase_result from spawn-session.sh
        bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; write_synthesized_phase_result '${result_file}' 'fail' 'WALL_CLOCK_TIMEOUT' '124'"
    else
        # Extract session cost from claude JSON output if available
        if [[ -f "${output_file}" ]]; then
            session_cost=$(jq -r '.total_cost_usd // .cost_usd // .result.cost_usd // 0' "${output_file}" 2>/dev/null || echo "0")
        fi
    fi

    # Belt-and-suspenders: synthesize fail result for ANY nonzero exit if no phase-result exists
    local result_file="${req_dir}/phase-result-${phase}.json"
    if [[ ${exit_code} -ne 0 && ${exit_code} -ne 124 && ! -f "${result_file}" ]]; then
        log_warn "spawn-session.sh exited ${exit_code} without creating phase-result; synthesizing fail result"
        bash -c "source '${PLUGIN_DIR}/bin/spawn-session.sh'; write_synthesized_phase_result '${result_file}' 'fail' 'AGENT_EXITED_NONZERO' '${exit_code}'"
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

# resolve_phase_prompt(phase: string, request_id: string, project: string) -> string
#   Looks up the phase-specific prompt template and performs variable
#   substitution. Falls back to a generic prompt when no template exists.
#   For code phase, appends branch/commit/PR instructions.
#
# Arguments:
#   $1 -- phase:      Current phase (e.g., "intake", "code", "prd_review").
#   $2 -- request_id: The request ID (e.g., "REQ-20260408-abcd").
#   $3 -- project:    Absolute path to the project/repository root.
#
# Stdout:
#   The resolved prompt string.
resolve_phase_prompt() {
    local phase="${1:-}"
    local request_id="${2:-}"
    local project="${3:-}"

    local prompt_file="${PLUGIN_DIR}/phase-prompts/${phase}.md"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    local base_prompt=""
    if [[ -f "${prompt_file}" ]]; then
        local prompt_template
        prompt_template=$(cat "${prompt_file}")

        base_prompt="${prompt_template}"
        base_prompt="${base_prompt//\{\{REQUEST_ID\}\}/${request_id}}"
        base_prompt="${base_prompt//\{\{PROJECT\}\}/${project}}"
        base_prompt="${base_prompt//\{\{STATE_FILE\}\}/${state_file}}"
        base_prompt="${base_prompt//\{\{PHASE\}\}/${phase}}"
    else
        local req_dir="${project}/.autonomous-dev/requests/${request_id}"
        base_prompt="You are an autonomous development agent working on request ${request_id}.

Your current phase is: ${phase}

Read the request state file at: ${state_file}
Read the project context at: ${project}

Perform the work required for the '${phase}' phase as described in the state file.

When you finish, write \`${req_dir}/phase-result-${phase}.json\` = \`{ \"status\": \"pass\" | \"fail\", \"feedback\": \"<short summary; for a review, the verdict + any blocking findings>\", \"artifacts\": [ { \"kind\": \"...\", \"path\": \"...\", \"title\": \"...\" } ] }\`.

**Do NOT modify \`current_phase\` or \`status\` in \`${state_file}\` — the daemon owns all phase transitions.** You MAY append an entry to \`phase_history[]\` and set \`current_phase_metadata.${phase}_completed_at\`, but never change \`current_phase\`. If you hit an error you can't resolve, still write \`phase-result-${phase}.json\` with \`\"status\": \"fail\"\` and the error in \`\"feedback\"`."

        log_info "No prompt file for phase '${phase}'. Using fallback prompt."
    fi

    # Add code-phase specific instructions
    if [[ "${phase}" == "code" ]]; then
        # Validate request_id first (TASK-011 requirement)
        if ! validate_request_id "${request_id}"; then
            log_error "Invalid request_id for code phase: ${request_id}"
            echo "ERROR: Invalid request_id format"
            return 1
        fi

        local code_instructions="

## Branch and PR Instructions

1. Create a branch named 'autonomous/${request_id}' (single-quoted in any shell command):
   git checkout -b 'autonomous/${request_id}'

2. Make commits using Conventional Commits format (feat:, fix:, docs:, etc.).

3. When implementation is done, create a PR:
   gh pr create --base main --head 'autonomous/${request_id}' --title <conventional-title> --body <summary>

4. Write the resulting PR URL into phase-result-code.json artifacts[] with kind: 'github_pr'."

        base_prompt="${base_prompt}${code_instructions}"
    fi

    echo "${base_prompt}"
}

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

    # Emit alert
    emit_alert "retry_exhaustion" "Request ${request_id} paused after ${retry_count} retries in phase '${phase}'"

    log_error "Request ${request_id} escalated to PAUSED (retry exhaustion in ${phase})"
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
idle_backoff_sleep() {
    log_info "No actionable work. Sleeping ${IDLE_BACKOFF_CURRENT}s."
    sleep "${IDLE_BACKOFF_CURRENT}" &
    local sleep_pid=$!
    wait "${sleep_pid}" 2>/dev/null || true
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
            # Try GNU date first, then gdate (macOS with coreutils), fall back to 0
            if entered_epoch=$(date -d "$gate_entered_at" +%s 2>/dev/null); then
                waited_min=$(( (now_epoch - entered_epoch) / 60 ))
            elif entered_epoch=$(gdate -d "$gate_entered_at" +%s 2>/dev/null); then
                waited_min=$(( (now_epoch - entered_epoch) / 60 ))
            else
                # Date parsing failed, leave waited_min as 0
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

###############################################################################
# Phase Advancement (SPEC-039-2-05)
###############################################################################

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
                        .current_phase_metadata.dispatched_phase = null' \
                       "$state_file" > "$tmp"
                else
                    jq --arg phase "$next_phase" \
                       --arg status "$next_status" \
                       --arg ts "$ts" \
                       '.current_phase = $phase |
                        .status = $status |
                        .updated_at = $ts |
                        .current_phase_metadata.dispatched_phase = null' \
                       "$state_file" > "$tmp"
                fi
                mv "$tmp" "$state_file"

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

                log_info "Review phase $current_phase failed, reset to author phase $author_phase"
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
#   Checks if request is in queued/intake state and auto-transitions to running/prd.
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

        # Atomically transition to running/prd
        local tmp="${state_file}.tmp.$$"
        jq --arg ts "$ts" \
           '.current_phase = "prd" | .status = "running" | .updated_at = $ts' \
           "$state_file" > "$tmp"
        mv "$tmp" "$state_file"

        # Append intake_to_prd event
        local event
        event=$(jq -n \
            --arg ts "$ts" \
            --arg req "$request_id" \
            '{
                event: "intake_to_prd",
                timestamp: $ts,
                request_id: $req,
                from: "intake",
                to: "prd"
            }')
        echo "$event" >> "$events_file"

        log_info "Auto-transitioned $request_id from intake to prd"

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
    else
        log_info "Request ${request_id} escalation_count ${escalation_count} < ${MAX_RETRIES_PER_PHASE}, not marking as failed"
    fi
}

###############################################################################
# Orphan Reconciliation
###############################################################################

# reconcile_orphans() -> void
#   Reconcile orphan SQLite rows and state.json files per SPEC-039-1-04.
#   Runs at startup and every RECONCILE_EVERY_N_POLLS iterations.
reconcile_orphans() {
    log_info "Starting orphan reconciliation"

    # Find orphan SQLite rows (queued + older than 24h)
    local orphan_rows
    if ! orphan_rows=$(bun "${PLUGIN_DIR}/scripts/find-orphan-sqlite-rows.ts" 2>/dev/null); then
        log_error "Failed to query orphan SQLite rows"
        return 1
    fi

    # Process each orphan SQLite row
    while IFS='|' read -r request_id target_repo created_at; do
        [[ -z "$request_id" ]] && continue

        # Check if state.json exists
        local state_file="${target_repo}/.autonomous-dev/requests/${request_id}/state.json"
        if [[ ! -f "$state_file" ]]; then
            log_info "Marking orphan SQLite row as cancelled: ${request_id} (state file missing)"
            if bun "${PLUGIN_DIR}/scripts/mark-request-cancelled.ts" "$request_id" "state-file-lost"; then
                # Write portal request action for the cancelled orphan
                write_portal_request_action "$request_id" "$target_repo"
            else
                log_error "Failed to mark ${request_id} as cancelled"
            fi
        fi
    done <<< "$orphan_rows"

    # Find orphan state.json files
    local known_repos
    known_repos=$(jq -r '.repos[]?' "$EFFECTIVE_CONFIG" 2>/dev/null || echo "")

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

            # Check if SQLite row exists
            local has_sqlite_row
            if has_sqlite_row=$(bun "${PLUGIN_DIR}/scripts/check-sqlite-row.ts" "$request_id" 2>/dev/null); then
                if [[ "$has_sqlite_row" != "true" ]]; then
                    log_warn "Orphan state.json file found: ${state_file} (no SQLite row for ${request_id})"
                fi
            else
                log_warn "Failed to check SQLite row for ${request_id}"
            fi
        done < <(find "$requests_dir" -name "state.json" -print0 2>/dev/null || true)
    done <<< "$known_repos"

    log_info "Orphan reconciliation complete"
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
        fi

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

        # Post-session state update, crash tracking, and cost ledger
        # Three-way branching: turn exhaustion / success / hard failure (SPEC-001-3-02)
        if [[ ${exit_code} -ne 0 ]] && detect_turn_exhaustion "${exit_code}" "${output_file}"; then
            # Turn exhaustion: treat as soft failure
            local current_phase
            current_phase=$(jq -r '.current_phase // .status' "${project}/.autonomous-dev/requests/${request_id}/state.json" 2>/dev/null || echo "unknown")
            log_warn "Turn budget exhausted for ${request_id}. Consider increasing max_turns for phase '${current_phase}'."
            log_warn "Hint: Set daemon.max_turns_by_phase.${current_phase} in ~/.claude/autonomous-dev.json"

            # Still counts as an error for retry purposes, but does NOT trip the circuit breaker
            update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
            check_retry_exhaustion "${request_id}" "${project}"
            # Do NOT call record_crash -- turn exhaustion is not a crash
            update_cost_ledger "${session_cost}" "${request_id}"
        elif [[ ${exit_code} -eq 0 ]]; then
            record_success
            advance_phase "${request_id}" "${project}"
            update_cost_ledger "${session_cost}" "${request_id}"
        else
            record_crash "${request_id}" "${exit_code}"
            update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
            check_retry_exhaustion "${request_id}" "${project}"
            update_cost_ledger "${session_cost}" "${request_id}"
        fi

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

    # Load and merge configuration (defaults + optional user overrides)
    # Must happen before stale heartbeat detection, as recovery scans repos from config.
    load_config

    # Detect stale heartbeat from prior crash or sleep/wake event
    detect_stale_heartbeat

    # Load crash state from persistent file (SPEC-001-3-01)
    load_crash_state

    # Initialize cost ledger if it does not exist
    initialize_cost_ledger

    # Enter the main supervisor loop
    main_loop

    log_info "Daemon exiting cleanly (iterations=${ITERATION_COUNT})"
fi
