#!/usr/bin/env bash
# session_stuck_snapshot.sh -- Diagnostic snapshot bundler (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §6
#
# Dependencies: jq (1.6+), lsof (optional), ps
# Sources: session_transcript.sh, phase_baselines.sh

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

# ---------------------------------------------------------------------------
# _snap_collect_session(pid, output_file) -> stdout: session JSON object
#   Runs ps and lsof (both best-effort); redacts sensitive paths.
# ---------------------------------------------------------------------------
_snap_collect_session() {
    local pid="$1" output_file="$2"
    local lsof_max="${AUTONOMOUS_DEV_HS_LSOF_MAX_ROWS:-200}"

    # --- ps ---
    local ps_line="unavailable"
    local real_pid="null"
    if [[ -n "$pid" && "$pid" != "null" ]]; then
        local ps_out
        ps_out="$(ps -p "$pid" -o pid,tty,stat,time,args 2>/dev/null)" || true
        local line_count
        line_count="$(echo "$ps_out" | wc -l | tr -d ' ')"
        if [[ "$line_count" -gt 1 ]]; then
            # Get second line (first is header)
            ps_line="$(echo "$ps_out" | tail -n +2 | head -1 | tr -s ' ')"
            real_pid="$pid"
        fi
    fi

    # --- lsof ---
    local open_fds_json="[]"
    local lsof_truncated="false"
    local lsof_error="null"

    if [[ -z "$pid" || "$pid" == "null" ]]; then
        lsof_error='"unavailable"'
        open_fds_json="[]"
        lsof_truncated="false"
    elif ! command -v lsof >/dev/null 2>&1; then
        lsof_error='"unavailable"'
        open_fds_json="[]"
        lsof_truncated="false"
    else
        local lsof_raw
        lsof_raw="$(lsof -p "$pid" -F ftn 2>/dev/null)" || lsof_raw=""
        if [[ -z "$lsof_raw" ]]; then
            lsof_error='"unavailable"'
            open_fds_json="[]"
        else
            # Parse lsof -F ftn output into fd/type/name objects
            # lsof -F output: lines starting with f=fd, t=type, n=name
            # Group: each 'f' line starts a new FD record
            local fds_array
            fds_array="$(echo "$lsof_raw" | awk -v max="$lsof_max" '
                BEGIN {
                    fd=""; type=""; name=""; count=0; truncated=0;
                    printf "["
                    first=1
                }
                /^f/ {
                    if (fd != "") {
                        if (count < max) {
                            if (!first) printf ","
                            # Redact sensitive paths
                            n = name
                            if (n ~ /^\/Users\/.*\/private\// || n ~ /^\/Library\/Keychains\//) {
                                n = "<redacted>"
                            }
                            gsub(/"/, "\\\"", n)
                            gsub(/"/, "\\\"", type)
                            gsub(/"/, "\\\"", fd)
                            printf "{\"fd\":\"%s\",\"type\":\"%s\",\"name\":\"%s\"}", fd, type, n
                            first=0
                            count++
                        } else {
                            truncated=1
                        }
                    }
                    fd=substr($0,2); type=""; name=""
                }
                /^t/ { type=substr($0,2) }
                /^n/ { name=substr($0,2) }
                END {
                    if (fd != "") {
                        if (count < max) {
                            if (!first) printf ","
                            n = name
                            if (n ~ /^\/Users\/.*\/private\// || n ~ /^\/Library\/Keychains\//) {
                                n = "<redacted>"
                            }
                            gsub(/"/, "\\\"", n)
                            gsub(/"/, "\\\"", type)
                            gsub(/"/, "\\\"", fd)
                            printf "{\"fd\":\"%s\",\"type\":\"%s\",\"name\":\"%s\"}", fd, type, n
                            count++
                        } else {
                            truncated=1
                        }
                    }
                    printf "]"
                }
            ' 2>/dev/null)" || fds_array="[]"

            open_fds_json="${fds_array:-[]}"
            # Check if truncated
            local row_count
            row_count="$(echo "$lsof_raw" | grep -c '^f' 2>/dev/null || echo "0")"
            if (( row_count > lsof_max )); then
                lsof_truncated="true"
            fi
            lsof_error="null"
        fi
    fi

    # Build session JSON
    jq -cn \
        --argjson pid "$real_pid" \
        --arg ps_line "$ps_line" \
        --argjson open_fds "$open_fds_json" \
        --argjson truncated "$lsof_truncated" \
        --argjson lsof_err "$lsof_error" \
        '{
          pid: $pid,
          ps_line: $ps_line,
          open_fds: $open_fds,
          lsof_truncated: $truncated,
          lsof_error: $lsof_err
        }' 2>/dev/null || echo '{"pid":null,"ps_line":"unavailable","open_fds":[],"lsof_truncated":false,"lsof_error":"unavailable"}'
}

# ---------------------------------------------------------------------------
# _snap_collect_transcript(output_file) -> stdout: transcript JSON object
# ---------------------------------------------------------------------------
_snap_collect_transcript() {
    local output_file="$1"
    local tail_bytes="${AUTONOMOUS_DEV_HS_TRANSCRIPT_TAIL_BYTES:-65536}"
    local tail_lines="${AUTONOMOUS_DEV_HS_TRANSCRIPT_TAIL_LINES:-128}"

    local bytes=0
    local last_mtime="null"
    local silent_s=0
    local tail_lines_arr="[]"

    if [[ -f "$output_file" ]]; then
        bytes="$(wc -c < "$output_file" 2>/dev/null | tr -d ' ' || echo "0")"
        # Get mtime
        if command -v gstat >/dev/null 2>&1; then
            local mt
            mt="$(gstat -c '%Y' "$output_file" 2>/dev/null || echo "")"
            if [[ -n "$mt" ]]; then
                last_mtime="$(gdate -u -d "@${mt}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "null")"
            fi
        elif stat -f %m "$output_file" >/dev/null 2>&1; then
            local mt
            mt="$(stat -f %m "$output_file" 2>/dev/null || echo "")"
            if [[ -n "$mt" && "$mt" != "0" ]]; then
                last_mtime="$(date -u -r "$mt" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "null")"
            fi
        else
            local mt
            mt="$(stat -c %Y "$output_file" 2>/dev/null || echo "")"
            if [[ -n "$mt" && "$mt" != "0" ]]; then
                last_mtime="$(date -u -d "@${mt}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "null")"
            fi
        fi
        # Compute silent seconds
        if [[ "$last_mtime" != "null" ]]; then
            local now_e
            now_e="$(date +%s)"
            local mt_e
            if command -v gdate >/dev/null 2>&1; then
                mt_e="$(gdate -u -d "$last_mtime" +%s 2>/dev/null || echo "$now_e")"
            elif date -u -d "$last_mtime" +%s >/dev/null 2>&1; then
                mt_e="$(date -u -d "$last_mtime" +%s 2>/dev/null || echo "$now_e")"
            else
                local clean="${last_mtime%Z}"
                clean="${clean/T/ }"
                mt_e="$(date -u -j -f '%Y-%m-%d %H:%M:%S' "$clean" +%s 2>/dev/null || echo "$now_e")"
            fi
            silent_s=$(( now_e - mt_e ))
            [[ "$silent_s" -lt 0 ]] && silent_s=0
        fi
        # Get tail lines (bytes-capped then line-capped)
        local tail_content
        tail_content="$(tail -c "$tail_bytes" "$output_file" 2>/dev/null | tail -n "$tail_lines" 2>/dev/null || echo "")"
        # Convert to JSON array of strings
        if [[ -n "$tail_content" ]]; then
            tail_lines_arr="$(echo "$tail_content" | jq -Rsc 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")"
        fi
    fi

    jq -cn \
        --arg path "$output_file" \
        --argjson bytes "$bytes" \
        --argjson mtime "$(echo "\"$last_mtime\"" | jq -c '.')" \
        --argjson silent "$silent_s" \
        --argjson tail "$tail_lines_arr" \
        '{
          path: $path,
          bytes: $bytes,
          last_mtime: (if $mtime == "\"null\"" then null else ($mtime | ltrimstr("\"") | rtrimstr("\"")) end),
          silent_seconds: $silent,
          tail_128_lines: $tail
        }' 2>/dev/null || echo '{"path":"","bytes":0,"last_mtime":null,"silent_seconds":0,"tail_128_lines":[]}'
}

# ---------------------------------------------------------------------------
# _snap_recovery_hint(reason, has_net, has_write) -> stdout: string
# ---------------------------------------------------------------------------
_snap_recovery_hint() {
    local reason="$1" has_net="$2" has_write="$3"
    case "$reason" in
        silent_stall)
            if [[ "$has_net" == "true" && "$has_write" == "true" ]]; then
                echo "API stall likely; consider retry after cool-off"
            elif [[ "$has_net" == "false" && "$has_write" == "true" ]]; then
                echo "Agent is spinning without I/O; consider raising log verbosity"
            elif [[ "$has_net" == "true" && "$has_write" == "false" ]]; then
                echo "Session stalled with transcript closed; check for output redirect issues"
            else
                echo "Session stalled with no observed activity; inspect ps for zombie/defunct"
            fi
            ;;
        elapsed_over_p95)
            echo "Phase running >Nx historical p95; not necessarily hung — inspect transcript tail"
            ;;
        hard_timeout)
            echo "Wall-clock timeout reached; see phase_baselines to tune timeout"
            ;;
        soft_timeout_with_progress)
            echo "Soft timeout reached WITH progress; supervisor will re-enter"
            ;;
        agent_exited_nonzero)
            echo "Agent exited without phase-result; check transcript tail for error line"
            ;;
        kill_signal)
            echo "Session received an external kill; check parent supervisor for context"
            ;;
        *)
            echo "Unknown reason: ${reason}"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# stuck_snapshot(req_dir, output_file, progress_file,
#                request_id, phase, mode, reason, extra_json) -> stdout: path
#
# mode   one of "advisory" | "postmortem"
# reason one of "silent_stall" | "elapsed_over_p95" | "hard_timeout"
#              | "soft_timeout_with_progress" | "agent_exited_nonzero"
#              | "kill_signal"
# extra_json  a JSON object to merge into the top-level snapshot
#             (empty string == no extras).
#
# Return: 0 on success; 1 only if the file write itself fails.
# ---------------------------------------------------------------------------
stuck_snapshot() {
    local req_dir="$1" output_file="$2" progress_file="$3"
    local request_id="$4" phase="$5" mode="$6" reason="$7"
    local extra_json="${8:-}"

    # Compute filename
    local iso_filesafe
    iso_filesafe="$(iso_ms_filesafe 2>/dev/null || date -u +%Y-%m-%dT%H-%M-%SZ)"
    # Canonical form for JSON field (colon separators)
    local captured_at
    captured_at="${iso_filesafe//-/:}"
    # But keep date part dashes - only replace time part
    # Actually iso_ms_filesafe returns YYYY-MM-DDTHH-MM-SS.sssZ
    # captured_at for the JSON field should be YYYY-MM-DDTHH:MM:SS.sssZ
    # So we need to replace only the time separators
    local date_part="${iso_filesafe%%T*}"
    local time_part="${iso_filesafe#*T}"
    time_part="${time_part/-/:}"
    time_part="${time_part/-/:}"
    captured_at="${date_part}T${time_part}"

    local base_name="session-stuck-${iso_filesafe}.json"
    local snap_path="${req_dir}/${base_name}"

    # Handle filename collision
    if [[ -f "$snap_path" ]]; then
        local i=1
        while [[ -f "${req_dir}/session-stuck-${iso_filesafe}-${i}.json" && "$i" -le 9 ]]; do
            (( i++ ))
        done
        snap_path="${req_dir}/session-stuck-${iso_filesafe}-${i}.json"
    fi

    # Collect elapsed_ms from progress file if available
    local elapsed_ms=0
    if [[ -f "$progress_file" ]]; then
        elapsed_ms="$(jq -r '.elapsed_ms // 0' "$progress_file" 2>/dev/null || echo "0")"
    fi

    # Collect session block
    local session_pid="null"
    if [[ -f "$progress_file" ]]; then
        session_pid="$(jq -r '.session_pid // "null"' "$progress_file" 2>/dev/null || echo "null")"
    fi
    local session_block
    session_block="$(_snap_collect_session "$session_pid" "$output_file" 2>/dev/null \
        || echo '{"pid":null,"ps_line":"unavailable","open_fds":[],"lsof_truncated":false,"lsof_error":"unavailable"}')"

    # Collect transcript block
    local transcript_block
    transcript_block="$(_snap_collect_transcript "$output_file" 2>/dev/null \
        || echo '{"path":"","bytes":0,"last_mtime":null,"silent_seconds":0,"tail_128_lines":[]}')"

    # Collect heartbeat block
    local last_two_samples="[]"
    local hung_suspected_count=0
    local first_suspected_at="null"
    if [[ -f "$progress_file" ]]; then
        local progress_data
        progress_data="$(cat "$progress_file" 2>/dev/null || echo "{}")"
        # For v1, last_two_samples holds just the current sample
        last_two_samples="$(echo "$progress_data" | jq -c '[.]' 2>/dev/null || echo "[]")"
        # Count suspected status if applicable
        local cur_status
        cur_status="$(echo "$progress_data" | jq -r '.status // "running"' 2>/dev/null || echo "running")"
        if [[ "$cur_status" == "suspected" ]]; then
            hung_suspected_count=1
            first_suspected_at="$(echo "$progress_data" | jq -r '.ts // null' 2>/dev/null || echo "null")"
        fi
    fi

    local heartbeat_block
    heartbeat_block="$(jq -cn \
        --argjson samples "$last_two_samples" \
        --argjson count "$hung_suspected_count" \
        --arg first_at "$first_suspected_at" \
        '{
          last_two_samples: $samples,
          hung_suspected_count: $count,
          first_suspected_at: (if $first_at == "null" then null else $first_at end)
        }' 2>/dev/null || echo '{"last_two_samples":[],"hung_suspected_count":0,"first_suspected_at":null}')"

    # Collect baselines block
    local baselines_raw
    baselines_raw="$(phase_baselines_read "$phase" 2>/dev/null || echo "{}")"
    local p50_ms p95_ms sample_count elapsed_vs_p95_ratio
    p50_ms="$(echo "$baselines_raw" | jq -c '.p50_ms // null' 2>/dev/null || echo "null")"
    p95_ms="$(echo "$baselines_raw" | jq -c '.p95_ms // null' 2>/dev/null || echo "null")"
    sample_count="$(echo "$baselines_raw" | jq -c '.sample_count // 0' 2>/dev/null || echo "0")"
    if [[ "$p95_ms" != "null" && "$p95_ms" != "0" && "$p95_ms" -gt 0 ]] 2>/dev/null; then
        elapsed_vs_p95_ratio="$(echo "$elapsed_ms $p95_ms" | awk '{printf "%.4f", $1/$2}')"
    else
        elapsed_vs_p95_ratio="null"
    fi
    local baselines_block
    baselines_block="$(jq -cn \
        --arg ph "$phase" \
        --argjson p50 "$p50_ms" \
        --argjson p95 "$p95_ms" \
        --argjson sc "$sample_count" \
        --argjson ratio "$(echo "$elapsed_vs_p95_ratio" | jq -c '.' 2>/dev/null || echo "null")" \
        '{
          phase: $ph,
          p50_ms: $p50,
          p95_ms: $p95,
          sample_count: $sc,
          elapsed_vs_p95_ratio: $ratio
        }' 2>/dev/null || echo '{"phase":"","p50_ms":null,"p95_ms":null,"sample_count":0,"elapsed_vs_p95_ratio":null}')"

    # Compute recovery_hint
    local has_net="false"
    local has_write="false"
    # Check for network FDs
    has_net="$(echo "$session_block" | jq -r \
        '[.open_fds[]? | select(.type == "IPv4" or .type == "IPv6" or .type == "unix")] | length > 0' \
        2>/dev/null || echo "false")"
    # Check for open transcript write FD
    has_write="$(echo "$session_block" | jq -r \
        --arg txpath "$output_file" \
        '[.open_fds[]? | select(.name == $txpath and (.fd | test("[wu]$")))] | length > 0' \
        2>/dev/null || echo "false")"
    local recovery_hint
    recovery_hint="$(_snap_recovery_hint "$reason" "$has_net" "$has_write")"

    # Build final snapshot JSON
    local snapshot
    snapshot="$(jq -cn \
        --argjson sv 1 \
        --arg captured_at "$captured_at" \
        --arg mode "$mode" \
        --arg reason "$reason" \
        --arg req_id "$request_id" \
        --arg ph "$phase" \
        --argjson elapsed "$elapsed_ms" \
        --argjson session "$session_block" \
        --argjson transcript "$transcript_block" \
        --argjson heartbeat "$heartbeat_block" \
        --argjson baselines "$baselines_block" \
        --arg hint "$recovery_hint" \
        '{
          schema_version: $sv,
          captured_at: $captured_at,
          mode: $mode,
          reason: $reason,
          request_id: $req_id,
          phase: $ph,
          agent: null,
          elapsed_ms: $elapsed,
          session: $session,
          transcript: $transcript,
          heartbeat: $heartbeat,
          baselines: $baselines,
          recovery_hint: $hint
        }' 2>/dev/null)"

    if [[ -z "$snapshot" ]]; then
        echo "stuck_snapshot: failed to build snapshot JSON" >&2
        echo ""
        return 1
    fi

    # Merge extra_json if provided
    if [[ -n "$extra_json" ]]; then
        local merged
        merged="$(echo "$snapshot" | jq -c \
            --argjson extra "$extra_json" \
            '. + $extra' 2>/dev/null)" || merged="$snapshot"
        snapshot="$merged"
    fi

    # Write snapshot
    if ! atomic_write_json "$snap_path" "$snapshot"; then
        echo "stuck_snapshot: failed to write snapshot to: ${snap_path}" >&2
        echo ""
        return 1
    fi

    echo "$snap_path"
    return 0
}

# ---------------------------------------------------------------------------
# stuck_snapshot_advisory(req_dir, output_file, progress_file,
#                         request_id, phase, reason, [extra_json]) -> path
# ---------------------------------------------------------------------------
stuck_snapshot_advisory() {
    local req_dir="$1" output_file="$2" progress_file="$3"
    local request_id="$4" phase="$5" reason="$6"
    local extra_json="${7:-}"
    stuck_snapshot "$req_dir" "$output_file" "$progress_file" \
        "$request_id" "$phase" "advisory" "$reason" "$extra_json"
}

# ---------------------------------------------------------------------------
# stuck_snapshot_postmortem(req_dir, output_file, progress_file,
#                           request_id, phase, reason, [extra_json]) -> path
# ---------------------------------------------------------------------------
stuck_snapshot_postmortem() {
    local req_dir="$1" output_file="$2" progress_file="$3"
    local request_id="$4" phase="$5" reason="$6"
    local extra_json="${7:-}"
    stuck_snapshot "$req_dir" "$output_file" "$progress_file" \
        "$request_id" "$phase" "postmortem" "$reason" "$extra_json"
}
