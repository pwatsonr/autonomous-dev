#!/usr/bin/env bash
# session_heartbeat.sh -- Progress sidecar heartbeat (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §4
#
# Dependencies: jq (1.6+)
# Sources: session_transcript.sh, phase_baselines.sh, hung_session_detector.sh

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope. Observability MUST NOT
# wedge the supervisor on partial failure (TDD §7.2).

# Source shared helpers if not already loaded
if ! declare -F atomic_write_json >/dev/null 2>&1; then
    _OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=session_transcript.sh
    source "${_OBS_DIR}/session_transcript.sh"
fi
if ! declare -F phase_baselines_read >/dev/null 2>&1; then
    _OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=phase_baselines.sh
    source "${_OBS_DIR}/phase_baselines.sh"
fi
if ! declare -F detect_hung >/dev/null 2>&1; then
    _OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=hung_session_detector.sh
    source "${_OBS_DIR}/hung_session_detector.sh"
fi

# ---------------------------------------------------------------------------
# _hb_file_bytes(path) -> stdout: integer byte count (0 if missing)
# ---------------------------------------------------------------------------
_hb_file_bytes() {
    local path="$1"
    if [[ -f "$path" ]]; then
        wc -c < "$path" 2>/dev/null | tr -d ' ' || echo "0"
    else
        echo "0"
    fi
}

# ---------------------------------------------------------------------------
# _hb_file_mtime_iso(path) -> stdout: ISO-8601 UTC mtime or "null"
# ---------------------------------------------------------------------------
_hb_file_mtime_iso() {
    local path="$1"
    if [[ ! -f "$path" ]]; then
        echo "null"
        return 0
    fi
    if command -v gstat >/dev/null 2>&1; then
        gstat -c '%Y' "$path" 2>/dev/null \
            | xargs -I{} sh -c 'gdate -u -d @{} +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo null' \
            || echo "null"
    elif stat -f %m "$path" >/dev/null 2>&1; then
        # macOS BSD stat + BSD date
        local mtime_epoch
        mtime_epoch="$(stat -f %m "$path" 2>/dev/null || echo "0")"
        if [[ "$mtime_epoch" == "0" ]]; then
            echo "null"
        else
            date -u -r "$mtime_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "null"
        fi
    else
        # GNU stat
        local mtime_epoch
        mtime_epoch="$(stat -c %Y "$path" 2>/dev/null || echo "0")"
        if [[ "$mtime_epoch" == "0" ]]; then
            echo "null"
        else
            date -u -d "@${mtime_epoch}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "null"
        fi
    fi
}

# ---------------------------------------------------------------------------
# _hb_silent_seconds(mtime_iso, bytes) -> stdout: integer seconds
#   Returns 0 if mtime_iso is "null" and bytes is 0 (file never written).
# ---------------------------------------------------------------------------
_hb_silent_seconds() {
    local mtime_iso="$1" bytes="$2"
    if [[ "$mtime_iso" == "null" || -z "$mtime_iso" ]]; then
        echo "0"
        return 0
    fi
    local now_epoch mtime_epoch
    now_epoch="$(date +%s)"
    # Parse ISO-8601 UTC to epoch
    if command -v gdate >/dev/null 2>&1; then
        mtime_epoch="$(gdate -u -d "$mtime_iso" +%s 2>/dev/null || echo "$now_epoch")"
    elif date -u -d "$mtime_iso" +%s >/dev/null 2>&1; then
        mtime_epoch="$(date -u -d "$mtime_iso" +%s 2>/dev/null || echo "$now_epoch")"
    else
        # BSD date: parse ISO format
        # Remove 'Z', replace 'T' with space
        local clean="${mtime_iso%Z}"
        clean="${clean/T/ }"
        mtime_epoch="$(date -u -j -f '%Y-%m-%d %H:%M:%S' "$clean" +%s 2>/dev/null || echo "$now_epoch")"
    fi
    local diff=$(( now_epoch - mtime_epoch ))
    echo "$(( diff < 0 ? 0 : diff ))"
}

# ---------------------------------------------------------------------------
# _hb_build_cfg_json() -> stdout: cfg JSON blob for detect_hung
# ---------------------------------------------------------------------------
_hb_build_cfg_json() {
    local stall="${AUTONOMOUS_DEV_HS_SILENT_STALL_SECONDS:-300}"
    local mult="${AUTONOMOUS_DEV_HS_ANOMALY_MULTIPLIER:-3.0}"
    local min="${AUTONOMOUS_DEV_HS_MIN_BASELINE_SAMPLES:-5}"
    jq -cn \
        --argjson stall "$stall" \
        --argjson mult "$mult" \
        --argjson min "$min" \
        '{silent_stall_s: $stall, anomaly_multiplier: $mult, min_baseline_samples: $min}' \
        2>/dev/null || echo '{"silent_stall_s":300,"anomaly_multiplier":3.0,"min_baseline_samples":5}'
}

# ---------------------------------------------------------------------------
# heartbeat_start(req_dir, output_file, progress_file,
#                 request_id, phase, phase_start_ms) -> stdout: bg PID
#
# Forks a background subshell that loops until it receives SIGTERM.
# Each iteration writes a session-progress sample to progress_file.
# ---------------------------------------------------------------------------
heartbeat_start() {
    local req_dir="$1" output_file="$2" progress_file="$3"
    local request_id="$4" phase="$5" phase_start_ms="$6"

    local interval="${AUTONOMOUS_DEV_HB_INTERVAL_S:-15}"
    local progress_stream="${AUTONOMOUS_DEV_HB_PROGRESS_STREAM:-}"

    # Source observability functions in the subshell
    local _obs_dir
    _obs_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    (
        # Re-source in subshell (env not inherited for functions)
        # Redirect stdout to /dev/null so the background subshell does NOT inherit
        # the command-substitution pipe from the caller.  Without this, any
        # $(heartbeat_start …) call hangs until the sidecar exits — because the
        # subshell still holds the write-end of the pipe open.
        exec >/dev/null
        # shellcheck source=session_transcript.sh
        source "${_obs_dir}/session_transcript.sh"
        # shellcheck source=phase_baselines.sh
        source "${_obs_dir}/phase_baselines.sh"
        # shellcheck source=hung_session_detector.sh
        source "${_obs_dir}/hung_session_detector.sh"

        local _running=1
        trap '_running=0' TERM

        local last_bytes=0
        local started_at
        started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

        while [[ "$_running" == "1" ]]; do
            local now_ms_val
            now_ms_val="$(now_ms)"
            local elapsed_ms=$(( now_ms_val - phase_start_ms ))

            local bytes
            bytes="$(_hb_file_bytes "$output_file")"
            local mtime_iso
            mtime_iso="$(_hb_file_mtime_iso "$output_file")"
            local silent_s
            silent_s="$(_hb_silent_seconds "$mtime_iso" "$bytes")"
            local delta=$(( bytes - last_bytes ))
            [[ "$delta" -lt 0 ]] && delta=0
            last_bytes="$bytes"

            local ts
            ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

            # Build sample JSON
            local sample
            sample="$(jq -cn \
                --argjson sv 1 \
                --arg req_id "$request_id" \
                --arg ph "$phase" \
                --arg started "$started_at" \
                --arg ts "$ts" \
                --argjson elapsed "$elapsed_ms" \
                --arg txpath "$output_file" \
                --argjson txbytes "$bytes" \
                --arg txmtime "$mtime_iso" \
                --argjson txdelta "$delta" \
                --argjson txsilent "$silent_s" \
                '{
                  schema_version: $sv,
                  request_id: $req_id,
                  phase: $ph,
                  session_pid: null,
                  started_at: $started,
                  ts: $ts,
                  elapsed_ms: $elapsed,
                  transcript: {
                    path: $txpath,
                    bytes: $txbytes,
                    last_mtime: (if $txmtime == "null" then null else $txmtime end),
                    delta_bytes_last_interval: $txdelta,
                    silent_seconds: $txsilent
                  },
                  status: "running"
                }' 2>/dev/null)" || sample='{"schema_version":1,"status":"running"}'

            # Run detector
            local baselines
            baselines="$(phase_baselines_read "$phase" 2>/dev/null || echo "{}")"
            local cfg
            cfg="$(_hb_build_cfg_json)"
            local verdict
            verdict="$(detect_hung "$sample" "$baselines" "$cfg" 2>/dev/null || echo '{"verdict":"ok","reason":null,"evidence":{}}')"

            # Merge verdict into sample
            local verdict_value
            verdict_value="$(echo "$verdict" | jq -r '.verdict // "ok"' 2>/dev/null || echo "ok")"
            local verdict_reason
            verdict_reason="$(echo "$verdict" | jq -c '.reason // null' 2>/dev/null || echo "null")"
            local verdict_evidence
            verdict_evidence="$(echo "$verdict" | jq -c '.evidence // {}' 2>/dev/null || echo "{}")"

            local status="running"
            if [[ "$verdict_value" == "suspected" ]]; then
                status="suspected"
            fi

            # Build anomaly block
            local anomaly
            anomaly="$(jq -cn \
                --arg verdict "$verdict_value" \
                --arg reason "$verdict_reason" \
                --argjson evidence "$verdict_evidence" \
                '{
                  elapsed_vs_p95_ratio: ($evidence.elapsed_vs_p95_ratio // null),
                  silent_stall_ratio: null,
                  verdict: $verdict,
                  reason: (if $reason == "null" then null else ($reason | ltrimstr("\"") | rtrimstr("\"")) end)
                }' 2>/dev/null)" || anomaly="null"

            # Build final sample with anomaly + status
            local final_sample
            final_sample="$(echo "$sample" | jq -c \
                --arg status "$status" \
                --argjson anomaly "$anomaly" \
                '. + {status: $status, anomaly: $anomaly}' 2>/dev/null)" || final_sample="$sample"

            # Write progress file
            atomic_write_json "$progress_file" "$final_sample" 2>/dev/null || true

            # Stream to progress log if env set (testability affordance)
            if [[ -n "$progress_stream" ]]; then
                printf '%s\n' "$final_sample" >> "$progress_stream" 2>/dev/null || true
            fi

            # On suspected: write advisory snapshot + emit event
            if [[ "$verdict_value" == "suspected" ]]; then
                if declare -F stuck_snapshot_advisory >/dev/null 2>&1; then
                    stuck_snapshot_advisory \
                        "$req_dir" "$output_file" "$progress_file" \
                        "$request_id" "$phase" \
                        "$(echo "$verdict" | jq -r '.reason // "silent_stall"' 2>/dev/null || echo "silent_stall")" \
                        "" 2>/dev/null || true
                fi
                if declare -F emit_session_hung_suspected >/dev/null 2>&1; then
                    local events_file="${req_dir}/events.jsonl"
                    emit_session_hung_suspected \
                        "$events_file" "$request_id" "unknown" "$phase" \
                        "$(echo "$verdict" | jq -r '.reason // "silent_stall"' 2>/dev/null || echo "silent_stall")" \
                        "$(echo "$verdict" | jq -c '.evidence // {}' 2>/dev/null || echo "{}")" \
                        "" 2>/dev/null || true
                fi
            fi

            # Sleep respecting SIGTERM
            sleep "$interval" &
            local sleep_pid=$!
            wait "$sleep_pid" 2>/dev/null || true
        done
    ) &

    local bg_pid=$!
    echo "$bg_pid"
    return 0
}

# ---------------------------------------------------------------------------
# heartbeat_stop(pid, progress_file) -> 0
#
# Sends SIGTERM to the sidecar, waits up to 500ms, then SIGKILL if needed.
# Updates progress_file status to "exited".
# ---------------------------------------------------------------------------
heartbeat_stop() {
    local pid="$1" progress_file="$2"

    # Send SIGTERM
    kill -TERM "$pid" 2>/dev/null || true

    # Poll up to 500ms
    local waited=0
    while (( waited < 500 )); do
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        sleep 0.05
        waited=$(( waited + 50 ))
    done

    # If still alive, SIGKILL
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
    fi

    # Wait for cleanup
    wait "$pid" 2>/dev/null || true

    # Update progress file status to exited
    if [[ -f "$progress_file" ]]; then
        local now_ts
        now_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        local current
        current="$(cat "$progress_file" 2>/dev/null || echo "{}")"
        local updated
        updated="$(echo "$current" | jq -c \
            --arg ts "$now_ts" \
            '. + {status: "exited", ts: $ts}' 2>/dev/null)" || updated="$current"
        if [[ -n "$updated" ]] && declare -F atomic_write_json >/dev/null 2>&1; then
            atomic_write_json "$progress_file" "$updated" 2>/dev/null || true
        fi
    fi

    return 0
}
