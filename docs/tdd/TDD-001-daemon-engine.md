# TDD-001: Daemon Engine

| Field          | Value                                          |
|----------------|------------------------------------------------|
| **Title**      | Daemon Engine                                  |
| **TDD ID**     | TDD-001                                        |
| **Version**    | 0.1.0                                          |
| **Date**       | 2026-04-08                                     |
| **Author**     | Paul Watson (Staff Engineer)                   |
| **Status**     | Draft                                          |
| **Parent PRD** | PRD-001: System Core & Daemon Engine           |
| **Subsystem**  | Daemon Engine (FR-100 through FR-111, FR-400 through FR-408) |

---

## 1. Overview / Problem Statement

Claude Code plugins cannot run as true background daemons. They execute within a Claude Code session that has a finite context window and a bounded lifetime. Yet the `autonomous-dev` system requires continuous, unattended operation that survives crashes, machine sleeps, reboots, and API outages --- running for days or weeks without human intervention.

This TDD designs the **Daemon Engine**: the process supervision layer that bridges this gap. It defines a bash supervisor loop managed by launchd (macOS) or systemd (Linux) that spawns ephemeral Claude Code sessions per iteration, monitors their health, recovers from failures, and provides the substrate on which every pipeline stage runs.

For full product context, goals, personas, and the complete requirements set, see PRD-001.

---

## 2. Architecture

### 2.1 Component Overview

```
+================================================================+
|                     OS Process Supervisor                        |
|              launchd (macOS) / systemd (Linux)                  |
|  - Restarts supervisor-loop.sh on crash or reboot               |
|  - Routes stdout/stderr to log files                            |
+============================+===================================+
                             |
                             | spawns & restarts
                             v
+============================+===================================+
|                    supervisor-loop.sh                            |
|  (Single long-lived bash process --- the "daemon")              |
|                                                                 |
|  +-----------------------------------------------------------+ |
|  |                    INIT PHASE (once)                       | |
|  |  1. Validate dependencies (bash, claude, jq, git)         | |
|  |  2. Acquire lock file (daemon.lock)                       | |
|  |  3. Register signal handlers (SIGTERM, SIGINT)            | |
|  |  4. Load & validate configuration                         | |
|  |  5. Detect stale heartbeat (sleep/wake recovery)          | |
|  |  6. Initialize crash counter from persistent state        | |
|  +-----------------------------------------------------------+ |
|                                                                 |
|  +-----------------------------------------------------------+ |
|  |                    MAIN LOOP (repeats)                     | |
|  |                                                            | |
|  |  +---------+    +----------+    +----------+              | |
|  |  | GATE    |--->| SELECT   |--->| SPAWN    |              | |
|  |  | checks  |    | request  |    | session  |              | |
|  |  +---------+    +----------+    +----+-----+              | |
|  |       |                              |                     | |
|  |       | (kill-switch,                | claude --max-turns  | |
|  |       |  cost cap,                   | --print             | |
|  |       |  circuit breaker)            | --output-format json| |
|  |       |                              v                     | |
|  |       |              +---------------+------+              | |
|  |       |              | CAPTURE & UPDATE     |              | |
|  |       |              | exit code, cost,     |              | |
|  |       |              | state transitions    |              | |
|  |       v              +---------------+------+              | |
|  |  +---------+                         |                     | |
|  |  | SLEEP   |<------------------------+                     | |
|  |  | (idle   |                                               | |
|  |  |  backoff|                                               | |
|  |  | or poll)|                                               | |
|  |  +---------+                                               | |
|  +-----------------------------------------------------------+ |
+================================================================+
         |              |               |               |
         v              v               v               v
+-------------+ +-------------+ +-------------+ +-------------+
| daemon.lock | | heartbeat   | | daemon.log  | | crash-state |
| (PID file)  | | .json       | | (rotating)  | | .json       |
+-------------+ +-------------+ +-------------+ +-------------+
         |
         v
+--------------------------+
|    Claude Code Session   |
|    (ephemeral process)   |
|    - Phase-specific      |
|      system prompt       |
|    - --max-turns N       |
|    - Reads/writes state  |
|      files directly      |
+--------------------------+
```

### 2.2 File System Layout

```
~/.autonomous-dev/
  daemon.lock                     # Lock file with PID
  heartbeat.json                  # Heartbeat timestamp + metadata
  crash-state.json                # Consecutive crash counter, circuit breaker state
  kill-switch.flag                # Existence = kill switch engaged
  cost-ledger.json                # Global cost tracking
  config/
    global.json                   # Global configuration (user-created)
  logs/
    daemon.log                    # Current log file
    daemon.log.1                  # Rotated log (age-based)
    daemon.log.2
  archive/                        # Archived completed requests

{project}/.autonomous-dev/
  requests/
    REQ-XXXXXXXX-XXXX/
      state.json                  # Request state
      events.jsonl                # Append-only event log
      checkpoint.json             # Last known-good state snapshot
```

### 2.3 Process Hierarchy

```
launchd / systemd
  |
  +-- supervisor-loop.sh  (PID in daemon.lock)
        |
        +-- claude [args]  (ephemeral, one at a time)
```

There is never more than one `claude` child process per supervisor loop. Concurrency of requests is sequential multiplexing: the loop picks the highest-priority request per iteration, not parallel child processes.

---

## 3. Detailed Design

### 3.1 Supervisor Loop Script (`supervisor-loop.sh`)

**Location:** `~/.claude/plugins/autonomous-dev/bin/supervisor-loop.sh`

The script is the single entry point invoked by launchd/systemd. It is a bash script (no external runtime dependencies beyond bash 4+, jq, git, and the `claude` CLI).

#### 3.1.1 Script Structure (Pseudocode)

```bash
#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Constants
# ============================================================
readonly DAEMON_HOME="${HOME}/.autonomous-dev"
readonly LOCK_FILE="${DAEMON_HOME}/daemon.lock"
readonly HEARTBEAT_FILE="${DAEMON_HOME}/heartbeat.json"
readonly CRASH_STATE_FILE="${DAEMON_HOME}/crash-state.json"
readonly KILL_SWITCH_FILE="${DAEMON_HOME}/kill-switch.flag"
readonly COST_LEDGER_FILE="${DAEMON_HOME}/cost-ledger.json"
readonly LOG_DIR="${DAEMON_HOME}/logs"
readonly LOG_FILE="${LOG_DIR}/daemon.log"
readonly CONFIG_FILE="${HOME}/.claude/autonomous-dev.json"
readonly DEFAULTS_FILE="$(dirname "$0")/../config/defaults.json"

# Populated from config on load
POLL_INTERVAL=30
CIRCUIT_BREAKER_THRESHOLD=3
HEARTBEAT_INTERVAL=30
ONCE_MODE=false

# Runtime state
SHUTDOWN_REQUESTED=false
CURRENT_CHILD_PID=""
ITERATION_COUNT=0

# ============================================================
# Parse CLI arguments
# ============================================================
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --once) ONCE_MODE=true; shift ;;
            *) log_error "Unknown argument: $1"; exit 1 ;;
        esac
    done
}

# ============================================================
# Signal handlers
# ============================================================
handle_shutdown() {
    local signal="$1"
    log_info "Received ${signal}, initiating graceful shutdown..."
    SHUTDOWN_REQUESTED=true

    if [[ -n "${CURRENT_CHILD_PID}" ]]; then
        log_info "Waiting for child process ${CURRENT_CHILD_PID} to finish current turn..."
        # Do NOT kill the child. Let it finish its current turn.
        # The loop will exit after the child completes.
    fi
    # If no child is running, the loop's next iteration check will exit.
}

trap 'handle_shutdown SIGTERM' SIGTERM
trap 'handle_shutdown SIGINT' SIGINT

# ============================================================
# Logging
# ============================================================
log_json() {
    local level="$1" message="$2"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    printf '{"timestamp":"%s","level":"%s","pid":%d,"iteration":%d,"message":"%s"}\n' \
        "${ts}" "${level}" "$$" "${ITERATION_COUNT}" "${message}" >> "${LOG_FILE}"
}
log_info()  { log_json "INFO"  "$1"; }
log_warn()  { log_json "WARN"  "$1"; }
log_error() { log_json "ERROR" "$1"; }

# ============================================================
# Dependency validation
# ============================================================
validate_dependencies() {
    local missing=()
    for cmd in bash jq git claude; do
        command -v "${cmd}" >/dev/null 2>&1 || missing+=("${cmd}")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "FATAL: Missing required commands: ${missing[*]}" >&2
        exit 1
    fi

    # Optionally: validate claude CLI version
    local claude_version
    claude_version=$(claude --version 2>/dev/null || echo "unknown")
    log_info "Claude CLI version: ${claude_version}"
}

# ============================================================
# Lock file management
# ============================================================
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

release_lock() {
    rm -f "${LOCK_FILE}"
    log_info "Lock released"
}
trap 'release_lock' EXIT

# ============================================================
# Heartbeat
# ============================================================
write_heartbeat() {
    local active_request="${1:-null}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local tmp="${HEARTBEAT_FILE}.tmp"
    jq -n \
        --arg ts "${ts}" \
        --arg pid "$$" \
        --argjson iter "${ITERATION_COUNT}" \
        --arg req "${active_request}" \
        '{
            timestamp: $ts,
            pid: ($pid | tonumber),
            iteration_count: $iter,
            active_request_id: (if $req == "null" then null else $req end)
        }' > "${tmp}"
    mv "${tmp}" "${HEARTBEAT_FILE}"
}

detect_stale_heartbeat() {
    if [[ ! -f "${HEARTBEAT_FILE}" ]]; then
        log_info "No heartbeat file found. Fresh start."
        return
    fi

    local last_ts now_epoch last_epoch staleness_seconds
    last_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -z "${last_ts}" ]]; then
        log_warn "Heartbeat file unreadable. Treating as stale."
        return
    fi

    now_epoch=$(date -u +%s)
    last_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${last_ts}" +%s 2>/dev/null \
                 || date -u -d "${last_ts}" +%s 2>/dev/null \
                 || echo "0")
    staleness_seconds=$(( now_epoch - last_epoch ))

    local threshold=$(( HEARTBEAT_INTERVAL * 2 ))
    if [[ ${staleness_seconds} -gt ${threshold} ]]; then
        log_warn "Stale heartbeat detected (${staleness_seconds}s old, threshold ${threshold}s). Prior crash or sleep event."
        log_info "Performing sleep/wake recovery checks..."
        # Recovery: validate all in-progress requests, check for orphaned
        # child processes, re-validate state files.
        recover_from_stale_heartbeat
    fi
}

recover_from_stale_heartbeat() {
    # 1. Check for orphaned claude processes from prior instance
    local stale_pid
    stale_pid=$(jq -r '.pid' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -n "${stale_pid}" ]] && kill -0 "${stale_pid}" 2>/dev/null; then
        log_warn "Orphaned process ${stale_pid} still running. Sending SIGTERM."
        kill -TERM "${stale_pid}" 2>/dev/null || true
        sleep 2
        kill -0 "${stale_pid}" 2>/dev/null && kill -KILL "${stale_pid}" 2>/dev/null || true
    fi

    # 2. Scan all active requests for state integrity
    #    (Delegated to state-machine validation; see state machine TDD)
    log_info "Sleep/wake recovery complete."
}

# ============================================================
# Crash counter & circuit breaker
# ============================================================
load_crash_state() {
    if [[ -f "${CRASH_STATE_FILE}" ]]; then
        CONSECUTIVE_CRASHES=$(jq -r '.consecutive_crashes // 0' "${CRASH_STATE_FILE}")
        CIRCUIT_BREAKER_TRIPPED=$(jq -r '.circuit_breaker_tripped // false' "${CRASH_STATE_FILE}")
    else
        CONSECUTIVE_CRASHES=0
        CIRCUIT_BREAKER_TRIPPED=false
    fi
}

save_crash_state() {
    local tmp="${CRASH_STATE_FILE}.tmp"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -n \
        --argjson crashes "${CONSECUTIVE_CRASHES}" \
        --argjson tripped "${CIRCUIT_BREAKER_TRIPPED}" \
        --arg ts "${ts}" \
        '{
            consecutive_crashes: $crashes,
            circuit_breaker_tripped: $tripped,
            updated_at: $ts
        }' > "${tmp}"
    mv "${tmp}" "${CRASH_STATE_FILE}"
}

record_success() {
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    save_crash_state
}

record_crash() {
    CONSECUTIVE_CRASHES=$(( CONSECUTIVE_CRASHES + 1 ))
    log_error "Crash recorded. Consecutive crashes: ${CONSECUTIVE_CRASHES}/${CIRCUIT_BREAKER_THRESHOLD}"

    if [[ ${CONSECUTIVE_CRASHES} -ge ${CIRCUIT_BREAKER_THRESHOLD} ]]; then
        CIRCUIT_BREAKER_TRIPPED=true
        log_error "CIRCUIT BREAKER TRIPPED after ${CONSECUTIVE_CRASHES} consecutive crashes."
        emit_alert "circuit_breaker" "Circuit breaker tripped after ${CONSECUTIVE_CRASHES} consecutive crashes"
    fi
    save_crash_state
}

# ============================================================
# Gate checks (run before each iteration)
# ============================================================
check_gates() {
    # Kill switch
    if [[ -f "${KILL_SWITCH_FILE}" ]]; then
        log_warn "Kill switch is engaged. Skipping iteration."
        return 1
    fi

    # Circuit breaker
    if [[ "${CIRCUIT_BREAKER_TRIPPED}" == "true" ]]; then
        log_warn "Circuit breaker is tripped. Skipping iteration."
        return 1
    fi

    # Cost cap (delegates to governance module)
    if ! check_cost_caps; then
        log_warn "Cost cap reached. Skipping iteration."
        return 1
    fi

    return 0
}

# ============================================================
# Request selection
# ============================================================
select_request() {
    # Scans all configured repository .autonomous-dev/requests/ directories.
    # Returns the highest-priority request in an actionable state.
    # "Actionable" = not paused, not failed, not cancelled, not blocked.
    # Priority: lower number = higher priority. Ties broken by created_at (oldest first).
    #
    # Implementation: iterate repos from config allowlist, find state.json
    # files, parse with jq, sort by priority then created_at.
    #
    # Outputs: request ID and project path to stdout, or empty if no work.

    local best_id="" best_project="" best_priority=999999 best_created=""

    local repos
    repos=$(jq -r '.repositories.allowlist[]' "${EFFECTIVE_CONFIG}" 2>/dev/null)

    while IFS= read -r repo; do
        local req_dir="${repo}/.autonomous-dev/requests"
        [[ -d "${req_dir}" ]] || continue

        for state_file in "${req_dir}"/*/state.json; do
            [[ -f "${state_file}" ]] || continue

            local status priority created_at blocked_by req_id
            status=$(jq -r '.status' "${state_file}")
            priority=$(jq -r '.priority // 999' "${state_file}")
            created_at=$(jq -r '.created_at' "${state_file}")
            blocked_by=$(jq -r '.blocked_by // [] | length' "${state_file}")
            req_id=$(jq -r '.id' "${state_file}")

            # Skip non-actionable states
            case "${status}" in
                paused|failed|cancelled|monitor) continue ;;
            esac

            # Skip blocked requests
            [[ "${blocked_by}" -gt 0 ]] && continue

            # Compare priority (lower = higher priority)
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

# ============================================================
# Session spawning
# ============================================================
spawn_session() {
    local request_id="$1" project="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local status max_turns phase_prompt

    status=$(jq -r '.status' "${state_file}")
    max_turns=$(resolve_max_turns "${status}")
    phase_prompt=$(resolve_phase_prompt "${status}" "${request_id}" "${project}")

    # Write checkpoint before spawning
    cp "${state_file}" "${project}/.autonomous-dev/requests/${request_id}/checkpoint.json"

    log_info "Spawning session: request=${request_id} phase=${status} max_turns=${max_turns}"
    write_heartbeat "${request_id}"

    # Build the claude command
    local output_file="${DAEMON_HOME}/logs/session-${request_id}-$(date +%s).json"

    # Spawn claude as a child process and capture PID
    claude \
        --print \
        --output-format json \
        --max-turns "${max_turns}" \
        --prompt "${phase_prompt}" \
        --project-directory "${project}" \
        > "${output_file}" 2>&1 &
    CURRENT_CHILD_PID=$!

    # Wait for child, capturing exit code even if interrupted by signal
    local exit_code=0
    wait "${CURRENT_CHILD_PID}" || exit_code=$?
    CURRENT_CHILD_PID=""

    log_info "Session exited: request=${request_id} exit_code=${exit_code}"

    # Parse session output for cost
    local session_cost
    session_cost=$(jq -r '.cost_usd // 0' "${output_file}" 2>/dev/null || echo "0")

    echo "${exit_code}|${session_cost}|${output_file}"
}

resolve_max_turns() {
    local phase="$1"
    # Read from effective config, fall back to defaults
    local turns
    turns=$(jq -r ".daemon.max_turns_by_phase.\"${phase}\" // null" "${EFFECTIVE_CONFIG}")
    if [[ "${turns}" == "null" ]]; then
        # Default categorization
        case "${phase}" in
            intake)                     turns=10  ;;
            prd|tdd|plan|spec)          turns=50  ;;
            prd_review|tdd_review|plan_review|spec_review|code_review) turns=30 ;;
            code)                       turns=200 ;;
            integration)                turns=100 ;;
            deploy)                     turns=30  ;;
            *)                          turns=50  ;;
        esac
    fi
    echo "${turns}"
}

# ============================================================
# Idle backoff
# ============================================================
IDLE_BACKOFF_CURRENT=${POLL_INTERVAL}
IDLE_BACKOFF_BASE=${POLL_INTERVAL}
IDLE_BACKOFF_MAX=900  # 15 minutes

idle_backoff_sleep() {
    log_info "No actionable work. Sleeping ${IDLE_BACKOFF_CURRENT}s."
    sleep "${IDLE_BACKOFF_CURRENT}"

    # Exponential increase: double, capped at max
    IDLE_BACKOFF_CURRENT=$(( IDLE_BACKOFF_CURRENT * 2 ))
    if [[ ${IDLE_BACKOFF_CURRENT} -gt ${IDLE_BACKOFF_MAX} ]]; then
        IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_MAX}
    fi
}

idle_backoff_reset() {
    IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_BASE}
}

# ============================================================
# Main
# ============================================================
main() {
    parse_args "$@"
    mkdir -p "${DAEMON_HOME}" "${LOG_DIR}"

    validate_dependencies
    acquire_lock
    load_config            # Merges defaults + global + project config
    detect_stale_heartbeat
    load_crash_state

    log_info "Daemon starting (PID $$, once_mode=${ONCE_MODE})"

    while true; do
        ITERATION_COUNT=$(( ITERATION_COUNT + 1 ))
        write_heartbeat

        # Check if shutdown was requested
        if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
            log_info "Shutdown requested. Exiting main loop."
            break
        fi

        # Gate checks
        if ! check_gates; then
            sleep "${POLL_INTERVAL}"
            continue
        fi

        # Select work
        local selection
        selection=$(select_request)

        if [[ -z "${selection}" ]]; then
            idle_backoff_sleep
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue
        fi

        idle_backoff_reset

        local request_id project
        IFS='|' read -r request_id project <<< "${selection}"

        # Spawn session and capture results
        local result exit_code session_cost output_file
        result=$(spawn_session "${request_id}" "${project}")
        IFS='|' read -r exit_code session_cost output_file <<< "${result}"

        # Update state based on exit code
        if [[ ${exit_code} -eq 0 ]]; then
            record_success
            update_request_state "${request_id}" "${project}" "success" "${session_cost}"
            update_cost_ledger "${session_cost}"
        else
            record_crash
            update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
            update_cost_ledger "${session_cost}"
        fi

        # Rotate logs if needed
        rotate_logs_if_needed

        # --once mode: exit after single iteration
        [[ "${ONCE_MODE}" == "true" ]] && break
    done

    log_info "Daemon exiting cleanly (iterations=${ITERATION_COUNT})"
    release_lock
}

main "$@"
```

#### 3.1.2 Key Design Decisions in the Script

1. **Single child at a time.** The loop never spawns more than one `claude` process. Concurrency is handled by sequential multiplexing across iterations, not parallel children. This eliminates race conditions on state files.

2. **`wait` not `sleep`-poll.** After spawning `claude`, the loop calls `wait $PID`. This is signal-safe --- `wait` is interrupted by signals, and the handler sets `SHUTDOWN_REQUESTED=true` without killing the child.

3. **Heartbeat is written at loop top and before spawn.** This ensures the heartbeat is fresh whether the loop is idle-sleeping or actively running a session.

4. **All state mutations are atomic.** Every JSON file write goes through a `.tmp` + `mv` pattern. `mv` on the same filesystem is atomic on both macOS (APFS) and Linux (ext4, XFS).

### 3.2 External Process Supervision

#### 3.2.1 launchd (macOS)

**Plist location:** `~/Library/LaunchAgents/com.autonomous-dev.daemon.plist`

Generated by `autonomous-dev install-daemon`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.autonomous-dev.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>PLUGIN_BIN_DIR/supervisor-loop.sh</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>DAEMON_HOME/logs/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>DAEMON_HOME/logs/launchd-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>USER_HOME</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>

    <key>LowPriorityBackgroundIO</key>
    <true/>
</dict>
</plist>
```

**Key launchd behaviors:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| `KeepAlive.SuccessfulExit = false` | Restart only on non-zero exit | Clean exits (SIGTERM during shutdown) should not trigger a restart. |
| `ThrottleInterval = 10` | Minimum 10s between restarts | Prevents rapid restart storms if the script fails immediately on startup. |
| `RunAtLoad = true` | Start on boot/login | Ensures the daemon is always running without manual intervention. |
| `ProcessType = Background` | Low priority scheduling | Prevents the daemon from interfering with interactive use. |
| `LowPriorityBackgroundIO = true` | Deprioritize disk I/O | State file writes should not contend with user workloads. |

**Installation command flow:**

```
autonomous-dev install-daemon
  1. Resolve PLUGIN_BIN_DIR, DAEMON_HOME, USER_HOME
  2. Template the plist with resolved paths
  3. Write to ~/Library/LaunchAgents/com.autonomous-dev.daemon.plist
  4. launchctl bootstrap gui/$(id -u) <plist-path>
  5. Verify: launchctl print gui/$(id -u)/com.autonomous-dev.daemon
```

#### 3.2.2 systemd (Linux)

**Unit file location:** `~/.config/systemd/user/autonomous-dev.service`

```ini
[Unit]
Description=autonomous-dev Daemon Engine
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash PLUGIN_BIN_DIR/supervisor-loop.sh
Restart=on-failure
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=USER_HOME

# Resource limits
MemoryMax=512M
CPUQuota=50%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=autonomous-dev

[Install]
WantedBy=default.target
```

**Installation command flow:**

```
autonomous-dev install-daemon
  1. Resolve PLUGIN_BIN_DIR, USER_HOME
  2. Template the unit file with resolved paths
  3. Write to ~/.config/systemd/user/autonomous-dev.service
  4. systemctl --user daemon-reload
  5. systemctl --user enable autonomous-dev.service
  6. systemctl --user start autonomous-dev.service
  7. Verify: systemctl --user status autonomous-dev.service
```

#### 3.2.3 Wrapper Commands

The `daemon start`, `daemon stop`, and `daemon status` commands abstract the OS-specific supervisor:

```
autonomous-dev daemon start
  macOS:  launchctl kickstart -k gui/$(id -u)/com.autonomous-dev.daemon
  Linux:  systemctl --user start autonomous-dev.service

autonomous-dev daemon stop
  macOS:  launchctl kill SIGTERM gui/$(id -u)/com.autonomous-dev.daemon
  Linux:  systemctl --user stop autonomous-dev.service

autonomous-dev daemon status
  1. Read heartbeat.json, crash-state.json, daemon.lock
  2. Check OS-level service status (launchctl print / systemctl status)
  3. Combine into unified status report (see Section 5: API/Interface Contracts)
```

### 3.3 Session Lifecycle

Each iteration of the supervisor loop that finds actionable work follows this lifecycle:

```
  CHECKPOINT -----> SPAWN -----> EXECUTE -----> CAPTURE -----> UPDATE
      |                |             |              |             |
  snapshot          claude          runs          exit code     state.json
  state.json       --print        turns          session cost   events.jsonl
  to checkpoint    --max-turns    against         output file   cost-ledger
  .json            --output-      context                       crash counter
                   format json
```

#### 3.3.1 Checkpoint

Before spawning a Claude Code session, the supervisor copies the current `state.json` to `checkpoint.json` in the same request directory. This is the recovery point if the session fails.

```bash
checkpoint_request() {
    local project="$1" request_id="$2"
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    cp "${req_dir}/state.json" "${req_dir}/checkpoint.json"
    log_info "Checkpoint created for ${request_id}"
}
```

On failure recovery, the system reads `checkpoint.json` to determine the `last_checkpoint` state and can restore from it rather than re-running prior phases.

#### 3.3.2 Spawn

The supervisor constructs the `claude` CLI invocation:

```bash
claude \
    --print \
    --output-format json \
    --max-turns "${max_turns}" \
    --prompt "${phase_prompt}" \
    --project-directory "${project}"
```

The `phase_prompt` is a fully self-contained instruction that includes:
- The current phase name and what the session must accomplish
- The path to the request state file
- The path to any input artifacts from prior phases
- Instructions for how to signal completion (update the state file)
- Instructions for how to signal failure (write error to state file)
- Context window management: instruction to checkpoint and exit if approaching limits

The phase prompt is generated by a separate module (`phase-prompts/`) and is not part of this TDD's scope. The daemon engine only needs to resolve the prompt file path and read its contents.

#### 3.3.3 Execute

The `claude` process runs autonomously up to `--max-turns` turns. The supervisor does not interact with it during execution --- it simply `wait`s for the process to exit.

The Claude Code session is responsible for:
- Reading the request state to understand context
- Performing the phase-specific work
- Writing output artifacts to the appropriate locations
- Updating the state file's `current_phase_metadata` field
- Exiting cleanly when work is complete

#### 3.3.4 Capture

After the `claude` process exits, the supervisor captures:

| Data Point | Source | Usage |
|------------|--------|-------|
| Exit code | `$?` after `wait` | Determines success (0) vs. crash (non-zero) |
| Session cost | Parsed from `--output-format json` stdout | Added to request's `cost_accrued_usd` and global ledger |
| Turn count | Parsed from session output | Added to request's `turn_count` |
| Session output | Written to `logs/session-{id}-{ts}.json` | Debugging and audit trail |

#### 3.3.5 Terminate

Normal termination: `claude` exits with code 0. The supervisor updates state and proceeds to the next iteration.

Abnormal termination: `claude` exits with a non-zero code. The supervisor records the crash, increments retry counters, and follows error recovery logic (Section 7).

Forced termination (SIGTERM to supervisor): The supervisor sets `SHUTDOWN_REQUESTED=true` and waits for the current `claude` process to finish. It does **not** send SIGTERM to the child immediately. The child will finish its current turn and exit naturally when `--max-turns` is reached or work completes. If the child does not exit within a grace period (configurable, default 5 minutes), the supervisor sends SIGTERM to the child, waits 10 seconds, then SIGKILL.

```bash
# Graceful shutdown with escalation
graceful_shutdown_child() {
    local child_pid="$1"
    local grace_period=300  # 5 minutes

    # Wait for child to finish naturally
    local waited=0
    while kill -0 "${child_pid}" 2>/dev/null && [[ ${waited} -lt ${grace_period} ]]; do
        sleep 5
        waited=$(( waited + 5 ))
    done

    if kill -0 "${child_pid}" 2>/dev/null; then
        log_warn "Child ${child_pid} did not exit within grace period. Sending SIGTERM."
        kill -TERM "${child_pid}" 2>/dev/null || true
        sleep 10
        if kill -0 "${child_pid}" 2>/dev/null; then
            log_error "Child ${child_pid} did not respond to SIGTERM. Sending SIGKILL."
            kill -KILL "${child_pid}" 2>/dev/null || true
        fi
    fi
}
```

#### 3.3.6 Respawn

Respawning happens at two levels:

1. **Session-level respawn:** If a session exits with an error and retries remain for the current phase, the next iteration of the supervisor loop will re-select the same request (it is still the highest-priority actionable request) and spawn a fresh session. The fresh session reads the checkpointed state and resumes.

2. **Supervisor-level respawn:** If `supervisor-loop.sh` itself crashes (e.g., bash error, OOM kill), launchd/systemd restarts it. On restart, the script detects the stale heartbeat, performs recovery, and resumes the main loop.

### 3.4 Heartbeat Mechanism and Health Monitoring

#### 3.4.1 Heartbeat File Schema

Written to `~/.autonomous-dev/heartbeat.json` on every iteration and before every session spawn.

```json
{
    "timestamp": "2026-04-08T14:30:00Z",
    "pid": 12345,
    "iteration_count": 42,
    "active_request_id": "REQ-20260408-a3f1",
    "daemon_version": "0.1.0"
}
```

#### 3.4.2 Staleness Detection

The heartbeat is considered stale when:

```
current_time - heartbeat.timestamp > (heartbeat_interval_seconds * 2)
```

Default: `30 * 2 = 60 seconds`. If the heartbeat is older than 60 seconds, the daemon infers a crash or sleep event occurred.

Staleness is checked:
- On supervisor startup (detect prior crash)
- By the `daemon status` command (report health to operator)
- Optionally by an independent cron job (external watchdog)

#### 3.4.3 External Watchdog (Optional, Phase 2)

A lightweight cron job that checks heartbeat freshness independently of the daemon itself:

```bash
# ~/.autonomous-dev/bin/watchdog.sh
# Installed as a cron job: */5 * * * * ~/.autonomous-dev/bin/watchdog.sh

HEARTBEAT_FILE="${HOME}/.autonomous-dev/heartbeat.json"
ALERT_THRESHOLD=300  # 5 minutes

if [[ ! -f "${HEARTBEAT_FILE}" ]]; then
    # No heartbeat file at all --- daemon may never have started
    notify "autonomous-dev daemon: heartbeat file missing"
    exit 0
fi

last_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}")
now=$(date -u +%s)
last=$(date -u -d "${last_ts}" +%s 2>/dev/null || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${last_ts}" +%s)
delta=$(( now - last ))

if [[ ${delta} -gt ${ALERT_THRESHOLD} ]]; then
    notify "autonomous-dev daemon: heartbeat stale (${delta}s old)"
fi
```

### 3.5 Crash Detection, Exponential Backoff, and Circuit Breaker

#### 3.5.1 Crash Counter

The crash counter tracks **consecutive** session failures. It is stored persistently in `crash-state.json` so it survives supervisor restarts.

| Event | Crash Counter Action |
|-------|---------------------|
| Session exits with code 0 | Reset to 0 |
| Session exits with non-zero code | Increment by 1 |
| Supervisor itself crashes and restarts | Counter is loaded from file (persisted) |

#### 3.5.2 Circuit Breaker

When the consecutive crash counter reaches `circuit_breaker_threshold` (default: 3), the circuit breaker trips:

1. `crash-state.json` is updated: `circuit_breaker_tripped = true`
2. An alert is emitted via configured notification channels
3. All subsequent iterations skip work (the gate check in the main loop rejects)
4. The daemon continues running (it does not exit) --- it just does nothing

**Resetting the circuit breaker:**

```
autonomous-dev circuit-breaker reset
```

This command:
1. Sets `consecutive_crashes = 0` and `circuit_breaker_tripped = false` in `crash-state.json`
2. The next iteration of the supervisor loop will pass the gate check and resume processing

The circuit breaker can also be reset automatically if the operator fixes the underlying issue and the next session succeeds (since success resets the crash counter to 0). However, while the breaker is tripped, no sessions are spawned, so manual reset is required.

#### 3.5.3 Exponential Backoff on Errors

Distinct from the idle backoff (Section 3.1.1), error backoff applies between retry attempts for a failing request:

```
Attempt 1: immediate
Attempt 2: wait 30s
Attempt 3: wait 60s
Attempt 4: wait 120s
...
Formula: min(base * 2^(attempt-2), max_backoff)
```

This is implemented per-request in the state file's `current_phase_metadata.next_retry_after` timestamp. The supervisor's request selection logic skips requests whose `next_retry_after` is in the future.

```json
{
    "current_phase_metadata": {
        "retry_count": 2,
        "next_retry_after": "2026-04-08T14:35:00Z",
        "last_error": "exit code 1: context window exhausted"
    }
}
```

### 3.6 Phase-Aware `--max-turns` Configuration

Turn budgets prevent runaway sessions and are calibrated to the expected complexity of each phase.

#### 3.6.1 Default Turn Budget Table

| Phase Category | Phases | Default `--max-turns` | Rationale |
|---------------|--------|----------------------|-----------|
| Intake | `intake` | 10 | Simple parsing and validation |
| Documentation Generation | `prd`, `tdd`, `plan`, `spec` | 50 | Document writing with research |
| Review | `prd_review`, `tdd_review`, `plan_review`, `spec_review`, `code_review` | 30 | Evaluation against criteria |
| Code Execution | `code` | 200 | Complex multi-file code generation |
| Integration | `integration` | 100 | Test execution, debugging, PR creation |
| Deployment | `deploy` | 30 | Scripted deployment steps |

#### 3.6.2 Configuration Override

Operators can override any phase's turn budget in the config file:

```json
{
    "daemon": {
        "max_turns_by_phase": {
            "code": 300,
            "integration": 150
        }
    }
}
```

Unspecified phases use the built-in defaults. The merge is per-key, not whole-object replacement.

#### 3.6.3 Turn Budget Exhaustion

When a session exits because `--max-turns` was reached (detected by parsing the session output for a turns-exhausted indicator), the supervisor treats this as a **soft failure**: the phase is not marked as failed, but a retry is consumed. If the phase consistently exhausts its turn budget, the operator should increase the budget for that phase.

### 3.7 Graceful Shutdown on SIGTERM/SIGINT

#### 3.7.1 Signal Flow

```
OS sends SIGTERM to supervisor-loop.sh
         |
         v
trap handler fires: handle_shutdown("SIGTERM")
         |
         v
Sets SHUTDOWN_REQUESTED=true
         |
         +-- If child process is running:
         |     Do NOT kill child.
         |     `wait` will return when child finishes naturally.
         |     After `wait` returns, loop checks SHUTDOWN_REQUESTED and breaks.
         |
         +-- If no child process is running (sleeping/idle):
               `sleep` is interrupted by the signal.
               Loop checks SHUTDOWN_REQUESTED and breaks.
         |
         v
Cleanup: release_lock, write final heartbeat, log exit
         |
         v
exit 0 (clean exit, so launchd KeepAlive.SuccessfulExit=false does NOT restart)
```

#### 3.7.2 SIGTERM vs SIGINT Behavior

Both signals trigger the same handler. The only difference:

- **SIGTERM:** Sent by launchd/systemd during `daemon stop`. Expected operational signal.
- **SIGINT:** Sent by Ctrl+C if running interactively (debugging). Same graceful behavior.

#### 3.7.3 Exit Code Contract

| Scenario | Exit Code | launchd/systemd Behavior |
|----------|-----------|-------------------------|
| Clean shutdown (SIGTERM/SIGINT) | 0 | No restart (KeepAlive.SuccessfulExit=false / Restart=on-failure) |
| Unhandled error in bash script | 1 | Restart after ThrottleInterval/RestartSec |
| Kill switch engaged on startup | 0 | No restart |
| Dependency validation failure | 2 | Restart (will keep failing until deps are installed) |

### 3.8 Sleep/Wake Recovery on macOS

macOS aggressively sleeps laptops and desktops. When the machine wakes, the daemon may find:

1. The heartbeat is stale (minutes, hours, or days old)
2. An in-progress `claude` session was killed by the OS during sleep
3. State files reflect a session that was mid-execution

#### 3.8.1 Recovery Procedure

On startup (or when the stale heartbeat is detected mid-run, which does not happen since the loop is also sleeping, so this is effectively always on startup):

```
1. Read heartbeat.json
2. Compute staleness = now - heartbeat.timestamp
3. If staleness > threshold:
   a. Log warning: "Stale heartbeat detected ({N}s). Recovering."
   b. Check for orphaned processes:
      - Read PID from heartbeat.json
      - If process exists, send SIGTERM then SIGKILL
   c. Scan all active requests for inconsistencies:
      - If a request's state indicates a session was in-progress
        (current_phase_metadata.session_active = true), mark the
        session as interrupted and restore from checkpoint.json
   d. Re-validate crash-state.json (do NOT increment crash counter
      for sleep events --- this was not a code failure)
   e. Write fresh heartbeat
   f. Resume normal loop
```

#### 3.8.2 Distinguishing Sleep from Crash

The system cannot definitively distinguish a sleep event from a crash. However, the heuristic is:

- **Staleness > 10 minutes** and **no crash-state changes**: likely sleep/wake
- **Staleness < 2 minutes** and **crash-state was recently updated**: likely crash

In both cases, the recovery procedure is the same. The only difference is whether the crash counter should be incremented. For sleep events, the crash counter is **not** incremented --- the prior session was killed by the OS, not by a code bug.

Detection: if the prior session's exit code was captured (it was `wait`ed on), it is stored in crash-state. If no exit code was captured (the supervisor itself was killed during sleep), the crash counter is left unchanged.

---

## 4. Data Models / Schemas

### 4.1 `heartbeat.json`

```json
{
    "$schema_note": "Written by supervisor-loop.sh every iteration",
    "timestamp": "2026-04-08T14:30:00Z",
    "pid": 12345,
    "iteration_count": 42,
    "active_request_id": "REQ-20260408-a3f1",
    "daemon_version": "0.1.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timestamp` | ISO-8601 string | Yes | UTC timestamp of last heartbeat write |
| `pid` | integer | Yes | PID of the supervisor-loop.sh process |
| `iteration_count` | integer | Yes | Number of main loop iterations since startup |
| `active_request_id` | string or null | Yes | Request ID currently being processed, or null if idle |
| `daemon_version` | string | Yes | Version of the daemon engine |

### 4.2 `crash-state.json`

```json
{
    "consecutive_crashes": 2,
    "circuit_breaker_tripped": false,
    "updated_at": "2026-04-08T14:28:00Z",
    "last_crash_exit_code": 1,
    "last_crash_request_id": "REQ-20260408-a3f1",
    "last_crash_phase": "code"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `consecutive_crashes` | integer | Yes | Count of consecutive non-zero exit codes |
| `circuit_breaker_tripped` | boolean | Yes | Whether the circuit breaker is currently tripped |
| `updated_at` | ISO-8601 string | Yes | Last update timestamp |
| `last_crash_exit_code` | integer | No | Exit code of the most recent crash |
| `last_crash_request_id` | string | No | Request that was being processed when crash occurred |
| `last_crash_phase` | string | No | Phase that was active when crash occurred |

### 4.3 `daemon.lock`

Plain text file containing a single line: the PID of the running supervisor-loop.sh process.

```
12345
```

No JSON. No newline after the PID. This keeps the file trivially parseable and writable.

### 4.4 `kill-switch.flag`

A sentinel file. Its **existence** is the signal --- contents are irrelevant. When present, the daemon skips all work. The file may optionally contain a human-readable reason:

```
Engaged by operator at 2026-04-08T15:00:00Z. Reason: investigating cost spike.
```

### 4.5 Configuration Schema (daemon section)

This covers only the `daemon` section of the global config file. Other sections (governance, state_machine, etc.) are defined in their respective TDDs.

```json
{
    "daemon": {
        "poll_interval_seconds": 30,
        "heartbeat_interval_seconds": 30,
        "circuit_breaker_threshold": 3,
        "log_retention_days": 30,
        "log_max_size_mb": 50,
        "graceful_shutdown_timeout_seconds": 300,
        "max_turns_by_phase": {
            "intake": 10,
            "prd": 50,
            "prd_review": 30,
            "tdd": 50,
            "tdd_review": 30,
            "plan": 50,
            "plan_review": 30,
            "spec": 50,
            "spec_review": 30,
            "code": 200,
            "code_review": 50,
            "integration": 100,
            "deploy": 30
        },
        "idle_backoff_max_seconds": 900,
        "error_backoff_base_seconds": 30,
        "error_backoff_max_seconds": 900
    }
}
```

### 4.6 Log Entry Schema (daemon.log)

Each line is a JSON object (JSONL format):

```json
{
    "timestamp": "2026-04-08T14:30:00Z",
    "level": "INFO",
    "pid": 12345,
    "iteration": 42,
    "message": "Session exited: request=REQ-20260408-a3f1 exit_code=0",
    "context": {
        "request_id": "REQ-20260408-a3f1",
        "phase": "code",
        "exit_code": 0,
        "session_cost_usd": 3.42,
        "turns_used": 187
    }
}
```

The `context` field is optional and contains structured data relevant to the log message. The `message` field is always a human-readable string.

---

## 5. API / Interface Contracts

### 5.1 CLI Commands (Daemon-Specific)

#### `autonomous-dev install-daemon`

Generates and installs the OS-specific supervisor configuration.

```
Usage: autonomous-dev install-daemon [--force]

Options:
  --force    Overwrite existing plist/unit file without prompting

Output:
  Writes launchd plist or systemd unit file.
  Enables and starts the service.

Exit codes:
  0  Success
  1  Installation failed (permissions, missing directories)
  2  Already installed (use --force to overwrite)
```

#### `autonomous-dev daemon start`

```
Usage: autonomous-dev daemon start

Behavior:
  macOS:  launchctl kickstart -k gui/$(id -u)/com.autonomous-dev.daemon
  Linux:  systemctl --user start autonomous-dev.service

Exit codes:
  0  Daemon started (or already running)
  1  Start failed
```

#### `autonomous-dev daemon stop`

```
Usage: autonomous-dev daemon stop

Behavior:
  Sends SIGTERM to the supervisor loop via the OS supervisor.
  Waits for clean exit.

Exit codes:
  0  Daemon stopped
  1  Stop failed
```

#### `autonomous-dev daemon status`

```
Usage: autonomous-dev daemon status [--json]

Output (human-readable, default):
  Status:            running
  PID:               12345
  Uptime:            2d 14h 32m
  Iteration count:   847
  Crash count:       0
  Circuit breaker:   OK
  Active request:    REQ-20260408-a3f1 (phase: code)
  Heartbeat age:     4s
  Cost (today):      $12.47
  Cost (this month): $89.31

Output (--json):
{
    "status": "running",
    "pid": 12345,
    "uptime_seconds": 225120,
    "iteration_count": 847,
    "consecutive_crashes": 0,
    "circuit_breaker_tripped": false,
    "active_request_id": "REQ-20260408-a3f1",
    "active_request_phase": "code",
    "heartbeat_age_seconds": 4,
    "cost_today_usd": 12.47,
    "cost_month_usd": 89.31
}

Exit codes:
  0  Status retrieved (daemon running)
  1  Status retrieved (daemon not running)
  2  Cannot determine status
```

#### `autonomous-dev kill-switch`

```
Usage: autonomous-dev kill-switch [--reason "..."]

Behavior:
  1. Creates ~/.autonomous-dev/kill-switch.flag with optional reason
  2. Sends SIGTERM to daemon (reads PID from daemon.lock)
  3. Daemon shuts down gracefully; launchd/systemd restarts it
  4. On restart, daemon detects kill-switch.flag and idles

Exit codes:
  0  Kill switch engaged
  1  Failed
```

#### `autonomous-dev kill-switch reset`

```
Usage: autonomous-dev kill-switch reset

Behavior:
  1. Removes ~/.autonomous-dev/kill-switch.flag
  2. Daemon's next iteration will pass the gate check and resume

Exit codes:
  0  Kill switch cleared
  1  Kill switch was not engaged
```

#### `autonomous-dev circuit-breaker reset`

```
Usage: autonomous-dev circuit-breaker reset

Behavior:
  1. Writes crash-state.json with consecutive_crashes=0, circuit_breaker_tripped=false
  2. Daemon's next iteration will pass the gate check and resume

Exit codes:
  0  Circuit breaker reset
  1  Circuit breaker was not tripped
```

### 5.2 File Contracts

These are the files that the daemon engine reads and writes. Other subsystems (state machine, governance) may also read/write some of these files, but the daemon engine is the primary owner.

| File | Owner | Readers | Write Frequency |
|------|-------|---------|-----------------|
| `daemon.lock` | daemon engine | daemon status, kill-switch | Once on startup, removed on exit |
| `heartbeat.json` | daemon engine | daemon status, watchdog, external tools | Every iteration + before spawn |
| `crash-state.json` | daemon engine | daemon status, circuit-breaker reset | After every session exit |
| `kill-switch.flag` | kill-switch command | daemon engine (gate check) | On demand (operator) |
| `logs/daemon.log` | daemon engine | Operator (tail -f), log rotation | Continuously |
| `cost-ledger.json` | daemon engine + governance | daemon status, cost commands | After every session |

### 5.3 Exit Code Contract (Claude Code Session)

The daemon engine interprets the exit code from the `claude` child process:

| Exit Code | Meaning | Daemon Action |
|-----------|---------|---------------|
| 0 | Session completed successfully | Record success, advance state |
| 1 | General error | Record crash, retry or escalate |
| 2 | Turns exhausted (`--max-turns` reached) | Soft failure, retry with checkpoint |
| 130 | SIGINT (Ctrl+C) | Not a crash, do not increment counter |
| 137 | SIGKILL (OOM or forced) | Record crash, retry or escalate |
| 143 | SIGTERM | Clean shutdown path, not a crash |

Note: The specific exit codes from `claude` may need to be verified empirically. The above is a best-effort mapping. The implementation should log unrecognized exit codes and treat them as crashes.

---

## 6. Log Rotation

The daemon writes structured JSON logs to `~/.autonomous-dev/logs/daemon.log`. Without rotation, this file will grow unbounded.

### 6.1 Rotation Strategy

**Age-based rotation**, implemented within the supervisor loop itself (no dependency on external logrotate):

```bash
rotate_logs_if_needed() {
    local max_size_bytes=$(( LOG_MAX_SIZE_MB * 1024 * 1024 ))
    local current_size
    current_size=$(stat -f%z "${LOG_FILE}" 2>/dev/null || stat -c%s "${LOG_FILE}" 2>/dev/null || echo 0)

    if [[ ${current_size} -gt ${max_size_bytes} ]]; then
        # Rotate: daemon.log.2 -> delete, daemon.log.1 -> daemon.log.2, daemon.log -> daemon.log.1
        rm -f "${LOG_FILE}.2"
        [[ -f "${LOG_FILE}.1" ]] && mv "${LOG_FILE}.1" "${LOG_FILE}.2"
        mv "${LOG_FILE}" "${LOG_FILE}.1"
        log_info "Log rotated (previous size: ${current_size} bytes)"
    fi
}
```

### 6.2 Retention

Log files older than `log_retention_days` (default: 30) are deleted on each iteration:

```bash
cleanup_old_logs() {
    find "${LOG_DIR}" -name "daemon.log.*" -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null || true
    find "${LOG_DIR}" -name "session-*.json" -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null || true
}
```

---

## 7. Error Handling & Recovery

### 7.1 Error Classification

| Error Class | Examples | Detection | Recovery |
|------------|----------|-----------|----------|
| **Session failure** | Bug in phase prompt, Claude hallucination, assertion error | Non-zero exit code from `claude` | Retry with checkpoint, escalate after threshold |
| **Infrastructure failure** | API rate limit, network timeout, disk full | Specific error patterns in session output or exit codes | Exponential backoff, pause if persistent |
| **Supervisor failure** | Bash error, OOM kill of supervisor | launchd/systemd detects process death | OS supervisor restarts, stale heartbeat recovery |
| **State corruption** | Partial write, disk error | JSON parse failure on state file read | Restore from checkpoint.json, fail if checkpoint also corrupt |
| **Configuration error** | Invalid JSON, missing required field | Validation on config load | Refuse to start, log clear error message |

### 7.2 Retry Flow

```
Session exits non-zero
     |
     v
Read state.json for current phase
     |
     v
Increment retry_count in current_phase_metadata
     |
     +-- retry_count <= max_retries_for_phase?
     |       |
     |       YES: Compute next_retry_after (exponential backoff)
     |       |    Write updated state.json
     |       |    Next iteration will re-select this request after backoff
     |       |
     |       NO: Escalate
     |           |
     |           +-- trust_level allows autonomous retry of prior phase?
     |           |       YES: Roll back to checkpoint, notify operator
     |           |       NO:  Transition to paused, notify operator
     |           |
     v
Update crash-state.json (increment consecutive_crashes)
     |
     +-- consecutive_crashes >= circuit_breaker_threshold?
             YES: Trip circuit breaker, alert
             NO:  Continue
```

### 7.3 State File Corruption Recovery

If `state.json` fails to parse:

1. Check if `checkpoint.json` exists and is valid
2. If yes: restore `state.json` from `checkpoint.json`, log warning, continue
3. If no: transition request to `failed` with reason `state_corruption`
4. Emit alert to operator

If both `state.json` and `checkpoint.json` are corrupt, the request is unrecoverable and must be manually inspected.

### 7.4 Cost Ledger Corruption Recovery

If `cost-ledger.json` fails to parse:

1. Refuse to process any work (safe default, per NFR-10)
2. Log error with instructions to restore from backup or reinitialize
3. Operator can reinitialize with `autonomous-dev config init --reset-ledger`

---

## 8. Security Considerations

### 8.1 File Permissions

| File/Directory | Permissions | Rationale |
|---------------|-------------|-----------|
| `~/.autonomous-dev/` | `700` | Only the owning user should access daemon state |
| `daemon.lock` | `600` | Contains PID only, but should not be world-readable |
| `heartbeat.json` | `600` | Contains PID and request metadata |
| `crash-state.json` | `600` | Operational state |
| `kill-switch.flag` | `600` | Security-sensitive control file |
| `config/global.json` | `600` | May contain webhook URLs (semi-sensitive) |
| `logs/` | `700` | Logs may contain session output with code snippets |

The `install-daemon` command should set these permissions explicitly and warn if they are more permissive.

### 8.2 Process Isolation

- The `claude` child process runs as the same user as the supervisor. No privilege escalation.
- The `--project-directory` flag restricts Claude Code's file access to the specified repository.
- The repository allowlist (FR-507) is validated before spawning any session. A request targeting a non-allowlisted repository is rejected at intake and never reaches the daemon's spawn logic.

### 8.3 Secret Management

- The daemon engine itself does not handle API keys. Claude Code's own authentication mechanism (Anthropic API key or OAuth) is used.
- Configuration files must not contain API keys. If they do (detected by pattern matching), the daemon should warn on startup.
- Webhook URLs in the notification config are semi-sensitive. The config file should be `600` permissions, and the daemon should warn if it is world-readable.

### 8.4 Lock File Security

The lock file prevents concurrent instances. A malicious actor with write access to `~/.autonomous-dev/` could delete the lock file to allow a second instance, causing race conditions. Mitigation: file permissions (Section 8.1). The lock file is not a security boundary --- it is a coordination mechanism.

---

## 9. Testing Strategy

### 9.1 Unit Tests

Implemented as bash test scripts using a lightweight test harness (e.g., `bats` or a custom `assert` function library).

| Test | What It Validates |
|------|-------------------|
| `test_lock_acquisition` | Lock file is created with correct PID. Second instance detects and exits. Stale lock (dead PID) is cleaned up. |
| `test_heartbeat_write` | Heartbeat file is valid JSON with correct fields. Timestamp is current. |
| `test_stale_heartbeat_detection` | Heartbeats older than threshold are detected. Fresh heartbeats are not flagged. |
| `test_crash_counter_increment` | Counter increments on failure. Resets on success. |
| `test_circuit_breaker_trip` | Breaker trips at threshold. Gate check rejects when tripped. |
| `test_circuit_breaker_reset` | Reset command clears state. Next gate check passes. |
| `test_kill_switch` | Flag file creation blocks processing. Removal unblocks. |
| `test_signal_handling` | SIGTERM sets SHUTDOWN_REQUESTED. Loop exits cleanly after current operation. |
| `test_max_turns_resolution` | Phase-to-turns mapping returns correct values. Config overrides work. |
| `test_idle_backoff` | Backoff doubles each idle iteration. Caps at max. Resets when work found. |
| `test_request_selection` | Highest priority selected. Ties broken by age. Paused/failed/cancelled skipped. Blocked requests skipped. |
| `test_atomic_writes` | All JSON writers use tmp+mv pattern. Interrupted writes do not corrupt files. |
| `test_config_merge` | Defaults are loaded. Global config overrides defaults. Per-key merge (not whole-object replacement). |
| `test_log_rotation` | Logs rotate when size exceeds threshold. Old logs are deleted per retention policy. |
| `test_once_mode` | `--once` flag causes exactly one iteration then exit. |
| `test_graceful_shutdown_timeout` | Child that does not exit within grace period receives SIGTERM then SIGKILL. |

### 9.2 Integration Tests

Require a mock `claude` binary that simulates various behaviors.

```bash
# mock-claude.sh --- simulates claude CLI for testing
#!/usr/bin/env bash
case "${MOCK_BEHAVIOR}" in
    success)
        echo '{"cost_usd": 1.50, "turns_used": 25}'
        exit 0 ;;
    failure)
        echo '{"error": "something went wrong"}'
        exit 1 ;;
    slow)
        sleep 60
        echo '{"cost_usd": 5.00, "turns_used": 200}'
        exit 0 ;;
    hang)
        sleep 999999 ;;
    turns_exhausted)
        echo '{"cost_usd": 3.00, "turns_used": 200, "reason": "max_turns_reached"}'
        exit 2 ;;
esac
```

| Test | What It Validates |
|------|-------------------|
| `test_full_iteration_success` | Submit request, run one iteration with mock-claude success, verify state advanced |
| `test_full_iteration_failure_and_retry` | Mock failure, verify retry counter incremented, next iteration re-attempts |
| `test_circuit_breaker_full_cycle` | Three consecutive failures trip breaker. Reset command clears. Next iteration succeeds. |
| `test_sleep_wake_recovery` | Simulate stale heartbeat (manually backdate). Verify recovery runs without crash counter increment. |
| `test_concurrent_instance_prevention` | Start supervisor, attempt second start, verify second exits with error. |
| `test_sigterm_with_active_session` | Start supervisor with slow mock-claude. Send SIGTERM. Verify child finishes, then supervisor exits 0. |
| `test_cost_tracking_across_iterations` | Run multiple iterations. Verify cost-ledger.json accumulates correctly. |
| `test_kill_switch_full_cycle` | Engage kill switch. Verify daemon idles. Reset. Verify daemon resumes. |

### 9.3 Test Environment

- Tests run in an isolated directory (`/tmp/autonomous-dev-test-XXXX/`)
- All file paths are overridden via environment variables (`DAEMON_HOME`, `CONFIG_FILE`)
- The `claude` binary is replaced with `mock-claude.sh` via PATH manipulation
- Tests clean up after themselves

### 9.4 Acceptance Criteria (from PRD Phase 1 Exit Criteria)

1. A request can be submitted and the daemon processes it through `intake -> prd -> prd_review` with a stub reviewer
2. `kill -9` of the Claude Code child process results in correct recovery on next iteration
3. Cost is tracked in both the request state file and the global ledger
4. `daemon status` reports accurate information
5. The daemon survives a `launchctl kill SIGTERM` and is restarted by launchd

---

## 10. Trade-offs & Alternatives Considered

### 10.1 Bash vs. Node.js/Python for the Supervisor Loop

| Option | Pros | Cons |
|--------|------|------|
| **Bash (chosen)** | Zero additional runtime dependencies. Matches the PRD's constraint that plugins cannot run as true daemons. Natural fit for process spawning (`wait`, signal handling). Extremely lightweight at idle. | Complex logic (JSON parsing, config merging) is awkward in bash. Relies heavily on `jq`. Testing is less ergonomic than in higher-level languages. |
| Node.js | Richer JSON handling. Better test frameworks. Claude Code itself is Node-based. | Adds a runtime dependency. Must manage node process lifecycle. Heavier at idle (V8 memory). |
| Python | Strong JSON/YAML support. Good subprocess management. | Adds a runtime dependency. venv management adds complexity. |

**Decision:** Bash, per PRD FR-100: "The engine SHALL be implemented as a bash supervisor loop." The PRD's rationale is sound --- the supervisor's job is simple (loop, spawn, wait, update files) even if some operations (JSON manipulation) are verbose. `jq` bridges the JSON gap adequately.

### 10.2 Heartbeat File vs. Unix Socket vs. Named Pipe

| Option | Pros | Cons |
|--------|------|------|
| **File (chosen)** | Simple. Survives crashes (file persists). Readable by any tool. No connection management. | Not real-time (polling-based). Small I/O overhead per iteration. |
| Unix socket | Real-time health queries. | Requires a listener thread/process. Lost on crash. Complex in bash. |
| Named pipe | Lightweight IPC. | Blocking semantics complicate the single-threaded loop. |

**Decision:** File-based heartbeat. The polling latency (up to `poll_interval_seconds`) is acceptable for this use case. The simplicity and crash-survival properties outweigh the real-time advantage of sockets.

### 10.3 Circuit Breaker: Stop Daemon vs. Idle Daemon

| Option | Pros | Cons |
|--------|------|------|
| Exit the process (let OS restart, re-trip) | Clear signal to OS supervisor | Restart storm risk. Operator must check logs to understand why. |
| **Idle in loop (chosen)** | Daemon stays running, responds to `status` queries, can be reset without OS-level intervention | Consumes (minimal) resources while doing nothing. |

**Decision:** Idle in loop. The daemon continues running and responding to status queries, which is better for operability. The `circuit-breaker reset` command instantly resumes processing without needing to restart the OS service.

### 10.4 Single-Child Sequential vs. Multi-Child Parallel

| Option | Pros | Cons |
|--------|------|------|
| **Single child (chosen)** | No race conditions on state files. Simple bash implementation. Predictable cost and resource usage. | Lower throughput --- one request at a time. |
| Multiple children | Higher throughput for concurrent requests. | Complex synchronization. State file locking needed. Cost runaway risk multiplied. Bash is poorly suited for managing multiple concurrent children. |

**Decision:** Single child. The PRD states concurrent requests are managed sequentially within the loop (FR-102: "select the highest-priority actionable request"). True parallelism is a Phase 2+ consideration and would likely require moving to a higher-level language.

### 10.5 `KeepAlive = true` vs. `KeepAlive.SuccessfulExit = false`

| Option | Behavior |
|--------|----------|
| `KeepAlive = true` | Always restart, even on clean exit. `daemon stop` triggers immediate restart. |
| **`KeepAlive.SuccessfulExit = false` (chosen)** | Only restart on non-zero exit. Clean shutdown (exit 0) stays stopped. |

**Decision:** `KeepAlive.SuccessfulExit = false`. This allows `daemon stop` to actually stop the daemon. The supervisor script exits 0 on SIGTERM, so launchd does not restart it.

---

## 11. Implementation Plan

### Phase 1: MVP (Target: 2 weeks)

| Task | Description | Estimate | Dependencies |
|------|-------------|----------|--------------|
| **T-1** | Scaffold `bin/supervisor-loop.sh` with argument parsing, logging, dependency validation | 2h | None |
| **T-2** | Implement lock file acquisition/release with PID validation and stale lock cleanup | 2h | T-1 |
| **T-3** | Implement heartbeat write and stale heartbeat detection | 3h | T-1 |
| **T-4** | Implement crash counter and circuit breaker (load, save, trip, reset) | 3h | T-1 |
| **T-5** | Implement signal handlers (SIGTERM, SIGINT) with graceful child wait | 4h | T-1 |
| **T-6** | Implement configuration loading (defaults + global config merge) | 4h | T-1 |
| **T-7** | Implement gate checks (kill switch, circuit breaker, cost cap stub) | 2h | T-4, T-6 |
| **T-8** | Implement request selection (scan repos, parse state files, priority sort) | 4h | T-6 |
| **T-9** | Implement session spawning (checkpoint, build claude command, wait, capture exit) | 6h | T-5, T-8 |
| **T-10** | Implement state update after session (success path, error path, retry logic) | 4h | T-9 |
| **T-11** | Implement cost tracking (parse session output, update ledger) | 3h | T-9 |
| **T-12** | Implement idle backoff (exponential sleep when no work) | 2h | T-8 |
| **T-13** | Implement `--once` mode | 1h | T-9 |
| **T-14** | Implement log rotation | 2h | T-1 |
| **T-15** | Generate launchd plist template and `install-daemon` command (macOS) | 4h | T-1 |
| **T-16** | Implement `daemon start`, `daemon stop`, `daemon status` commands (macOS) | 4h | T-15 |
| **T-17** | Implement `kill-switch` and `kill-switch reset` commands | 2h | T-7 |
| **T-18** | Implement `circuit-breaker reset` command | 1h | T-4 |
| **T-19** | Write unit tests (bats) for all components | 8h | T-1 through T-18 |
| **T-20** | Write integration tests with mock-claude | 8h | T-19 |
| **T-21** | End-to-end test: submit -> process -> survive kill -9 -> recover | 4h | T-20 |

**Total estimate: ~72 hours (~9 working days)**

### Phase 2: Full (Target: 2 weeks)

| Task | Description | Estimate | Dependencies |
|------|-------------|----------|--------------|
| **T-22** | Generate systemd unit file and `install-daemon` for Linux | 4h | Phase 1 |
| **T-23** | Implement `daemon start/stop/status` for Linux (systemctl) | 3h | T-22 |
| **T-24** | Implement sleep/wake recovery with orphaned process cleanup | 4h | Phase 1 |
| **T-25** | Implement per-request error backoff (next_retry_after in state) | 3h | Phase 1 |
| **T-26** | Implement external watchdog cron script | 2h | Phase 1 |
| **T-27** | Implement phase-aware turn budget exhaustion detection | 3h | Phase 1 |
| **T-28** | Implement graceful shutdown child timeout escalation (SIGTERM -> SIGKILL) | 3h | Phase 1 |
| **T-29** | Implement state file corruption recovery (checkpoint restore) | 3h | Phase 1 |
| **T-30** | Implement config file permission checking and warnings | 2h | Phase 1 |
| **T-31** | Implement session output parsing for structured cost/turn data | 4h | Phase 1 |
| **T-32** | Implement old log cleanup by retention policy | 2h | Phase 1 |
| **T-33** | Stress testing: 50+ iterations, multiple repos, simulated failures | 6h | T-22 through T-32 |
| **T-34** | 7-day unattended run validation on macOS | Elapsed (7d) | T-33 |

**Total estimate: ~39 hours + 7-day soak test**

---

## 12. Open Questions / Decisions Needed

| ID | Question | Impact | Proposed Answer | Status |
|----|----------|--------|-----------------|--------|
| OQ-D1 | What exact output format does `claude --print --output-format json` produce? We need the schema to parse cost and turn count. | High --- cost tracking and turn counting depend on this. | Empirically test the current CLI version and document the schema. Build a parsing wrapper that can be updated if the format changes (per PRD R-1 mitigation). | Open |
| OQ-D2 | Should the supervisor detect and handle macOS `caffeinate` to prevent sleep during active sessions? | Medium --- sleep during a session kills it, requiring retry. | No. The system is designed to survive sleep/wake. Using `caffeinate` risks draining battery on laptops. Operators who want uninterrupted processing should disable sleep at the OS level or use a desktop/server. | Proposed: No |
| OQ-D3 | Should the heartbeat include memory/CPU usage of the `claude` child process for observability? | Low --- nice-to-have for debugging resource issues. | Phase 2. Add `ps`-based metrics to heartbeat when a child is active. | Proposed: Defer |
| OQ-D4 | What bash version is the minimum? macOS ships bash 3.2 (GPLv2). Bash 4+ features (associative arrays, `mapfile`) are convenient. | High --- affects script implementation patterns. | Require bash 4+ (available via Homebrew on macOS). The `install-daemon` command should check and warn. The plist should use the Homebrew bash path if system bash is 3.2. | Proposed: bash 4+ |
| OQ-D5 | How should the daemon handle the case where `jq` is not installed? It is a hard dependency. | High --- the script cannot parse or write JSON without jq. | `validate_dependencies` checks for jq on startup and exits with a clear error message and installation instructions if missing. This is already in the design. | Resolved |
| OQ-D6 | Should the `--once` flag also bypass the kill-switch and circuit-breaker, for debugging? | Low --- debugging convenience. | No. `--once` should still respect all gates. If an operator needs to debug past a tripped breaker, they should reset the breaker first. This keeps behavior consistent. | Proposed: No |
| OQ-D7 | What is the interaction between `daemon stop` and a running `claude` session? Does stop wait for the session to finish? | High --- affects operator expectations. | Yes. `daemon stop` sends SIGTERM to the supervisor, which waits for the child to finish (up to `graceful_shutdown_timeout_seconds`). The `stop` command should communicate this: "Waiting for active session to complete..." | Proposed: Wait |
| OQ-D8 | PRD OQ-7 asks about token counting. For the daemon engine, should we estimate tokens from character count, or is this entirely the session's responsibility? | Medium --- affects context window management (FR-308). | Token counting is the session's responsibility. The phase prompt instructs Claude to monitor its own context usage. The daemon engine only cares about exit codes and whether the session reported "context exhausted" in its output. | Proposed: Session responsibility |

---

*End of TDD-001: Daemon Engine*
