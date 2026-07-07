#!/usr/bin/env bash
# phase_baselines.sh -- Rolling p50/p95 baseline store (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §3
#
# Dependencies: jq (1.6+)
# Sources: session_transcript.sh (for atomic_write_json, now_ms)

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope. Observability MUST NOT
# wedge the supervisor on partial failure (TDD §7.2).

# Source shared helpers if not already loaded
if ! declare -F atomic_write_json >/dev/null 2>&1; then
    _OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=session_transcript.sh
    source "${_OBS_DIR}/session_transcript.sh"
fi

# Default max samples per phase (env override: AUTONOMOUS_DEV_BASELINE_MAX_SAMPLES)
_PB_DEFAULT_MAX_SAMPLES=200

# Baseline file location
_pb_baseline_dir() {
    echo "${HOME}/.autonomous-dev/state/observability"
}

_pb_baseline_file() {
    echo "$(_pb_baseline_dir)/phase-baselines.json"
}

# ---------------------------------------------------------------------------
# _pb_now_iso() -> stdout: ISO-8601 UTC timestamp (seconds precision)
# ---------------------------------------------------------------------------
_pb_now_iso() {
    date -u +%Y-%m-%dT%H:%M:%SZ
}

# ---------------------------------------------------------------------------
# _pb_acquire_lock(lock_path) -> 0|1
#   Uses noclobber to create a lock file. Returns 0 on success, 1 on busy.
#   Caller must call _pb_release_lock after use.
# ---------------------------------------------------------------------------
_pb_acquire_lock() {
    local lock="$1"
    local dir
    dir="$(dirname "$lock")"
    mkdir -p "$dir" 2>/dev/null || true

    # Check for stale lock (>60s old)
    if [[ -f "$lock" ]]; then
        local lock_age=0
        if command -v gstat >/dev/null 2>&1; then
            lock_age=$(( $(now_ms) / 1000 - $(gstat -c %Y "$lock" 2>/dev/null || echo "0") ))
        elif stat -f %m "$lock" >/dev/null 2>&1; then
            # macOS BSD stat
            lock_age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || echo "0") ))
        else
            lock_age=$(( $(date +%s) - $(stat -c %Y "$lock" 2>/dev/null || echo "0") ))
        fi
        if (( lock_age > 60 )); then
            rm -f "$lock" 2>/dev/null || true
        fi
    fi

    # Try to acquire lock using noclobber (atomic create)
    local acquired=0
    ( set -o noclobber; : > "$lock" ) 2>/dev/null && acquired=1

    if [[ "$acquired" == "0" ]]; then
        # Wait up to 500ms in 50ms increments
        local waited=0
        while (( waited < 500 )); do
            sleep 0.05
            waited=$(( waited + 50 ))
            ( set -o noclobber; : > "$lock" ) 2>/dev/null && acquired=1 && break
        done
    fi

    if [[ "$acquired" == "0" ]]; then
        echo "phase_baselines: lock busy after 500ms: ${lock}" >&2
        return 1
    fi

    return 0
}

# ---------------------------------------------------------------------------
# _pb_release_lock(lock_path) -> 0
# ---------------------------------------------------------------------------
_pb_release_lock() {
    local lock="$1"
    rm -f "$lock" 2>/dev/null || true
    return 0
}

# ---------------------------------------------------------------------------
# phase_baselines_record(phase, elapsed_ms, exit_code) -> 0|non-zero
#
# Behavior:
#   1. Skip (return 0) if exit_code == 124 (ignore-124 rule).
#   2. Acquire file lock.
#   3. Read existing file; treat as empty on missing/empty.
#   4. Corrupt file: rename to *.corrupt-<ts> and treat as empty.
#   5. Append elapsed_ms; cap at max samples (default 200).
#   6. Recompute p50, p95, mean.
#   7. atomic_write_json.
#   8. Release lock.
#
# Return: 0 on success or ignore-124; 1 on any hard failure.
# ---------------------------------------------------------------------------
phase_baselines_record() {
    local phase="$1" elapsed_ms="$2" exit_code="$3"

    # Ignore timeout samples
    if [[ "$exit_code" == "124" ]]; then
        return 0
    fi

    local max_samples="${AUTONOMOUS_DEV_BASELINE_MAX_SAMPLES:-${_PB_DEFAULT_MAX_SAMPLES}}"
    local base_dir
    base_dir="$(_pb_baseline_dir)"
    local base_file
    base_file="$(_pb_baseline_file)"
    local lock="${base_file}.lock"

    # Acquire lock
    if ! _pb_acquire_lock "$lock"; then
        return 1
    fi

    # Ensure release on exit
    local _lock_held=1
    # shellcheck disable=SC2064
    trap '_pb_release_lock "'"$lock"'" 2>/dev/null; _lock_held=0' EXIT

    # Read existing data
    local existing="{}"
    if [[ -f "$base_file" && -s "$base_file" ]]; then
        if ! existing="$(jq -c '.' "$base_file" 2>/dev/null)"; then
            # Corrupt file: rename it
            local corrupt_name="${base_file}.corrupt-$(date +%s)"
            mv -f "$base_file" "$corrupt_name" 2>/dev/null || true
            existing="{}"
        fi
    fi

    # Initialize if no phases key
    local has_phases
    has_phases="$(echo "$existing" | jq -r 'has("phases")' 2>/dev/null || echo "false")"
    if [[ "$has_phases" != "true" ]]; then
        existing='{"schema_version":1,"updated_at":"'"$(_pb_now_iso)"'","phases":{}}'
    fi

    # Update the phase entry
    local now_iso
    now_iso="$(_pb_now_iso)"
    local updated
    updated="$(echo "$existing" | jq -c \
        --arg phase "$phase" \
        --argjson elapsed "$elapsed_ms" \
        --argjson max "$max_samples" \
        --arg now "$now_iso" \
        '
        # Get current samples or empty array
        (.phases[$phase].samples_ms // []) as $old_samples
        # Append new sample and cap
        | ($old_samples + [$elapsed]) as $new_samples_pre
        | (if ($new_samples_pre | length) > $max
           then $new_samples_pre[(($new_samples_pre | length) - $max):]
           else $new_samples_pre
           end) as $samples
        # Compute stats
        | ($samples | sort) as $sorted
        | ($sorted | length) as $n
        | (if $n == 0 then null
           else $sorted[($n * 0.5 | floor)]
           end) as $p50
        | (if $n == 0 then null
           else $sorted[([($n * 0.95 | floor), ($n - 1)] | min)]
           end) as $p95
        | (if $n == 0 then null
           else ($sorted | add / $n | floor)
           end) as $mean
        | .phases[$phase] = {
            samples_ms: $samples,
            p50_ms: $p50,
            p95_ms: $p95,
            mean_ms: $mean,
            sample_count: $n,
            last_updated: $now
          }
        | .updated_at = $now
        | .schema_version = 1
        ' 2>/dev/null)" || { _pb_release_lock "$lock"; return 1; }

    if [[ -z "$updated" ]]; then
        _pb_release_lock "$lock"
        return 1
    fi

    mkdir -p "$base_dir" 2>/dev/null || true
    if ! atomic_write_json "$base_file" "$updated"; then
        _pb_release_lock "$lock"
        return 1
    fi

    _pb_release_lock "$lock"
    trap - EXIT
    return 0
}

# ---------------------------------------------------------------------------
# phase_baselines_read(phase) -> stdout: JSON object
#
# Output: {"p50_ms":N,"p95_ms":N,"mean_ms":N,"sample_count":N}
#         or {} if not found / corrupt.
# Return: 0 always.
# ---------------------------------------------------------------------------
phase_baselines_read() {
    local phase="$1"
    local base_file
    base_file="$(_pb_baseline_file)"

    if [[ ! -f "$base_file" || ! -s "$base_file" ]]; then
        echo "{}"
        return 0
    fi

    local result
    result="$(jq -c \
        --arg phase "$phase" \
        'if has("phases") and (.phases | has($phase)) then
           .phases[$phase] | {p50_ms, p95_ms, mean_ms, sample_count}
         else {} end' "$base_file" 2>/dev/null)" || true

    if [[ -z "$result" ]]; then
        echo "WARNING: phase_baselines_read: corrupt or missing data" >&2
        echo "{}"
        return 0
    fi

    echo "$result"
    return 0
}
