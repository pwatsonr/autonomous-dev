#!/usr/bin/env bats
###############################################################################
# hung_session_detector_anomaly.bats -- Tests for hung_session_detector.sh
# REQ-000060 / TASK-004
# Table-driven tests matching §5.3 of the spec.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    # shellcheck source=../../lib/observability/session_transcript.sh
    source "${OBS_LIB}/session_transcript.sh"
    # shellcheck source=../../lib/observability/hung_session_detector.sh
    source "${OBS_LIB}/hung_session_detector.sh"
}

# Helper: build sample JSON
_make_sample() {
    local elapsed="$1" silent="$2"
    jq -cn \
        --argjson elapsed "$elapsed" \
        --argjson silent "$silent" \
        '{elapsed_ms: $elapsed, transcript: {silent_seconds: $silent, path: "", bytes: 0, last_mtime: null, delta_bytes_last_interval: 0}}'
}

# Helper: build baselines JSON
_make_baselines() {
    local p95="$1" n="$2"
    if [[ "$p95" == "null" ]]; then
        jq -cn --argjson n "$n" '{p95_ms: null, sample_count: $n}'
    else
        jq -cn --argjson p95 "$p95" --argjson n "$n" '{p95_ms: $p95, sample_count: $n}'
    fi
}

# Helper: build cfg JSON
_make_cfg() {
    local stall="$1" mult="$2" min="$3"
    jq -cn --argjson stall "$stall" --argjson mult "$mult" --argjson min "$min" \
        '{silent_stall_s: $stall, anomaly_multiplier: $mult, min_baseline_samples: $min}'
}

# T4-U1: no anomaly (well within all bounds)
@test "T4-U1: elapsed=1000 p95=100000 silent=0 -> ok/null" {
    local sample baselines cfg
    sample="$(_make_sample 1000 0)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "ok" ]
    [ "$reason" = "null" ]
}

# T4-U2: elapsed over p95 threshold
@test "T4-U2: elapsed=350000 p95=100000 silent=0 -> suspected/elapsed_over_p95" {
    local sample baselines cfg
    sample="$(_make_sample 350000 0)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "suspected" ]
    [ "$reason" = "elapsed_over_p95" ]
}

# T4-U3: silent stall detected
@test "T4-U3: elapsed=1000 p95=100000 silent=400 -> suspected/silent_stall" {
    local sample baselines cfg
    sample="$(_make_sample 1000 400)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "suspected" ]
    [ "$reason" = "silent_stall" ]
}

# T4-U4: cold baseline (no p95) -> ok
@test "T4-U4: elapsed=350000 p95=null n=0 silent=0 -> ok/null (cold baseline)" {
    local sample baselines cfg
    sample="$(_make_sample 350000 0)"
    baselines="$(_make_baselines null 0)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "ok" ]
    [ "$reason" = "null" ]
}

# T4-U5: below min samples -> ok
@test "T4-U5: elapsed=350000 p95=100000 n=3 (below min 5) -> ok/null" {
    local sample baselines cfg
    sample="$(_make_sample 350000 0)"
    baselines="$(_make_baselines 100000 3)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "ok" ]
    [ "$reason" = "null" ]
}

# T4-U6: both conditions fire; silent_stall wins (precedence)
@test "T4-U6: elapsed=350000 p95=100000 silent=400 -> suspected/silent_stall (precedence)" {
    local sample baselines cfg
    sample="$(_make_sample 350000 400)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "suspected" ]
    [ "$reason" = "silent_stall" ]
}

# T4-U7: exactly at threshold (== threshold fires)
@test "T4-U7: elapsed=300000 p95=100000 silent=0 -> suspected/elapsed_over_p95 (at threshold)" {
    local sample baselines cfg
    sample="$(_make_sample 300000 0)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "suspected" ]
    [ "$reason" = "elapsed_over_p95" ]
}

# T4-U8: silent exactly at threshold
@test "T4-U8: elapsed=300 p95=100000 silent=300 -> suspected/silent_stall (at threshold)" {
    local sample baselines cfg
    sample="$(_make_sample 300 300)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "suspected" ]
    [ "$reason" = "silent_stall" ]
}

# T4-U9: p95=0 guard -> ok
@test "T4-U9: p95=0 -> ok/null (p95=0 guard)" {
    local sample baselines cfg
    sample="$(_make_sample 1000 0)"
    baselines="$(_make_baselines 0 5)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    local verdict reason
    verdict="$(echo "$output" | jq -r '.verdict')"
    reason="$(echo "$output" | jq -r '.reason')"
    [ "$verdict" = "ok" ]
    [ "$reason" = "null" ]
}

# T4-U10: Determinism (same input -> byte-identical output)
@test "T4-U10: detect_hung is deterministic (same output on repeated calls)" {
    local sample baselines cfg
    sample="$(_make_sample 350000 0)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    local out1 out2
    out1="$(detect_hung "$sample" "$baselines" "$cfg")"
    out2="$(detect_hung "$sample" "$baselines" "$cfg")"
    [ "$out1" = "$out2" ]
}

# T4-U11: No filesystem writes (best-effort on macOS; skip if not feasible)
@test "T4-U11: detect_hung writes no files (best-effort)" {
    local sample baselines cfg
    sample="$(_make_sample 350000 0)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    # Run in a temp dir and verify it stays empty
    local tmp_dir="${BATS_TMPDIR}/no-write-test-$$"
    mkdir -p "$tmp_dir"

    (cd "$tmp_dir" && detect_hung "$sample" "$baselines" "$cfg" > /dev/null)

    local file_count
    file_count="$(find "$tmp_dir" -type f | wc -l | tr -d ' ')"
    [ "$file_count" -eq 0 ]
    rm -rf "$tmp_dir"
}

# Invalid JSON input returns safe default
@test "detect_hung with invalid JSON input returns ok verdict with exit 2" {
    run detect_hung "invalid{json" "{}" "{}"
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.verdict == "ok"' >/dev/null
}

# evidence block is present in output
@test "detect_hung output includes evidence block" {
    local sample baselines cfg
    sample="$(_make_sample 1000 0)"
    baselines="$(_make_baselines 100000 47)"
    cfg="$(_make_cfg 300 3.0 5)"

    run detect_hung "$sample" "$baselines" "$cfg"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("evidence")' >/dev/null
    echo "$output" | jq -e '.evidence | has("elapsed_ms") and has("silent_seconds") and has("p95_ms") and has("sample_count")' >/dev/null
}
