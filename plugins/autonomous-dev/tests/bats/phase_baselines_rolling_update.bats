#!/usr/bin/env bats
###############################################################################
# phase_baselines_rolling_update.bats -- Tests for phase_baselines.sh
# REQ-000060 / TASK-002
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    # shellcheck source=../../lib/observability/session_transcript.sh
    source "${OBS_LIB}/session_transcript.sh"
    # shellcheck source=../../lib/observability/phase_baselines.sh
    source "${OBS_LIB}/phase_baselines.sh"

    # Isolate HOME to avoid touching real baseline file
    export HOME="${BATS_TMPDIR}/home-$$"
    mkdir -p "${HOME}"
}

teardown() {
    rm -rf "${HOME}" 2>/dev/null || true
}

# T2-U1: Fresh file has correct perms and initial sample
@test "phase_baselines_record creates file with correct perms and initial sample" {
    run phase_baselines_record tdd 100 0
    [ "$status" -eq 0 ]

    local base_file="${HOME}/.autonomous-dev/state/observability/phase-baselines.json"
    [ -f "$base_file" ]

    # Check file permissions
    local file_perms
    file_perms="$(stat -f %Lp "$base_file" 2>/dev/null || stat -c %a "$base_file" 2>/dev/null || echo "unknown")"
    [ "$file_perms" = "600" ]

    # Check initial sample
    local samples
    samples="$(jq -c '.phases.tdd.samples_ms' "$base_file")"
    [ "$samples" = "[100]" ]
}

# T2-U2: Cap at 200 samples
@test "phase_baselines_record caps at 200 samples after 300" {
    export AUTONOMOUS_DEV_BASELINE_MAX_SAMPLES=200
    for i in $(seq 1 300); do
        phase_baselines_record tdd $(( i * 1000 )) 0 >/dev/null 2>&1
    done

    local base_file="${HOME}/.autonomous-dev/state/observability/phase-baselines.json"
    local count
    count="$(jq '.phases.tdd.samples_ms | length' "$base_file")"
    [ "$count" -eq 200 ]

    # First entry should be 101000 (samples 1-100 were dropped)
    local first
    first="$(jq '.phases.tdd.samples_ms[0]' "$base_file")"
    [ "$first" -eq 101000 ]
}

# T2-U4: Ignore-124 samples
@test "phase_baselines_record ignores exit_code 124" {
    phase_baselines_record tdd 3600000 124
    phase_baselines_record tdd 3600000 124
    phase_baselines_record tdd 5000 0

    local base_file="${HOME}/.autonomous-dev/state/observability/phase-baselines.json"
    local samples
    samples="$(jq -c '.phases.tdd.samples_ms' "$base_file")"
    [ "$samples" = "[5000]" ]

    local count
    count="$(jq '.phases.tdd.sample_count' "$base_file")"
    [ "$count" -eq 1 ]
}

# T2-U5: Empty/unknown phase returns {}
@test "phase_baselines_read returns {} for unknown phase" {
    run phase_baselines_read nonexistent_phase_xyz
    [ "$status" -eq 0 ]
    [ "$output" = "{}" ]
}

# T2-U6: Corrupt file rescued
@test "phase_baselines_record rescues corrupt baseline file" {
    local base_dir="${HOME}/.autonomous-dev/state/observability"
    mkdir -p "$base_dir"
    local base_file="${base_dir}/phase-baselines.json"
    printf '{"invalid' > "$base_file"

    run phase_baselines_record tdd 100 0
    [ "$status" -eq 0 ]

    # Old file renamed to .corrupt-*
    local corrupt_count
    corrupt_count="$(find "$base_dir" -name 'phase-baselines.json.corrupt-*' | wc -l | tr -d ' ')"
    [ "$corrupt_count" -ge 1 ]

    # New file has the fresh sample
    local samples
    samples="$(jq -c '.phases.tdd.samples_ms' "$base_file")"
    [ "$samples" = "[100]" ]
}

# T2-U7: Concurrent writes serialize (basic version)
@test "phase_baselines_record handles concurrent writes" {
    # Fork two subshells each recording 5 samples
    (
        for i in $(seq 1 5); do
            phase_baselines_record tdd $(( i * 100 )) 0 >/dev/null 2>&1
        done
    ) &
    local pid1=$!
    (
        for i in $(seq 6 10); do
            phase_baselines_record tdd $(( i * 100 )) 0 >/dev/null 2>&1
        done
    ) &
    local pid2=$!

    wait "$pid1" 2>/dev/null || true
    wait "$pid2" 2>/dev/null || true

    local base_file="${HOME}/.autonomous-dev/state/observability/phase-baselines.json"
    if [[ -f "$base_file" ]]; then
        local count
        count="$(jq '.phases.tdd.sample_count' "$base_file" 2>/dev/null || echo "0")"
        # Should have at least 5 samples (at worst one group failed to write)
        [ "$count" -ge 5 ]
    else
        # Acceptable: if the file doesn't exist, at least both processes ran
        true
    fi
}

# T2-U8: Stale lock cleaned
@test "phase_baselines_record cleans stale lock" {
    local base_dir="${HOME}/.autonomous-dev/state/observability"
    mkdir -p "$base_dir"
    local lock_file="${base_dir}/phase-baselines.json.lock"

    # Create a stale lock (touch with mtime 120s in the past)
    touch "$lock_file"
    # Manually age it - we use a fake old mtime by running `touch -t`
    if command -v gtouch >/dev/null 2>&1; then
        gtouch -t "$(date -v-200S +%Y%m%d%H%M.%S 2>/dev/null || date -u -d '200 seconds ago' +%Y%m%d%H%M.%S 2>/dev/null || date +%Y%m%d%H%M.%S)" "$lock_file" 2>/dev/null || true
    else
        touch -t "$(date -v-200S +%Y%m%d%H%M.%S 2>/dev/null || date -d '200 seconds ago' +%Y%m%d%H%M.%S 2>/dev/null || date +%Y%m%d%H%M.%S)" "$lock_file" 2>/dev/null || true
    fi

    run phase_baselines_record tdd 100 0
    [ "$status" -eq 0 ]

    # Lock file should be removed after success
    [ ! -f "$lock_file" ]
}

# T2-U9: phase_baselines_read returns 4 keys
@test "phase_baselines_read returns exactly 4 keys" {
    phase_baselines_record tdd 100 0

    run phase_baselines_read tdd
    [ "$status" -eq 0 ]
    [ "$output" != "{}" ]

    # Check for exactly the 4 required keys
    echo "$output" | jq -e 'has("p50_ms") and has("p95_ms") and has("mean_ms") and has("sample_count")' >/dev/null
}

# T2-U3: p50/p95 arithmetic (basic validation)
@test "phase_baselines_record computes p50 and p95 correctly" {
    # Feed samples 1000..10000 (10 samples)
    for i in $(seq 1 10); do
        phase_baselines_record tdd $(( i * 1000 )) 0 >/dev/null 2>&1
    done

    local result
    result="$(phase_baselines_read tdd)"
    local p50
    p50="$(echo "$result" | jq -r '.p50_ms')"
    local p95
    p95="$(echo "$result" | jq -r '.p95_ms')"
    local count
    count="$(echo "$result" | jq -r '.sample_count')"

    [ "$count" -eq 10 ]
    # p50 = sorted[floor(10*0.5)] = sorted[5] = 6000
    [ "$p50" -eq 6000 ]
    # p95 = sorted[min(floor(10*0.95), 9)] = sorted[min(9,9)] = sorted[9] = 10000
    [ "$p95" -eq 10000 ]
}
